import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/config/init.ts";
import { DEFAULT_CONFIG_FILE, loadConfig } from "../../src/config/load.ts";
import { configJsonSchema } from "../../src/config/schema.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fjo-init-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function read(name: string): Promise<string> {
  return readFile(join(dir, name), "utf8");
}

describe("runInit", () => {
  it("writes the starter files into an empty directory", async () => {
    const result = await runInit(dir);

    expect(result).toEqual([
      { file: DEFAULT_CONFIG_FILE, status: "created" },
      { file: "config.schema.json", status: "created" },
      { file: ".env.example", status: "created" },
      {
        file: ".gitignore",
        status: "created",
        addedLines: [".env", "reports/", "seen.json"],
      },
    ]);
    expect((await readdir(dir)).sort()).toEqual(
      [
        ".env.example",
        ".gitignore",
        "config.schema.json",
        DEFAULT_CONFIG_FILE,
      ].sort(),
    );
  });

  it("writes a starter config with one example search that passes validation", async () => {
    await runInit(dir);

    const raw = JSON.parse(await read(DEFAULT_CONFIG_FILE));
    expect(raw.$schema).toBe("./config.schema.json");

    const config = await loadConfig(join(dir, DEFAULT_CONFIG_FILE));
    expect(config.searches).toEqual([
      {
        name: "java-warsaw",
        keywords: "Java Backend Developer",
        location: "Warsaw, Poland",
        postedWithin: "7d",
        maxOffers: 100,
        profile: "Java development",
      },
    ]);
    expect(config.outputDir).toBe(join(dir, "reports"));
    expect(config.seenStore).toBe(join(dir, "seen.json"));
  });

  it("writes config.schema.json from the Zod schema", async () => {
    await runInit(dir);
    expect(await read("config.schema.json")).toBe(configJsonSchema());
  });

  it("writes a .env.example with placeholders only", async () => {
    await runInit(dir);
    const text = await read(".env.example");

    expect(text).toMatch(/^OPENAI_API_KEY=$/m);
    expect(text).toMatch(/^#.*\.env/m);
    const assignments = text
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(assignments).toEqual(["OPENAI_API_KEY="]);
  });

  it("writes a .gitignore with the three entries when none exists", async () => {
    await runInit(dir);
    expect(await read(".gitignore")).toBe(".env\nreports/\nseen.json\n");
  });

  it("never overwrites an existing file and reports it as skipped", async () => {
    const existing = '{ "searches": [], "note": "mine" }\n';
    await writeFile(join(dir, DEFAULT_CONFIG_FILE), existing);
    await writeFile(join(dir, ".env.example"), "OPENAI_API_KEY=sk-mine\n");

    const result = await runInit(dir);

    expect(await read(DEFAULT_CONFIG_FILE)).toBe(existing);
    expect(await read(".env.example")).toBe("OPENAI_API_KEY=sk-mine\n");
    expect(result).toContainEqual({
      file: DEFAULT_CONFIG_FILE,
      status: "skipped",
    });
    expect(result).toContainEqual({ file: ".env.example", status: "skipped" });
    expect(result).toContainEqual({
      file: "config.schema.json",
      status: "created",
    });
  });

  it("appends only the missing .gitignore lines, keeping existing content", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n.env\n");

    const result = await runInit(dir);

    expect(await read(".gitignore")).toBe(
      "node_modules/\n.env\nreports/\nseen.json\n",
    );
    expect(result).toContainEqual({
      file: ".gitignore",
      status: "updated",
      addedLines: ["reports/", "seen.json"],
    });
  });

  it("adds a newline before appending when .gitignore lacks a trailing one", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/");
    await runInit(dir);
    expect(await read(".gitignore")).toBe(
      "node_modules/\n.env\nreports/\nseen.json\n",
    );
  });

  it("keeps CRLF line endings in an existing .gitignore", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\r\n");
    await runInit(dir);
    expect(await read(".gitignore")).toBe(
      "node_modules/\r\n.env\r\nreports/\r\nseen.json\r\n",
    );
  });

  it("treats equivalent .gitignore spellings as already present", async () => {
    const existing = "/.env\n/reports\nseen.json  \n";
    await writeFile(join(dir, ".gitignore"), existing);

    const result = await runInit(dir);

    expect(await read(".gitignore")).toBe(existing);
    expect(result).toContainEqual({ file: ".gitignore", status: "skipped" });
  });

  it("doesn't count directory-only or indented lines as the file entries", async () => {
    // `.env/` matches only a directory, and git keeps leading spaces.
    await writeFile(join(dir, ".gitignore"), ".env/\n  seen.json\nreports/\n");

    const result = await runInit(dir);

    expect(result).toContainEqual({
      file: ".gitignore",
      status: "updated",
      addedLines: [".env", "seen.json"],
    });
  });

  it("changes nothing when run twice", async () => {
    await runInit(dir);
    const names = (await readdir(dir)).sort();
    const before = await Promise.all(names.map(read));

    const result = await runInit(dir);

    expect(result.every((entry) => entry.status === "skipped")).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(names);
    expect(await Promise.all(names.map(read))).toEqual(before);
  });
});
