import { setTimeout as delay } from "node:timers/promises";

/** Fixed wait before each LinkedIn request (spec section 6). */
export const PACING_MS = 1000;
/** How long one attempt, including reading the body, may take. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Base waits before the 1st, 2nd and 3rd retry; jitter is added on top. */
const BACKOFF_MS = [2000, 4000, 8000] as const;
const JITTER_MS = 1000;
/** A 429 asking for a longer wait than this is treated as rate limited. */
const MAX_RETRY_AFTER_MS = 60_000;

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** How one LinkedIn request ended, after pacing and retries. */
export type LinkedInOutcome =
  | { kind: "ok"; body: string }
  /** 404: the offer was removed. Never retried. */
  | { kind: "not-found" }
  /** Retries exhausted on a network error, timeout or 5xx, or a non-retryable 4xx. */
  | { kind: "failed"; reason: string }
  /** Still 429 after retries, or a Retry-After too long to wait. */
  | { kind: "rate-limited" };

/** One attempt as seen by the `onAttempt` hook; `attempt` starts at 1. */
export type AttemptEvent =
  | { url: string; attempt: number; status: number }
  | { url: string; attempt: number; error: string };

export interface LinkedInClientDeps {
  fetch?: typeof fetch;
  /** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Returns a number in [0, 1), like `Math.random`. */
  random?: () => number;
  onAttempt?: (event: AttemptEvent) => void;
}

export interface LinkedInClient {
  /**
   * GETs `url` politely. Resolves to an outcome for every HTTP result;
   * rejects only with the signal's reason when `signal` aborts.
   */
  get(url: string, signal?: AbortSignal): Promise<LinkedInOutcome>;
}

type AttemptResult =
  | { status: number; body: string; retryAfter: string | null }
  | { error: string };

const TIMED_OUT = Symbol("timed out");

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, signal ? { signal } : {});
  } catch (error) {
    // Node wraps the reason in an AbortError; surface the reason itself.
    signal?.throwIfAborted();
    throw error;
  }
}

/** Waits for `turn`, or rejects with the signal's reason if it aborts first. */
async function waitTurn(
  turn: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await turn;
    return;
  }
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([turn, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return error.message + cause;
}

/** Parses a delay-seconds `Retry-After`; HTTP dates fall back to the backoff. */
function retryAfterMs(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Number(header.trim()) * 1000;
}

/**
 * Creates the client every LinkedIn GET goes through. Requests run one at a
 * time: each waits PACING_MS, then up to 4 attempts with backoff between
 * them. fetch, sleep and randomness are injectable for tests.
 */
export function createLinkedInClient(
  deps: LinkedInClientDeps = {},
): LinkedInClient {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const onAttempt = deps.onAttempt;

  async function attempt(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<AttemptResult> {
    const attemptController = new AbortController();
    const attemptSignal = signal
      ? AbortSignal.any([signal, attemptController.signal])
      : attemptController.signal;
    const request = fetchFn(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: attemptSignal,
    }).then(async (response) => ({
      status: response.status,
      body: await response.text(),
      retryAfter: response.headers.get("Retry-After"),
    }));
    const timeout = sleep(REQUEST_TIMEOUT_MS, attemptSignal).then(
      (): typeof TIMED_OUT => TIMED_OUT,
    );
    try {
      const result = await Promise.race([request, timeout]);
      return result === TIMED_OUT ? { error: "timeout" } : result;
    } catch (error) {
      signal?.throwIfAborted();
      return { error: describeError(error) };
    } finally {
      // Cancels the losing side: the timer, or the timed-out request.
      attemptController.abort();
    }
  }

  async function request(
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<LinkedInOutcome> {
    signal?.throwIfAborted();
    await sleep(PACING_MS, signal);

    for (let n = 1; ; n++) {
      const result = await attempt(url, signal);
      onAttempt?.(
        "error" in result
          ? { url, attempt: n, error: result.error }
          : { url, attempt: n, status: result.status },
      );

      let wait: number | null = null;
      if ("status" in result) {
        const { status } = result;
        if (status >= 200 && status < 300) {
          return { kind: "ok", body: result.body };
        }
        if (status === 404) return { kind: "not-found" };
        if (status === 429) {
          wait = retryAfterMs(result.retryAfter);
          if (wait !== null && wait > MAX_RETRY_AFTER_MS) {
            return { kind: "rate-limited" };
          }
        } else if (status < 500) {
          return { kind: "failed", reason: `HTTP ${status}` };
        }
      }

      const backoff = BACKOFF_MS[n - 1];
      if (backoff === undefined) {
        if ("error" in result) return { kind: "failed", reason: result.error };
        return result.status === 429
          ? { kind: "rate-limited" }
          : { kind: "failed", reason: `HTTP ${result.status}` };
      }
      await sleep(wait ?? backoff + Math.floor(random() * JITTER_MS), signal);
    }
  }

  // Each request waits for the one before it. A request aborted while queued
  // rejects at once, but the next one still waits for everything ahead.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    get(url, signal) {
      const turn = queue;
      const outcome = waitTurn(turn, signal).then(() => request(url, signal));
      queue = Promise.allSettled([turn, outcome]);
      return outcome;
    },
  };
}
