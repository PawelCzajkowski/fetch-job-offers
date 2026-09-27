import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  type Config,
  ConfigError,
  DEFAULT_CONFIG_FILE,
  loadConfig,
} from "./load.ts";
import { configSchema, savedSearchSchema } from "./schema.ts";

/** Label of the search defined by criteria flags without `--search`. */
export const AD_HOC_LABEL = "ad-hoc";

/** One search a run performs: a saved search (after overrides) or the ad-hoc search. */
export interface PlannedSearch {
  /** The saved search's name, or `ad-hoc`. */
  label: string;
  keywords: string;
  location: string;
  postedWithin: string;
  maxOffers: number;
  profile: string;
}

export interface RunOptions {
  model: string;
  /** Absolute. */
  outputDir: string;
  /** Absolute. */
  seenStore: string;
  all: boolean;
  rejudge: boolean;
  dryRun: boolean;
  verbose: boolean;
}

/** What a run does: the searches to perform, in order, and its options. */
export interface RunPlan {
  searches: PlannedSearch[];
  options: RunOptions;
  /** Absolute path of the config file used, or `null` when there was none. */
  configFile: string | null;
}

/** What the command line asks for. */
export type Command =
  | { kind: "help" }
  | { kind: "init" }
  | { kind: "run"; plan: RunPlan };

/** A bad command line, with a user-facing message. */
export class CommandLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandLineError";
  }
}

const nonEmpty = z.string().min(1);

// Criteria flags reuse the saved-search rules; only --max-offers needs its
// string turned into a number first.
const criteriaFlags = {
  keywords: savedSearchSchema.shape.keywords.optional(),
  location: savedSearchSchema.shape.location.optional(),
  postedWithin: savedSearchSchema.shape.postedWithin.unwrap().optional(),
  maxOffers: z
    .string()
    .regex(/^[1-9]\d*$/, { error: "must be a positive integer" })
    .transform(Number)
    .pipe(savedSearchSchema.shape.maxOffers.unwrap())
    .optional(),
  profile: savedSearchSchema.shape.profile.optional(),
};

type CriteriaKey = keyof typeof criteriaFlags;
const CRITERIA_KEYS = Object.keys(criteriaFlags) as CriteriaKey[];
const AD_HOC_REQUIRED = ["keywords", "location", "profile"] as const;

const flagsSchema = z
  .strictObject({
    search: z.array(nonEmpty),
    ...criteriaFlags,
    model: configSchema.shape.model.unwrap().optional(),
    out: configSchema.shape.outputDir.unwrap().optional(),
    config: nonEmpty.optional(),
    all: z.boolean(),
    rejudge: z.boolean(),
    dryRun: z.boolean(),
    verbose: z.boolean(),
  })
  .superRefine((flags, ctx) => {
    if (flags.search.length > 0) return;
    if (!CRITERIA_KEYS.some((key) => flags[key] !== undefined)) return;
    for (const key of AD_HOC_REQUIRED) {
      if (flags[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "is required for an ad-hoc search (no --search given)",
        });
      }
    }
  });

/** The validated flags of a run, before the config is applied. */
export type RunFlags = z.output<typeof flagsSchema>;

/** The command line parsed and validated, without looking at the config. */
export type ParsedCommandLine =
  | { kind: "help" }
  | { kind: "init" }
  | { kind: "run"; flags: RunFlags };

const FLAG_NAMES: Record<keyof RunFlags, string> = {
  search: "--search",
  keywords: "--keywords",
  location: "--location",
  postedWithin: "--posted-within",
  maxOffers: "--max-offers",
  profile: "--profile",
  model: "--model",
  out: "--out",
  config: "--config",
  all: "--all",
  rejudge: "--rejudge",
  dryRun: "--dry-run",
  verbose: "--verbose",
};

const PARSE_OPTIONS = {
  search: { type: "string", multiple: true },
  keywords: { type: "string" },
  location: { type: "string" },
  "posted-within": { type: "string" },
  profile: { type: "string" },
  "max-offers": { type: "string" },
  model: { type: "string" },
  out: { type: "string" },
  config: { type: "string" },
  all: { type: "boolean" },
  rejudge: { type: "boolean" },
  "dry-run": { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * Parses and validates `argv` (without the node and script entries). Detects
 * `--help` and `init` so the caller can handle them before loading a config.
 * Throws a `CommandLineError` on unknown flags, stray positionals or invalid
 * values.
 */
export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const { values, positionals } = parseFlags(argv);

  if (values.help) return { kind: "help" };

  const [first, ...rest] = positionals;
  const extra = first === "init" ? rest : positionals;
  if (extra.length > 0) {
    throw new CommandLineError(
      `Unexpected argument ${JSON.stringify(extra[0])}. See --help.`,
    );
  }
  if (first === "init") {
    if (Object.keys(values).length > 0) {
      throw new CommandLineError("init takes no options. See --help.");
    }
    return { kind: "init" };
  }

  const result = flagsSchema.safeParse(
    {
      search: values.search ?? [],
      keywords: values.keywords,
      location: values.location,
      postedWithin: values["posted-within"],
      maxOffers: values["max-offers"],
      profile: values.profile,
      model: values.model,
      out: values.out,
      config: values.config,
      all: values.all ?? false,
      rejudge: values.rejudge ?? false,
      dryRun: values["dry-run"] ?? false,
      verbose: values.verbose ?? false,
    },
    {
      error: (issue) =>
        issue.code === "too_small" && issue.origin === "string"
          ? "must not be empty"
          : undefined,
    },
  );
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path[0] as keyof RunFlags;
      return `  - ${FLAG_NAMES[key]}: ${issue.message}`;
    });
    throw new CommandLineError(`Invalid command line:\n${problems.join("\n")}`);
  }
  return { kind: "run", flags: result.data };
}

function parseFlags(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: PARSE_OPTIONS,
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new CommandLineError(`${(error as Error).message} See --help.`);
  }
}

/** Absolute path of the config file the flags point to (`--config` or the default). */
export function configPathFor(flags: RunFlags, cwd: string): string {
  return resolve(cwd, flags.config ?? DEFAULT_CONFIG_FILE);
}

/**
 * Turns validated run flags plus the loaded config (or `"no-config"` when
 * there is no config file) into a run plan. Pure. Throws a
 * `CommandLineError` when the flags and config don't make a runnable plan.
 */
export function planRun(
  flags: RunFlags,
  config: Config | "no-config",
  cwd: string,
): RunPlan {
  const configFile = configPathFor(flags, cwd);
  const adHoc = flags.search.length === 0 && flags.keywords !== undefined;

  let searches: PlannedSearch[];
  if (adHoc) {
    searches = [adHocSearch(flags)];
  } else if (config === "no-config") {
    throw new CommandLineError(
      `No config file found at ${configFile}. Run \`fetch-job-offers init\` to create one, or pass --keywords, --location and --profile for an ad-hoc search.`,
    );
  } else if (config.searches.length === 0) {
    throw new CommandLineError(
      `Config file ${configFile} has no saved searches. Add one to its "searches", or pass --keywords, --location and --profile for an ad-hoc search.`,
    );
  } else {
    searches = selectSearches(config.searches, flags);
  }

  const base = config === "no-config" ? cwdDefaults(cwd) : config;
  return {
    searches,
    options: {
      model: flags.model ?? base.model,
      outputDir:
        flags.out === undefined ? base.outputDir : resolve(cwd, flags.out),
      seenStore: base.seenStore,
      all: flags.all,
      rejudge: flags.rejudge,
      dryRun: flags.dryRun,
      verbose: flags.verbose,
    },
    configFile: config === "no-config" ? null : configFile,
  };
}

/** `parseCommandLine` followed by `planRun`. Pure. */
export function planCommand(
  argv: readonly string[],
  config: Config | "no-config",
  cwd: string,
): Command {
  const parsed = parseCommandLine(argv);
  if (parsed.kind !== "run") return parsed;
  return { kind: "run", plan: planRun(parsed.flags, config, cwd) };
}

/**
 * Parses `argv`, loads the config it points to (`--config` or
 * `fetch-job-offers.config.json` in `cwd`) and builds the run plan. A
 * missing default config file counts as no config; a missing `--config` file
 * and other `ConfigError`s are thrown.
 * `--help` and `init` return without loading anything.
 */
export async function resolveCommand(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<Command> {
  const parsed = parseCommandLine(argv);
  if (parsed.kind !== "run") return parsed;

  let config: Config | "no-config";
  try {
    config = await loadConfig(configPathFor(parsed.flags, cwd));
  } catch (error) {
    // Only the default file may be absent: a path the user named with
    // --config must exist, or a typo would silently run on cwd defaults.
    const missingDefault =
      error instanceof ConfigError &&
      error.reason === "not-found" &&
      parsed.flags.config === undefined;
    if (!missingDefault) throw error;
    config = "no-config";
  }
  return { kind: "run", plan: planRun(parsed.flags, config, cwd) };
}

/** The config defaults, with paths relative to `cwd`, for a run without a config file. */
function cwdDefaults(cwd: string): Omit<Config, "searches"> {
  const { model, outputDir, seenStore } = configSchema.parse({ searches: [] });
  return {
    model,
    outputDir: resolve(cwd, outputDir),
    seenStore: resolve(cwd, seenStore),
  };
}

function adHocSearch(flags: RunFlags): PlannedSearch {
  // The flags schema already guarantees keywords, location and profile here;
  // parsing applies the saved-search defaults for the rest.
  const { name, ...criteria } = savedSearchSchema.parse({
    name: AD_HOC_LABEL,
    keywords: flags.keywords,
    location: flags.location,
    postedWithin: flags.postedWithin,
    maxOffers: flags.maxOffers,
    profile: flags.profile,
  });
  return { label: name, ...criteria };
}

function selectSearches(
  saved: Config["searches"],
  flags: RunFlags,
): PlannedSearch[] {
  const known = new Set(saved.map((search) => search.name));
  const unknown = flags.search.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new CommandLineError(
      `Unknown saved search ${unknown.map((n) => JSON.stringify(n)).join(", ")}. Known searches: ${[...known].join(", ")}.`,
    );
  }

  const selected =
    flags.search.length === 0
      ? saved
      : saved.filter((search) => flags.search.includes(search.name));
  return selected.map(({ name, ...search }) => {
    const planned: PlannedSearch = { label: name, ...search };
    for (const key of CRITERIA_KEYS) {
      const value = flags[key];
      if (value !== undefined) Object.assign(planned, { [key]: value });
    }
    return planned;
  });
}
