import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../../src/judge/judge.ts";
import {
  estimateCost,
  formatAttempt,
  formatCost,
  formatRunEvent,
  formatSummary,
} from "../../src/output/terminal.ts";
import type {
  RunResult,
  RunSearchInfo,
  SearchCounts,
  SearchResult,
} from "../../src/run/runLoop.ts";

const info = (label: string): RunSearchInfo => ({
  label,
  profile: "Senior Java backend developer",
  criteria: {
    keywords: "java developer",
    location: "Kraków, Poland",
    postedWithin: "24h",
    maxOffers: 50,
  },
});

const counts = (over: Partial<SearchCounts> = {}): SearchCounts => ({
  cardsFetched: 0,
  seenSkipped: 0,
  new: 0,
  accepted: 0,
  rejected: 0,
  unjudged: 0,
  removed: 0,
  unfetched: 0,
  ...over,
});

const search = (
  label: string,
  over: Partial<SearchCounts> = {},
  partial: SearchResult["partial"] = null,
): SearchResult => ({ ...info(label), counts: counts(over), partial });

const noUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

const result = (over: Partial<RunResult> = {}): RunResult => ({
  startedAt: new Date("2026-09-27T10:00:00Z"),
  searches: [],
  offers: [],
  usage: noUsage,
  dryRun: false,
  stopped: null,
  notRun: [],
  ...over,
});

describe("formatRunEvent", () => {
  it("formats a search start with its position and criteria", () => {
    expect(
      formatRunEvent({
        type: "search-start",
        search: info("java-krakow"),
        index: 0,
        total: 2,
      }),
    ).toBe(
      'Search 1/2: java-krakow ("java developer" in Kraków, Poland, posted within 24h, up to 50 new offers)',
    );
  });

  it("formats a page with its new-offer count", () => {
    expect(
      formatRunEvent({
        type: "page",
        search: "java-krakow",
        start: 10,
        cards: 10,
        newOffers: 3,
      }),
    ).toBe("  Page start=10: 10 cards, 3 new");
  });

  it("formats an accepted offer as in the spec", () => {
    expect(
      formatRunEvent({
        type: "offer-judged",
        search: "java-krakow",
        jobId: "1",
        verdict: "accepted",
        reason: "Java backend work.",
        title: "Senior Java Dev",
        company: "Acme",
      }),
    ).toBe("✓ accepted  Senior Java Dev @ Acme");
  });

  it("marks a rejected offer", () => {
    expect(
      formatRunEvent({
        type: "offer-judged",
        search: "java-krakow",
        jobId: "2",
        verdict: "rejected",
        reason: "QA role.",
        title: "QA Engineer",
        company: "Beta",
      }),
    ).toBe("✗ rejected  QA Engineer @ Beta");
  });

  it("marks an unjudged offer and shows why it couldn't be judged", () => {
    expect(
      formatRunEvent({
        type: "offer-judged",
        search: "java-krakow",
        jobId: "3",
        verdict: "unjudged",
        reason: "Request timed out.",
        title: "Java Dev",
        company: "Gamma",
      }),
    ).toBe("? unjudged  Java Dev @ Gamma: Request timed out.");
  });
});

describe("formatAttempt", () => {
  it("shows the URL, status and attempt number", () => {
    expect(
      formatAttempt({
        url: "https://www.linkedin.com/jobs/view/1",
        attempt: 1,
        status: 200,
      }),
    ).toBe("  GET https://www.linkedin.com/jobs/view/1 → 200 (attempt 1)");
  });

  it("shows the error in place of a status", () => {
    expect(
      formatAttempt({
        url: "https://www.linkedin.com/jobs/view/1",
        attempt: 3,
        error: "fetch failed",
      }),
    ).toBe(
      "  GET https://www.linkedin.com/jobs/view/1 → error: fetch failed (attempt 3)",
    );
  });
});

describe("estimateCost", () => {
  it("prices gpt-6-luna at $0.10/1M input and $0.50/1M output", () => {
    expect(
      estimateCost("gpt-6-luna", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        reasoningTokens: 0,
      }),
    ).toBeCloseTo(0.6, 10);
  });

  it("doesn't bill reasoning tokens twice: they're part of the output tokens", () => {
    const withReasoning = estimateCost("gpt-6-luna", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 800_000,
    });
    expect(withReasoning).toBeCloseTo(0.5, 10);
  });

  it("returns null for a model outside the price table", () => {
    expect(estimateCost("gpt-6-sol", noUsage)).toBeNull();
  });
});

describe("formatCost", () => {
  it("shows small amounts to four decimals", () => {
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.03426)).toBe("$0.0343");
  });

  it("shows a dollar or more to two decimals", () => {
    expect(formatCost(1.234)).toBe("$1.23");
    expect(formatCost(0.99996)).toBe("$1.00");
  });

  it("shows zero and tiny amounts sensibly", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.00001)).toBe("<$0.0001");
  });

  it("says cost unknown when there is no price", () => {
    expect(formatCost(null)).toBe("cost unknown");
  });
});

describe("formatSummary", () => {
  const usage: TokenUsage = {
    inputTokens: 180_000,
    outputTokens: 32_600,
    reasoningTokens: 25_000,
  };

  it("prints a block per search with every count, a partial reason, and the totals", () => {
    const text = formatSummary(
      result({
        searches: [
          search("java-krakow", {
            cardsFetched: 30,
            seenSkipped: 5,
            new: 25,
            accepted: 3,
            rejected: 19,
            unjudged: 1,
            removed: 1,
            unfetched: 1,
          }),
          search(
            "ts-remote",
            { cardsFetched: 10, new: 4, accepted: 1, rejected: 3 },
            { reason: "Search page start=10 failed: HTTP 500" },
          ),
        ],
        usage,
      }),
      {
        model: "gpt-6-luna",
        reportPaths: ["out/2026-09-27_1200.md", "out/2026-09-27_1200.html"],
      },
    );
    expect(text).toBe(
      [
        "java-krakow",
        "  cards fetched  30",
        "  seen skipped   5",
        "  new            25",
        "  accepted       3",
        "  rejected       19",
        "  unjudged       1",
        "  removed        1",
        "  unfetched      1",
        "",
        "ts-remote (partial: Search page start=10 failed: HTTP 500)",
        "  cards fetched  10",
        "  seen skipped   0",
        "  new            4",
        "  accepted       1",
        "  rejected       3",
        "  unjudged       0",
        "  removed        0",
        "  unfetched      0",
        "",
        "Total: 180,000 input, 32,600 output (25,000 of them reasoning) tokens, estimated cost $0.0343",
        "Reports: out/2026-09-27_1200.md, out/2026-09-27_1200.html",
        "",
      ].join("\n"),
    );
  });

  it("says why a stopped run stopped and lists the searches that didn't run", () => {
    const text = formatSummary(
      result({
        searches: [search("java-krakow", { cardsFetched: 10, new: 2 })],
        stopped: {
          kind: "rate-limited",
          reason: "LinkedIn kept answering 429",
        },
        notRun: [info("ts-remote"), info("go-warsaw")],
      }),
      { model: "gpt-6-luna", reportPaths: [] },
    );
    expect(text).toContain(
      "Run stopped (rate limited): LinkedIn kept answering 429",
    );
    expect(text).toContain("Didn't run: ts-remote, go-warsaw");
    expect(text.indexOf("Run stopped")).toBeGreaterThan(
      text.indexOf("java-krakow"),
    );
    expect(text.indexOf("Run stopped")).toBeLessThan(text.indexOf("Total:"));
  });

  it("labels an aborted run", () => {
    const text = formatSummary(
      result({
        stopped: { kind: "aborted", reason: "Interrupted by Ctrl-C" },
      }),
      { model: "gpt-6-luna", reportPaths: [] },
    );
    expect(text).toContain("Run stopped (aborted): Interrupted by Ctrl-C");
    expect(text).not.toContain("Didn't run");
  });

  it("labels a dry run at the top", () => {
    const text = formatSummary(
      result({ dryRun: true, searches: [search("java-krakow")] }),
      { model: "gpt-6-luna", reportPaths: ["out/a.md", "out/a.html"] },
    );
    expect(text.startsWith("Dry run: the seen store was not updated.\n")).toBe(
      true,
    );
  });

  it("doesn't label a normal run as a dry run", () => {
    const text = formatSummary(result(), {
      model: "gpt-6-luna",
      reportPaths: [],
    });
    expect(text).not.toContain("Dry run");
  });

  it("says no report was written when there are no report paths", () => {
    const text = formatSummary(result({ searches: [search("java-krakow")] }), {
      model: "gpt-6-luna",
      reportPaths: [],
    });
    expect(text).toContain("No new offers, no report written");
    expect(text).not.toContain("Reports:");
  });

  it("shows cost unknown for a model outside the price table", () => {
    const text = formatSummary(result({ usage }), {
      model: "gpt-6-sol",
      reportPaths: [],
    });
    expect(text).toContain(
      "Total: 180,000 input, 32,600 output (25,000 of them reasoning) tokens, cost unknown",
    );
  });
});
