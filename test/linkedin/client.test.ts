import { describe, expect, it } from "vitest";
import {
  type AttemptEvent,
  createLinkedInClient,
  PACING_MS,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
} from "../../src/linkedin/client.ts";

const URL_A = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1";
const URL_B = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/2";

/** One scripted fetch result: a response, a network error, or a hang. */
type Step =
  | { status: number; body?: string; headers?: Record<string, string> }
  | "network-error"
  | "hang";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Rejects with the signal's reason once it aborts; never resolves. */
function untilAborted(signal: AbortSignal | undefined | null): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function fakeFetch(steps: Step[]) {
  const calls: FetchCall[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(input), init });
    const step = steps.shift();
    if (step === undefined) throw new Error("fake fetch ran out of steps");
    if (step === "network-error") throw new TypeError("fetch failed");
    if (step === "hang") return untilAborted(init?.signal);
    return new Response(step.body ?? "", {
      status: step.status,
      headers: step.headers ?? {},
    });
  };
  return { fetch, calls };
}

/**
 * Records every requested delay except the request timeout. Waits resolve at
 * once. The timeout fires only when `timeoutFires` says so, and only after any
 * scripted response has settled; otherwise it waits for its signal (the
 * client aborts it once the attempt settles).
 */
function fakeSleep(options: { timeoutFires?: boolean } = {}) {
  const delays: number[] = [];
  const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (ms !== REQUEST_TIMEOUT_MS) delays.push(ms);
    signal?.throwIfAborted();
    if (ms !== REQUEST_TIMEOUT_MS) return;
    if (!options.timeoutFires) await untilAborted(signal);
    // Fire on the next macrotask, so a scripted response still wins the race.
    await new Promise((resolve) => setImmediate(resolve));
    signal?.throwIfAborted();
  };
  return { sleep, delays };
}

function setup(
  steps: Step[],
  options: { timeoutFires?: boolean; random?: number } = {},
) {
  const { fetch, calls } = fakeFetch(steps);
  const { sleep, delays } = fakeSleep(options);
  const attempts: AttemptEvent[] = [];
  const client = createLinkedInClient({
    fetch,
    sleep,
    random: () => options.random ?? 0,
    onAttempt: (event) => attempts.push(event),
  });
  return { client, calls, delays, attempts };
}

describe("createLinkedInClient", () => {
  it("waits the pacing delay, then returns the body as ok", async () => {
    const { client, calls, delays } = setup([
      { status: 200, body: "<html>offer</html>" },
    ]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "ok", body: "<html>offer</html>" });
    expect(delays).toEqual([PACING_MS]);
    expect(PACING_MS).toBe(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_A);
  });

  it("sends a desktop browser User-Agent", async () => {
    const { client, calls } = setup([{ status: 200 }]);

    await client.get(URL_A);

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("User-Agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
  });

  it("retries 5xx with 2, 4 and 8 s backoff, then succeeds", async () => {
    const { client, calls, delays } = setup([
      { status: 500 },
      { status: 502 },
      { status: 503 },
      { status: 200, body: "finally" },
    ]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "ok", body: "finally" });
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([PACING_MS, 2000, 4000, 8000]);
  });

  it("adds jitter from the injected randomness to each backoff", async () => {
    const { client, delays } = setup(
      [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }],
      { random: 0.5 },
    );

    await client.get(URL_A);

    expect(delays).toEqual([PACING_MS, 2500, 4500, 8500]);
  });

  it("fails after 3 retries of 5xx", async () => {
    const { client, calls } = setup([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 503 },
    ]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "failed", reason: "HTTP 503" });
    expect(calls).toHaveLength(4);
  });

  it("retries network errors and fails once they are exhausted", async () => {
    const { client, calls } = setup([
      "network-error",
      "network-error",
      "network-error",
      "network-error",
    ]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "failed", reason: "fetch failed" });
    expect(calls).toHaveLength(4);
  });

  it("times out a hanging request, aborts it and retries", async () => {
    const { client, calls } = setup(["hang", { status: 200, body: "ok" }], {
      timeoutFires: true,
    });

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "ok", body: "ok" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
  });

  it("fails when every attempt times out", async () => {
    const { client } = setup(["hang", "hang", "hang", "hang"], {
      timeoutFires: true,
    });

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "failed", reason: "timeout" });
  });

  it("returns not found for a 404 without retrying", async () => {
    const { client, calls } = setup([{ status: 404 }]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "not-found" });
    expect(calls).toHaveLength(1);
  });

  it("fails a 400 without retrying", async () => {
    const { client, calls } = setup([{ status: 400 }]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "failed", reason: "HTTP 400" });
    expect(calls).toHaveLength(1);
  });

  it("returns rate limited when 429 persists after retries", async () => {
    const { client, calls, delays } = setup([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { status: 429 },
    ]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "rate-limited" });
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([PACING_MS, 2000, 4000, 8000]);
  });

  it("waits the Retry-After seconds of a 429 instead of the backoff", async () => {
    const { client, delays } = setup([
      { status: 429, headers: { "Retry-After": "30" } },
      { status: 200, body: "ok" },
    ]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "ok", body: "ok" });
    expect(delays).toEqual([PACING_MS, 30_000]);
  });

  it("falls back to the backoff when Retry-After is not a number", async () => {
    const { client, delays } = setup([
      {
        status: 429,
        headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
      },
      { status: 200 },
    ]);

    await client.get(URL_A);

    expect(delays).toEqual([PACING_MS, 2000]);
  });

  it("gives up as rate limited when Retry-After is too long to wait", async () => {
    const { client, calls, delays } = setup([
      { status: 429, headers: { "Retry-After": "3600" } },
    ]);

    const outcome = await client.get(URL_A);

    expect(outcome).toEqual({ kind: "rate-limited" });
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([PACING_MS]);
  });

  it("reports each attempt to the hook", async () => {
    const { client, attempts } = setup(
      ["network-error", "hang", { status: 500 }, { status: 200 }],
      { timeoutFires: true },
    );

    await client.get(URL_A);

    expect(attempts).toEqual([
      { url: URL_A, attempt: 1, error: "fetch failed" },
      { url: URL_A, attempt: 2, error: "timeout" },
      { url: URL_A, attempt: 3, status: 500 },
      { url: URL_A, attempt: 4, status: 200 },
    ]);
  });

  it("runs concurrent requests one at a time, each paced", async () => {
    const { client, calls, delays } = setup([
      { status: 200, body: "a" },
      { status: 200, body: "b" },
    ]);

    const [a, b] = await Promise.all([client.get(URL_A), client.get(URL_B)]);

    expect(a).toEqual({ kind: "ok", body: "a" });
    expect(b).toEqual({ kind: "ok", body: "b" });
    expect(calls.map((call) => call.url)).toEqual([URL_A, URL_B]);
    expect(delays).toEqual([PACING_MS, PACING_MS]);
  });

  describe("abort", () => {
    it("rejects without requesting when the signal is already aborted", async () => {
      const { client, calls } = setup([{ status: 200 }]);
      const controller = new AbortController();
      controller.abort();

      await expect(client.get(URL_A, controller.signal)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it("stops the pacing wait and never requests", async () => {
      const { fetch, calls } = fakeFetch([{ status: 200 }]);
      const delays: number[] = [];
      let sleeping = () => {};
      const asleep = new Promise<void>((resolve) => {
        sleeping = resolve;
      });
      const client = createLinkedInClient({
        fetch,
        sleep: (ms, signal) => {
          delays.push(ms);
          sleeping();
          return untilAborted(signal);
        },
        random: () => 0,
      });
      const controller = new AbortController();
      const reason = new Error("stop");

      const pending = client.get(URL_A, controller.signal);
      await asleep;
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(delays).toEqual([PACING_MS]);
      expect(calls).toHaveLength(0);
    });

    it("passes the signal through to fetch and stops a request in flight", async () => {
      const { client, calls } = setup(["hang"]);
      const controller = new AbortController();

      const pending = client.get(URL_A, controller.signal);
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();

      await expect(pending).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init?.signal?.aborted).toBe(true);
    });

    it("stops a backoff wait and does not retry", async () => {
      const { fetch, calls } = fakeFetch([{ status: 500 }, { status: 200 }]);
      const controller = new AbortController();
      const client = createLinkedInClient({
        fetch,
        sleep: async (ms, signal) => {
          if (ms === PACING_MS) return;
          if (ms !== REQUEST_TIMEOUT_MS) controller.abort();
          await untilAborted(signal);
        },
        random: () => 0,
      });

      await expect(client.get(URL_A, controller.signal)).rejects.toThrow();
      expect(calls).toHaveLength(1);
    });

    it("rejects a queued request at once, while the next still waits its turn", async () => {
      const { fetch, calls } = fakeFetch(["hang", { status: 200 }]);
      const client = createLinkedInClient({
        fetch,
        sleep: async (ms, signal) => {
          if (ms === REQUEST_TIMEOUT_MS) await untilAborted(signal);
        },
        random: () => 0,
      });
      const first = new AbortController();
      const second = new AbortController();
      const reason = new Error("stop");

      const pendingFirst = client.get(URL_A, first.signal);
      const pendingSecond = client.get(URL_B, second.signal);
      const pendingThird = client.get(URL_B);
      second.abort(reason);

      await expect(pendingSecond).rejects.toBe(reason);
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls.map((call) => call.url)).toEqual([URL_A]);

      first.abort();
      await expect(pendingFirst).rejects.toThrow();
      await expect(pendingThird).resolves.toEqual({ kind: "ok", body: "" });
      expect(calls.map((call) => call.url)).toEqual([URL_A, URL_B]);
    });

    it("rejects with the signal's reason when the default sleep is aborted", async () => {
      const { fetch, calls } = fakeFetch([{ status: 200 }]);
      const client = createLinkedInClient({ fetch });
      const controller = new AbortController();
      const reason = new Error("stop");

      const pending = client.get(URL_A, controller.signal);
      // Let the request reach the pacing wait before aborting it.
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(calls).toHaveLength(0);
    });
  });
});
