import type { PlannedSearch, RunOptions } from "../config/plan.ts";
import type {
  JudgeResult,
  OfferForJudging,
  TokenUsage,
} from "../judge/judge.ts";
import type { LinkedInClient, LinkedInOutcome } from "../linkedin/client.ts";
import { buildDetailUrl, parseDetailPage } from "../linkedin/detailPage.ts";
import { type OfferCard, parseSearchPage } from "../linkedin/searchPage.ts";
import { buildSearchUrl } from "../linkedin/searchUrl.ts";
import {
  type OfferData,
  profileKey,
  type SeenStore,
  type StoredOffer,
  type StoredVerdict,
  type VerdictData,
} from "../store/seenStore.ts";

/**
 * The run loop (spec sections 6 and 9): runs each search in order, pages
 * through its results, handles the offers that are new under its profile
 * (and, with `--all` or `--rejudge`, the seen ones), records them in the
 * seen store and saves the store after each search unless it's a dry run.
 * LinkedIn failures make a search partial or stop the run; either way the
 * loop returns a result rather than throwing.
 */

/** LinkedIn serves 10 cards per page. */
export const PAGE_SIZE = 10;
/** `start=1000` returns 400, so paging stops before it. */
export const MAX_START = 1000;
/** Detail pages that may fail in a row before a search is given up on. */
export const MAX_DETAIL_FAILURES_IN_A_ROW = 3;

/** Why a search or the run stopped when the signal aborted. */
const ABORTED = "The run was aborted.";

/** What a search is: its label, profile and search criteria. */
export interface RunSearchInfo {
  /** The saved search's name (an ad-hoc search is labelled `ad-hoc`). */
  label: string;
  /** The profile as written; verdicts are keyed by `profileKey(profile)`. */
  profile: string;
  criteria: {
    keywords: string;
    location: string;
    postedWithin: string;
    maxOffers: number;
  };
}

/**
 * Per-search counts, for the terminal summary. `new` always equals
 * `accepted + rejected + unjudged + removed + unfetched`: those five count
 * new offers only. Seen offers brought in by `--all` or `--rejudge` have
 * their own counts.
 */
export interface SearchCounts {
  /** Cards on every search page fetched, including seen and repeated ones. */
  cardsFetched: number;
  /**
   * Cards skipped because they were seen under the profile before the run
   * (and neither `--all` nor `--rejudge` brought them in).
   */
  seenSkipped: number;
  /**
   * New offers tried, counting toward `maxOffers`: judged ones plus removed
   * and unfetched ones. A card already handled earlier in this run under the
   * same profile is not counted anywhere but `cardsFetched`.
   */
  new: number;
  /** New offers judged accepted. */
  accepted: number;
  /** New offers judged rejected. */
  rejected: number;
  /** New offers the judge gave no verdict on. */
  unjudged: number;
  /** New offers whose detail page is gone (404). Not recorded or judged. */
  removed: number;
  /**
   * New offers whose detail page couldn't be fetched, including one that hit
   * a persistent 429. Not recorded or judged.
   */
  unfetched: number;
  /** Seen offers included with their stored verdict by `--all`. */
  seenIncluded: number;
  /** Seen unjudged offers `--rejudge` judged again and got accepted. */
  rejudgedAccepted: number;
  /** Seen unjudged offers `--rejudge` judged again and got rejected. */
  rejudgedRejected: number;
  /** Seen unjudged offers `--rejudge` judged again that stayed unjudged. */
  rejudgedUnjudged: number;
}

/** Why a search stopped early, or `null` when it ran to its end. */
export type PartialReason = { reason: string } | null;

/** One search's outcome in the run. */
export interface SearchResult extends RunSearchInfo {
  counts: SearchCounts;
  /**
   * Set when the search gave up partway: a search page failed, 3 detail
   * pages failed in a row, LinkedIn kept rate-limiting, or the run aborted.
   */
  partial: PartialReason;
}

/** How a handled offer got into the run; see `HandledOffer.origin`. */
export type OfferOrigin = "new" | "seen" | "rejudged";

/**
 * Why the whole run stopped before its last search, or `null` when every
 * search ran: LinkedIn kept rate-limiting (a persistent 429) or the signal
 * aborted (Ctrl-C). The search it stopped in is partial (unless it stopped
 * between searches), and the searches after it are in `RunResult.notRun`.
 */
export type RunStop = {
  kind: "rate-limited" | "aborted";
  reason: string;
} | null;

/**
 * One offer handled under one profile: a row in the report. The same job ID
 * handled under two profiles gives two handled offers sharing offer data.
 */
export interface HandledOffer {
  jobId: string;
  /** The profile it was judged against, as written by `foundBy`'s search. */
  profile: string;
  /**
   * How it got into the run: `"new"` (judged for the first time under this
   * profile), `"seen"` (seen before and included by `--all`, with its stored
   * verdict) or `"rejudged"` (a stored unjudged offer judged again by
   * `--rejudge`).
   */
  origin: OfferOrigin;
  /** Card and detail data, as stored (with `firstSeenAt`). */
  offer: StoredOffer;
  /** The verdict as stored: accepted, rejected or unjudged. */
  verdict: StoredVerdict;
  /** Label of the search that handled it. */
  foundBy: string;
  /** Labels of later searches with the same profile key that also found it. */
  alsoFoundBy: string[];
}

/** Everything a run did, for the report model and the terminal summary. */
export interface RunResult {
  startedAt: Date;
  /** The searches that ran (fully or partially), in order. */
  searches: SearchResult[];
  /** The handled offers, in the order they were handled. */
  offers: HandledOffer[];
  /** Token usage summed over every judge call. */
  usage: TokenUsage;
  /** A dry run: the store was never saved. */
  dryRun: boolean;
  /** Set when the run stopped before its last search. */
  stopped: RunStop;
  /** Searches that never started because the run stopped, in order. */
  notRun: RunSearchInfo[];
}

/** Progress, for the stderr lines (formatted by another module). */
export type RunEvent =
  | {
      type: "search-start";
      search: RunSearchInfo;
      /** Zero-based position among the run's searches. */
      index: number;
      total: number;
    }
  | {
      /** A non-empty search page was fetched. */
      type: "page";
      search: string;
      start: number;
      cards: number;
      /** New offers this page contributes toward `maxOffers`. */
      newOffers: number;
    }
  | {
      /** A new offer was judged, or a seen unjudged one was rejudged. */
      type: "offer-judged";
      search: string;
      jobId: string;
      verdict: StoredVerdict["verdict"];
      reason: string;
      title: string;
      company: string;
    };

/** Judges one offer against a profile; bound to the model, client and signal. */
export type JudgeFn = (
  profile: string,
  offer: OfferForJudging,
) => Promise<JudgeResult>;

export interface RunDeps {
  linkedin: LinkedInClient;
  /** Rethrows an abort; any other failure is an unjudged result. */
  judge: JudgeFn;
  /** The model the judge uses; recorded on each verdict. */
  model: string;
  store: SeenStore;
  storePath: string;
  /** Saves the store; `saveSeenStore` in production. */
  save: (store: SeenStore, path: string) => Promise<void>;
  now: () => Date;
  /**
   * Passed to every LinkedIn request, and bound into `judge`. Once it
   * aborts, the run stops and returns what it did.
   */
  signal: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

/**
 * The run flags the loop acts on; a run plan's `options` satisfy it.
 * - `all`: include seen offers with their stored verdict.
 * - `rejudge`: judge seen unjudged offers again from stored data.
 * - `dryRun`: never save the store (it is still updated in memory).
 */
export type RunLoopOptions = Pick<RunOptions, "all" | "rejudge" | "dryRun">;

const emptyCounts = (): SearchCounts => ({
  cardsFetched: 0,
  seenSkipped: 0,
  new: 0,
  accepted: 0,
  rejected: 0,
  unjudged: 0,
  removed: 0,
  unfetched: 0,
  seenIncluded: 0,
  rejudgedAccepted: 0,
  rejudgedRejected: 0,
  rejudgedUnjudged: 0,
});

const REJUDGED_COUNT = {
  accepted: "rejudgedAccepted",
  rejected: "rejudgedRejected",
  unjudged: "rejudgedUnjudged",
} as const satisfies Record<StoredVerdict["verdict"], keyof SearchCounts>;

function infoOf(search: PlannedSearch): RunSearchInfo {
  return {
    label: search.label,
    profile: search.profile,
    criteria: {
      keywords: search.keywords,
      location: search.location,
      postedWithin: search.postedWithin,
      maxOffers: search.maxOffers,
    },
  };
}

/**
 * Gives up on the current search. Thrown inside a search and caught by
 * `runSearches`; `stopsRun` also stops the run (a persistent 429).
 */
class SearchGaveUp extends Error {
  readonly stopsRun: boolean;
  constructor(reason: string, stopsRun: boolean) {
    super(reason);
    this.name = "SearchGaveUp";
    this.stopsRun = stopsRun;
  }
}

/**
 * Runs the searches in order and returns what the run did. A partial
 * search, a persistent 429 or an abort is recorded in the result rather
 * than thrown; the store is still saved after the search it happened in
 * (unless it's a dry run). Anything else thrown is a bug and propagates.
 */
export async function runSearches(
  searches: readonly PlannedSearch[],
  deps: RunDeps,
  options: RunLoopOptions,
): Promise<RunResult> {
  const result: RunResult = {
    startedAt: deps.now(),
    searches: [],
    offers: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    dryRun: options.dryRun,
    stopped: null,
    notRun: [],
  };
  const state: RunState = {
    result,
    tried: new Map(),
    failedDetails: new Map(),
  };

  for (const [index, search] of searches.entries()) {
    if (deps.signal.aborted) {
      // Aborted between searches: none of the rest start.
      result.stopped = { kind: "aborted", reason: ABORTED };
      result.notRun = searches.slice(index).map(infoOf);
      break;
    }
    const info = infoOf(search);
    deps.onEvent?.({
      type: "search-start",
      search: info,
      index,
      total: searches.length,
    });
    const searchResult: SearchResult = {
      ...info,
      counts: emptyCounts(),
      partial: null,
    };
    result.searches.push(searchResult);

    try {
      await runSearch(search, searchResult, deps, options, state);
    } catch (error) {
      if (error instanceof SearchGaveUp) {
        searchResult.partial = { reason: error.message };
        if (error.stopsRun) {
          result.stopped = { kind: "rate-limited", reason: error.message };
        }
      } else if (deps.signal.aborted) {
        searchResult.partial = { reason: ABORTED };
        result.stopped = { kind: "aborted", reason: ABORTED };
      } else {
        throw error;
      }
    }

    if (!options.dryRun) await deps.save(deps.store, deps.storePath);
    if (result.stopped) {
      result.notRun = searches.slice(index + 1).map(infoOf);
      break;
    }
  }
  return result;
}

/** What the run remembers across its searches. */
interface RunState {
  result: RunResult;
  /**
   * Profile key -> job ID -> the offer handled under it in this run, or
   * `null` when it was tried but its detail gave no data (removed or
   * unfetched). Either way it isn't tried again under that profile.
   */
  tried: Map<string, Map<string, HandledOffer | null>>;
  /** Job IDs whose detail fetch failed this run, so it isn't fetched again. */
  failedDetails: Map<string, "removed" | "unfetched">;
}

/** What one search is working on, besides the run's state. */
interface SearchContext {
  search: PlannedSearch;
  counts: SearchCounts;
  deps: RunDeps;
  state: RunState;
  /** Detail pages fetched by this search that failed in a row. */
  detailFailuresInARow: number;
}

/** What to do with one card of a search page. */
type Work =
  | { kind: "new"; card: OfferCard }
  | { kind: "seen" | "rejudge"; card: OfferCard; offer: StoredOffer };

async function runSearch(
  search: PlannedSearch,
  searchResult: SearchResult,
  deps: RunDeps,
  options: RunLoopOptions,
  state: RunState,
): Promise<void> {
  const { counts } = searchResult;
  const context: SearchContext = {
    search,
    counts,
    deps,
    state,
    detailFailuresInARow: 0,
  };
  const key = profileKey(search.profile);
  const triedHere =
    state.tried.get(key) ?? new Map<string, HandledOffer | null>();
  state.tried.set(key, triedHere);

  for (let start = 0; start < MAX_START; start += PAGE_SIZE) {
    if (counts.new >= search.maxOffers) break;

    const outcome = await deps.linkedin.get(
      buildSearchUrl(search, start),
      deps.signal,
    );
    if (outcome.kind === "rate-limited") {
      throw new SearchGaveUp(
        `LinkedIn kept rate-limiting the search page at start=${start}`,
        true,
      );
    }
    if (outcome.kind !== "ok") {
      const why = outcome.kind === "failed" ? outcome.reason : "HTTP 404";
      throw new SearchGaveUp(
        `Search page start=${start} failed: ${why}`,
        false,
      );
    }

    const cards = parseSearchPage(outcome.body);
    if (cards.length === 0) break;
    counts.cardsFetched += cards.length;

    const work = planPage(cards, triedHere, context, options);
    const newOffers = work.filter((item) => item.kind === "new").length;
    deps.onEvent?.({
      type: "page",
      search: search.label,
      start,
      cards: cards.length,
      newOffers,
    });

    for (const item of work) {
      const handled =
        item.kind === "new"
          ? await handleNewOffer(item.card, context)
          : item.kind === "rejudge"
            ? await rejudgeOffer(item.card, item.offer, context)
            : includeSeenOffer(item.card, item.offer, context);
      triedHere.set(item.card.jobId, handled);
    }
  }
}

/**
 * Decides, card by card in page order, what to do with a page's cards:
 * repeats in this run under the profile gain "also found by", seen offers
 * are skipped or (with the flags) brought in, and new offers are queued up
 * to `maxOffers`. New cards beyond it are skipped, but the rest of the page
 * is still looked at, since repeats and seen offers don't count toward it.
 */
function planPage(
  cards: readonly OfferCard[],
  triedHere: Map<string, HandledOffer | null>,
  { search, counts, deps }: SearchContext,
  options: RunLoopOptions,
): Work[] {
  const work: Work[] = [];
  const queued = new Set<string>();
  let newQueued = 0;

  for (const card of cards) {
    // Already tried in this run under this profile: checked before the
    // store, which by now holds a handled offer's verdict.
    if (triedHere.has(card.jobId)) {
      const earlier = triedHere.get(card.jobId);
      if (
        earlier &&
        earlier.foundBy !== search.label &&
        !earlier.alsoFoundBy.includes(search.label)
      ) {
        earlier.alsoFoundBy.push(search.label);
      }
      continue;
    }
    if (queued.has(card.jobId)) continue;

    const stored = deps.store.getVerdict(search.profile, card.jobId);
    if (stored) {
      const kind =
        options.rejudge && stored.verdict === "unjudged"
          ? "rejudge"
          : options.all
            ? "seen"
            : null;
      // A verdict without offer data can't be shown or rejudged.
      const offer = kind && deps.store.getOffer(card.jobId);
      if (!kind || !offer) {
        counts.seenSkipped++;
        continue;
      }
      queued.add(card.jobId);
      work.push({ kind, card, offer });
      continue;
    }

    if (counts.new + newQueued >= search.maxOffers) continue;
    queued.add(card.jobId);
    newQueued++;
    work.push({ kind: "new", card });
  }
  return work;
}

/**
 * Fetches (unless known), judges and records one new offer. Returns `null`
 * when its detail gave no data (removed or unfetched). The offer is counted
 * once its outcome is known, so one cut short by an abort isn't.
 */
async function handleNewOffer(
  card: OfferCard,
  context: SearchContext,
): Promise<HandledOffer | null> {
  const { deps, state, counts } = context;
  const { store } = deps;
  // Stored data covers offers seen in earlier runs and offers fetched
  // earlier in this run (they are recorded right after the fetch), and a
  // failed fetch is remembered for the run, so each job ID's detail page is
  // fetched at most once per run.
  if (!store.hasOffer(card.jobId)) {
    const failed = state.failedDetails.get(card.jobId);
    if (failed) {
      counts.new++;
      counts[failed]++;
      return null;
    }
    const outcome = await deps.linkedin.get(
      buildDetailUrl(card.jobId),
      deps.signal,
    );
    if (outcome.kind !== "ok") {
      recordDetailFailure(card.jobId, outcome, context);
      return null;
    }
    context.detailFailuresInARow = 0;
    store.recordOffer(
      card.jobId,
      mergeOffer(card, parseDetailPage(outcome.body)),
    );
  }
  const offer = store.getOffer(card.jobId) as StoredOffer;

  const verdict = await judgeAndRecord(card.jobId, offer, context);
  counts.new++;
  counts[verdict.verdict]++;
  return addHandled(card.jobId, offer, verdict, "new", context);
}

/**
 * Counts a failed detail fetch and applies the failure rules. A 404 is
 * "removed": LinkedIn answered, so it starts the in-a-row count again
 * rather than adding to it. Any other failure is "unfetched" and adds to
 * it; the third in a row gives up on the search. A persistent 429 stops
 * the run.
 */
function recordDetailFailure(
  jobId: string,
  outcome: Exclude<LinkedInOutcome, { kind: "ok" }>,
  context: SearchContext,
): void {
  const { counts, state } = context;
  counts.new++;
  if (outcome.kind === "not-found") {
    state.failedDetails.set(jobId, "removed");
    counts.removed++;
    context.detailFailuresInARow = 0;
    return;
  }
  counts.unfetched++;
  if (outcome.kind === "rate-limited") {
    throw new SearchGaveUp(
      `LinkedIn kept rate-limiting the detail page of offer ${jobId}`,
      true,
    );
  }
  state.failedDetails.set(jobId, "unfetched");
  context.detailFailuresInARow++;
  if (context.detailFailuresInARow >= MAX_DETAIL_FAILURES_IN_A_ROW) {
    throw new SearchGaveUp(
      `${MAX_DETAIL_FAILURES_IN_A_ROW} detail pages in a row failed; the last: ${outcome.reason}`,
      false,
    );
  }
}

/**
 * Judges a seen unjudged offer again from its stored data (`--rejudge`).
 * The new verdict replaces the unjudged one, even when it is unjudged too.
 */
async function rejudgeOffer(
  card: OfferCard,
  offer: StoredOffer,
  context: SearchContext,
): Promise<HandledOffer> {
  const verdict = await judgeAndRecord(card.jobId, offer, context);
  context.counts[REJUDGED_COUNT[verdict.verdict]]++;
  return addHandled(card.jobId, offer, verdict, "rejudged", context);
}

/** Includes a seen offer with its stored verdict, untouched (`--all`). */
function includeSeenOffer(
  card: OfferCard,
  offer: StoredOffer,
  context: SearchContext,
): HandledOffer {
  const { search, deps, counts } = context;
  const verdict = deps.store.getVerdict(
    search.profile,
    card.jobId,
  ) as StoredVerdict;
  counts.seenIncluded++;
  return addHandled(card.jobId, offer, verdict, "seen", context);
}

/** Judges an offer under the search's profile and records the verdict. */
async function judgeAndRecord(
  jobId: string,
  offer: StoredOffer,
  { search, deps, state }: SearchContext,
): Promise<StoredVerdict> {
  const judged = await deps.judge(search.profile, {
    title: offer.title,
    company: offer.company,
    location: offer.location,
    description: offer.description,
  });
  addUsage(state.result.usage, judged.usage);
  deps.store.recordVerdict(
    search.profile,
    jobId,
    toVerdictData(judged, deps.model),
  );
  const verdict = deps.store.getVerdict(search.profile, jobId) as StoredVerdict;
  deps.onEvent?.({
    type: "offer-judged",
    search: search.label,
    jobId,
    verdict: verdict.verdict,
    reason: verdict.reason,
    title: offer.title,
    company: offer.company,
  });
  return verdict;
}

function addHandled(
  jobId: string,
  offer: StoredOffer,
  verdict: StoredVerdict,
  origin: OfferOrigin,
  { search, state }: SearchContext,
): HandledOffer {
  const handled: HandledOffer = {
    jobId,
    profile: search.profile,
    origin,
    offer,
    verdict,
    foundBy: search.label,
    alsoFoundBy: [],
  };
  state.result.offers.push(handled);
  return handled;
}

function mergeOffer(
  card: OfferCard,
  detail: ReturnType<typeof parseDetailPage>,
): OfferData {
  return {
    title: card.title,
    company: card.company,
    location: card.location,
    postedDate: card.postedDate,
    salary: detail.salary,
    employmentType: detail.employmentType,
    jobFunction: detail.jobFunction,
    industries: detail.industries,
    description: detail.description,
  };
}

function toVerdictData(judged: JudgeResult, model: string): VerdictData {
  return judged.outcome === "judged"
    ? { ...judged.verdict, model }
    : { verdict: "unjudged", reason: judged.reason, model };
}

function addUsage(total: TokenUsage, usage: TokenUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.reasoningTokens += usage.reasoningTokens;
}
