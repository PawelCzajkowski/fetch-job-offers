import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SavedSearch } from "../../src/config/schema.ts";
import type {
  JudgeResult,
  OfferForJudging,
  TokenUsage,
} from "../../src/judge/judge.ts";
import type {
  LinkedInClient,
  LinkedInOutcome,
} from "../../src/linkedin/client.ts";
import { buildDetailUrl } from "../../src/linkedin/detailPage.ts";
import { parseSearchPage } from "../../src/linkedin/searchPage.ts";
import { buildSearchUrl } from "../../src/linkedin/searchUrl.ts";
import {
  type RunDeps,
  type RunEvent,
  runSearches,
} from "../../src/run/runLoop.ts";
import {
  createSeenStore,
  loadSeenStore,
  type SeenFile,
  type SeenStore,
  saveSeenStore,
} from "../../src/store/seenStore.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/linkedin/${name}`, import.meta.url),
    "utf8",
  );

const PAGE_A = fixture("search-typescript-poland-start0.html");
const PAGE_B = fixture("search-typescript-poland-f_TPR-r3600.html");
const EMPTY = fixture("search-empty-past-end.html");
const DETAIL_NO_SALARY = fixture("job-4467798222-no-salary.html");
const DETAIL_WITH_SALARY = fixture("job-4464163116-with-salary.html");

const PAGE_A_IDS = parseSearchPage(PAGE_A).map((card) => card.jobId);
const PAGE_B_IDS = parseSearchPage(PAGE_B).map((card) => card.jobId);

function search(overrides: Partial<SavedSearch> = {}): SavedSearch {
  return {
    name: "ts-poland",
    keywords: "TypeScript",
    location: "Poland",
    postedWithin: "7d",
    maxOffers: 100,
    profile: "TypeScript development",
    ...overrides,
  };
}

const searchUrl = (s: SavedSearch, start: number) => buildSearchUrl(s, start);

/**
 * A fake LinkedIn client serving fixtures by URL. Search URLs come from
 * `pages`; any detail URL gets a real detail fixture (the no-salary one for
 * its own job ID, the salary one otherwise). Unknown search URLs fail the
 * test loudly. Every requested URL is logged.
 */
function fakeClient(
  pages: Record<string, string | LinkedInOutcome>,
  details: Record<string, LinkedInOutcome> = {},
) {
  const requests: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const client: LinkedInClient = {
    async get(url, signal) {
      requests.push(url);
      signals.push(signal);
      const detail = details[url];
      if (detail) return detail;
      if (url.includes("/jobPosting/")) {
        return {
          kind: "ok",
          body: url.endsWith("/4467798222")
            ? DETAIL_NO_SALARY
            : DETAIL_WITH_SALARY,
        };
      }
      const page = pages[url];
      if (page === undefined) throw new Error(`Unexpected URL ${url}`);
      return typeof page === "string" ? { kind: "ok", body: page } : page;
    },
  };
  return {
    client,
    requests,
    signals,
    detailRequests: () =>
      requests.filter((url) => url.includes("/jobPosting/")),
    searchRequests: () =>
      requests.filter((url) => !url.includes("/jobPosting/")),
  };
}

/** Pages for a search: the given bodies at start 0, 10, …, then an empty one. */
function pagesFor(s: SavedSearch, ...bodies: string[]) {
  const pages: Record<string, string> = {};
  bodies.forEach((body, index) => {
    pages[searchUrl(s, index * 10)] = body;
  });
  pages[searchUrl(s, bodies.length * 10)] = EMPTY;
  return pages;
}

const USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 20,
  reasoningTokens: 5,
};

type JudgeCall = { profile: string; offer: OfferForJudging };

/** A fake judge: accepts by default, or answers per title via `decide`. */
function fakeJudge(
  decide: (
    offer: OfferForJudging,
  ) => JudgeResult["outcome"] | "rejected" = () => "judged",
) {
  const calls: JudgeCall[] = [];
  const judge = async (
    profile: string,
    offer: OfferForJudging,
  ): Promise<JudgeResult> => {
    calls.push({ profile, offer });
    const decision = decide(offer);
    if (decision === "unjudged") {
      return {
        outcome: "unjudged",
        reason: "The OpenAI call failed: boom",
        usage: USAGE,
      };
    }
    return {
      outcome: "judged",
      verdict: {
        verdict: decision === "rejected" ? "rejected" : "accepted",
        reason: `Reason for ${offer.title}`,
        workMode: "remote",
        seniority: "senior",
        techStack: ["TypeScript"],
      },
      usage: USAGE,
    };
  };
  return { judge, calls };
}

const NOW = new Date("2026-09-27T10:00:00.000Z");

function setup(
  pages: Record<string, string | LinkedInOutcome>,
  options: {
    store?: SeenStore;
    judge?: ReturnType<typeof fakeJudge>;
    details?: Record<string, LinkedInOutcome>;
  } = {},
) {
  const linkedin = fakeClient(pages, options.details);
  const judge = options.judge ?? fakeJudge();
  const store = options.store ?? createSeenStore({ now: () => NOW });
  const saves: { path: string; snapshot: SeenFile }[] = [];
  const events: RunEvent[] = [];
  const controller = new AbortController();
  const deps: RunDeps = {
    linkedin: linkedin.client,
    judge: judge.judge,
    model: "gpt-6-luna",
    store,
    storePath: "/stores/seen.json",
    save: async (saved, path) => {
      saves.push({ path, snapshot: saved.toJSON() });
    },
    now: () => NOW,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  };
  return { deps, linkedin, judge, store, saves, events, controller };
}

describe("runSearches", () => {
  describe("one search", () => {
    it("pages from start=0 in steps of 10 and stops at the first empty page", async () => {
      const s = search();
      const { deps, linkedin } = setup(pagesFor(s, PAGE_A, PAGE_B));

      await runSearches([s], deps);

      expect(linkedin.searchRequests()).toEqual([
        searchUrl(s, 0),
        searchUrl(s, 10),
        searchUrl(s, 20),
      ]);
    });

    it("merges the card and the detail into the offer data and judges it with the search's profile", async () => {
      const s = search();
      const { deps, judge, store } = setup(pagesFor(s, PAGE_A));

      const result = await runSearches([s], deps);

      const handled = result.offers.find((o) => o.jobId === "4467798222");
      expect(handled?.offer).toMatchObject({
        title: "Staff Software Engineer, UI Platform",
        company: "Redpanda Data",
        location: "Warsaw, Mazowieckie, Poland",
        postedDate: "2026-09-15",
        salary: null,
        employmentType: "Full-time",
        jobFunction: "Engineering and Information Technology",
        industries: "Software Development",
      });
      expect(handled?.offer.description).toContain("\n- ");
      expect(store.getOffer("4467798222")).toEqual(handled?.offer);

      const call = judge.calls.find(
        (c) => c.offer.title === "Staff Software Engineer, UI Platform",
      );
      expect(call).toEqual({
        profile: "TypeScript development",
        offer: {
          title: "Staff Software Engineer, UI Platform",
          company: "Redpanda Data",
          location: "Warsaw, Mazowieckie, Poland",
          description: handled?.offer.description,
        },
      });
    });

    it("records each verdict in the store with the model, and carries it on the handled offer", async () => {
      const s = search();
      const { deps, store } = setup(pagesFor(s, PAGE_A));

      const result = await runSearches([s], deps);

      expect(result.offers).toHaveLength(10);
      for (const id of PAGE_A_IDS) {
        expect(store.isSeen("TypeScript development", id)).toBe(true);
      }
      const handled = result.offers[0];
      expect(handled?.verdict).toEqual({
        verdict: "accepted",
        reason: "Reason for Staff Software Engineer, UI Platform",
        workMode: "remote",
        seniority: "senior",
        techStack: ["TypeScript"],
        model: "gpt-6-luna",
        judgedAt: NOW.toISOString(),
      });
      expect(store.getVerdict("TypeScript development", "4467798222")).toEqual(
        handled?.verdict,
      );
    });

    it("records an unjudged offer with its reason and no judged fields", async () => {
      const s = search();
      const { deps, store } = setup(pagesFor(s, PAGE_A), {
        judge: fakeJudge(() => "unjudged"),
      });

      const result = await runSearches([s], deps);

      const expected = {
        verdict: "unjudged",
        reason: "The OpenAI call failed: boom",
        model: "gpt-6-luna",
        judgedAt: NOW.toISOString(),
      };
      expect(result.offers[0]?.verdict).toEqual(expected);
      expect(store.getVerdict("TypeScript development", "4467798222")).toEqual(
        expected,
      );
    });

    it("never requests start=1000", async () => {
      const s = search({ maxOffers: 1000 });
      const pages: Record<string, string> = {};
      for (let start = 0; start <= 1000; start += 10) {
        pages[searchUrl(s, start)] = PAGE_A;
      }
      const { deps, linkedin } = setup(pages);

      const result = await runSearches([s], deps);

      const starts = linkedin
        .searchRequests()
        .map((url) => new URL(url).searchParams.get("start"));
      expect(starts).toHaveLength(100);
      expect(starts.at(-1)).toBe("990");
      expect(starts).not.toContain("1000");
      // The same cards on every page are handled once.
      expect(result.offers).toHaveLength(10);
      expect(result.searches[0]?.counts.cardsFetched).toBe(1000);
      expect(result.searches[0]?.counts.new).toBe(10);
    });
  });

  describe("seen offers", () => {
    it("skips offers seen under the search's profile at the card: no detail fetch, no judging", async () => {
      const s = search();
      const store = createSeenStore({ now: () => NOW });
      const [first, second] = PAGE_A_IDS as [string, string];
      // A differently written but equal profile key is still seen.
      for (const id of [first, second]) {
        store.recordVerdict("  typescript   DEVELOPMENT ", id, {
          verdict: "rejected",
          reason: "old",
          workMode: null,
          seniority: null,
          techStack: [],
          model: "gpt-6-luna",
        });
      }
      const { deps, linkedin, judge } = setup(pagesFor(s, PAGE_A), { store });

      const result = await runSearches([s], deps);

      expect(linkedin.detailRequests()).not.toContain(buildDetailUrl(first));
      expect(linkedin.detailRequests()).not.toContain(buildDetailUrl(second));
      expect(judge.calls).toHaveLength(8);
      expect(result.offers.map((o) => o.jobId)).toEqual(PAGE_A_IDS.slice(2));
      expect(result.searches[0]?.counts).toMatchObject({
        cardsFetched: 10,
        seenSkipped: 2,
        new: 8,
      });
    });

    it("treats an offer seen only under another profile as new", async () => {
      const s = search();
      const store = createSeenStore({ now: () => NOW });
      store.recordVerdict("Java development", "4467798222", {
        verdict: "unjudged",
        reason: "x",
        model: "gpt-6-luna",
      });
      const { deps } = setup(pagesFor(s, PAGE_A), { store });

      const result = await runSearches([s], deps);

      expect(result.offers.map((o) => o.jobId)).toContain("4467798222");
    });
  });

  describe("maxOffers", () => {
    it("stops once maxOffers new offers have been tried, without fetching the next page", async () => {
      const s = search({ maxOffers: 3 });
      const { deps, linkedin, judge } = setup(pagesFor(s, PAGE_A, PAGE_B));

      const result = await runSearches([s], deps);

      expect(linkedin.searchRequests()).toEqual([searchUrl(s, 0)]);
      expect(judge.calls).toHaveLength(3);
      expect(result.offers.map((o) => o.jobId)).toEqual(PAGE_A_IDS.slice(0, 3));
      expect(result.searches[0]?.counts.new).toBe(3);
    });

    it("does not count seen offers toward maxOffers", async () => {
      const s = search({ maxOffers: 3 });
      const store = createSeenStore({ now: () => NOW });
      for (const id of PAGE_A_IDS.slice(0, 2)) {
        store.recordVerdict(s.profile, id, {
          verdict: "unjudged",
          reason: "x",
          model: "gpt-6-luna",
        });
      }
      const { deps } = setup(pagesFor(s, PAGE_A), { store });

      const result = await runSearches([s], deps);

      expect(result.offers.map((o) => o.jobId)).toEqual(PAGE_A_IDS.slice(2, 5));
      expect(result.searches[0]?.counts).toMatchObject({
        seenSkipped: 2,
        new: 3,
      });
    });

    it("stops after a full page that reaches maxOffers exactly", async () => {
      const s = search({ maxOffers: 10 });
      const { deps, linkedin } = setup(pagesFor(s, PAGE_A, PAGE_B));

      await runSearches([s], deps);

      expect(linkedin.searchRequests()).toEqual([searchUrl(s, 0)]);
    });

    it("carries on into the next page until maxOffers is reached", async () => {
      const s = search({ maxOffers: 12 });
      const { deps, linkedin } = setup(pagesFor(s, PAGE_A, PAGE_B));

      const result = await runSearches([s], deps);

      expect(linkedin.searchRequests()).toEqual([
        searchUrl(s, 0),
        searchUrl(s, 10),
      ]);
      expect(result.offers.map((o) => o.jobId)).toEqual([
        ...PAGE_A_IDS,
        ...PAGE_B_IDS.slice(0, 2),
      ]);
    });
  });

  describe("several searches", () => {
    it("runs them in the given order", async () => {
      const a = search({ name: "a", keywords: "TypeScript" });
      const b = search({ name: "b", keywords: "Node", profile: "Node" });
      const { deps, linkedin } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_B),
      });

      const result = await runSearches([a, b], deps);

      expect(linkedin.searchRequests()).toEqual([
        searchUrl(a, 0),
        searchUrl(a, 10),
        searchUrl(b, 0),
        searchUrl(b, 10),
      ]);
      expect(result.searches.map((r) => r.label)).toEqual(["a", "b"]);
    });

    it("records 'also found by' on an offer handled earlier in the run under the same profile, without fetching, judging or counting it again", async () => {
      const a = search({ name: "a", keywords: "TypeScript" });
      const b = search({
        name: "b",
        keywords: "Node",
        profile: " typescript  Development",
      });
      const { deps, linkedin, judge } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_A, PAGE_B),
      });

      const result = await runSearches([a, b], deps);

      expect(judge.calls).toHaveLength(20);
      expect(linkedin.detailRequests()).toHaveLength(20);
      expect(result.offers).toHaveLength(20);
      const fromA = result.offers.filter((o) => PAGE_A_IDS.includes(o.jobId));
      for (const offer of fromA) {
        expect(offer.foundBy).toBe("a");
        expect(offer.alsoFoundBy).toEqual(["b"]);
      }
      const fromB = result.offers.filter((o) => PAGE_B_IDS.includes(o.jobId));
      for (const offer of fromB) {
        expect(offer.foundBy).toBe("b");
        expect(offer.alsoFoundBy).toEqual([]);
      }
      expect(result.searches[1]?.counts).toMatchObject({
        cardsFetched: 20,
        seenSkipped: 0,
        new: 10,
      });
    });

    it("counts in-run duplicates toward nothing, even with maxOffers", async () => {
      const a = search({ name: "a" });
      const b = search({ name: "b", keywords: "Node", maxOffers: 2 });
      const { deps } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_A, PAGE_B),
      });

      const result = await runSearches([a, b], deps);

      expect(
        result.offers.filter((o) => o.foundBy === "b").map((o) => o.jobId),
      ).toEqual(PAGE_B_IDS.slice(0, 2));
    });

    it("records 'also found by' on already handled cards after maxOffers is reached", async () => {
      const a = search({ name: "a" });
      const b = search({ name: "b", keywords: "Node", maxOffers: 10 });
      // Page B's ten new cards, then page A's ten already handled ones.
      const { deps } = setup({
        ...pagesFor(a, PAGE_A),
        [searchUrl(b, 0)]: PAGE_B + PAGE_A,
      });

      const result = await runSearches([a, b], deps);

      for (const offer of result.offers.filter((o) => o.foundBy === "a")) {
        expect(offer.alsoFoundBy).toEqual(["b"]);
      }
    });

    it("handles the same job ID independently under a different profile, reusing its offer data", async () => {
      const a = search({ name: "a" });
      const b = search({
        name: "b",
        keywords: "Frontend",
        profile: "Frontend development",
      });
      const { deps, linkedin, judge } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_A),
      });

      const result = await runSearches([a, b], deps);

      expect(result.offers).toHaveLength(20);
      expect(linkedin.detailRequests()).toHaveLength(10);
      expect(new Set(linkedin.detailRequests()).size).toBe(10);
      const underB = result.offers.filter((o) => o.foundBy === "b");
      expect(underB.map((o) => o.profile)).toEqual(
        Array(10).fill("Frontend development"),
      );
      expect(judge.calls.slice(10).map((c) => c.profile)).toEqual(
        Array(10).fill("Frontend development"),
      );
      const firstA = result.offers.find(
        (o) => o.foundBy === "a" && o.jobId === "4467798222",
      );
      const firstB = underB.find((o) => o.jobId === "4467798222");
      expect(firstB?.offer).toEqual(firstA?.offer);
      expect(firstA?.alsoFoundBy).toEqual([]);
      expect(result.searches[1]?.counts.new).toBe(10);
    });

    it("judges stored offer data without fetching the detail again", async () => {
      const s = search();
      const store = createSeenStore({ now: () => NOW });
      store.recordOffer("4467798222", {
        title: "Stored title",
        company: "Stored company",
        location: "Stored location",
        postedDate: "2026-09-01",
        salary: "stored salary",
        employmentType: null,
        jobFunction: null,
        industries: null,
        description: "Stored description",
      });
      const { deps, linkedin, judge } = setup(pagesFor(s, PAGE_A), { store });

      const result = await runSearches([s], deps);

      expect(linkedin.detailRequests()).not.toContain(
        buildDetailUrl("4467798222"),
      );
      expect(linkedin.detailRequests()).toHaveLength(9);
      expect(judge.calls[0]?.offer).toEqual({
        title: "Stored title",
        company: "Stored company",
        location: "Stored location",
        description: "Stored description",
      });
      expect(result.offers[0]?.offer.salary).toBe("stored salary");
    });
  });

  describe("saving the store", () => {
    it("saves the store to the store path after each search", async () => {
      const a = search({ name: "a" });
      const b = search({ name: "b", keywords: "Node", profile: "Node" });
      const { deps, saves } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_B),
      });

      await runSearches([a, b], deps);

      expect(saves.map((s) => s.path)).toEqual([
        "/stores/seen.json",
        "/stores/seen.json",
      ]);
      expect(Object.keys(saves[0]?.snapshot.verdicts ?? {})).toEqual([
        "typescript development",
      ]);
      expect(Object.keys(saves[1]?.snapshot.verdicts ?? {})).toEqual([
        "typescript development",
        "node",
      ]);
    });

    describe("with a store in a temp directory", () => {
      let dir: string;
      beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "run-loop-"));
      });
      afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      it("leaves every handled offer seen in the saved file", async () => {
        const path = join(dir, "seen.json");
        const s = search();
        const store = await loadSeenStore(path, { now: () => NOW });
        const { deps } = setup(pagesFor(s, PAGE_A), { store });

        await runSearches([s], {
          ...deps,
          storePath: path,
          save: saveSeenStore,
        });

        const reloaded = await loadSeenStore(path);
        for (const id of PAGE_A_IDS) {
          expect(reloaded.isSeen(s.profile, id)).toBe(true);
          expect(reloaded.hasOffer(id)).toBe(true);
        }
      });
    });
  });

  describe("progress events", () => {
    it("emits search start, each page with its new-offer count, and each judged offer", async () => {
      const s = search({ maxOffers: 12 });
      const store = createSeenStore({ now: () => NOW });
      store.recordVerdict(s.profile, PAGE_A_IDS[0] as string, {
        verdict: "unjudged",
        reason: "x",
        model: "gpt-6-luna",
      });
      const { deps, events } = setup(pagesFor(s, PAGE_A, PAGE_B), {
        store,
        judge: fakeJudge((offer) =>
          offer.title.includes("Staff") ? "rejected" : "judged",
        ),
      });

      await runSearches([s], deps);

      const info = {
        label: "ts-poland",
        profile: "TypeScript development",
        criteria: {
          keywords: "TypeScript",
          location: "Poland",
          postedWithin: "7d",
          maxOffers: 12,
        },
      };
      expect(events[0]).toEqual({
        type: "search-start",
        search: info,
        index: 0,
        total: 1,
      });
      expect(events[1]).toEqual({
        type: "page",
        search: "ts-poland",
        start: 0,
        cards: 10,
        newOffers: 9,
      });
      const judged = events.filter((e) => e.type === "offer-judged");
      expect(judged).toHaveLength(12);
      expect(judged[0]).toEqual({
        type: "offer-judged",
        search: "ts-poland",
        jobId: PAGE_A_IDS[1],
        verdict: expect.stringMatching(/accepted|rejected/),
        reason: expect.any(String),
        title: expect.any(String),
        company: expect.any(String),
      });
      expect(events.map((e) => e.type)).toEqual([
        "search-start",
        "page",
        ...Array(9).fill("offer-judged"),
        "page",
        ...Array(3).fill("offer-judged"),
      ]);
      expect(events[11]).toMatchObject({
        type: "page",
        start: 10,
        newOffers: 3,
      });
    });

    it("reports the verdict, title and company of each judged offer", async () => {
      const s = search({ maxOffers: 1 });
      const { deps, events } = setup(pagesFor(s, PAGE_A), {
        judge: fakeJudge(() => "unjudged"),
      });

      await runSearches([s], deps);

      expect(events.at(-1)).toEqual({
        type: "offer-judged",
        search: "ts-poland",
        jobId: "4467798222",
        verdict: "unjudged",
        reason: "The OpenAI call failed: boom",
        title: "Staff Software Engineer, UI Platform",
        company: "Redpanda Data",
      });
    });
  });

  describe("the run result", () => {
    it("counts cards, seen skipped, new, accepted, rejected and unjudged per search, and sums the token usage", async () => {
      const s = search();
      const store = createSeenStore({ now: () => NOW });
      store.recordVerdict(s.profile, PAGE_A_IDS[0] as string, {
        verdict: "unjudged",
        reason: "x",
        model: "gpt-6-luna",
      });
      let n = 0;
      const judge = fakeJudge(() => {
        n++;
        if (n <= 4) return "judged";
        if (n <= 7) return "rejected";
        return "unjudged";
      });
      const { deps } = setup(pagesFor(s, PAGE_A, PAGE_B), { store, judge });

      const result = await runSearches([s], deps);

      expect(result.searches[0]?.counts).toEqual({
        cardsFetched: 20,
        seenSkipped: 1,
        new: 19,
        accepted: 4,
        rejected: 3,
        unjudged: 12,
        removed: 0,
        unfetched: 0,
      });
      expect(result.searches[0]?.partial).toBeNull();
      expect(result.usage).toEqual({
        inputTokens: 1900,
        outputTokens: 380,
        reasoningTokens: 95,
      });
    });

    it("describes each search by its label, profile and criteria, and stamps the start time", async () => {
      const s = search({ postedWithin: "24h", maxOffers: 5 });
      const { deps } = setup(pagesFor(s, PAGE_A));

      const result = await runSearches([s], deps);

      expect(result.startedAt).toEqual(NOW);
      expect(result.searches[0]).toMatchObject({
        label: "ts-poland",
        profile: "TypeScript development",
        criteria: {
          keywords: "TypeScript",
          location: "Poland",
          postedWithin: "24h",
          maxOffers: 5,
        },
      });
      expect(result.offers[0]).toMatchObject({
        jobId: "4467798222",
        profile: "TypeScript development",
        origin: "new",
        foundBy: "ts-poland",
        alsoFoundBy: [],
      });
    });

    it("returns an empty result for no searches", async () => {
      const { deps, saves } = setup({});

      const result = await runSearches([], deps);

      expect(result.searches).toEqual([]);
      expect(result.offers).toEqual([]);
      expect(result.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      });
      expect(saves).toEqual([]);
    });
  });

  describe("LinkedIn failures (minimal until #23)", () => {
    it("passes the abort signal to every LinkedIn request", async () => {
      const s = search({ maxOffers: 2 });
      const { deps, linkedin, controller } = setup(pagesFor(s, PAGE_A));

      await runSearches([s], deps);

      expect(linkedin.signals.length).toBeGreaterThan(0);
      for (const signal of linkedin.signals) {
        expect(signal).toBe(controller.signal);
      }
    });

    it("counts a removed or unfetched detail toward maxOffers without recording or judging it", async () => {
      const s = search({ maxOffers: 3 });
      const [removedId, unfetchedId] = PAGE_A_IDS as [string, string];
      const { deps, judge, store } = setup(pagesFor(s, PAGE_A), {
        details: {
          [buildDetailUrl(removedId)]: { kind: "not-found" },
          [buildDetailUrl(unfetchedId)]: { kind: "failed", reason: "HTTP 500" },
        },
      });

      const result = await runSearches([s], deps);

      expect(judge.calls).toHaveLength(1);
      expect(result.offers.map((o) => o.jobId)).toEqual([PAGE_A_IDS[2]]);
      expect(store.hasOffer(removedId)).toBe(false);
      expect(store.isSeen(s.profile, unfetchedId)).toBe(false);
      expect(result.searches[0]?.counts).toMatchObject({
        new: 3,
        accepted: 1,
        removed: 1,
        unfetched: 1,
      });
    });

    it("fetches a failed detail once per run and tries it once per profile", async () => {
      const a = search({ name: "a" });
      const b = search({ name: "b", keywords: "Node" });
      const c = search({
        name: "c",
        keywords: "Frontend",
        profile: "Frontend development",
      });
      const removedId = PAGE_A_IDS[0] as string;
      const { deps, linkedin } = setup(
        {
          ...pagesFor(a, PAGE_A, PAGE_A),
          ...pagesFor(b, PAGE_A),
          ...pagesFor(c, PAGE_A),
        },
        { details: { [buildDetailUrl(removedId)]: { kind: "not-found" } } },
      );

      const result = await runSearches([a, b, c], deps);

      expect(
        linkedin
          .detailRequests()
          .filter((u) => u === buildDetailUrl(removedId)),
      ).toHaveLength(1);
      expect(result.searches.map((s) => s.counts.removed)).toEqual([1, 0, 1]);
      expect(result.searches.map((s) => s.counts.new)).toEqual([10, 0, 10]);
    });

    it("stops a search whose page fails, marks it partial, still saves, and runs the next search", async () => {
      const a = search({ name: "a" });
      const b = search({ name: "b", keywords: "Node", profile: "Node" });
      const { deps, saves } = setup({
        [searchUrl(a, 0)]: PAGE_A,
        [searchUrl(a, 10)]: { kind: "failed", reason: "HTTP 500" },
        ...pagesFor(b, PAGE_B),
      });

      const result = await runSearches([a, b], deps);

      expect(result.searches[0]?.partial).toEqual({
        reason: "Search page start=10 failed: HTTP 500",
      });
      expect(result.searches[0]?.counts.new).toBe(10);
      expect(result.searches[1]?.partial).toBeNull();
      expect(saves).toHaveLength(2);
    });
  });
});
