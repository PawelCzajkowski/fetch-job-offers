import type { HandledOffer, RunResult } from "../run/runLoop.ts";
import type { JudgedVerdict, StoredVerdict } from "../store/seenStore.ts";

/**
 * The report model (spec section 10): a pure transformation from a run result
 * to the rows, counts and header that both the Markdown and the HTML report
 * render, plus the flags the file writer needs. It never reads the clock or
 * the file system, and never shows cost.
 */

export type ReportVerdict = StoredVerdict["verdict"];
export type ReportWorkMode = JudgedVerdict["workMode"];
export type ReportSeniority = JudgedVerdict["seniority"];

/**
 * One row: an offer handled under one profile. The same job ID under two
 * profiles gives two rows; searches sharing a profile are already merged
 * into `alsoFoundBy` by the run loop. Seen offers included by `--all` look
 * exactly like new ones: they carry their stored verdict and no marker.
 */
export interface ReportRow {
  /**
   * Unique among the model's rows, for anchors and DOM keys: the job ID, or
   * `<jobId>-<n>` for its n-th row (n ≥ 2, in handled order) when the same
   * job ID was handled under several profiles.
   */
  rowId: string;
  jobId: string;
  /** `https://www.linkedin.com/jobs/view/<jobId>` */
  url: string;
  title: string;
  company: string;
  location: string;
  /** ISO date (`YYYY-MM-DD`). */
  postedDate: string;
  salary: string | null;
  employmentType: string | null;
  jobFunction: string | null;
  industries: string | null;
  verdict: ReportVerdict;
  /** The verdict's reason, or the error for an unjudged offer. */
  reason: string;
  /** `null` when not stated, and always for an unjudged offer. */
  workMode: ReportWorkMode;
  /** `null` when not stated, and always for an unjudged offer. */
  seniority: ReportSeniority;
  /** Empty for an unjudged offer. */
  techStack: string[];
  /** Label of the search that handled it. */
  foundBy: string;
  /** Labels of later searches with the same profile that also found it. */
  alsoFoundBy: string[];
  /**
   * The description split on line breaks. Lines starting with `- ` are
   * bullets; an empty line separates paragraphs. Empty for no description.
   */
  descriptionLines: string[];
}

/** One header line per search that ran. */
export interface ReportSearch {
  label: string;
  keywords: string;
  location: string;
  postedWithin: string;
  profile: string;
}

export interface ReportCounts {
  /** Every row, including seen ones shown by `--all`. */
  rows: number;
  /** Rows judged or rejudged in this run (origin other than `"seen"`). */
  new: number;
  accepted: number;
  rejected: number;
  unjudged: number;
}

export interface ReportModel {
  /** When the run started; renderers format it (local time). */
  startedAt: Date;
  /** The searches that ran, in order. Partial ones aren't marked. */
  searches: ReportSearch[];
  counts: ReportCounts;
  /** The HTML default order: newest posted first. */
  rowsNewestFirst: ReportRow[];
  /** The Markdown order: accepted, unjudged, rejected, then newest first. */
  rowsByVerdict: ReportRow[];
  /** `false` means no report files are written at all. */
  hasRows: boolean;
  /**
   * The run judged or rejudged at least one offer (a row not carried over
   * from the store by `--all`). `latest.*` is replaced only when this holds
   * and the run isn't a dry run.
   */
  judgedAny: boolean;
  dryRun: boolean;
}

export const linkedInJobUrl = (jobId: string): string =>
  `https://www.linkedin.com/jobs/view/${jobId}`;

const VERDICT_RANK: Record<ReportVerdict, number> = {
  accepted: 0,
  unjudged: 1,
  rejected: 2,
};

// Plain code-unit comparison, so the order doesn't depend on the locale.
const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Newest posted first, then title, job ID and search label. Two rows can't
 * share a job ID and a search label (a search has one profile), so the
 * order is total and independent of the handled order.
 */
function compareNewestFirst(a: ReportRow, b: ReportRow): number {
  return (
    compareText(b.postedDate, a.postedDate) ||
    compareText(a.title, b.title) ||
    compareText(a.jobId, b.jobId) ||
    compareText(a.foundBy, b.foundBy)
  );
}

function compareByVerdict(a: ReportRow, b: ReportRow): number {
  return (
    VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
    compareNewestFirst(a, b)
  );
}

function descriptionLines(description: string): string[] {
  return description === "" ? [] : description.split(/\r?\n/);
}

function toRow(handled: HandledOffer, rowId: string): ReportRow {
  const { offer, verdict } = handled;
  const judged = verdict.verdict === "unjudged" ? null : verdict;
  return {
    rowId,
    jobId: handled.jobId,
    url: linkedInJobUrl(handled.jobId),
    title: offer.title,
    company: offer.company,
    location: offer.location,
    postedDate: offer.postedDate,
    salary: offer.salary,
    employmentType: offer.employmentType,
    jobFunction: offer.jobFunction,
    industries: offer.industries,
    verdict: verdict.verdict,
    reason: verdict.reason,
    workMode: judged?.workMode ?? null,
    seniority: judged?.seniority ?? null,
    techStack: judged ? [...judged.techStack] : [],
    foundBy: handled.foundBy,
    alsoFoundBy: [...handled.alsoFoundBy],
    descriptionLines: descriptionLines(offer.description),
  };
}

export function buildReportModel(run: RunResult): ReportModel {
  const timesSeen = new Map<string, number>();
  const rows = run.offers.map((handled) => {
    const n = (timesSeen.get(handled.jobId) ?? 0) + 1;
    timesSeen.set(handled.jobId, n);
    return toRow(handled, n === 1 ? handled.jobId : `${handled.jobId}-${n}`);
  });

  const newRows = run.offers.filter((o) => o.origin !== "seen").length;
  const countOf = (verdict: ReportVerdict) =>
    rows.filter((row) => row.verdict === verdict).length;

  return {
    startedAt: new Date(run.startedAt.getTime()),
    searches: run.searches.map((search) => ({
      label: search.label,
      keywords: search.criteria.keywords,
      location: search.criteria.location,
      postedWithin: search.criteria.postedWithin,
      profile: search.profile,
    })),
    counts: {
      rows: rows.length,
      new: newRows,
      accepted: countOf("accepted"),
      rejected: countOf("rejected"),
      unjudged: countOf("unjudged"),
    },
    rowsNewestFirst: [...rows].sort(compareNewestFirst),
    rowsByVerdict: [...rows].sort(compareByVerdict),
    hasRows: rows.length > 0,
    judgedAny: newRows > 0,
    dryRun: run.dryRun,
  };
}
