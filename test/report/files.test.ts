import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { reportFileStem, writeReportFiles } from "../../src/report/files.ts";
import { renderHtml } from "../../src/report/html.ts";
import { renderMarkdown } from "../../src/report/markdown.ts";
import { buildReportModel, type ReportModel } from "../../src/report/model.ts";
import type { HandledOffer, RunResult } from "../../src/run/runLoop.ts";

// File names and both report headers use the process's local time zone, so
// pin it for these tests. A zone other than UTC proves local time is used;
// the old value is restored so other test files in the worker keep theirs.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Warsaw";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// 08:05 UTC is 10:05 in Warsaw (CEST).
const STARTED_AT = new Date("2026-09-27T08:05:42.000Z");
const STEM = "2026-09-27_1005";

function handled(overrides: Partial<HandledOffer> = {}): HandledOffer {
  return {
    jobId: "4467798222",
    profile: "Java development",
    origin: "new",
    offer: {
      title: "Senior Java Developer",
      company: "Acme",
      location: "Warsaw, Poland",
      postedDate: "2026-09-22",
      salary: null,
      employmentType: "Full-time",
      jobFunction: "Engineering",
      industries: "Software Development",
      description: "About us\n- Java",
      firstSeenAt: "2026-09-27T08:06:00.000Z",
    },
    verdict: {
      verdict: "accepted",
      reason: "Java backend role",
      workMode: "hybrid",
      seniority: "senior",
      techStack: ["Java"],
      model: "gpt-6-luna",
      judgedAt: "2026-09-27T08:06:00.000Z",
    },
    foundBy: "java-warsaw",
    alsoFoundBy: [],
    ...overrides,
  };
}

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    startedAt: STARTED_AT,
    searches: [
      {
        label: "java-warsaw",
        profile: "Java development",
        criteria: {
          keywords: "Java",
          location: "Warsaw",
          postedWithin: "7d",
          maxOffers: 50,
        },
        counts: {
          cardsFetched: 1,
          seenSkipped: 0,
          new: 1,
          accepted: 1,
          rejected: 0,
          unjudged: 0,
          removed: 0,
          unfetched: 0,
          seenIncluded: 0,
          rejudgedAccepted: 0,
          rejudgedRejected: 0,
          rejudgedUnjudged: 0,
        },
        partial: null,
      },
    ],
    offers: [handled()],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    dryRun: false,
    stopped: null,
    notRun: [],
    ...overrides,
  };
}

const model = (overrides: Partial<RunResult> = {}): ReportModel =>
  buildReportModel(runResult(overrides));

let root: string;
let outDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fjo-report-files-"));
  outDir = join(root, "reports");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (name: string) => readFile(join(outDir, name), "utf8");
const listing = async (dir = outDir) => (await readdir(dir)).sort();

describe("reportFileStem", () => {
  it("is YYYY-MM-DD_HHmm in local time, without seconds", () => {
    expect(reportFileStem(STARTED_AT)).toBe(STEM);
  });

  it("zero-pads every field", () => {
    // 2026-01-02 03:04 in Warsaw (CET, UTC+1).
    expect(reportFileStem(new Date("2026-01-02T02:04:59.000Z"))).toBe(
      "2026-01-02_0304",
    );
  });
});

describe("writeReportFiles: a real run that judged offers", () => {
  it("writes both timestamped reports and both latest files", async () => {
    const result = await writeReportFiles(model(), outDir);

    expect(result).toEqual({
      written: true,
      paths: [join(outDir, `${STEM}.md`), join(outDir, `${STEM}.html`)],
      latestPaths: [join(outDir, "latest.md"), join(outDir, "latest.html")],
    });
    expect(await listing()).toEqual([
      `${STEM}.html`,
      `${STEM}.md`,
      "latest.html",
      "latest.md",
    ]);
  });

  it("writes the renderers' output, the same in the latest files", async () => {
    const m = model();
    await writeReportFiles(m, outDir);

    const markdown = renderMarkdown(m);
    const html = renderHtml(m);
    expect(await read(`${STEM}.md`)).toBe(markdown);
    expect(await read(`${STEM}.html`)).toBe(html);
    expect(await read("latest.md")).toBe(markdown);
    expect(await read("latest.html")).toBe(html);
  });

  it("uses the same local time in the file name and the headers", async () => {
    await writeReportFiles(model(), outDir);

    expect(await read(`${STEM}.md`)).toContain("2026-09-27 10:05");
    expect(await read(`${STEM}.html`)).toContain("2026-09-27 10:05");
  });

  it("replaces existing latest files", async () => {
    await writeReportFiles(model(), outDir);
    await writeFile(join(outDir, "latest.md"), "old");
    await writeFile(join(outDir, "latest.html"), "old");

    const m = model({ startedAt: new Date("2026-09-28T07:00:00.000Z") });
    await writeReportFiles(m, outDir);

    expect(await read("latest.md")).toBe(renderMarkdown(m));
    expect(await read("latest.html")).toBe(renderHtml(m));
  });

  it("creates a missing output directory, however deep", async () => {
    const deep = join(root, "a", "b", "reports");
    const result = await writeReportFiles(model(), deep);

    expect(result.written).toBe(true);
    expect(await listing(deep)).toContain(`${STEM}.md`);
  });

  it("overwrites the reports of an earlier run in the same minute", async () => {
    await writeReportFiles(model(), outDir);

    const later = model({
      startedAt: new Date("2026-09-27T08:05:59.000Z"),
      offers: [handled({ jobId: "999", foundBy: "java-warsaw" })],
    });
    await writeReportFiles(later, outDir);

    expect(await read(`${STEM}.md`)).toBe(renderMarkdown(later));
    expect(await read(`${STEM}.html`)).toBe(renderHtml(later));
    expect(await listing()).toHaveLength(4);
  });

  it("leaves no temp files behind", async () => {
    await writeReportFiles(model(), outDir);
    await writeReportFiles(model(), outDir);

    const names = await listing();
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(names.filter((name) => name.startsWith("."))).toEqual([]);
  });
});

describe("writeReportFiles: latest left alone", () => {
  async function seedLatest() {
    await writeReportFiles(model(), outDir);
    await writeFile(join(outDir, "latest.md"), "previous markdown");
    await writeFile(join(outDir, "latest.html"), "previous html");
  }

  const later = new Date("2026-09-28T07:00:00.000Z");
  const laterStem = "2026-09-28_0900";

  it("on a dry run, which still writes the timestamped reports", async () => {
    await seedLatest();

    const m = model({ startedAt: later, dryRun: true });
    const result = await writeReportFiles(m, outDir);

    expect(result).toEqual({
      written: true,
      paths: [
        join(outDir, `${laterStem}.md`),
        join(outDir, `${laterStem}.html`),
      ],
      latestPaths: [],
    });
    expect(await read(`${laterStem}.md`)).toBe(renderMarkdown(m));
    expect(await read("latest.md")).toBe("previous markdown");
    expect(await read("latest.html")).toBe("previous html");
  });

  it("when the run judged nothing (--all showing only seen offers)", async () => {
    await seedLatest();

    const m = model({
      startedAt: later,
      offers: [handled({ origin: "seen" })],
    });
    expect(m.hasRows).toBe(true);
    expect(m.judgedAny).toBe(false);
    const result = await writeReportFiles(m, outDir);

    expect(result).toEqual({
      written: true,
      paths: [
        join(outDir, `${laterStem}.md`),
        join(outDir, `${laterStem}.html`),
      ],
      latestPaths: [],
    });
    expect(await read("latest.md")).toBe("previous markdown");
    expect(await read("latest.html")).toBe("previous html");
  });
});

describe("writeReportFiles: no rows", () => {
  it("writes nothing and doesn't create the directory", async () => {
    const result = await writeReportFiles(model({ offers: [] }), outDir);

    expect(result).toEqual({ written: false });
    expect(await listing(root)).toEqual([]);
  });
});
