import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import { configSchema, type SavedSearch } from "./schema.ts";

export const DEFAULT_CONFIG_FILE = "fetch-job-offers.config.json";

/** The loaded config: defaults applied, paths absolute. */
export interface Config {
  model: string;
  /** Absolute; resolved against the config file's directory. */
  outputDir: string;
  /** Absolute; resolved against the config file's directory. */
  seenStore: string;
  searches: SavedSearch[];
}

export type ConfigErrorReason = "not-found" | "invalid-json" | "invalid-config";

export class ConfigError extends Error {
  readonly reason: ConfigErrorReason;
  readonly path: string;

  constructor(reason: ConfigErrorReason, path: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
    this.path = path;
  }
}

/**
 * Reads and validates the config file at `path` (default
 * `fetch-job-offers.config.json` in the current directory), applies defaults and
 * resolves `outputDir` and `seenStore` against the file's directory.
 * Throws a `ConfigError` when the file is missing, isn't JSON, or doesn't
 * match the schema (every problem is listed with its path).
 */
export async function loadConfig(
  path: string = DEFAULT_CONFIG_FILE,
): Promise<Config> {
  const file = resolve(path);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(
        "not-found",
        file,
        `Config file not found: ${file}`,
      );
    }
    throw error;
  }

  let json: unknown;
  try {
    // Strip a UTF-8 BOM, which some editors write and JSON.parse rejects.
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ConfigError(
      "invalid-json",
      file,
      `Config file ${file} is not valid JSON: ${(error as Error).message}`,
    );
  }

  const result = configSchema.safeParse(json, {
    error: (issue) =>
      issue.code === "invalid_type" && issue.input === undefined
        ? "required"
        : undefined,
  });
  if (!result.success) {
    const problems = result.error.issues.flatMap(describeIssue);
    throw new ConfigError(
      "invalid-config",
      file,
      `Config file ${file} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  const configDir = dirname(file);
  const { model, outputDir, seenStore, searches } = result.data;
  return {
    model,
    outputDir: resolve(configDir, outputDir),
    seenStore: resolve(configDir, seenStore),
    searches,
  };
}

function describeIssue(issue: z.core.$ZodIssue): string[] {
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map(
      (key) => `${formatPath([...issue.path, key])}: unknown key`,
    );
  }
  return [`${formatPath(issue.path)}: ${issue.message}`];
}

/** Formats a Zod issue path as `searches[0].postedWithin`. */
function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      const name = String(segment);
      return index === 0 ? name : `.${name}`;
    })
    .join("");
}
