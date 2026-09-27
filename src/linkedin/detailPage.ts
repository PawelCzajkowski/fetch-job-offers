import * as cheerio from "cheerio";

export interface OfferDetail {
  salary: string | null;
  employmentType: string | null;
  jobFunction: string | null;
  industries: string | null;
  description: string;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The naive cleanup: line breaks at `<br>`, list items and block ends, list
 * items prefixed `- `, then plain text. The result is lines, with list items
 * as `- ` lines and at most one blank line between paragraphs. `</li>` adds
 * no break of its own, since the next `<li>` (or the list's end) already
 * does; otherwise every item would be followed by a blank line. Whitespace
 * in the source markup (indentation, newlines between tags) is insignificant
 * in HTML, so it is collapsed before the breaks go in.
 */
function cleanDescription(html: string): string {
  const withBreaks = html
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h\d|ul|ol)>/gi, "\n");

  return cheerio
    .load(`<div>${withBreaks}</div>`)("div")
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turns a LinkedIn guest detail page into its parsed fields and a cleaned
 * description. Salary, employment type, job function and industries are
 * `null` when the page doesn't carry them, never guessed from the text. The
 * "Seniority level" criterion is ignored (ADR-0001). See the spec's section 5.
 */
export function parseDetailPage(html: string): OfferDetail {
  const $ = cheerio.load(html);

  const criteria = new Map<string, string>();
  $("ul.description__job-criteria-list > li").each((_, element) => {
    const item = $(element);
    const label = collapseWhitespace(
      item.find("h3.description__job-criteria-subheader").text(),
    );
    const value = collapseWhitespace(
      item.find("span.description__job-criteria-text").text(),
    );
    if (label && value) {
      criteria.set(label, value);
    }
  });

  return {
    salary:
      collapseWhitespace($("div.salary.compensation__salary").text()) || null,
    employmentType: criteria.get("Employment type") ?? null,
    jobFunction: criteria.get("Job function") ?? null,
    industries: criteria.get("Industries") ?? null,
    description: cleanDescription(
      $("div.show-more-less-html__markup").html() ?? "",
    ),
  };
}
