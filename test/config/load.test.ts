import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/load.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fjo-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: unknown, name = "config.json") {
  const path = join(dir, name);
  const text =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  await writeFile(path, text);
  return path;
}

const minimalSearch = {
  name: "java-warsaw",
  keywords: "Java Backend Developer",
  location: "Warsaw, Poland",
  profile: "Java development",
};

async function loadError(content: unknown): Promise<ConfigError> {
  const path = await writeConfig(content);
  const error = await loadConfig(path).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
}

describe("loadConfig", () => {
  it("loads the full example config from the spec", async () => {
    const path = await writeConfig({
      $schema: "./config.schema.json",
      model: "gpt-6-luna",
      outputDir: "reports",
      seenStore: "seen.json",
      searches: [{ ...minimalSearch, postedWithin: "7d", maxOffers: 100 }],
    });

    await expect(loadConfig(path)).resolves.toEqual({
      model: "gpt-6-luna",
      outputDir: join(dir, "reports"),
      seenStore: join(dir, "seen.json"),
      searches: [{ ...minimalSearch, postedWithin: "7d", maxOffers: 100 }],
    });
  });

  it("applies the defaults to a minimal config", async () => {
    const path = await writeConfig({ searches: [minimalSearch] });

    await expect(loadConfig(path)).resolves.toEqual({
      model: "gpt-6-luna",
      outputDir: join(dir, "reports"),
      seenStore: join(dir, "seen.json"),
      searches: [{ ...minimalSearch, postedWithin: "7d", maxOffers: 100 }],
    });
  });

  it("keeps explicit values over the defaults", async () => {
    const path = await writeConfig({
      model: "gpt-other",
      outputDir: "out/reports",
      seenStore: "state/seen-offers.json",
      searches: [{ ...minimalSearch, postedWithin: "24h", maxOffers: 5 }],
    });

    const config = await loadConfig(path);
    expect(config.model).toBe("gpt-other");
    expect(config.outputDir).toBe(join(dir, "out", "reports"));
    expect(config.seenStore).toBe(join(dir, "state", "seen-offers.json"));
    expect(config.searches[0]).toMatchObject({
      postedWithin: "24h",
      maxOffers: 5,
    });
  });

  it("resolves outputDir and seenStore relative to the config file, not the cwd", async () => {
    await mkdir(join(dir, "nested"));
    const path = await writeConfig(
      { searches: [minimalSearch] },
      join("nested", "fetch-job-offers.config.json"),
    );

    const config = await loadConfig(path);
    expect(config.outputDir).toBe(join(dir, "nested", "reports"));
    expect(config.seenStore).toBe(join(dir, "nested", "seen.json"));
  });

  it("keeps absolute outputDir and seenStore as they are", async () => {
    const outputDir = join(tmpdir(), "elsewhere", "reports");
    const seenStore = join(tmpdir(), "elsewhere", "seen.json");
    const path = await writeConfig({
      outputDir,
      seenStore,
      searches: [minimalSearch],
    });

    const config = await loadConfig(path);
    expect(config.outputDir).toBe(outputDir);
    expect(config.seenStore).toBe(seenStore);
  });

  it("reports an unknown key with its exact path", async () => {
    const error = await loadError({
      searches: [{ ...minimalSearch, postedWithn: "7d" }],
    });
    expect(error.reason).toBe("invalid-config");
    expect(error.message).toContain("searches[0].postedWithn");
  });

  it("reports an unknown top-level key", async () => {
    const error = await loadError({ searches: [minimalSearch], modle: "x" });
    expect(error.message).toContain("modle");
  });

  it.each(["name", "keywords", "location", "profile"])(
    "requires %s on every search",
    async (field) => {
      const search: Record<string, unknown> = { ...minimalSearch };
      delete search[field];
      const error = await loadError({ searches: [search] });
      expect(error.message).toContain(`searches[0].${field}: required`);
    },
  );

  it("requires searches", async () => {
    const error = await loadError({ model: "gpt-6-luna" });
    expect(error.message).toContain("searches: required");
  });

  it.each(["Java-Warsaw", "java warsaw", "java_warsaw", "-java", "java-", ""])(
    "rejects the non-slug search name %j",
    async (name) => {
      const error = await loadError({
        searches: [{ ...minimalSearch, name }],
      });
      expect(error.message).toContain("searches[0].name");
    },
  );

  it("accepts slugs with digits and hyphens", async () => {
    const path = await writeConfig({
      searches: [{ ...minimalSearch, name: "java-17-warsaw2" }],
    });
    const config = await loadConfig(path);
    expect(config.searches[0]?.name).toBe("java-17-warsaw2");
  });

  it("rejects duplicate search names, pointing at the duplicate", async () => {
    const error = await loadError({
      searches: [
        minimalSearch,
        { ...minimalSearch, name: "ts-poland" },
        { ...minimalSearch, keywords: "Kotlin" },
      ],
    });
    expect(error.message).toContain("searches[2].name");
    expect(error.message).toContain("java-warsaw");
  });

  it.each(["abc", "7", "1w", "1.5d", "-1d", "0d", "0h", " 7d"])(
    "rejects the postedWithin %j",
    async (postedWithin) => {
      const error = await loadError({
        searches: [{ ...minimalSearch, postedWithin }],
      });
      expect(error.message).toContain("searches[0].postedWithin");
    },
  );

  it.each(["1h", "24h", "3d", "7d", "30d"])(
    "accepts the postedWithin %j",
    async (postedWithin) => {
      const path = await writeConfig({
        searches: [{ ...minimalSearch, postedWithin }],
      });
      const config = await loadConfig(path);
      expect(config.searches[0]?.postedWithin).toBe(postedWithin);
    },
  );

  it.each([0, -1, 1.5, "100"])(
    "rejects the maxOffers %j",
    async (maxOffers) => {
      const error = await loadError({
        searches: [{ ...minimalSearch, maxOffers }],
      });
      expect(error.message).toContain("searches[0].maxOffers");
    },
  );

  it("rejects a non-string $schema", async () => {
    const error = await loadError({ $schema: 1, searches: [minimalSearch] });
    expect(error.message).toContain("$schema");
  });

  it("lists every problem, not only the first", async () => {
    const error = await loadError({
      searches: [{ ...minimalSearch, name: "Bad Name", maxOffers: 0 }],
    });
    expect(error.message).toContain("searches[0].name");
    expect(error.message).toContain("searches[0].maxOffers");
  });

  it("names the file when it is missing", async () => {
    const path = join(dir, "nope.json");
    const error = await loadConfig(path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).reason).toBe("not-found");
    expect((error as ConfigError).message).toContain(path);
  });

  it("accepts a file saved with a UTF-8 BOM", async () => {
    const path = await writeConfig(
      `﻿${JSON.stringify({ searches: [minimalSearch] })}`,
    );
    const config = await loadConfig(path);
    expect(config.searches[0]?.name).toBe("java-warsaw");
  });

  it("gives a clear message for invalid JSON", async () => {
    const error = await loadError("{ searches: [ }");
    expect(error.reason).toBe("invalid-json");
    expect(error.message).toMatch(/not valid JSON/);
    expect(error.message).toContain("config.json");
  });
});
