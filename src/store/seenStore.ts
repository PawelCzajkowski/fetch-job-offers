import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

/**
 * The seen store (`seen.json`): offer data once per LinkedIn job ID, and
 * verdicts per profile key. See the spec's section 8 and ADR-0002.
 */

const StoredOfferSchema = z.strictObject({
  title: z.string(),
  company: z.string(),
  location: z.string(),
  postedDate: z.string(),
  salary: z.string().nullable(),
  employmentType: z.string().nullable(),
  jobFunction: z.string().nullable(),
  industries: z.string().nullable(),
  description: z.string(),
  firstSeenAt: z.iso.datetime(),
});

const JudgedVerdictSchema = z.strictObject({
  verdict: z.enum(["accepted", "rejected"]),
  reason: z.string(),
  workMode: z.enum(["remote", "hybrid", "on-site"]).nullable(),
  seniority: z
    .enum(["intern", "junior", "mid", "senior", "lead", "principal"])
    .nullable(),
  techStack: z.array(z.string()),
  model: z.string(),
  judgedAt: z.iso.datetime(),
});

/** An unjudged verdict has the error as its reason and no judged fields. */
const UnjudgedVerdictSchema = z.strictObject({
  verdict: z.literal("unjudged"),
  reason: z.string(),
  model: z.string(),
  judgedAt: z.iso.datetime(),
});

const StoredVerdictSchema = z.discriminatedUnion("verdict", [
  JudgedVerdictSchema,
  UnjudgedVerdictSchema,
]);

// Recording drops keys outside the layout (a spread card's jobId, say) rather
// than throwing; loading a file stays strict.
const RecordedOfferSchema = StoredOfferSchema.strip();
const RecordedVerdictSchema = z.discriminatedUnion("verdict", [
  JudgedVerdictSchema.strip(),
  UnjudgedVerdictSchema.strip(),
]);

export type StoredOffer = z.infer<typeof StoredOfferSchema>;
export type JudgedVerdict = z.infer<typeof JudgedVerdictSchema>;
export type UnjudgedVerdict = z.infer<typeof UnjudgedVerdictSchema>;
export type StoredVerdict = z.infer<typeof StoredVerdictSchema>;

/** The on-disk layout of `seen.json`. */
export interface SeenFile {
  version: 1;
  offers: Record<string, StoredOffer>;
  verdicts: Record<string, Record<string, StoredVerdict>>;
}

/** Offer data as recorded; the store stamps `firstSeenAt`. */
export type OfferData = Omit<StoredOffer, "firstSeenAt">;

/** A verdict as recorded; the store stamps `judgedAt`. */
export type VerdictData =
  | Omit<JudgedVerdict, "judgedAt">
  | Omit<UnjudgedVerdict, "judgedAt">;

export interface SeenStoreOptions {
  now?: () => Date;
}

export interface SeenStore {
  /** Whether a verdict (of any kind) exists for the offer under this profile. */
  isSeen(profile: string, jobId: string): boolean;
  getVerdict(profile: string, jobId: string): StoredVerdict | undefined;
  /** Whether offer data is stored, so the detail fetch can be skipped. */
  hasOffer(jobId: string): boolean;
  getOffer(jobId: string): StoredOffer | undefined;
  /**
   * Stores offer data the first time a job ID is recorded. Later calls for
   * the same job ID keep the existing data and its `firstSeenAt`.
   */
  recordOffer(jobId: string, offer: OfferData): void;
  /**
   * Stores a verdict under the profile's key. It may replace only an
   * unjudged verdict; replacing an accepted or rejected one throws.
   */
  recordVerdict(profile: string, jobId: string, verdict: VerdictData): void;
  /** A copy of the store in its on-disk layout. */
  toJSON(): SeenFile;
}

/**
 * The key verdicts are stored under: the profile trimmed, internal
 * whitespace collapsed to single spaces, lower-cased. Any other change,
 * punctuation included, is a different profile.
 */
export function profileKey(profile: string): string {
  return profile.trim().replace(/\s+/g, " ").toLowerCase();
}

export function createSeenStore(options: SeenStoreOptions = {}): SeenStore {
  return buildStore(new Map(), new Map(), options);
}

// Maps, not plain objects, so a key such as "__proto__" (a profile is free
// text) is stored like any other.
type Offers = Map<string, StoredOffer>;
type Verdicts = Map<string, Map<string, StoredVerdict>>;

function buildStore(
  offers: Offers,
  verdicts: Verdicts,
  options: SeenStoreOptions,
): SeenStore {
  const now = options.now ?? (() => new Date());

  const lookup = (profile: string, jobId: string) =>
    verdicts.get(profileKey(profile))?.get(jobId);

  return {
    isSeen: (profile, jobId) => lookup(profile, jobId) !== undefined,

    getVerdict: (profile, jobId) => {
      const verdict = lookup(profile, jobId);
      return verdict && structuredClone(verdict);
    },

    hasOffer: (jobId) => offers.has(jobId),

    getOffer: (jobId) => {
      const offer = offers.get(jobId);
      return offer && structuredClone(offer);
    },

    recordOffer(jobId, offer) {
      if (offers.has(jobId)) return;
      offers.set(
        jobId,
        RecordedOfferSchema.parse({
          ...offer,
          firstSeenAt: now().toISOString(),
        }),
      );
    },

    recordVerdict(profile, jobId, verdict) {
      const key = profileKey(profile);
      const byJobId = verdicts.get(key) ?? new Map<string, StoredVerdict>();
      const existing = byJobId.get(jobId);
      if (existing && existing.verdict !== "unjudged") {
        throw new Error(
          `Offer ${jobId} is already judged "${existing.verdict}" under profile "${key}"; only unjudged verdicts can be replaced.`,
        );
      }
      byJobId.set(
        jobId,
        RecordedVerdictSchema.parse({
          ...verdict,
          judgedAt: now().toISOString(),
        }),
      );
      verdicts.set(key, byJobId);
    },

    // Object.fromEntries defines own properties, so "__proto__" survives.
    toJSON: () =>
      structuredClone({
        version: 1,
        offers: Object.fromEntries(offers),
        verdicts: Object.fromEntries(
          [...verdicts].map(([key, byJobId]) => [
            key,
            Object.fromEntries(byJobId),
          ]),
        ),
      }),
  };
}

/**
 * Loads the store from `path`. A missing file is an empty store; invalid
 * JSON, an unknown `version` or an invalid shape throws.
 */
export async function loadSeenStore(
  path: string,
  options: SeenStoreOptions = {},
): Promise<SeenStore> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createSeenStore(options);
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Seen store ${path} is not valid JSON.`, { cause: error });
  }

  const { offers, verdicts } = parseSeenFile(json, path);
  return buildStore(offers, verdicts, options);
}

/**
 * Validates the file's layout. Zod checks each record entry, but the
 * records themselves are walked with Object.entries: z.record skips a
 * "__proto__" key, which would drop that profile's verdicts unnoticed.
 */
function parseSeenFile(
  json: unknown,
  path: string,
): { offers: Offers; verdicts: Verdicts } {
  const invalid = (where: string, detail: string) =>
    new Error(
      `Seen store ${path} has an invalid shape at ${where}:\n${detail}`,
    );

  const entriesOf = (value: unknown, where: string) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalid(where, "expected an object");
    }
    return Object.entries(value);
  };

  const parse = <T>(schema: z.ZodType<T>, value: unknown, where: string) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw invalid(where, z.prettifyError(result.error));
    }
    return result.data;
  };

  const top = new Map(entriesOf(json, "the top level"));
  if (!top.has("version")) throw invalid("the top level", "missing version");
  const version = top.get("version");
  if (version !== 1) {
    throw new Error(
      `Seen store ${path} has unsupported version ${JSON.stringify(version)}; this tool reads version 1.`,
    );
  }
  const unknownKeys = [...top.keys()].filter(
    (key) => !["version", "offers", "verdicts"].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw invalid("the top level", `unknown keys ${unknownKeys.join(", ")}`);
  }

  const offers: Offers = new Map(
    entriesOf(top.get("offers"), "offers").map(([jobId, offer]) => [
      jobId,
      parse(StoredOfferSchema, offer, `offers[${JSON.stringify(jobId)}]`),
    ]),
  );
  const verdicts: Verdicts = new Map(
    entriesOf(top.get("verdicts"), "verdicts").map(([key, byJobId]) => {
      const where = `verdicts[${JSON.stringify(key)}]`;
      return [
        key,
        new Map(
          entriesOf(byJobId, where).map(([jobId, verdict]) => [
            jobId,
            parse(
              StoredVerdictSchema,
              verdict,
              `${where}[${JSON.stringify(jobId)}]`,
            ),
          ]),
        ),
      ];
    }),
  );
  return { offers, verdicts };
}

/**
 * Writes the store to `path` atomically: a temp file in the same directory,
 * then a rename over the target.
 */
export async function saveSeenStore(
  store: SeenStore,
  path: string,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(store.toJSON(), null, 2)}\n`);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
