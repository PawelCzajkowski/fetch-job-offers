import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlannedSearch } from "../../src/config/plan.ts";
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
  type RunLoopOptions,
  runSearches,
} from "../../src/run/runLoop.ts";
import {
  createSeenStore,
  loadSeenStore,
  type OfferData,
  profileKey,
  type SeenFile,
  type SeenStore,
  type StoredVerdict,
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

function search(overrides: Partial<PlannedSearch> = {}): PlannedSearch {
  return {
    label: "ts-poland",
    keywords: "TypeScript",
    location: "Poland",
    postedWithin: "7d",
    maxOffers: 100,
    profile: "TypeScript development",
    ...overrides,
  };
}

const searchUrl = (s: PlannedSearch, start: number) => buildSearchUrl(s, start);

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
function pagesFor(s: PlannedSearch, ...bodies: string[]) {
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
/** No flags: a plain run. */
const FLAGS: RunLoopOptions = { all: false, rejudge: false, dryRun: false };

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

const OLD = new Date("2026-09-01T08:00:00.000Z");

function storedOffer(id: string): OfferData {
  return {
    title: `Stored ${id}`,
    company: "Stored Co",
    location: "Stored place",
    postedDate: "2026-08-30",
    salary: null,
    employmentType: null,
    jobFunction: null,
    industries: null,
    description: `Stored description of ${id}`,
  };
}

/**
 * A store holding offers seen under `profile` before the run, with their
 * offer data, stamped OLD; writes made during the run are stamped NOW.
 */
function seededStore(
  profile: string,
  seen: Record<string, StoredVerdict["verdict"]>,
): SeenStore {
  let clock = OLD;
  const store = createSeenStore({ now: () => clock });
  for (const [id, verdict] of Object.entries(seen)) {
    store.recordOffer(id, storedOffer(id));
    store.recordVerdict(
      profile,
      id,
      verdict === "unjudged"
        ? { verdict, reason: "old error", model: "gpt-5" }
        : {
            verdict,
            reason: `old ${verdict}`,
            workMode: null,
            seniority: null,
            techStack: [],
            model: "gpt-5",
          },
    );
  }
  clock = NOW;
  return store;
}

/** Makes `linkedin.get` abort the run when it is asked for `url`. */
function abortOnRequest(
  deps: RunDeps,
  controller: AbortController,
  url: string,
): void {
  const inner = deps.linkedin;
  deps.linkedin = {
    get(requested, signal) {
      if (requested === url) {
        controller.abort();
        return Promise.reject(controller.signal.reason);
      }
      return inner.get(requested, signal);
    },
  };
}

const [A0, A1, A2, A3, A4, A5] = PAGE_A_IDS as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const [A8, A9] = PAGE_A_IDS.slice(8) as [string, string];
const B0 = PAGE_B_IDS[0] as string;
const failed: LinkedInOutcome = { kind: "failed", reason: "HTTP 500" };
const failedDetails = (...ids: string[]) =>
  Object.fromEntries(ids.map((id) => [buildDetailUrl(id), failed]));

describe("runSearches", () => {
  describe("one search", () => {
    it("pages from start=0 in steps of 10 and stops at the first empty page", async () => {
      const s = search();
      const { deps, linkedin } = setup(pagesFor(s, PAGE_A, PAGE_B));

      await runSearches([s], deps, FLAGS);

      expect(linkedin.searchRequests()).toEqual([
        searchUrl(s, 0),
        searchUrl(s, 10),
        searchUrl(s, 20),
      ]);
    });

    it("merges the card and the detail into the offer data and judges it with the search's profile", async () => {
      const s = search();
      const { deps, judge, store } = setup(pagesFor(s, PAGE_A));

      const result = await runSearches([s], deps, FLAGS);

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

      const result = await runSearches([s], deps, FLAGS);

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

      const result = await runSearches([s], deps, FLAGS);

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

      const result = await runSearches([s], deps, FLAGS);

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

      const result = await runSearches([s], deps, FLAGS);

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
  });

  describe("maxOffers", () => {
    it("stops once maxOffers new offers have been tried, without fetching the next page", async () => {
      const s = search({ maxOffers: 3 });
      const { deps, linkedin, judge } = setup(pagesFor(s, PAGE_A, PAGE_B));

      const result = await runSearches([s], deps, FLAGS);

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

      const result = await runSearches([s], deps, FLAGS);

      expect(result.offers.map((o) => o.jobId)).toEqual(PAGE_A_IDS.slice(2, 5));
      expect(result.searches[0]?.counts).toMatchObject({
        seenSkipped: 2,
        new: 3,
      });
    });

    it("carries on into the next page until maxOffers is reached", async () => {
      const s = search({ maxOffers: 12 });
      const { deps, linkedin } = setup(pagesFor(s, PAGE_A, PAGE_B));

      const result = await runSearches([s], deps, FLAGS);

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
      const a = search({ label: "a", keywords: "TypeScript" });
      const b = search({ label: "b", keywords: "Node", profile: "Node" });
      const { deps, linkedin } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_B),
      });

      const result = await runSearches([a, b], deps, FLAGS);

      expect(linkedin.searchRequests()).toEqual([
        searchUrl(a, 0),
        searchUrl(a, 10),
        searchUrl(b, 0),
        searchUrl(b, 10),
      ]);
      expect(result.searches.map((r) => r.label)).toEqual(["a", "b"]);
    });

    it("records 'also found by' on an offer handled earlier in the run under the same profile, without fetching, judging or counting it again", async () => {
      const a = search({ label: "a", keywords: "TypeScript" });
      const b = search({
        label: "b",
        keywords: "Node",
        profile: " typescript  Development",
      });
      const { deps, linkedin, judge } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_A, PAGE_B),
      });

      const result = await runSearches([a, b], deps, FLAGS);

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
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node", maxOffers: 2 });
      const { deps } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_A, PAGE_B),
      });

      const result = await runSearches([a, b], deps, FLAGS);

      expect(
        result.offers.filter((o) => o.foundBy === "b").map((o) => o.jobId),
      ).toEqual(PAGE_B_IDS.slice(0, 2));
    });

    it("records 'also found by' on already handled cards after maxOffers is reached", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node", maxOffers: 10 });
      // Page B's ten new cards, then page A's ten already handled ones.
      const { deps } = setup({
        ...pagesFor(a, PAGE_A),
        [searchUrl(b, 0)]: PAGE_B + PAGE_A,
      });

      const result = await runSearches([a, b], deps, FLAGS);

      for (const offer of result.offers.filter((o) => o.foundBy === "a")) {
        expect(offer.alsoFoundBy).toEqual(["b"]);
      }
    });

    it("handles the same job ID independently under a different profile, reusing its offer data", async () => {
      const a = search({ label: "a" });
      const b = search({
        label: "b",
        keywords: "Frontend",
        profile: "Frontend development",
      });
      const { deps, linkedin, judge } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_A),
      });

      const result = await runSearches([a, b], deps, FLAGS);

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

      const result = await runSearches([s], deps, FLAGS);

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
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node", profile: "Node" });
      const { deps, saves } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_B),
      });

      await runSearches([a, b], deps, FLAGS);

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

        await runSearches(
          [s],
          {
            ...deps,
            storePath: path,
            save: saveSeenStore,
          },
          FLAGS,
        );

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

      await runSearches([s], deps, FLAGS);

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

      await runSearches([s], deps, FLAGS);

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

      const result = await runSearches([s], deps, FLAGS);

      expect(result.searches[0]?.counts).toEqual({
        cardsFetched: 20,
        seenSkipped: 1,
        new: 19,
        accepted: 4,
        rejected: 3,
        unjudged: 12,
        removed: 0,
        unfetched: 0,
        seenIncluded: 0,
        rejudgedAccepted: 0,
        rejudgedRejected: 0,
        rejudgedUnjudged: 0,
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

      const result = await runSearches([s], deps, FLAGS);

      expect(result.startedAt).toEqual(NOW);
      expect(result.dryRun).toBe(false);
      expect(result.stopped).toBeNull();
      expect(result.notRun).toEqual([]);
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
      expect(result.offers.every((o) => o.origin === "new")).toBe(true);
    });

    it("returns an empty result for no searches", async () => {
      const { deps, saves } = setup({});

      const result = await runSearches([], deps, FLAGS);

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

  describe("LinkedIn failures", () => {
    it("passes the abort signal to every LinkedIn request", async () => {
      const s = search({ maxOffers: 2 });
      const { deps, linkedin, controller } = setup(pagesFor(s, PAGE_A));

      await runSearches([s], deps, FLAGS);

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

      const result = await runSearches([s], deps, FLAGS);

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
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node" });
      const c = search({
        label: "c",
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

      const result = await runSearches([a, b, c], deps, FLAGS);

      expect(
        linkedin
          .detailRequests()
          .filter((u) => u === buildDetailUrl(removedId)),
      ).toHaveLength(1);
      expect(result.searches.map((s) => s.counts.removed)).toEqual([1, 0, 1]);
      expect(result.searches.map((s) => s.counts.new)).toEqual([10, 0, 10]);
    });

    it("stops a search whose page fails, marks it partial, still saves, and runs the next search", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node", profile: "Node" });
      const { deps, saves } = setup({
        [searchUrl(a, 0)]: PAGE_A,
        [searchUrl(a, 10)]: { kind: "failed", reason: "HTTP 500" },
        ...pagesFor(b, PAGE_B),
      });

      const result = await runSearches([a, b], deps, FLAGS);

      expect(result.searches[0]?.partial).toEqual({
        reason: "Search page start=10 failed: HTTP 500",
      });
      expect(result.searches[0]?.counts.new).toBe(10);
      expect(result.searches[1]?.partial).toBeNull();
      expect(saves).toHaveLength(2);
      expect(result.stopped).toBeNull();
    });
  });

  describe("--all", () => {
    const ALL: RunLoopOptions = { ...FLAGS, all: true };

    it("includes seen offers with their stored verdict, unchanged, without fetching or judging them", async () => {
      const s = search();
      const store = seededStore(s.profile, {
        [A0]: "accepted",
        [A1]: "rejected",
        [A2]: "unjudged",
      });
      const before = [A0, A1, A2].map((id) => store.getVerdict(s.profile, id));
      const { deps, linkedin, judge, events } = setup(pagesFor(s, PAGE_A), {
        store,
      });

      const result = await runSearches([s], deps, ALL);

      for (const id of [A0, A1, A2]) {
        expect(linkedin.detailRequests()).not.toContain(buildDetailUrl(id));
      }
      expect(judge.calls).toHaveLength(7);
      expect(result.offers.map((o) => o.jobId)).toEqual(PAGE_A_IDS);
      const seen = result.offers.slice(0, 3);
      expect(seen.map((o) => o.origin)).toEqual(["seen", "seen", "seen"]);
      expect(seen.map((o) => o.verdict)).toEqual(before);
      expect(seen[0]).toMatchObject({
        profile: s.profile,
        offer: { ...storedOffer(A0), firstSeenAt: OLD.toISOString() },
        foundBy: "ts-poland",
        alsoFoundBy: [],
      });
      expect(result.offers.slice(3).every((o) => o.origin === "new")).toBe(
        true,
      );
      expect([A0, A1, A2].map((id) => store.getVerdict(s.profile, id))).toEqual(
        before,
      );
      expect(result.searches[0]?.counts).toMatchObject({
        cardsFetched: 10,
        seenSkipped: 0,
        seenIncluded: 3,
        new: 7,
        accepted: 7,
        unjudged: 0,
      });
      expect(events.filter((e) => e.type === "offer-judged")).toHaveLength(7);
      expect(events.find((e) => e.type === "page")).toMatchObject({
        newOffers: 7,
      });
    });

    it("does not count seen offers toward maxOffers", async () => {
      const s = search({ maxOffers: 2 });
      const store = seededStore(s.profile, {
        [A0]: "accepted",
        [A1]: "accepted",
        [A2]: "rejected",
      });
      const { deps, linkedin } = setup(pagesFor(s, PAGE_A, PAGE_B), { store });

      const result = await runSearches([s], deps, ALL);

      expect(result.offers.map((o) => [o.jobId, o.origin])).toEqual([
        [A0, "seen"],
        [A1, "seen"],
        [A2, "seen"],
        [A3, "new"],
        [A4, "new"],
      ]);
      expect(linkedin.searchRequests()).toEqual([searchUrl(s, 0)]);
    });

    it("includes a seen offer found after maxOffers is reached on the same page", async () => {
      const s = search({ maxOffers: 1 });
      const store = seededStore(s.profile, { [A5]: "accepted" });
      const { deps } = setup(pagesFor(s, PAGE_A), { store });

      const result = await runSearches([s], deps, ALL);

      expect(result.offers.map((o) => [o.jobId, o.origin])).toEqual([
        [A0, "new"],
        [A5, "seen"],
      ]);
    });

    it("adds 'also found by' to an included seen offer found by a later search with the same profile", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node" });
      const store = seededStore(a.profile, { [A0]: "accepted" });
      const { deps } = setup(
        { ...pagesFor(a, PAGE_A), ...pagesFor(b, PAGE_A) },
        { store },
      );

      const result = await runSearches([a, b], deps, ALL);

      expect(result.offers).toHaveLength(10);
      expect(result.offers[0]).toMatchObject({
        jobId: A0,
        origin: "seen",
        alsoFoundBy: ["b"],
      });
      expect(result.searches[1]?.counts).toMatchObject({
        seenIncluded: 0,
        new: 0,
      });
    });
  });

  describe("--rejudge", () => {
    const REJUDGE: RunLoopOptions = { ...FLAGS, rejudge: true };

    it("judges seen unjudged offers again from stored data and replaces the record", async () => {
      const s = search();
      const store = seededStore(s.profile, {
        [A0]: "unjudged",
        [A1]: "accepted",
        [A2]: "rejected",
      });
      const judgedBefore = [A1, A2].map((id) =>
        store.getVerdict(s.profile, id),
      );
      const { deps, linkedin, judge, events } = setup(pagesFor(s, PAGE_A), {
        store,
      });

      const result = await runSearches([s], deps, REJUDGE);

      for (const id of [A0, A1, A2]) {
        expect(linkedin.detailRequests()).not.toContain(buildDetailUrl(id));
      }
      expect(judge.calls[0]).toEqual({
        profile: s.profile,
        offer: {
          title: `Stored ${A0}`,
          company: "Stored Co",
          location: "Stored place",
          description: `Stored description of ${A0}`,
        },
      });
      expect(judge.calls).toHaveLength(8);
      const expected = {
        verdict: "accepted",
        reason: `Reason for Stored ${A0}`,
        workMode: "remote",
        seniority: "senior",
        techStack: ["TypeScript"],
        model: "gpt-6-luna",
        judgedAt: NOW.toISOString(),
      };
      expect(result.offers[0]).toMatchObject({
        jobId: A0,
        origin: "rejudged",
        verdict: expected,
        offer: storedOffer(A0),
      });
      expect(store.getVerdict(s.profile, A0)).toEqual(expected);
      // Accepted and rejected verdicts are neither shown nor touched.
      expect(result.offers.map((o) => o.jobId)).not.toContain(A1);
      expect(result.offers.map((o) => o.jobId)).not.toContain(A2);
      expect([A1, A2].map((id) => store.getVerdict(s.profile, id))).toEqual(
        judgedBefore,
      );
      expect(result.searches[0]?.counts).toMatchObject({
        seenSkipped: 2,
        seenIncluded: 0,
        rejudgedAccepted: 1,
        rejudgedRejected: 0,
        rejudgedUnjudged: 0,
        new: 7,
        accepted: 7,
      });
      expect(events.find((e) => e.type === "offer-judged")).toMatchObject({
        jobId: A0,
        verdict: "accepted",
      });
    });

    it("does not count rejudged offers toward maxOffers", async () => {
      const s = search({ maxOffers: 1 });
      const store = seededStore(s.profile, {
        [A0]: "unjudged",
        [A1]: "unjudged",
      });
      const { deps, judge } = setup(pagesFor(s, PAGE_A), { store });

      const result = await runSearches([s], deps, REJUDGE);

      expect(result.offers.map((o) => [o.jobId, o.origin])).toEqual([
        [A0, "rejudged"],
        [A1, "rejudged"],
        [A2, "new"],
      ]);
      expect(judge.calls).toHaveLength(3);
    });

    it("keeps a failed rejudge unjudged, with the new error as its reason", async () => {
      const s = search({ maxOffers: 1 });
      const store = seededStore(s.profile, { [A0]: "unjudged" });
      const { deps } = setup(pagesFor(s, PAGE_A), {
        store,
        judge: fakeJudge(() => "unjudged"),
      });

      const result = await runSearches([s], deps, REJUDGE);

      const expected = {
        verdict: "unjudged",
        reason: "The OpenAI call failed: boom",
        model: "gpt-6-luna",
        judgedAt: NOW.toISOString(),
      };
      expect(result.offers[0]).toMatchObject({
        origin: "rejudged",
        verdict: expected,
      });
      expect(store.getVerdict(s.profile, A0)).toEqual(expected);
      expect(result.searches[0]?.counts).toMatchObject({
        rejudgedUnjudged: 1,
        unjudged: 1,
      });
    });

    it("combines with --all: accepted and rejected come in as seen, unjudged ones are rejudged", async () => {
      const s = search();
      const store = seededStore(s.profile, {
        [A0]: "unjudged",
        [A1]: "accepted",
        [A2]: "rejected",
      });
      const { deps, judge } = setup(pagesFor(s, PAGE_A), { store });

      const result = await runSearches([s], deps, {
        ...FLAGS,
        all: true,
        rejudge: true,
      });

      expect(result.offers.slice(0, 3).map((o) => [o.jobId, o.origin])).toEqual(
        [
          [A0, "rejudged"],
          [A1, "seen"],
          [A2, "seen"],
        ],
      );
      expect(result.offers[1]?.verdict.verdict).toBe("accepted");
      expect(result.offers[2]?.verdict.verdict).toBe("rejected");
      expect(judge.calls).toHaveLength(8);
      expect(result.searches[0]?.counts).toMatchObject({
        seenSkipped: 0,
        seenIncluded: 2,
        rejudgedAccepted: 1,
        new: 7,
      });
    });
  });

  describe("--dry-run", () => {
    const DRY: RunLoopOptions = { ...FLAGS, dryRun: true };

    it("judges normally but never saves the store", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node", profile: "Node" });
      const { deps, saves, judge } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_B),
      });

      const result = await runSearches([a, b], deps, DRY);

      expect(result.dryRun).toBe(true);
      expect(judge.calls).toHaveLength(20);
      expect(result.offers).toHaveLength(20);
      expect(saves).toEqual([]);
    });

    it("never saves on any stop path: a partial search, a rate limit or an abort", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node" });
      const limited = setup({
        [searchUrl(a, 0)]: failed,
        [searchUrl(b, 0)]: { kind: "rate-limited" },
      });
      const aborted = setup(pagesFor(a, PAGE_A));
      abortOnRequest(aborted.deps, aborted.controller, buildDetailUrl(A2));

      const limitedResult = await runSearches([a, b], limited.deps, DRY);
      const abortedResult = await runSearches([a], aborted.deps, DRY);

      expect(limitedResult.searches[0]?.partial).not.toBeNull();
      expect(limitedResult.stopped?.kind).toBe("rate-limited");
      expect(limited.saves).toEqual([]);
      expect(abortedResult.stopped?.kind).toBe("aborted");
      expect(aborted.saves).toEqual([]);
    });
  });

  describe("3 failed detail pages in a row", () => {
    it("make the search partial; its handled offers are kept and saved, and the run moves on", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node", profile: "Node" });
      const { deps, linkedin, saves } = setup(
        { ...pagesFor(a, PAGE_A, PAGE_B), ...pagesFor(b, PAGE_B) },
        { details: failedDetails(A1, A2, A3) },
      );

      const result = await runSearches([a, b], deps, FLAGS);

      expect(result.searches[0]?.partial).toEqual({
        reason: "3 detail pages in a row failed; the last: HTTP 500",
      });
      expect(result.offers.filter((o) => o.foundBy === "a")).toHaveLength(1);
      expect(linkedin.detailRequests().slice(0, 5)).toEqual([
        buildDetailUrl(A0),
        buildDetailUrl(A1),
        buildDetailUrl(A2),
        buildDetailUrl(A3),
        buildDetailUrl(B0),
      ]);
      expect(linkedin.searchRequests()).not.toContain(searchUrl(a, 10));
      expect(result.searches[0]?.counts).toMatchObject({
        new: 4,
        accepted: 1,
        unfetched: 3,
      });
      expect(saves).toHaveLength(2);
      expect(
        Object.keys(saves[0]?.snapshot.verdicts[profileKey(a.profile)] ?? {}),
      ).toEqual([A0]);
      expect(result.searches[1]?.partial).toBeNull();
      expect(result.stopped).toBeNull();
      expect(result.notRun).toEqual([]);
    });

    it("are counted again from zero after a successful detail page", async () => {
      const s = search();
      const { deps } = setup(pagesFor(s, PAGE_A), {
        details: failedDetails(A0, A1, A3, A4),
      });

      const result = await runSearches([s], deps, FLAGS);

      expect(result.searches[0]?.partial).toBeNull();
      expect(result.searches[0]?.counts).toMatchObject({
        new: 10,
        unfetched: 4,
      });
    });

    it("don't include a removed offer, which also starts the count again", async () => {
      const s = search();
      const { deps } = setup(pagesFor(s, PAGE_A), {
        details: {
          ...failedDetails(A0, A1, A3, A4),
          [buildDetailUrl(A2)]: { kind: "not-found" },
        },
      });

      const result = await runSearches([s], deps, FLAGS);

      expect(result.searches[0]?.partial).toBeNull();
      expect(result.searches[0]?.counts).toMatchObject({
        removed: 1,
        unfetched: 4,
      });
    });

    it("are counted across search pages", async () => {
      const s = search();
      const { deps, linkedin } = setup(pagesFor(s, PAGE_A, PAGE_B, PAGE_A), {
        details: failedDetails(A8, A9, B0),
      });

      const result = await runSearches([s], deps, FLAGS);

      expect(result.searches[0]?.partial).not.toBeNull();
      expect(result.searches[0]?.counts.new).toBe(11);
      expect(linkedin.searchRequests()).not.toContain(searchUrl(s, 20));
    });
  });

  describe("a persistent 429", () => {
    it("on a search page stops the whole run after saving, and lists the searches that didn't run", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node" });
      const c = search({ label: "c", keywords: "Deno" });
      const { deps, linkedin, saves } = setup({
        [searchUrl(a, 0)]: PAGE_A,
        [searchUrl(a, 10)]: { kind: "rate-limited" },
        ...pagesFor(b, PAGE_B),
        ...pagesFor(c, PAGE_B),
      });

      const result = await runSearches([a, b, c], deps, FLAGS);

      const reason = "LinkedIn kept rate-limiting the search page at start=10";
      expect(result.searches).toHaveLength(1);
      expect(result.searches[0]?.partial).toEqual({ reason });
      expect(result.stopped).toEqual({ kind: "rate-limited", reason });
      expect(result.notRun).toEqual([
        {
          label: "b",
          profile: b.profile,
          criteria: {
            keywords: "Node",
            location: "Poland",
            postedWithin: "7d",
            maxOffers: 100,
          },
        },
        expect.objectContaining({ label: "c" }),
      ]);
      expect(result.offers).toHaveLength(10);
      expect(saves).toHaveLength(1);
      expect(linkedin.searchRequests()).not.toContain(searchUrl(b, 0));
    });

    it("on a detail page stops the whole run after saving", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node" });
      const { deps, linkedin, saves } = setup(
        { ...pagesFor(a, PAGE_A), ...pagesFor(b, PAGE_B) },
        { details: { [buildDetailUrl(A2)]: { kind: "rate-limited" } } },
      );

      const result = await runSearches([a, b], deps, FLAGS);

      const reason = `LinkedIn kept rate-limiting the detail page of offer ${A2}`;
      expect(result.searches[0]?.partial).toEqual({ reason });
      expect(result.stopped).toEqual({ kind: "rate-limited", reason });
      expect(result.notRun.map((i) => i.label)).toEqual(["b"]);
      expect(result.offers.map((o) => o.jobId)).toEqual([A0, A1]);
      expect(result.searches[0]?.counts).toMatchObject({
        new: 3,
        accepted: 2,
        unfetched: 1,
      });
      expect(linkedin.detailRequests()).toHaveLength(3);
      expect(saves).toHaveLength(1);
      expect(
        Object.keys(saves[0]?.snapshot.verdicts[profileKey(a.profile)] ?? {}),
      ).toEqual([A0, A1]);
    });
  });

  describe("aborting", () => {
    it("during a detail fetch makes the search partial, still saves, and returns", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node" });
      const { deps, controller, saves, linkedin } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_B),
      });
      abortOnRequest(deps, controller, buildDetailUrl(A2));

      const result = await runSearches([a, b], deps, FLAGS);

      expect(result.stopped).toEqual({
        kind: "aborted",
        reason: "The run was aborted.",
      });
      expect(result.searches).toHaveLength(1);
      expect(result.searches[0]?.partial).toEqual({
        reason: "The run was aborted.",
      });
      expect(result.notRun.map((i) => i.label)).toEqual(["b"]);
      expect(result.offers.map((o) => o.jobId)).toEqual([A0, A1]);
      // The offer being fetched when the run stopped isn't counted.
      expect(result.searches[0]?.counts.new).toBe(2);
      expect(saves).toHaveLength(1);
      expect(
        Object.keys(saves[0]?.snapshot.verdicts[profileKey(a.profile)] ?? {}),
      ).toEqual([A0, A1]);
      expect(linkedin.searchRequests()).not.toContain(searchUrl(b, 0));
    });

    it("during judging keeps the offers judged before it and still saves", async () => {
      const s = search();
      const { deps, controller, saves, store } = setup(pagesFor(s, PAGE_A));
      const inner = deps.judge;
      let calls = 0;
      deps.judge = (profile, offer) => {
        calls++;
        if (calls === 3) {
          controller.abort();
          return Promise.reject(controller.signal.reason);
        }
        return inner(profile, offer);
      };

      const result = await runSearches([s], deps, FLAGS);

      expect(result.stopped?.kind).toBe("aborted");
      expect(result.searches[0]?.partial).not.toBeNull();
      expect(result.offers.map((o) => o.jobId)).toEqual([A0, A1]);
      expect(store.isSeen(s.profile, A2)).toBe(false);
      expect(result.searches[0]?.counts).toMatchObject({
        new: 2,
        accepted: 2,
      });
      expect(saves).toHaveLength(1);
    });

    it("between searches leaves the next searches not run", async () => {
      const a = search({ label: "a" });
      const b = search({ label: "b", keywords: "Node" });
      const { deps, controller, saves, linkedin } = setup({
        ...pagesFor(a, PAGE_A),
        ...pagesFor(b, PAGE_B),
      });
      const save = deps.save;
      deps.save = async (store, path) => {
        await save(store, path);
        controller.abort();
      };

      const result = await runSearches([a, b], deps, FLAGS);

      expect(result.stopped?.kind).toBe("aborted");
      expect(result.searches.map((r) => [r.label, r.partial])).toEqual([
        ["a", null],
      ]);
      expect(result.notRun.map((i) => i.label)).toEqual(["b"]);
      expect(saves).toHaveLength(1);
      expect(linkedin.searchRequests()).not.toContain(searchUrl(b, 0));
    });

    it("rethrows an error that isn't an abort, without saving", async () => {
      const s = search();
      const { deps, saves } = setup(pagesFor(s, PAGE_A));
      deps.judge = () => Promise.reject(new Error("a bug"));

      await expect(runSearches([s], deps, FLAGS)).rejects.toThrow("a bug");
      expect(saves).toEqual([]);
    });
  });
});
