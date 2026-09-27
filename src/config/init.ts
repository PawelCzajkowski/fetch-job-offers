import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG_FILE } from "./load.ts";
import { type ConfigInput, configJsonSchema } from "./schema.ts";

const SCHEMA_FILE = "config.schema.json";
const ENV_EXAMPLE_FILE = ".env.example";
const GITIGNORE_FILE = ".gitignore";

/** What `runInit` did with one file. */
export type InitFileStatus = "created" | "updated" | "skipped";

/** One file `runInit` looked at, named relative to the init directory. */
export interface InitFileResult {
  file: string;
  status: InitFileStatus;
  /** For `.gitignore` when created or updated: the lines it appended. */
  addedLines?: string[];
}

/** Every file `runInit` looked at, in the order it handled them. */
export type InitResult = InitFileResult[];

/** The starter config: the spec's example, with every default spelled out. */
const STARTER_CONFIG = {
  $schema: `./${SCHEMA_FILE}`,
  model: "gpt-6-luna",
  outputDir: "reports",
  seenStore: "seen.json",
  searches: [
    {
      name: "java-warsaw",
      keywords: "Java Backend Developer",
      location: "Warsaw, Poland",
      postedWithin: "7d",
      maxOffers: 100,
      profile: "Java development",
    },
  ],
} satisfies ConfigInput;

const ENV_EXAMPLE = `# Copy this file to .env and set your OpenAI API key there.
# .env is ignored by git; never commit a real key.
OPENAI_API_KEY=
`;

const GITIGNORE_ENTRIES = [
  ".env",
  `${STARTER_CONFIG.outputDir}/`,
  STARTER_CONFIG.seenStore,
];

/**
 * Sets up `dir` for a first run: writes a starter config with one example
 * search, `config.schema.json` and `.env.example`, and appends the `.env`,
 * reports and seen store entries to `.gitignore`. Never overwrites an existing
 * file: existing files are skipped, and only missing `.gitignore` lines are
 * appended, so running it twice changes nothing.
 */
export async function runInit(dir: string): Promise<InitResult> {
  return [
    await writeIfAbsent(
      dir,
      DEFAULT_CONFIG_FILE,
      `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`,
    ),
    await writeIfAbsent(dir, SCHEMA_FILE, configJsonSchema()),
    await writeIfAbsent(dir, ENV_EXAMPLE_FILE, ENV_EXAMPLE),
    await appendGitignore(dir),
  ];
}

async function writeIfAbsent(
  dir: string,
  file: string,
  content: string,
): Promise<InitFileResult> {
  try {
    // "wx" fails if the file exists, so an existing file is never touched.
    await writeFile(join(dir, file), content, { flag: "wx" });
    return { file, status: "created" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { file, status: "skipped" };
    }
    throw error;
  }
}

async function appendGitignore(dir: string): Promise<InitFileResult> {
  const path = join(dir, GITIGNORE_FILE);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const present = new Set(
    (existing ?? "").split(/\r?\n/).map(normalizeIgnoreLine),
  );
  const addedLines = GITIGNORE_ENTRIES.filter(
    (entry) => !isIgnored(entry, present),
  );
  if (addedLines.length === 0) {
    return { file: GITIGNORE_FILE, status: "skipped" };
  }

  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const separator =
    existing === undefined || existing === "" || existing.endsWith("\n")
      ? ""
      : eol;
  const appended = `${separator}${addedLines.join(eol)}${eol}`;
  await writeFile(path, appended, { flag: "a" });
  return {
    file: GITIGNORE_FILE,
    status: existing === undefined ? "created" : "updated",
    addedLines,
  };
}

/**
 * Reduces a `.gitignore` line to a comparable form: trailing whitespace (which
 * git ignores) and a leading `/` (which only anchors the pattern to this
 * directory) are dropped. Leading whitespace is kept, since git keeps it too.
 */
function normalizeIgnoreLine(line: string): string {
  return line.trimEnd().replace(/^\//, "");
}

/**
 * Whether `entry` is already covered by one of the normalized `present`
 * lines. A directory entry like `reports/` is also covered by `reports`, but a
 * file entry like `.env` is not covered by `.env/`, which matches only a
 * directory.
 */
function isIgnored(entry: string, present: ReadonlySet<string>): boolean {
  if (present.has(entry)) return true;
  return entry.endsWith("/") && present.has(entry.slice(0, -1));
}
