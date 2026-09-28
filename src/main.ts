import { constants, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runInit } from "./config/init.ts";
import { ConfigError } from "./config/load.ts";
import {
  CommandLineError,
  type RunPlan,
  resolveCommand,
} from "./config/plan.ts";
import { HELP_TEXT } from "./help.ts";
import { INTERRUPTED_EXIT_CODE } from "./interrupt.ts";
import { type JudgeClient, judgeOffer } from "./judge/judge.ts";
import {
  createLinkedInClient,
  type LinkedInClientDeps,
} from "./linkedin/client.ts";
import {
  formatAttempt,
  formatRunEvent,
  formatSummary,
} from "./output/terminal.ts";
import { writeReportFiles } from "./report/files.ts";
import { buildReportModel } from "./report/model.ts";
import { type RunResult, runSearches } from "./run/runLoop.ts";
import {
  loadSeenStore,
  type SeenStore,
  saveSeenStore,
} from "./store/seenStore.ts";

/**
 * The whole command (spec sections 4 and 11): plans from the command line
 * and config, runs, writes the reports, prints the summary and returns the
 * exit code. Everything outside the process is injected through `MainEnv`;
 * `cli.ts` wires in the real pieces.
 */

export const EXIT_OK = 0;
/** A fatal error before any work: bad command line or config, no key, corrupt store. */
export const EXIT_FATAL = 1;
/** The report step ran, but a search was partial or the run stopped on a 429. */
export const EXIT_INCOMPLETE = 2;

const API_KEY_VAR = "OPENAI_API_KEY";
const ENV_FILE = ".env";

export interface MainEnv {
  /** Where the config, `.env` and relative paths are looked up. */
  cwd: string;
  /** Receives the summary, `--help` and `init` output. */
  stdout: (text: string) => void;
  /** Receives progress lines and error messages. */
  stderr: (text: string) => void;
  /** The environment variables; `process.env` in production. */
  vars: Record<string, string | undefined>;
  /**
   * Adds the variables of a `.env` file to `vars`, keeping those already
   * set; `process.loadEnvFile` in production. Only called when the file exists.
   */
  loadEnvFile: (path: string) => void;
  /** For the LinkedIn client. */
  fetch: typeof fetch;
  /** For the LinkedIn client; real timers when omitted. */
  sleep?: LinkedInClientDeps["sleep"];
  /** For the LinkedIn client's jitter; `Math.random` when omitted. */
  random?: () => number;
  /** Creates the OpenAI client; `new OpenAI({ apiKey })` in production. */
  createJudgeClient: (apiKey: string) => JudgeClient;
  now: () => Date;
  /** Aborted by the first Ctrl-C; stops the LinkedIn requests and the judge. */
  signal: AbortSignal;
}

/** A fatal error with a user-facing message, printed without a stack trace. */
class FatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FatalError";
  }
}

const isExpected = (error: unknown): error is Error =>
  error instanceof CommandLineError ||
  error instanceof ConfigError ||
  error instanceof FatalError;

/** Runs the command `argv` (without the node and script entries) asks for. */
export async function main(
  argv: readonly string[],
  env: MainEnv,
): Promise<number> {
  try {
    const command = await resolveCommand(argv, env.cwd);
    switch (command.kind) {
      case "help":
        env.stdout(HELP_TEXT);
        return EXIT_OK;
      case "init":
        await init(env);
        return EXIT_OK;
      case "run":
        return await run(command.plan, env);
    }
  } catch (error) {
    if (isExpected(error)) {
      env.stderr(`Error: ${error.message}\n`);
    } else {
      // A bug or an I/O failure: the stack helps whoever debugs it.
      const detail =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      env.stderr(`Unexpected error: ${detail}\n`);
    }
    return EXIT_FATAL;
  }
}

async function init(env: MainEnv): Promise<void> {
  const results = await runInit(env.cwd);
  for (const { file, status, addedLines } of results) {
    const detail =
      status === "skipped"
        ? file === ".gitignore"
          ? " (already has every entry)"
          : " (already exists)"
        : addedLines && status === "updated"
          ? ` (added ${addedLines.join(", ")})`
          : "";
    env.stdout(`${status.padEnd(7)}  ${file}${detail}\n`);
  }
  env.stdout(
    `\nNext: copy .env.example to .env and set ${API_KEY_VAR}, edit the searches in the config, then run fetch-job-offers.\n`,
  );
}

async function run(plan: RunPlan, env: MainEnv): Promise<number> {
  const { options } = plan;
  const { signal } = env;
  const apiKey = loadApiKey(plan, env);
  // Checked up front, so a run doesn't judge (and pay for) offers it then
  // can't store or report.
  await assertWritableDir(options.outputDir, "output directory");
  if (!options.dryRun) {
    await assertWritableDir(dirname(options.seenStore), "seen store directory");
  }
  const store = await loadStore(options.seenStore, env);

  const linkedin = createLinkedInClient({
    fetch: env.fetch,
    ...(env.sleep && { sleep: env.sleep }),
    ...(env.random && { random: env.random }),
    ...(options.verbose && {
      onAttempt: (event) => env.stderr(`${formatAttempt(event)}\n`),
    }),
  });
  const client = env.createJudgeClient(apiKey);

  const result = await runSearches(
    plan.searches,
    {
      linkedin,
      judge: (profile, offer) =>
        judgeOffer({ client, model: options.model, signal }, profile, offer),
      model: options.model,
      store,
      storePath: options.seenStore,
      save: saveSeenStore,
      now: env.now,
      signal,
      onEvent: (event) => env.stderr(`${formatRunEvent(event)}\n`),
    },
    options,
  );

  // The store is already saved, so a failed write still gets the summary,
  // and a hint, since this run's offers now count as seen.
  let reportPaths: string[] = [];
  let reportError: string | undefined;
  try {
    const written = await writeReportFiles(
      buildReportModel(result),
      options.outputDir,
    );
    if (written.written) reportPaths = written.paths;
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
  }
  env.stdout(
    formatSummary(result, {
      model: options.model,
      reportPaths,
      ...(reportError !== undefined && { reportError }),
    }),
  );
  if (reportError !== undefined) {
    env.stderr(
      `Error: the report couldn't be written: ${reportError}\n` +
        (options.dryRun
          ? ""
          : "This run's offers are already in the seen store; fix the problem and run again with --all to report them.\n"),
    );
    return EXIT_FATAL;
  }
  return exitCodeOf(result, signal);
}

/**
 * Fails before any work when `dir` can't be created or written: the nearest
 * existing ancestor (or `dir` itself) must be a writable directory. Creates
 * nothing, since a run with no report writes no files at all.
 */
async function assertWritableDir(dir: string, what: string): Promise<void> {
  let existing = dir;
  for (;;) {
    try {
      const stats = await stat(existing);
      if (!stats.isDirectory()) {
        throw new FatalError(
          `Can't write the ${what} ${dir}: ${existing} is not a directory.`,
        );
      }
      await access(existing, constants.W_OK);
      return;
    } catch (error) {
      if (error instanceof FatalError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(existing);
      if (code === "ENOENT" && parent !== existing) {
        existing = parent;
        continue;
      }
      throw new FatalError(
        `Can't write the ${what} ${dir}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
}

/**
 * Loads `.env` next to the config file (or in cwd without one), if it
 * exists, and returns the API key. Variables already set win.
 */
function loadApiKey(plan: RunPlan, env: MainEnv): string {
  const envDir = plan.configFile === null ? env.cwd : dirname(plan.configFile);
  const envFile = join(envDir, ENV_FILE);
  if (existsSync(envFile)) env.loadEnvFile(envFile);

  const apiKey = env.vars[API_KEY_VAR]?.trim();
  if (!apiKey) {
    throw new FatalError(
      `${API_KEY_VAR} is not set. Put it in ${envFile} (see .env.example) or in the environment.`,
    );
  }
  return apiKey;
}

async function loadStore(path: string, env: MainEnv): Promise<SeenStore> {
  try {
    return await loadSeenStore(path, { now: env.now });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FatalError(
      `${message}\nFix or delete the seen store to continue (deleting it forgets every offer seen).`,
      { cause: error },
    );
  }
}

function exitCodeOf(result: RunResult, signal: AbortSignal): number {
  if (signal.aborted || result.stopped?.kind === "aborted") {
    return INTERRUPTED_EXIT_CODE;
  }
  const incomplete =
    result.stopped?.kind === "rate-limited" ||
    result.searches.some((search) => search.partial !== null);
  return incomplete ? EXIT_INCOMPLETE : EXIT_OK;
}
