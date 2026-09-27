import type { TokenUsage } from "../judge/judge.ts";
import type { AttemptEvent } from "../linkedin/client.ts";
import type {
  RunEvent,
  RunResult,
  RunStop,
  SearchCounts,
  SearchResult,
} from "../run/runLoop.ts";

/**
 * Terminal output (spec section 11): pure formatters for the stderr progress
 * lines and the stdout run summary. They return strings without a trailing
 * newline (except the summary, which ends in one); the caller writes them.
 */

/** USD per 1M tokens. */
interface Price {
  input: number;
  output: number;
}

/**
 * Hardcoded prices, from OpenAI's model and pricing pages (see the research
 * on #3). Reasoning tokens are billed as output.
 */
const PRICES: Readonly<Record<string, Price>> = {
  "gpt-6-luna": { input: 0.1, output: 0.5 },
};

/**
 * The estimated cost of `usage` in USD, or `null` when the model isn't in the
 * price table. `outputTokens` is the Responses API's `usage.output_tokens`,
 * which already includes the reasoning tokens (`reasoningTokens` comes from
 * `usage.output_tokens_details.reasoning_tokens`, a breakdown of it), so
 * reasoning is billed as output without being added again.
 */
export function estimateCost(model: string, usage: TokenUsage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (
    (usage.inputTokens * price.input + usage.outputTokens * price.output) /
    1_000_000
  );
}

/** `$0.0042` below a dollar, `$1.23` from a dollar up, `cost unknown` for `null`. */
export function formatCost(cost: number | null): string {
  if (cost === null) return "cost unknown";
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return "<$0.0001";
  const fine = cost.toFixed(4);
  // Decided on the rounded amount, so 0.99996 shows as $1.00, not $1.0000.
  return `$${Number(fine) < 1 ? fine : cost.toFixed(2)}`;
}

const MARKERS = {
  accepted: "✓",
  rejected: "✗",
  unjudged: "?",
} as const;

/** One stderr progress line for a run-loop event. */
export function formatRunEvent(event: RunEvent): string {
  switch (event.type) {
    case "search-start": {
      const { label, criteria } = event.search;
      return (
        `Search ${event.index + 1}/${event.total}: ${label} ` +
        `("${criteria.keywords}" in ${criteria.location}, ` +
        `posted within ${criteria.postedWithin}, ` +
        `up to ${criteria.maxOffers} new offers)`
      );
    }
    case "page":
      return `  Page start=${event.start}: ${event.cards} cards, ${event.newOffers} new`;
    case "offer-judged": {
      const line = `${MARKERS[event.verdict]} ${event.verdict}  ${event.title} @ ${event.company}`;
      // An unjudged offer's reason is the error, worth seeing as it happens.
      return event.verdict === "unjudged" ? `${line}: ${event.reason}` : line;
    }
  }
}

/** One `--verbose` stderr line for a LinkedIn request attempt. */
export function formatAttempt(event: AttemptEvent): string {
  const outcome =
    "status" in event ? String(event.status) : `error: ${event.error}`;
  return `  GET ${event.url} → ${outcome} (attempt ${event.attempt})`;
}

export interface SummaryOptions {
  /** The model the judge used, for the price table. */
  model: string;
  /** The report files written; empty when no report was written. */
  reportPaths: readonly string[];
}

const COUNT_LABELS: ReadonlyArray<readonly [keyof SearchCounts, string]> = [
  ["cardsFetched", "cards fetched"],
  ["seenSkipped", "seen skipped"],
  ["new", "new"],
  ["accepted", "accepted"],
  ["rejected", "rejected"],
  ["unjudged", "unjudged"],
  ["removed", "removed"],
  ["unfetched", "unfetched"],
];
const LABEL_WIDTH = Math.max(...COUNT_LABELS.map(([, label]) => label.length));

function searchBlock(search: SearchResult): string[] {
  const heading = search.partial
    ? `${search.label} (partial: ${search.partial.reason})`
    : search.label;
  return [
    heading,
    ...COUNT_LABELS.map(
      ([key, label]) => `  ${label.padEnd(LABEL_WIDTH)}  ${search.counts[key]}`,
    ),
  ];
}

const STOP_LABELS: Record<NonNullable<RunStop>["kind"], string> = {
  "rate-limited": "rate limited",
  aborted: "aborted",
};

/** Groups thousands with commas, independent of the locale. */
function formatInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The stdout summary of a run, ending in a newline. */
export function formatSummary(
  result: RunResult,
  options: SummaryOptions,
): string {
  const lines: string[] = [];
  if (result.dryRun) lines.push("Dry run: the seen store was not updated.", "");

  for (const search of result.searches) {
    lines.push(...searchBlock(search), "");
  }

  if (result.stopped) {
    lines.push(
      `Run stopped (${STOP_LABELS[result.stopped.kind]}): ${result.stopped.reason}`,
    );
    if (result.notRun.length > 0) {
      lines.push(`Didn't run: ${result.notRun.map((s) => s.label).join(", ")}`);
    }
    lines.push("");
  }

  const { inputTokens, outputTokens, reasoningTokens } = result.usage;
  const cost = estimateCost(options.model, result.usage);
  lines.push(
    `Total: ${formatInt(inputTokens)} input, ${formatInt(outputTokens)} output ` +
      `(${formatInt(reasoningTokens)} of them reasoning) tokens, ` +
      (cost === null ? "cost unknown" : `estimated cost ${formatCost(cost)}`),
  );
  lines.push(
    options.reportPaths.length > 0
      ? `Reports: ${options.reportPaths.join(", ")}`
      : "No new offers, no report written",
  );
  return `${lines.join("\n")}\n`;
}
