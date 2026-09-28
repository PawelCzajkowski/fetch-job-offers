import { describe, expect, it } from "vitest";
import { buildReportModel, type ReportRow } from "../../src/report/model.ts";
import type {
  HandledOffer,
  OfferOrigin,
  RunResult,
  SearchResult,
} from "../../src/run/runLoop.ts";
import type { StoredOffer, StoredVerdict } from "../../src/store/seenStore.ts";

const STARTED_AT = new Date("2026-09-27T08:30:00.000Z");

function storedOffer(overrides: Partial<StoredOffer> = {}): StoredOffer {
  return {
    title: "Senior Java Developer",
    company: "Acme",
    location: "Warsaw, Poland",
    postedDate: "2026-09-22",
    salary: null,
    employmentType: "Full-time",
    jobFunction: "Engineering",
    industries: "Software Development",
    description: "About us\n\nWe build things.\n- Java\n- Spring",
    firstSeenAt: "2026-09-27T08:31:00.000Z",
    ...overrides,
  };
}

const accepted = (reason = "Java backend role"): StoredVerdict => ({
  verdict: "accepted",
  reason,
  workMode: "hybrid",
  seniority: "senior",
  techStack: ["Java", "Spring"],
  model: "gpt-6-luna",
  judgedAt: "2026-09-27T08:32:00.000Z",
});

const rejected = (reason = "Frontend role"): StoredVerdict => ({
  verdict: "rejected",
  reason,
  workMode: "remote",
  seniority: "mid",
  techStack: ["React"],
  model: "gpt-6-luna",
  judgedAt: "2026-09-27T08:32:00.000Z",
});

const unjudged = (reason = "OpenAI timed out"): StoredVerdict => ({
  verdict: "unjudged",
  reason,
  model: "gpt-6-luna",
  judgedAt: "2026-09-27T08:32:00.000Z",
});

interface OfferSpec {
  jobId?: string;
  profile?: string;
  origin?: OfferOrigin;
  offer?: Partial<StoredOffer>;
  verdict?: StoredVerdict;
  foundBy?: string;
  alsoFoundBy?: string[];
}

function handled(spec: OfferSpec = {}): HandledOffer {
  return {
    jobId: spec.jobId ?? "4467798222",
    profile: spec.profile ?? "Java development",
    origin: spec.origin ?? "new",
    offer: storedOffer(spec.offer),
    verdict: spec.verdict ?? accepted(),
    foundBy: spec.foundBy ?? "java-warsaw",
    alsoFoundBy: spec.alsoFoundBy ?? [],
  };
}

function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    label: "java-warsaw",
    profile: "Java development",
    criteria: {
      keywords: "Java",
      location: "Warsaw",
      postedWithin: "7d",
      maxOffers: 50,
    },
    counts: {
      cardsFetched: 10,
      seenSkipped: 0,
      new: 1,
      accepted: 1,
      rejected: 0,
      unjudged: 0,
      removed: 0,
      unfetched: 0,
      seenIncluded: 0,
      rejudgedAccepted: 0,
      rejudgedRejected: 0,
      rejudgedUnjudged: 0,
    },
    partial: null,
    ...overrides,
  };
}

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    startedAt: STARTED_AT,
    searches: [searchResult()],
    offers: [handled()],
    usage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 50 },
    dryRun: false,
    stopped: null,
    notRun: [],
    ...overrides,
  };
}

const ids = (rows: ReportRow[]) => rows.map((row) => row.rowId);

describe("buildReportModel: rows", () => {
  it("carries everything the reports show for an accepted offer", () => {
    const model = buildReportModel(
      runResult({
        offers: [
          handled({
            jobId: "111",
            offer: { salary: "PLN 20,000–25,000/month" },
            alsoFoundBy: ["java-remote"],
          }),
        ],
      }),
    );

    expect(model.rowsNewestFirst).toEqual([
      {
        rowId: "111",
        jobId: "111",
        url: "https://www.linkedin.com/jobs/view/111",
        title: "Senior Java Developer",
        company: "Acme",
        location: "Warsaw, Poland",
        postedDate: "2026-09-22",
        salary: "PLN 20,000–25,000/month",
        employmentType: "Full-time",
        jobFunction: "Engineering",
        industries: "Software Development",
        verdict: "accepted",
        reason: "Java backend role",
        workMode: "hybrid",
        seniority: "senior",
        techStack: ["Java", "Spring"],
        foundBy: "java-warsaw",
        alsoFoundBy: ["java-remote"],
        descriptionLines: [
          "About us",
          "",
          "We build things.",
          "- Java",
          "- Spring",
        ],
      },
    ]);
  });

  it("gives an unjudged offer its error as reason and no judged fields", () => {
    const [row] = buildReportModel(
      runResult({ offers: [handled({ verdict: unjudged("Rate limited") })] }),
    ).rowsNewestFirst;

    expect(row).toMatchObject({
      verdict: "unjudged",
      reason: "Rate limited",
      workMode: null,
      seniority: null,
      techStack: [],
    });
  });

  it("splits Windows line endings and gives an empty description no lines", () => {
    const model = buildReportModel(
      runResult({
        offers: [
          handled({ jobId: "1", offer: { description: "One\r\n- Two" } }),
          handled({ jobId: "2", offer: { description: "" } }),
        ],
      }),
    );
    const byJob = new Map(model.rowsNewestFirst.map((r) => [r.jobId, r]));

    expect(byJob.get("1")?.descriptionLines).toEqual(["One", "- Two"]);
    expect(byJob.get("2")?.descriptionLines).toEqual([]);
  });

  it("gives the same job ID under two profiles two rows with distinct row IDs", () => {
    const model = buildReportModel(
      runResult({
        offers: [
          handled({ jobId: "42", profile: "Java development" }),
          handled({
            jobId: "42",
            profile: "Team leadership",
            foundBy: "lead-warsaw",
            verdict: rejected("Not a lead role"),
          }),
        ],
      }),
    );

    expect(model.rowsNewestFirst).toHaveLength(2);
    expect(model.counts).toMatchObject({ rows: 2, accepted: 1, rejected: 1 });
    const rows = [...model.rowsNewestFirst].sort((a, b) =>
      a.foundBy < b.foundBy ? -1 : 1,
    );
    expect(rows.map((r) => [r.rowId, r.jobId, r.foundBy, r.verdict])).toEqual([
      ["42", "42", "java-warsaw", "accepted"],
      ["42-2", "42", "lead-warsaw", "rejected"],
    ]);
  });

  it("shows seen offers under --all with their stored verdict and no marker", () => {
    const model = buildReportModel(
      runResult({
        offers: [
          handled({ jobId: "1", origin: "new" }),
          handled({ jobId: "2", origin: "seen", verdict: rejected("Old") }),
        ],
      }),
    );
    const seen = model.rowsNewestFirst.find((r) => r.jobId === "2");
    const fresh = model.rowsNewestFirst.find((r) => r.jobId === "1");

    expect(seen).toMatchObject({ verdict: "rejected", reason: "Old" });
    // Same shape as a new row: nothing tells a seen row apart.
    expect(Object.keys(seen ?? {}).sort()).toEqual(
      Object.keys(fresh ?? {}).sort(),
    );
    expect(model.counts).toMatchObject({ rows: 2, new: 1, rejected: 1 });
  });
});

describe("buildReportModel: counts and header", () => {
  it("counts each verdict, the rows and the new offers, with no cost", () => {
    const model = buildReportModel(
      runResult({
        offers: [
          handled({ jobId: "1", verdict: accepted() }),
          handled({ jobId: "2", verdict: accepted() }),
          handled({ jobId: "3", verdict: rejected() }),
          handled({ jobId: "4", verdict: unjudged(), origin: "rejudged" }),
          handled({ jobId: "5", verdict: rejected(), origin: "seen" }),
        ],
      }),
    );

    expect(model.counts).toEqual({
      rows: 5,
      new: 4,
      accepted: 2,
      rejected: 2,
      unjudged: 1,
    });
    expect(JSON.stringify(model)).not.toMatch(/cost|token/i);
  });

  it("gives the run's start and one line per search that ran", () => {
    const model = buildReportModel(
      runResult({
        searches: [
          searchResult(),
          searchResult({
            label: "lead-remote",
            profile: "Team leadership",
            criteria: {
              keywords: "Tech Lead",
              location: "Poland",
              postedWithin: "24h",
              maxOffers: 20,
            },
            partial: { reason: "LinkedIn kept failing" },
          }),
        ],
        stopped: { kind: "aborted", reason: "Ctrl-C" },
        notRun: [
          {
            label: "never",
            profile: "x",
            criteria: {
              keywords: "x",
              location: "x",
              postedWithin: "7d",
              maxOffers: 1,
            },
          },
        ],
      }),
    );

    expect(model.startedAt).toEqual(STARTED_AT);
    expect(model.searches).toEqual([
      {
        label: "java-warsaw",
        keywords: "Java",
        location: "Warsaw",
        postedWithin: "7d",
        profile: "Java development",
      },
      {
        label: "lead-remote",
        keywords: "Tech Lead",
        location: "Poland",
        postedWithin: "24h",
        profile: "Team leadership",
      },
    ]);
    expect(JSON.stringify(model)).not.toMatch(/partial|never|stopped|Ctrl-C/);
  });
});

describe("buildReportModel: orders", () => {
  const offers = [
    handled({
      jobId: "a",
      verdict: rejected(),
      offer: { postedDate: "2026-09-25", title: "Z" },
    }),
    handled({
      jobId: "b",
      verdict: accepted(),
      offer: { postedDate: "2026-09-20", title: "A" },
    }),
    handled({
      jobId: "c",
      verdict: unjudged(),
      offer: { postedDate: "2026-09-26", title: "M" },
    }),
    handled({
      jobId: "d",
      verdict: accepted(),
      offer: { postedDate: "2026-09-24", title: "B" },
    }),
    handled({
      jobId: "e",
      verdict: rejected(),
      offer: { postedDate: "2026-09-21", title: "C" },
    }),
  ];

  it("orders the HTML rows newest posted first", () => {
    const model = buildReportModel(runResult({ offers }));
    expect(ids(model.rowsNewestFirst)).toEqual(["c", "a", "d", "e", "b"]);
  });

  it("orders the Markdown rows accepted, unjudged, rejected, then newest first", () => {
    const model = buildReportModel(runResult({ offers }));
    expect(ids(model.rowsByVerdict)).toEqual(["d", "b", "c", "a", "e"]);
  });

  it("breaks ties by title, then job ID, then search, whatever the input order", () => {
    const tied = [
      handled({ jobId: "9", offer: { title: "Beta" } }),
      handled({ jobId: "8", offer: { title: "Alpha" } }),
      handled({ jobId: "7", offer: { title: "Beta" } }),
      handled({
        jobId: "7",
        offer: { title: "Beta" },
        profile: "Other",
        foundBy: "other",
      }),
    ];

    const forward = buildReportModel(runResult({ offers: tied }));
    const backward = buildReportModel(
      runResult({ offers: [...tied].reverse() }),
    );

    expect(forward.rowsNewestFirst.map((r) => r.jobId)).toEqual([
      "8",
      "7",
      "7",
      "9",
    ]);
    expect(forward.rowsByVerdict.map((r) => r.jobId)).toEqual([
      "8",
      "7",
      "7",
      "9",
    ]);
    expect(backward.rowsNewestFirst.map((r) => [r.jobId, r.foundBy])).toEqual(
      forward.rowsNewestFirst.map((r) => [r.jobId, r.foundBy]),
    );
  });
});

describe("buildReportModel: flags", () => {
  it("has no rows when the run handled no offers", () => {
    const model = buildReportModel(runResult({ offers: [] }));
    expect(model.hasRows).toBe(false);
    expect(model.rowsNewestFirst).toEqual([]);
    expect(model.rowsByVerdict).toEqual([]);
    expect(model.judgedAny).toBe(false);
  });

  it("has rows when there is at least one", () => {
    expect(buildReportModel(runResult()).hasRows).toBe(true);
  });

  it.each([
    [["new"], true],
    [["rejudged"], true],
    [["seen"], false],
    [["seen", "seen"], false],
    [["seen", "rejudged"], true],
    [["seen", "new"], true],
  ] as [OfferOrigin[], boolean][])(
    "judgedAny for origins %j is %s",
    (origins, expected) => {
      const model = buildReportModel(
        runResult({
          offers: origins.map((origin, i) =>
            handled({ jobId: String(i), origin }),
          ),
        }),
      );
      expect(model.judgedAny).toBe(expected);
    },
  );

  it("carries the dry run through", () => {
    expect(buildReportModel(runResult({ dryRun: true })).dryRun).toBe(true);
    expect(buildReportModel(runResult({ dryRun: false })).dryRun).toBe(false);
  });

  it("does not mutate its input", () => {
    const input = runResult({
      offers: [handled({ jobId: "2" }), handled({ jobId: "1" })],
    });
    const before = JSON.stringify(input);
    buildReportModel(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
