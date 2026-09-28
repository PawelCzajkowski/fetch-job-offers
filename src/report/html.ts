import { createHash } from "node:crypto";
import { PAGE_FUNCTIONS, type PageData } from "./htmlPage.ts";
import type { ReportModel } from "./model.ts";

/**
 * The HTML report (spec section 10): one self-contained file with the rows
 * as inline JSON and a small inline script that renders the triage table
 * (`htmlPage.ts`). It makes no external requests, and a content security
 * policy pins the page to its own inline script and style.
 */

export interface HtmlOptions {
  /** IANA time zone for the run's date and time; the local one by default. */
  timeZone?: string;
}

const STYLE = `
  :root { --bg:#fafaf9; --panel:#fff; --text:#1c1917; --muted:#78716c; --line:#e7e5e4; --soft:#f5f5f4; --accent:#2563eb; --ok:#15803d; --no:#b91c1c; --warn:#a16207; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --panel:#1d1d1d; --text:#e7e5e4; --muted:#a8a29e; --line:#303030; --soft:#262626; --accent:#60a5fa; --ok:#4ade80; --no:#f87171; --warn:#facc15; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, sans-serif; }
  a { color: var(--accent); }
  button, select, input { font: inherit; color: var(--text); }
  .muted { color: var(--muted); }
  .nowrap { white-space: nowrap; }
  .badge { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
  .accepted { color: var(--ok); } .rejected { color: var(--no); } .unjudged { color: var(--warn); }
  .chip { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 6px; background: var(--panel); margin: 0 4px 4px 0; }
  .desc p { margin: 0 0 8px; } .desc ul { margin: 0 0 8px; padding-left: 20px; }
  .btn { padding: 5px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; text-decoration: none; display: inline-block; font-size: 14px; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .wrap { padding: 20px 16px 96px; max-width: 1280px; margin: 0 auto; }
  .head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  .head h1 { font-size: 20px; margin: 0; }
  .tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 14px 0; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; background: var(--panel); padding: 5px 12px; cursor: pointer; }
  .seg button.on { background: var(--text); color: var(--bg); }
  .tools select, .tools input { padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); }
  .tools input { min-width: 200px; flex: 1; }
  .status { margin-bottom: 6px; font-size: 13px; }
  .scroll { overflow: auto; max-height: 80vh; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th { text-align: left; font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--line); cursor: pointer; white-space: nowrap; user-select: none; position: sticky; top: 0; background: var(--panel); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr.detail td { background: var(--soft); padding: 14px 18px; }
  tr.row { cursor: pointer; } tr.row:hover td { background: var(--soft); }
  .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 20px; }
  @media (max-width: 720px) { .detail-grid { grid-template-columns: 1fr; } }
  .reason { margin-top: 0; }
  .chips { margin: 6px 0; }
  .actions { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; }
  .stack { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
`;

// The functions come from `htmlPage.ts` as source text; Node has already
// stripped their types. The bootstrap hands `boot` the browser's pieces.
const SCRIPT = `
(() => {
"use strict";
${PAGE_FUNCTIONS.map((fn) => fn.toString()).join("\n\n")}

boot(
  {
    document,
    copyText: (text) =>
      navigator.clipboard
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error("No clipboard")),
    fallbackCopy: (text) => {
      window.prompt("Copy the description:", text);
    },
    later: (fn, ms) => {
      setTimeout(fn, ms);
    },
  },
  JSON.parse(document.getElementById("report-data").textContent),
);
})();
`;

// Our own source must not end its element early; the data is escaped below.
for (const [name, text] of [
  ["script", SCRIPT],
  ["style", STYLE],
] as const) {
  if (/<\/(script|style)|<!--/i.test(text)) {
    throw new Error(`The HTML report's inline ${name} would break out`);
  }
}

const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const CSP = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );

// Built from code points so the source holds no raw line separators.
const UNSAFE_IN_SCRIPT = new RegExp(
  `[<>&${String.fromCharCode(0x2028, 0x2029)}]`,
  "g",
);

/**
 * JSON that is safe inside `<script type="application/json">`: `<`, `>` and
 * `&` can't close the element or start a comment, and U+2028 / U+2029 can't
 * trip up older parsers. `JSON.parse` reads the escapes back unchanged.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(
    UNSAFE_IN_SCRIPT,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** `YYYY-MM-DD HH:mm` in the given (or the local) time zone. */
function formatRunTime(date: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function summaryLine(model: ReportModel): string {
  const { counts } = model;
  // Seen offers shown by --all make the rows outnumber the new ones.
  const offers =
    counts.new === counts.rows
      ? plural(counts.new, "new offer", "new offers")
      : `${plural(counts.rows, "offer", "offers")} (${counts.new} new)`;
  return [
    plural(model.searches.length, "search", "searches"),
    offers,
    `${counts.accepted} accepted`,
    `${counts.rejected} rejected`,
    `${counts.unjudged} unjudged`,
  ].join(" · ");
}

export function renderHtml(
  model: ReportModel,
  options: HtmlOptions = {},
): string {
  const title = `Job offers, ${formatRunTime(model.startedAt, options.timeZone)}`;
  const data: PageData = {
    rows: model.rowsNewestFirst,
    searches: model.searches.map((search) => search.label),
    counts: model.counts,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header class="head"><h1>${escapeHtml(title)}</h1><span class="muted">${escapeHtml(summaryLine(model))}</span></header>
<main id="app"><noscript><p>This report needs JavaScript to show its table.</p></noscript></main>
</div>
<script type="application/json" id="report-data">${embedJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
