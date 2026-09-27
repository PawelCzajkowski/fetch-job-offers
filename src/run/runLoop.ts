import type { SavedSearch } from "../config/schema.ts";
import type {
  JudgeResult,
  OfferForJudging,
  TokenUsage,
} from "../judge/judge.ts";
import type { LinkedInClient } from "../linkedin/client.ts";
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
 * The run loop (spec section 9, steps 1–4): runs each search in order, pages
 * through its results, handles the offers that are new under its profile,
 * records them in the seen store and saves the store after each search.
 * Flags (`--all`, `--rejudge`, `--dry-run`) and the failure rules (partial
 * searches, the 429 stop, abort) belong to #23; the seams are marked.
 */

/** LinkedIn serves 10 cards per page. */
export const PAGE_SIZE = 10;
/** `start=1000` returns 400, so paging stops before it. */
export const MAX_START = 1000;

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

/** Per-search counts, for the terminal summary. */
export interface SearchCounts {
  /** Cards on every search page fetched, including seen and repeated ones. */
  cardsFetched: number;
  /** Cards skipped because they were seen under the profile before the run. */
  seenSkipped: number;
  /**
   * New offers tried, counting toward `maxOffers`: judged ones plus removed
   * and unfetched ones. A card already handled earlier in this run under the
   * same profile is not counted anywhere but `cardsFetched`.
   */
  new: number;
  accepted: number;
  rejected: number;
  unjudged: number;
  /** New offers whose detail page is gone (404). Not recorded or judged. */
  removed: number;
  /** New offers whose detail page couldn't be fetched. Not recorded or judged. */
  unfetched: number;
}

/** Why a search stopped early, or `null` when it ran to its end. */
export type PartialReason = { reason: string } | null;

/** One search's outcome in the run. */
export interface SearchResult extends RunSearchInfo {
  counts: SearchCounts;
  /** Set when the search gave up partway (the failure rules are #23's). */
  partial: PartialReason;
}

/**
 * One offer handled under one profile: a row in the report. The same job ID
 * handled under two profiles gives two handled offers sharing offer data.
 */
export interface HandledOffer {
  jobId: string;
  /** The profile it was judged against, as written by `foundBy`'s search. */
  profile: string;
  /**
   * How it got into the run. This ticket only produces `"new"`; #23 adds
   * seen offers included by `--all` and ones rejudged by `--rejudge`.
   */
  origin: "new";
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
  /** The searches that ran, in order. */
  searches: SearchResult[];
  /** The handled offers, in the order they were handled. */
  offers: HandledOffer[];
  /** Token usage summed over every judge call. */
  usage: TokenUsage;
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
  judge: JudgeFn;
  /** The model the judge uses; recorded on each verdict. */
  model: string;
  store: SeenStore;
  storePath: string;
  /** Saves the store; `saveSeenStore` in production. */
  save: (store: SeenStore, path: string) => Promise<void>;
  now: () => Date;
  /** Passed to every LinkedIn request. */
  signal: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

const emptyCounts = (): SearchCounts => ({
  cardsFetched: 0,
  seenSkipped: 0,
  new: 0,
  accepted: 0,
  rejected: 0,
  unjudged: 0,
  removed: 0,
  unfetched: 0,
});

function infoOf(search: SavedSearch): RunSearchInfo {
  return {
    label: search.name,
    profile: search.profile,
    criteria: {
      keywords: search.keywords,
      location: search.location,
      postedWithin: search.postedWithin,
      maxOffers: search.maxOffers,
    },
  };
}

/** Runs the searches in order and returns what the run did. */
export async function runSearches(
  searches: readonly SavedSearch[],
  deps: RunDeps,
): Promise<RunResult> {
  const result: RunResult = {
    startedAt: deps.now(),
    searches: [],
    offers: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  };
  const state: RunState = {
    result,
    tried: new Map(),
    failedDetails: new Map(),
  };

  for (const [index, search] of searches.entries()) {
    const info = infoOf(search);
    deps.onEvent?.({
      type: "search-start",
      search: info,
      index,
      total: searches.length,
    });
    const searchResult = await runSearch(search, info, deps, state);
    result.searches.push(searchResult);
    // TODO(#23): skip the save on --dry-run.
    await deps.save(deps.store, deps.storePath);
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

async function runSearch(
  search: SavedSearch,
  info: RunSearchInfo,
  deps: RunDeps,
  state: RunState,
): Promise<SearchResult> {
  const counts = emptyCounts();
  const searchResult: SearchResult = { ...info, counts, partial: null };
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
    if (outcome.kind !== "ok") {
      // TODO(#23): the partial-search and 429 stop rules. For now a failed
      // page simply ends this search.
      const why =
        outcome.kind === "failed"
          ? outcome.reason
          : outcome.kind === "rate-limited"
            ? "rate limited"
            : "not found";
      searchResult.partial = {
        reason: `Search page start=${start} failed: ${why}`,
      };
      break;
    }

    const cards = parseSearchPage(outcome.body);
    if (cards.length === 0) break;
    counts.cardsFetched += cards.length;

    const toTry: OfferCard[] = [];
    for (const card of cards) {
      // Already tried in this run under this profile: checked before the
      // store, which by now holds a handled offer's verdict.
      if (triedHere.has(card.jobId)) {
        const earlier = triedHere.get(card.jobId);
        if (
          earlier &&
          earlier.foundBy !== info.label &&
          !earlier.alsoFoundBy.includes(info.label)
        ) {
          earlier.alsoFoundBy.push(info.label);
        }
        continue;
      }
      if (toTry.some((c) => c.jobId === card.jobId)) continue;
      // TODO(#23): --all and --rejudge change what happens to seen offers.
      if (deps.store.isSeen(search.profile, card.jobId)) {
        counts.seenSkipped++;
        continue;
      }
      if (counts.new + toTry.length >= search.maxOffers) break;
      toTry.push(card);
    }

    deps.onEvent?.({
      type: "page",
      search: info.label,
      start,
      cards: cards.length,
      newOffers: toTry.length,
    });

    for (const card of toTry) {
      counts.new++;
      triedHere.set(
        card.jobId,
        await handleOffer(card, search, info, deps, state, counts),
      );
    }
  }
  return searchResult;
}

/** Fetches (unless known), judges and records one new offer. */
async function handleOffer(
  card: OfferCard,
  search: SavedSearch,
  info: RunSearchInfo,
  deps: RunDeps,
  state: RunState,
  counts: SearchCounts,
): Promise<HandledOffer | null> {
  const { store } = deps;
  const run = state.result;
  // Stored data covers offers seen in earlier runs and offers fetched
  // earlier in this run (they are recorded right after the fetch), and a
  // failed fetch is remembered for the run, so each job ID's detail page is
  // fetched at most once per run.
  if (!store.hasOffer(card.jobId)) {
    const failed = state.failedDetails.get(card.jobId);
    if (failed) {
      counts[failed]++;
      return null;
    }
    const outcome = await deps.linkedin.get(
      buildDetailUrl(card.jobId),
      deps.signal,
    );
    if (outcome.kind !== "ok") {
      // TODO(#23): three failures in a row make the search partial, and a
      // rate-limited outcome stops the run.
      const failure = outcome.kind === "not-found" ? "removed" : "unfetched";
      state.failedDetails.set(card.jobId, failure);
      counts[failure]++;
      return null;
    }
    store.recordOffer(
      card.jobId,
      mergeOffer(card, parseDetailPage(outcome.body)),
    );
  }
  const offer = store.getOffer(card.jobId) as StoredOffer;

  const judged = await deps.judge(search.profile, {
    title: offer.title,
    company: offer.company,
    location: offer.location,
    description: offer.description,
  });
  addUsage(run.usage, judged.usage);
  store.recordVerdict(
    search.profile,
    card.jobId,
    toVerdictData(judged, deps.model),
  );
  const verdict = store.getVerdict(search.profile, card.jobId) as StoredVerdict;
  counts[verdict.verdict]++;

  const handled: HandledOffer = {
    jobId: card.jobId,
    profile: search.profile,
    origin: "new",
    offer,
    verdict,
    foundBy: info.label,
    alsoFoundBy: [],
  };
  run.offers.push(handled);
  deps.onEvent?.({
    type: "offer-judged",
    search: info.label,
    jobId: card.jobId,
    verdict: verdict.verdict,
    reason: verdict.reason,
    title: offer.title,
    company: offer.company,
  });
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
