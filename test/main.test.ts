import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { APIUserAbortError } from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/config/init.ts";
import { HELP_TEXT } from "../src/help.ts";
import type {
  JudgeClient,
  JudgeRequest,
  JudgeResponse,
} from "../src/judge/judge.ts";
import type { Verdict } from "../src/judge/verdict.ts";
import { REQUEST_TIMEOUT_MS } from "../src/linkedin/client.ts";
import { parseSearchPage } from "../src/linkedin/searchPage.ts";
import { buildSearchUrl } from "../src/linkedin/searchUrl.ts";
import { type MainEnv, main } from "../src/main.ts";
import type { SeenFile } from "../src/store/seenStore.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/linkedin/${name}`, import.meta.url), "utf8");

const PAGE = fixture("search-typescript-poland-start0.html");
const EMPTY = fixture("search-empty-past-end.html");
const DETAIL_NO_SALARY = fixture("job-4467798222-no-salary.html");
const DETAIL_WITH_SALARY = fixture("job-4464163116-with-salary.html");
const PAGE_IDS = parseSearchPage(PAGE).map((card) => card.jobId);

const TS_SEARCH = {
  name: "ts-poland",
  keywords: "TypeScript",
  location: "Poland",
  postedWithin: "7d",
  profile: "TypeScript development",
};
const JAVA_SEARCH = {
  name: "java-poland",
  keywords: "Java",
  location: "Poland",
  postedWithin: "7d",
  profile: "Java development",
};

const urlFor = (search: typeof TS_SEARCH, start: number) =>
  buildSearchUrl(search, start);

/** A search served as the fixture page at start=0, then an empty page. */
function servedSearch(search: typeof TS_SEARCH): Record<string, Route> {
  return {
    [urlFor(search, 0)]: PAGE,
    [urlFor(search, 10)]: EMPTY,
  };
}

type Route = string | { status: number; body?: string };

/**
 * A fake `fetch` keyed by URL. Detail pages get a real detail fixture; any
 * URL not in `routes` is logged in `unexpected` and answered with 500.
 */
function fakeFetch(routes: Record<string, Route>) {
  const requested: string[] = [];
  const unexpected: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/jobPosting/")) {
      return new Response(
        url.endsWith("/4467798222") ? DETAIL_NO_SALARY : DETAIL_WITH_SALARY,
      );
    }
    const route = routes[url];
    if (route === undefined) {
      unexpected.push(url);
      return new Response("", { status: 500 });
    }
    return typeof route === "string"
      ? new Response(route)
      : new Response(route.body ?? "", { status: route.status });
  }) as typeof globalThis.fetch;
  return { fetch, requested, unexpected };
}

/**
 * Waits resolve at once, except the per-request timeout, which waits for its
 * signal (the client aborts it once the request settles).
 */
async function instantSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms !== REQUEST_TIMEOUT_MS) return;
  await new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

const USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  output_tokens_details: { reasoning_tokens: 50 },
};

/**
 * A fake OpenAI client: accepts offers whose title mentions TypeScript and
 * rejects the rest. `beforeCall` runs first on every call (1-based count).
 */
function fakeOpenAI(beforeCall: (n: number) => void = () => {}) {
  const apiKeys: string[] = [];
  const requests: JudgeRequest[] = [];
  const client: JudgeClient = {
    responses: {
      async parse(body, options) {
        requests.push(body);
        beforeCall(requests.length);
        if (options.signal.aborted) throw new APIUserAbortError();
        const accepted = /typescript/i.test(
          /Title: (.*)/.exec(body.input)?.[1] ?? "",
        );
        const verdict: Verdict = {
          reason: accepted
            ? "The day-to-day work is TypeScript development."
            : "TypeScript is not the main technology.",
          verdict: accepted ? "accepted" : "rejected",
          workMode: "remote",
          seniority: "senior",
          techStack: ["TypeScript"],
        };
        const response: JudgeResponse = {
          status: "completed",
          output_parsed: verdict,
          output: [{ type: "message", content: [{ type: "output_text" }] }],
          usage: USAGE,
        };
        return response;
      },
    },
  };
  return {
    create: (apiKey: string) => {
      apiKeys.push(apiKey);
      return client;
    },
    apiKeys,
    requests,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fjo-main-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(
  searches: object[],
  extra: Record<string, unknown> = {},
  where = dir,
) {
  await writeFile(
    join(where, "fetch-job-offers.config.json"),
    JSON.stringify({ searches, ...extra }),
  );
}

const writeDotEnv = (content: string, where = dir) =>
  writeFile(join(where, ".env"), content);

interface Setup {
  routes?: Record<string, Route>;
  vars?: Record<string, string | undefined>;
  openai?: ReturnType<typeof fakeOpenAI>;
  controller?: AbortController;
  now?: Date;
  cwd?: string;
}

/** Runs `main` with fakes and captures its output. */
async function run(argv: string[], setup: Setup = {}) {
  const net = fakeFetch(setup.routes ?? {});
  const openai = setup.openai ?? fakeOpenAI();
  const vars = setup.vars ?? {};
  const loaded: string[] = [];
  let stdout = "";
  let stderr = "";
  const env: MainEnv = {
    cwd: setup.cwd ?? dir,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    vars,
    // Like process.loadEnvFile: variables already set win.
    loadEnvFile: (path) => {
      loaded.push(path);
      for (const [key, value] of Object.entries(
        parseEnv(readFileSync(path, "utf8")),
      )) {
        vars[key] ??= value;
      }
    },
    fetch: net.fetch,
    sleep: instantSleep,
    random: () => 0,
    createJudgeClient: openai.create,
    now: () => setup.now ?? new Date("2026-09-27T08:05:00.000Z"),
    signal: (setup.controller ?? new AbortController()).signal,
  };
  const code = await main(argv, env);
  return { code, stdout, stderr, net, openai, loaded, vars };
}

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const reportFiles = async (outputDir = join(dir, "reports")) =>
  (await readdir(outputDir)).sort();

const exists = async (path: string) =>
  readFile(path).then(
    () => true,
    () => false,
  );

describe("main: help and init", () => {
  it("prints the help text to stdout and exits 0, without a key", async () => {
    const { code, stdout, stderr, openai } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toBe(HELP_TEXT);
    expect(stderr).toBe("");
    expect(openai.apiKeys).toEqual([]);
  });

  it("runs init in cwd, printing one line per file, and exits 0", async () => {
    const { code, stdout } = await run(["init"]);
    expect(code).toBe(0);
    expect(stdout).toContain("created  fetch-job-offers.config.json");
    expect(stdout).toContain("created  config.schema.json");
    expect(stdout).toContain("created  .env.example");
    expect(stdout).toContain("created  .gitignore");
    expect(await exists(join(dir, "fetch-job-offers.config.json"))).toBe(true);

    const again = await run(["init"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("skipped  fetch-job-offers.config.json");
    expect(again.stdout).toContain("skipped  .gitignore");
  });

  it("reports the .gitignore lines init appended", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n.env\n");
    const { stdout } = await run(["init"]);
    expect(stdout).toContain("updated  .gitignore (added reports/, seen.json)");
  });
});

describe("main: fatal errors before any work", () => {
  const expectFatal = (
    result: Awaited<ReturnType<typeof run>>,
    message: string,
  ) => {
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.net.requested).toEqual([]);
    expect(result.openai.requests).toEqual([]);
  };

  it("points to init when there's no config and no ad-hoc search", async () => {
    const result = await run([], { vars: { OPENAI_API_KEY: "sk-test" } });
    expectFatal(result, "Run `fetch-job-offers init` to create one");
  });

  it("rejects a bad command line", async () => {
    expectFatal(await run(["--bogus"]), "Unknown option");
  });

  it("rejects a config that isn't valid JSON", async () => {
    await writeFile(join(dir, "fetch-job-offers.config.json"), "{ nope");
    expectFatal(
      await run([], { vars: { OPENAI_API_KEY: "sk-test" } }),
      "is not valid JSON",
    );
  });

  it("rejects an output directory that can't be written, before any request", async () => {
    await writeConfig([TS_SEARCH], { outputDir: "reports/sub" });
    await writeFile(join(dir, "reports"), "a file, not a directory");
    expectFatal(
      await run([], { vars: { OPENAI_API_KEY: "sk-test" } }),
      `Can't write the output directory ${join(dir, "reports", "sub")}`,
    );
    expect(await exists(join(dir, "seen.json"))).toBe(false);
  });

  it("rejects a seen store directory that can't be written", async () => {
    await writeConfig([TS_SEARCH], { seenStore: "state/seen.json" });
    await writeFile(join(dir, "state"), "a file, not a directory");
    expectFatal(
      await run([], { vars: { OPENAI_API_KEY: "sk-test" } }),
      `Can't write the seen store directory ${join(dir, "state")}`,
    );
  });

  it("rejects an invalid config, listing the problem's path", async () => {
    await writeConfig([{ ...TS_SEARCH, postedWithn: "7d" }]);
    expectFatal(
      await run([], { vars: { OPENAI_API_KEY: "sk-test" } }),
      "searches[0].postedWithn: unknown key",
    );
  });

  it("rejects an unknown --search", async () => {
    await writeConfig([TS_SEARCH]);
    expectFatal(
      await run(["--search", "nope"], { vars: { OPENAI_API_KEY: "sk-test" } }),
      'Unknown saved search "nope"',
    );
  });

  it("fails without OPENAI_API_KEY", async () => {
    await writeConfig([TS_SEARCH]);
    expectFatal(await run([]), "OPENAI_API_KEY is not set");
  });

  it("treats an empty OPENAI_API_KEY in .env as missing", async () => {
    await writeConfig([TS_SEARCH]);
    await writeDotEnv("OPENAI_API_KEY=\n");
    expectFatal(await run([]), "OPENAI_API_KEY is not set");
  });

  it("rejects a corrupt seen store", async () => {
    await writeConfig([TS_SEARCH]);
    await writeFile(join(dir, "seen.json"), "{");
    expectFatal(
      await run([], { vars: { OPENAI_API_KEY: "sk-test" } }),
      "is not valid JSON",
    );
  });
});

describe("main: .env", () => {
  it("loads .env next to the config file, not from cwd", async () => {
    const configDir = join(dir, "elsewhere");
    await mkdir(configDir);
    await writeConfig([TS_SEARCH], {}, configDir);
    await writeDotEnv("OPENAI_API_KEY=sk-next-to-config\n", configDir);
    await writeDotEnv("OPENAI_API_KEY=sk-from-cwd\n");

    const { code, loaded, openai } = await run(
      ["--config", join(configDir, "fetch-job-offers.config.json")],
      { routes: servedSearch(TS_SEARCH) },
    );
    expect(code).toBe(0);
    expect(loaded).toEqual([join(configDir, ".env")]);
    expect(openai.apiKeys).toEqual(["sk-next-to-config"]);
  });

  it("loads .env from cwd for an ad-hoc search without a config", async () => {
    await writeDotEnv("OPENAI_API_KEY=sk-from-cwd\n");
    const { code, loaded, openai } = await run(
      [
        "--keywords",
        TS_SEARCH.keywords,
        "--location",
        TS_SEARCH.location,
        "--profile",
        TS_SEARCH.profile,
      ],
      { routes: servedSearch(TS_SEARCH) },
    );
    expect(code).toBe(0);
    expect(loaded).toEqual([join(dir, ".env")]);
    expect(openai.apiKeys).toEqual(["sk-from-cwd"]);
  });

  it("lets a variable already in the environment win over .env", async () => {
    await writeConfig([TS_SEARCH]);
    await writeDotEnv("OPENAI_API_KEY=sk-from-file\n");
    const { openai } = await run([], {
      routes: servedSearch(TS_SEARCH),
      vars: { OPENAI_API_KEY: "sk-from-env" },
    });
    expect(openai.apiKeys).toEqual(["sk-from-env"]);
  });

  it("is fine without a .env when the key is in the environment", async () => {
    await writeConfig([TS_SEARCH]);
    const { code, loaded } = await run([], {
      routes: servedSearch(TS_SEARCH),
      vars: { OPENAI_API_KEY: "sk-from-env" },
    });
    expect(code).toBe(0);
    expect(loaded).toEqual([]);
  });
});

describe("main: end to end", () => {
  beforeEach(async () => {
    // A config written by init, pointed at the fixture search, plus a .env.
    await runInit(dir);
    const configPath = join(dir, "fetch-job-offers.config.json");
    const config = await readJson<Record<string, unknown>>(configPath);
    await writeFile(
      configPath,
      JSON.stringify({ ...config, searches: [TS_SEARCH] }, null, 2),
    );
    await writeDotEnv("OPENAI_API_KEY=sk-test-not-real\n");
  });

  it("runs, stores, writes both reports, prints the summary and exits 0", async () => {
    const { code, stdout, stderr, net, openai } = await run([], {
      routes: servedSearch(TS_SEARCH),
    });

    expect(net.unexpected).toEqual([]);
    expect(code).toBe(0);
    expect(openai.apiKeys).toEqual(["sk-test-not-real"]);
    expect(openai.requests).toHaveLength(PAGE_IDS.length);
    expect(openai.requests.every((r) => r.model === "gpt-6-luna")).toBe(true);

    const files = await reportFiles();
    expect(files).toHaveLength(4);
    expect(files).toEqual(expect.arrayContaining(["latest.html", "latest.md"]));
    const stamped = files.filter((f) => !f.startsWith("latest."));
    expect(
      stamped.map((f) => f.replace(/^\d{4}-\d{2}-\d{2}_\d{4}/, "STAMP")),
    ).toEqual(["STAMP.html", "STAMP.md"]);

    const seen = await readJson<SeenFile>(join(dir, "seen.json"));
    expect(Object.keys(seen.offers).sort()).toEqual([...PAGE_IDS].sort());
    expect(
      Object.keys(seen.verdicts["typescript development"] ?? {}).sort(),
    ).toEqual([...PAGE_IDS].sort());

    expect(stderr).toContain("Search 1/1: ts-poland");
    expect(stderr).toContain("Page start=0: 10 cards, 10 new");
    expect(stderr).toMatch(/✓ accepted {2}.+ @ /);
    expect(stderr).not.toContain("GET https://"); // only with --verbose

    expect(stdout).toContain("ts-poland\n");
    expect(stdout).toContain("cards fetched  10");
    expect(stdout).toContain("Total: 10,000 input, 2,000 output");
    expect(stdout).toContain(
      `Reports: ${join(dir, "reports", stamped[1] as string)}, ${join(dir, "reports", stamped[0] as string)}`,
    );
  });

  it("logs every LinkedIn request to stderr with --verbose", async () => {
    const { code, stderr } = await run(["--verbose"], {
      routes: servedSearch(TS_SEARCH),
    });
    expect(code).toBe(0);
    expect(stderr).toContain(`GET ${urlFor(TS_SEARCH, 0)} → 200 (attempt 1)`);
  });

  it("marks everything seen, so a second run writes no report", async () => {
    await run([], { routes: servedSearch(TS_SEARCH) });
    const before = await reportFiles();
    const latestMd = await readFile(join(dir, "reports", "latest.md"), "utf8");

    const second = await run([], {
      routes: servedSearch(TS_SEARCH),
      now: new Date("2026-09-27T09:30:00.000Z"),
    });
    expect(second.code).toBe(0);
    expect(second.openai.requests).toEqual([]);
    expect(second.stdout).toContain("seen skipped   10");
    expect(second.stdout).toContain("No new offers, no report written");
    expect(await reportFiles()).toEqual(before);
    expect(await readFile(join(dir, "reports", "latest.md"), "utf8")).toBe(
      latestMd,
    );
  });

  it("leaves seen.json unwritten and latest.* alone on a dry run", async () => {
    const { code, stdout } = await run(["--dry-run"], {
      routes: servedSearch(TS_SEARCH),
    });
    expect(code).toBe(0);
    expect(stdout).toContain("Dry run: the seen store was not updated.");
    expect(await exists(join(dir, "seen.json"))).toBe(false);
    const files = await reportFiles();
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.startsWith("latest."))).toBe(false);
  });

  it("writes to --out instead of the config's outputDir", async () => {
    const { code } = await run(["--out", "elsewhere"], {
      routes: servedSearch(TS_SEARCH),
    });
    expect(code).toBe(0);
    expect(await reportFiles(join(dir, "elsewhere"))).toHaveLength(4);
  });
});

describe("main: exit codes", () => {
  beforeEach(async () => {
    await writeConfig([TS_SEARCH, JAVA_SEARCH]);
    await writeDotEnv("OPENAI_API_KEY=sk-test-not-real\n");
  });

  it("exits 2 when a search is partial, still storing and reporting", async () => {
    const { code, stdout } = await run([], {
      routes: {
        ...servedSearch(TS_SEARCH),
        [urlFor(JAVA_SEARCH, 0)]: { status: 500 },
      },
    });
    expect(code).toBe(2);
    expect(stdout).toContain(
      "java-poland (partial: Search page start=0 failed: HTTP 500)",
    );
    expect(await reportFiles()).toHaveLength(4);
    const seen = await readJson<SeenFile>(join(dir, "seen.json"));
    expect(Object.keys(seen.offers)).toHaveLength(PAGE_IDS.length);
  });

  it("still prints the summary and exits 1 when the report can't be written", async () => {
    // latest.md as a directory: the timestamped files write, latest fails.
    await mkdir(join(dir, "reports", "latest.md"), { recursive: true });
    const { code, stdout, stderr } = await run(["--search", "ts-poland"], {
      routes: servedSearch(TS_SEARCH),
    });
    expect(code).toBe(1);
    expect(stdout).toContain("cards fetched  10");
    expect(stdout).toMatch(/Report not written: .+latest\.md/);
    expect(stderr).toContain("run again with --all");
    const seen = await readJson<SeenFile>(join(dir, "seen.json"));
    expect(Object.keys(seen.offers)).toHaveLength(PAGE_IDS.length);
  });

  it("exits 2 when the run stops on a persistent 429", async () => {
    const { code, stdout } = await run([], {
      routes: { [urlFor(TS_SEARCH, 0)]: { status: 429 } },
    });
    expect(code).toBe(2);
    expect(stdout).toContain("Run stopped (rate limited)");
    expect(stdout).toContain("Didn't run: java-poland");
    expect(stdout).toContain("No new offers, no report written");
  });

  it("exits 130 on abort, after saving the store and writing the report", async () => {
    const controller = new AbortController();
    // The "Ctrl-C" lands while the third offer is being judged.
    const openai = fakeOpenAI((n) => {
      if (n === 3) controller.abort();
    });
    const { code, stdout } = await run([], {
      routes: { ...servedSearch(TS_SEARCH), ...servedSearch(JAVA_SEARCH) },
      openai,
      controller,
    });
    expect(code).toBe(130);
    expect(stdout).toContain("ts-poland (partial: The run was aborted.)");
    expect(stdout).toContain("Run stopped (aborted)");
    expect(stdout).toContain("Didn't run: java-poland");
    expect(stdout).toContain("Reports: ");

    const seen = await readJson<SeenFile>(join(dir, "seen.json"));
    expect(
      Object.keys(seen.verdicts["typescript development"] ?? {}),
    ).toHaveLength(2);
    expect(await reportFiles()).toHaveLength(4);
  });
});
