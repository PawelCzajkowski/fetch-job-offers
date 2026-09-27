import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSeenStore,
  loadSeenStore,
  type OfferData,
  profileKey,
  saveSeenStore,
  type VerdictData,
} from "../../src/store/seenStore.ts";

const offer: OfferData = {
  title: "Senior TypeScript Engineer",
  company: "Acme",
  location: "Warsaw, Poland",
  postedDate: "2026-09-22",
  salary: null,
  employmentType: "Full-time",
  jobFunction: "Engineering",
  industries: "Software Development",
  description: "Build things.\n- TypeScript\n- Node",
};

const accepted: VerdictData = {
  verdict: "accepted",
  reason: "TypeScript backend role.",
  workMode: "remote",
  seniority: "senior",
  techStack: ["TypeScript", "Node.js"],
  model: "gpt-6-luna",
};

const clockAt = (iso: string) => () => new Date(iso);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seen-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("profileKey", () => {
  it("trims, collapses internal whitespace and lower-cases", () => {
    expect(profileKey("  Java \n\t  Development  ")).toBe("java development");
  });

  it("treats punctuation and rewording as a different profile", () => {
    expect(profileKey("Java development.")).not.toBe(
      profileKey("Java development"),
    );
    expect(profileKey("Java developer")).not.toBe(
      profileKey("Java development"),
    );
  });
});

describe("loadSeenStore", () => {
  it("loads a missing file as an empty store", async () => {
    const store = await loadSeenStore(join(dir, "seen.json"));

    expect(store.toJSON()).toEqual({ version: 1, offers: {}, verdicts: {} });
  });

  it("throws a clear error on invalid JSON", async () => {
    const path = join(dir, "seen.json");
    await writeFile(path, "{ not json");

    await expect(loadSeenStore(path)).rejects.toThrow(/not valid JSON/);
  });

  it("throws a clear error on an unknown version", async () => {
    const path = join(dir, "seen.json");
    await writeFile(
      path,
      JSON.stringify({ version: 2, offers: {}, verdicts: {} }),
    );

    await expect(loadSeenStore(path)).rejects.toThrow(/unsupported version 2/);
  });

  it("throws a clear error on an invalid shape", async () => {
    const path = join(dir, "seen.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        offers: {},
        verdicts: { "java development": { "1": { verdict: "maybe" } } },
      }),
    );

    await expect(loadSeenStore(path)).rejects.toThrow(/invalid shape/);
  });

  it("validates entries under a __proto__ key and names where the error is", async () => {
    const path = join(dir, "seen.json");
    await writeFile(
      path,
      '{"version":1,"offers":{},"verdicts":{"__proto__":{"1":{"verdict":"maybe"}}}}',
    );

    await expect(loadSeenStore(path)).rejects.toThrow(
      /invalid shape at verdicts\["__proto__"\]\["1"\]/,
    );
  });

  it("throws on a missing version or unknown top-level keys", async () => {
    const path = join(dir, "seen.json");
    await writeFile(path, JSON.stringify({ offers: {}, verdicts: {} }));
    await expect(loadSeenStore(path)).rejects.toThrow(/missing version/);

    await writeFile(
      path,
      JSON.stringify({ version: 1, offers: {}, verdicts: {}, extra: 1 }),
    );
    await expect(loadSeenStore(path)).rejects.toThrow(/unknown keys extra/);
  });

  it("rejects an unjudged verdict that carries judged fields", async () => {
    const path = join(dir, "seen.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        offers: {},
        verdicts: {
          "java development": {
            "1": {
              verdict: "unjudged",
              reason: "Timed out.",
              workMode: "remote",
              model: "gpt-6-luna",
              judgedAt: "2026-09-27T10:00:00.000Z",
            },
          },
        },
      }),
    );

    await expect(loadSeenStore(path)).rejects.toThrow(/invalid shape/);
  });
});

describe("lookups and recording", () => {
  it("is not seen until a verdict is recorded under the profile", () => {
    const store = createSeenStore();

    expect(store.isSeen("Java development", "1")).toBe(false);
    expect(store.getVerdict("Java development", "1")).toBeUndefined();

    store.recordVerdict("Java development", "1", accepted);

    expect(store.isSeen("Java development", "1")).toBe(true);
  });

  it("looks verdicts up by the normalised profile key", () => {
    const store = createSeenStore({
      now: clockAt("2026-09-27T10:00:00.000Z"),
    });
    store.recordVerdict("Java development", "1", accepted);

    expect(store.isSeen("  java   DEVELOPMENT ", "1")).toBe(true);
    expect(store.isSeen("TypeScript development", "1")).toBe(false);
    expect(store.getVerdict("JAVA development", "1")).toEqual({
      ...accepted,
      judgedAt: "2026-09-27T10:00:00.000Z",
    });
  });

  it("stores offer data once per job ID, keeping the first firstSeenAt", () => {
    let now = new Date("2026-09-27T10:00:00.000Z");
    const store = createSeenStore({ now: () => now });

    expect(store.hasOffer("1")).toBe(false);

    store.recordOffer("1", offer);
    now = new Date("2026-09-28T10:00:00.000Z");
    store.recordOffer("1", { ...offer, title: "Changed" });

    expect(store.hasOffer("1")).toBe(true);
    expect(store.getOffer("1")).toEqual({
      ...offer,
      firstSeenAt: "2026-09-27T10:00:00.000Z",
    });
  });

  it("keeps only the layout's fields when recording", () => {
    const store = createSeenStore();
    store.recordOffer("1", { ...offer, jobId: "1" } as OfferData);

    expect(store.getOffer("1")).not.toHaveProperty("jobId");
  });

  it("records unjudged verdicts with no judged fields", () => {
    const store = createSeenStore({
      now: clockAt("2026-09-27T10:00:00.000Z"),
    });
    store.recordVerdict("Java development", "1", {
      verdict: "unjudged",
      reason: "The model refused.",
      model: "gpt-6-luna",
    });

    expect(store.isSeen("Java development", "1")).toBe(true);
    expect(store.getVerdict("Java development", "1")).toEqual({
      verdict: "unjudged",
      reason: "The model refused.",
      model: "gpt-6-luna",
      judgedAt: "2026-09-27T10:00:00.000Z",
    });
  });

  it("replaces an unjudged verdict with a real one or a newer unjudged one", () => {
    let now = new Date("2026-09-27T10:00:00.000Z");
    const store = createSeenStore({ now: () => now });
    store.recordVerdict("Java development", "1", {
      verdict: "unjudged",
      reason: "Timed out.",
      model: "gpt-6-luna",
    });

    now = new Date("2026-09-28T10:00:00.000Z");
    store.recordVerdict("Java development", "1", {
      verdict: "unjudged",
      reason: "Refused.",
      model: "gpt-6-luna",
    });
    expect(store.getVerdict("Java development", "1")).toMatchObject({
      reason: "Refused.",
      judgedAt: "2026-09-28T10:00:00.000Z",
    });

    store.recordVerdict("Java development", "1", accepted);
    expect(store.getVerdict("Java development", "1")).toMatchObject({
      verdict: "accepted",
      judgedAt: "2026-09-28T10:00:00.000Z",
    });
  });

  it("refuses to overwrite an accepted or rejected verdict", () => {
    const store = createSeenStore();
    store.recordVerdict("Java development", "1", accepted);

    expect(() =>
      store.recordVerdict("Java development", "1", {
        ...accepted,
        verdict: "rejected",
      }),
    ).toThrow(/already judged "accepted"/);
    expect(store.getVerdict("Java development", "1")?.verdict).toBe("accepted");
  });

  it("keeps verdicts under different profiles independent", () => {
    const store = createSeenStore();
    store.recordVerdict("Java development", "1", {
      ...accepted,
      verdict: "rejected",
    });
    store.recordVerdict("TypeScript development", "1", accepted);

    expect(store.getVerdict("Java development", "1")?.verdict).toBe("rejected");
    expect(store.getVerdict("TypeScript development", "1")?.verdict).toBe(
      "accepted",
    );
  });

  it("does not let callers mutate stored records through lookups", () => {
    const store = createSeenStore();
    store.recordOffer("1", offer);
    store.recordVerdict("Java development", "1", accepted);

    const stored = store.getVerdict("Java development", "1");
    if (stored?.verdict === "accepted") stored.techStack.push("Java");
    const storedOffer = store.getOffer("1");
    if (storedOffer) storedOffer.title = "Mutated";

    expect(store.toJSON().verdicts["java development"]?.["1"]).toMatchObject({
      techStack: ["TypeScript", "Node.js"],
    });
    expect(store.getOffer("1")?.title).toBe(offer.title);
  });
});

describe("saveSeenStore", () => {
  it("writes a file that round-trips and matches the spec layout", async () => {
    const path = join(dir, "seen.json");
    const store = createSeenStore({
      now: clockAt("2026-09-27T10:00:00.000Z"),
    });
    store.recordOffer("1", offer);
    store.recordVerdict("  Java  Development ", "1", accepted);
    store.recordVerdict("TypeScript development", "1", {
      verdict: "unjudged",
      reason: "Refused.",
      model: "gpt-6-luna",
    });

    await saveSeenStore(store, path);

    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written).toEqual({
      version: 1,
      offers: {
        "1": { ...offer, firstSeenAt: "2026-09-27T10:00:00.000Z" },
      },
      verdicts: {
        "java development": {
          "1": { ...accepted, judgedAt: "2026-09-27T10:00:00.000Z" },
        },
        "typescript development": {
          "1": {
            verdict: "unjudged",
            reason: "Refused.",
            model: "gpt-6-luna",
            judgedAt: "2026-09-27T10:00:00.000Z",
          },
        },
      },
    });

    const reloaded = await loadSeenStore(path);
    expect(reloaded.toJSON()).toEqual(store.toJSON());
  });

  it("round-trips a profile whose key is __proto__", async () => {
    const path = join(dir, "seen.json");
    const store = createSeenStore();
    store.recordVerdict("  __PROTO__ ", "1", accepted);

    expect(store.isSeen("Java development", "verdict")).toBe(false);
    await saveSeenStore(store, path);

    const reloaded = await loadSeenStore(path);
    expect(reloaded.isSeen("__proto__", "1")).toBe(true);
    expect(Object.keys(reloaded.toJSON().verdicts)).toEqual(["__proto__"]);
  });

  it("leaves no temp file behind and overwrites an existing file", async () => {
    const path = join(dir, "seen.json");
    const store = createSeenStore();
    await saveSeenStore(store, path);
    store.recordOffer("1", offer);
    await saveSeenStore(store, path);

    expect(await readdir(dir)).toEqual(["seen.json"]);
    expect((await loadSeenStore(path)).hasOffer("1")).toBe(true);
  });

  it("creates the directory when it does not exist", async () => {
    const path = join(dir, "nested", "seen.json");

    await saveSeenStore(createSeenStore(), path);

    expect(await readdir(join(dir, "nested"))).toEqual(["seen.json"]);
  });
});
