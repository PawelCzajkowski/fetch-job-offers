import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { configJsonSchema } from "../../src/config/schema.ts";

const committedPath = new URL("../../config.schema.json", import.meta.url);

describe("config.schema.json", () => {
  it("is up to date with the Zod schema (run `pnpm schema` to regenerate)", async () => {
    const committed = await readFile(committedPath, "utf8");
    expect(committed).toBe(configJsonSchema());
  });

  it("requires searches and each search's name, keywords, location and profile", () => {
    const schema = JSON.parse(configJsonSchema());
    expect(schema.required).toEqual(["searches"]);
    expect(schema.additionalProperties).toBe(false);

    const search = schema.properties.searches.items;
    expect([...search.required].sort()).toEqual(
      ["keywords", "location", "name", "profile"].sort(),
    );
    expect(search.additionalProperties).toBe(false);
  });

  it("documents the defaults", () => {
    const schema = JSON.parse(configJsonSchema());
    expect(schema.properties.model.default).toBe("gpt-6-luna");
    expect(schema.properties.outputDir.default).toBe("reports");
    expect(schema.properties.seenStore.default).toBe("seen.json");
    const search = schema.properties.searches.items;
    expect(search.properties.postedWithin.default).toBe("7d");
    expect(search.properties.maxOffers.default).toBe(100);
  });
});
