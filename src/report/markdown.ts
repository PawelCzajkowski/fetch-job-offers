import type { ReportModel, ReportRow, ReportSearch } from "./model.ts";

/**
 * The Markdown report (spec section 10, `markdownB()` in the report-layout
 * prototype): a header with the run summary and one line per search, one
 * index table in the model's by-verdict order, then an anchored details
 * block per row. A pure function of the model; the run's start is shown in
 * the process's local time zone. No cost is shown.
 */
export function renderMarkdown(model: ReportModel): string {
  const rows = model.rowsByVerdict;
  const lines = [
    `# Job offers, ${formatLocalDateTime(model.startedAt)}`,
    "",
    summaryLine(model),
    "",
    ...model.searches.map(searchLine),
    "",
    "| Verdict | Title | Company | Search | Mode | Seniority | Salary | Posted |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(tableRow),
    "",
    "## Details",
    "",
    ...rows.flatMap(detailsBlock),
  ];
  while (lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

/** Shown for an absent or empty value. */
const PLACEHOLDER = "—";

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:mm` in local time. */
function formatLocalDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function summaryLine({ searches, counts }: ReportModel): string {
  // Seen offers shown by --all make the rows outnumber the new ones.
  const offers =
    counts.new === counts.rows
      ? plural(counts.new, "new offer")
      : `${plural(counts.rows, "offer")} (${counts.new} new)`;
  return [
    plural(searches.length, "search", "searches"),
    offers,
    `${counts.accepted} accepted`,
    `${counts.rejected} rejected`,
    `${counts.unjudged} unjudged`,
  ].join(" · ");
}

function searchLine(search: ReportSearch): string {
  const facts = [
    inline(search.keywords),
    inline(search.location),
    `posted within ${inline(search.postedWithin)}`,
    `profile: "${inline(search.profile)}"`,
  ];
  return `- **${inline(search.label)}**: ${facts.join(" · ")}`;
}

/** The same ID for the table's link and the details block's anchor. */
const anchorId = (row: ReportRow) =>
  `offer-${row.rowId.replace(/[^A-Za-z0-9_-]/g, "-")}`;

function tableRow(row: ReportRow): string {
  const cells = [
    row.verdict,
    `[${inline(row.title)}](#${anchorId(row)})`,
    inline(row.company),
    inline(row.foundBy),
    inline(row.workMode),
    inline(row.seniority),
    inline(row.salary),
    inline(row.postedDate),
  ];
  return `| ${cells.join(" | ")} |`;
}

function detailsBlock(row: ReportRow): string[] {
  const facts = [
    row.location,
    row.employmentType,
    row.jobFunction,
    row.industries,
  ].filter((fact): fact is string => fact !== null && fact.trim() !== "");
  const factsLine = [
    ...facts.map((fact) => inline(fact)),
    ...(row.alsoFoundBy.length > 0
      ? [`also found by: ${row.alsoFoundBy.map((l) => inline(l)).join(", ")}`]
      : []),
  ].join(" · ");

  // Two trailing spaces end each line with a hard line break.
  const block = [
    `<a id="${anchorId(row)}"></a>`,
    `### ${inline(row.title)}, ${inline(row.company)}`,
    "",
    `**${row.verdict}**: ${inline(row.reason)}  `,
  ];
  if (factsLine !== "") block.push(`${blockStart(factsLine)}  `);
  if (row.techStack.length > 0) {
    block.push(`Stack: ${row.techStack.map((t) => inline(t)).join(", ")}  `);
  }
  block.push(`[Open on LinkedIn](${safeUrl(row.url)})`, "");

  const description = descriptionBlock(row.descriptionLines);
  if (description.length === 0) {
    block.push("_No description._", "");
  } else {
    block.push(
      "<details><summary>Description</summary>",
      "",
      ...description,
      "",
      "</details>",
      "",
    );
  }
  return block;
}

/**
 * Keeps `- ` bullets and the empty lines between paragraphs; every other
 * line is escaped so it stays plain text. A blank line ends a list before a
 * following text line, which would otherwise join the last bullet.
 */
function descriptionBlock(lines: string[]): string[] {
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const text = line.trim();
    if (line.startsWith("- ")) {
      // An empty bullet under a text line would make it a heading.
      if (text === "-") continue;
      out.push(`- ${blockStart(escapeText(text.slice(2).trim()))}`);
      inList = true;
    } else if (text === "") {
      out.push("");
      inList = false;
    } else {
      if (inList) out.push("");
      out.push(blockStart(escapeText(text)));
      inList = false;
    }
  }
  while (out[0] === "") out.shift();
  while (out.at(-1) === "") out.pop();
  return out;
}

/**
 * Escapes the characters that could start Markdown or HTML inside a line:
 * emphasis, code, links, strikethrough, table pipes, tags, headings and
 * closing `#`s, and entity references. Leaves the text readable otherwise.
 */
function escapeText(text: string): string {
  return text
    .replace(/[\\`*_[\]~|<]/g, "\\$&")
    .replace(/(^|\s)#/g, "$1\\#")
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "&amp;");
}

/** One line of escaped text, safe in a table cell; absent shows a dash. */
function inline(value: string | null): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? PLACEHOLDER : escapeText(text);
}

/**
 * Escapes what would make an escaped line start a block: a quote, a list
 * item, or a setext heading underline.
 */
function blockStart(line: string): string {
  return line.replace(/^[-+=>]/, "\\$&").replace(/^(\d+)([.)])/, "$1\\$2");
}

/** Percent-encodes the characters that would end a Markdown link early. */
function safeUrl(url: string): string {
  return url.replace(
    /[\s()<>]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}
