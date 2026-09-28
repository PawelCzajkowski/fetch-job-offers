import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderHtml } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import type { ReportModel } from "./model.ts";

/**
 * Writes the report files (spec section 10, "Files"):
 * `YYYY-MM-DD_HHmm.md` and `.html` in the output directory, plus
 * `latest.md` and `latest.html` when the run judged or rejudged an offer and
 * isn't a dry run. The time in the name is the run's start in the process's
 * local time zone, the same zone both renderers use for their header.
 */

export type WriteReportResult =
  /** The model had no rows: nothing was written, not even the directory. */
  | { written: false }
  | {
      written: true;
      /** The timestamped reports, Markdown then HTML. */
      paths: string[];
      /**
       * `latest.md` then `latest.html` when they were replaced; empty when
       * they were left as they were (a dry run, or nothing judged).
       */
      latestPaths: string[];
    };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `YYYY-MM-DD_HHmm` for `date` in local time. No seconds and no UTC offset,
 * by design (spec section 10), so runs in the same local minute share a
 * name, including the repeated hour when clocks go back.
 */
export function reportFileStem(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * Writes `content` to `path` atomically: a temp file in the same directory,
 * then a rename over the target, so a crash never leaves a half-written file.
 */
async function writeAtomically(
  directory: string,
  name: string,
  content: string,
): Promise<string> {
  const path = join(directory, name);
  const tempPath = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return path;
}

/**
 * Renders the model and writes the report files into `outputDir`, creating
 * it (recursively) when it's missing. A second run in the same local minute
 * overwrites the first one's timestamped files. Returned paths are
 * `join(outputDir, name)`, so they're relative when `outputDir` is.
 */
export async function writeReportFiles(
  model: ReportModel,
  outputDir: string,
): Promise<WriteReportResult> {
  if (!model.hasRows) return { written: false };

  const markdown = renderMarkdown(model);
  const html = renderHtml(model);
  const stem = reportFileStem(model.startedAt);

  await mkdir(outputDir, { recursive: true });
  const paths = [
    await writeAtomically(outputDir, `${stem}.md`, markdown),
    await writeAtomically(outputDir, `${stem}.html`, html),
  ];

  const latestPaths =
    model.judgedAny && !model.dryRun
      ? [
          await writeAtomically(outputDir, "latest.md", markdown),
          await writeAtomically(outputDir, "latest.html", html),
        ]
      : [];

  return { written: true, paths, latestPaths };
}
