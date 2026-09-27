import { z } from "zod";

/** Lowercase letters and digits in hyphen-separated groups, e.g. `java-warsaw`. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The `postedWithin` rule from `postedWithinToSeconds` (`<integer><h|d>`),
 * narrowed to positive amounts so a search never asks for a zero window.
 * Kept as a regex so it also lands in `config.schema.json` as a `pattern`.
 */
const DURATION_PATTERN = /^[1-9]\d*[hd]$/;

export const savedSearchSchema = z.strictObject({
  name: z
    .string()
    .regex(SLUG_PATTERN, {
      error:
        "must be a slug: lowercase letters, digits and hyphens (e.g. java-warsaw)",
    })
    .describe(
      "Unique slug naming this saved search, e.g. java-warsaw. Used with --search.",
    ),
  keywords: z
    .string()
    .min(1)
    .describe("LinkedIn search keywords, e.g. Java Backend Developer."),
  location: z
    .string()
    .min(1)
    .describe("Free-text LinkedIn location, e.g. Warsaw, Poland."),
  postedWithin: z
    .string()
    .regex(DURATION_PATTERN, {
      error: "must be a duration like 1h, 24h, 3d or 7d",
    })
    .default("7d")
    .describe("Only offers posted within this window: <number>h or <number>d."),
  maxOffers: z
    .int()
    .positive()
    .default(100)
    .describe("Maximum number of new offers to fetch and judge per run."),
  profile: z
    .string()
    .min(1)
    .describe(
      "The kind of work this search looks for, e.g. Java development. Offers are judged against it.",
    ),
});

export const configSchema = z.strictObject({
  $schema: z
    .string()
    .optional()
    .describe("Path or URL of this file's JSON Schema, for editors."),
  model: z
    .string()
    .min(1)
    .default("gpt-6-luna")
    .describe("OpenAI model that judges offers."),
  outputDir: z
    .string()
    .min(1)
    .default("reports")
    .describe("Directory for reports, relative to this config file."),
  seenStore: z
    .string()
    .min(1)
    .default("seen.json")
    .describe("File remembering seen offers, relative to this config file."),
  searches: z
    .array(savedSearchSchema)
    .superRefine((searches, ctx) => {
      const seen = new Set<string>();
      searches.forEach((search, index) => {
        if (seen.has(search.name)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "name"],
            message: `duplicate search name ${JSON.stringify(search.name)}`,
          });
        }
        seen.add(search.name);
      });
    })
    .describe("Saved searches, each with its criteria and profile."),
});

/** A saved search as written in the config, before defaults. */
export type SavedSearchInput = z.input<typeof savedSearchSchema>;
/** A saved search with defaults applied. */
export type SavedSearch = z.output<typeof savedSearchSchema>;
/** The config file as written, before defaults. */
export type ConfigInput = z.input<typeof configSchema>;

/**
 * The JSON Schema for the config file, as committed in `config.schema.json`.
 * Generated from the input side of `configSchema`, so fields with defaults
 * are optional.
 */
export function configJsonSchema(): string {
  const schema = z.toJSONSchema(configSchema, { io: "input" });
  return `${JSON.stringify(schema, null, 2)}\n`;
}
