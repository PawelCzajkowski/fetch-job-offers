import { createHash } from "node:crypto";
import { createContext, runInContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderHtml } from "../../src/report/html.ts";
import { FakeDocument } from "./fakeDom.ts";
import { model, row, sampleRows } from "./htmlFixture.ts";

const OPTIONS = { timeZone: "Europe/Warsaw" } as const;

function scriptBlocks(html: string): Array<{ attrs: string; body: string }> {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(
    (m) => ({ attrs: m[1] ?? "", body: m[2] ?? "" }),
  );
}

function dataBlock(html: string): string {
  const block = scriptBlocks(html).find((b) =>
    b.attrs.includes('type="application/json"'),
  );
  if (!block) throw new Error("no data block");
  return block.body;
}

function pageScript(html: string): string {
  const block = scriptBlocks(html).find(
    (b) => !b.attrs.includes("application/json"),
  );
  if (!block) throw new Error("no page script");
  return block.body;
}

/** The page's markup with the embedded data taken out. */
function withoutData(html: string): string {
  return html.replace(dataBlock(html), "");
}

const header = (html: string) =>
  html.slice(html.indexOf("<header"), html.indexOf("</header>"));

describe("renderHtml", () => {
  it("renders one complete HTML document", () => {
    const html = renderHtml(model(), OPTIONS);
    expect(html.startsWith("<!doctype html>\n")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<main id="app">');
  });

  it("makes no external references", () => {
    // The script holds the LinkedIn prefix it checks links against; that's
    // the only URL allowed in the markup.
    const markup = withoutData(renderHtml(model(), OPTIONS)).replaceAll(
      '"https://www.linkedin.com/"',
      "",
    );
    expect(markup).not.toMatch(/https?:\/\//i);
    expect(markup).not.toMatch(/\/\/[a-z0-9-]+\.[a-z]/i);
    expect(markup).not.toMatch(/\ssrc\s*=/i);
    expect(markup).not.toMatch(/<link\b/i);
    expect(markup).not.toMatch(/@import|(?<![a-z])url\(/i);
    expect(scriptBlocks(markup)).toHaveLength(2);
  });

  it("forbids network requests with a content security policy", () => {
    const html = renderHtml(model(), OPTIONS);
    const csp = html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
    )?.[1];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe");
    const script = pageScript(html);
    const hash = createHash("sha256").update(script, "utf8").digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const styleHash = createHash("sha256")
      .update(style, "utf8")
      .digest("base64");
    expect(csp).toContain(`style-src 'sha256-${styleHash}'`);
  });

  it("embeds the rows newest first, round-tripping through JSON", () => {
    const m = model();
    const data = JSON.parse(dataBlock(renderHtml(m, OPTIONS)));
    expect(data.rows).toEqual(m.rowsNewestFirst);
    expect(data.counts).toEqual(m.counts);
    expect(data.searches).toEqual([
      "java-warsaw",
      "kotlin-remote",
      "architect-warsaw",
    ]);
  });

  it("keeps markup in offer text from breaking out of the data", () => {
    const [ls, ps] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    const evil = `</script><script>alert(1)</script><!-- & ${ls}${ps} >`;
    const m = model([
      row({
        title: evil,
        company: evil,
        reason: evil,
        descriptionLines: [evil, `- ${evil}`],
        techStack: [evil],
      }),
    ]);
    const html = renderHtml(m, OPTIONS);
    expect(html).not.toContain("alert(1)</script>");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<!--");
    expect(html).not.toContain(ls);
    expect(html).not.toContain(ps);
    const block = dataBlock(html);
    expect(block).not.toMatch(/[<>&]/);
    expect(scriptBlocks(html)).toHaveLength(2);
    expect(JSON.parse(block).rows).toEqual(m.rowsNewestFirst);
  });

  it("shows the run date and time in local time", () => {
    const html = renderHtml(model(), OPTIONS);
    expect(header(html)).toContain("Job offers, 2026-09-27 10:30");
    expect(html).toContain("<title>Job offers, 2026-09-27 10:30</title>");
    const utc = renderHtml(model(), { timeZone: "UTC" });
    expect(header(utc)).toContain("Job offers, 2026-09-27 08:30");
  });

  it("formats in the process's local time by default", () => {
    const html = renderHtml(model());
    const at = model().startedAt;
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    expect(header(html)).toContain(local);
  });

  it("summarizes searches, new offers and verdict counts", () => {
    const html = renderHtml(model(), OPTIONS);
    expect(header(html)).toContain(
      "3 searches · 5 new offers · 2 accepted · 2 rejected · 1 unjudged",
    );
  });

  it("counts all rows and the new ones when --all adds seen offers, as the Markdown report does", () => {
    const m = model();
    m.counts = { ...m.counts, rows: 5, new: 2 };
    const html = renderHtml(m, OPTIONS);
    expect(header(html)).toContain(
      "3 searches · 5 offers (2 new) · 2 accepted · 2 rejected · 1 unjudged",
    );
  });

  it("uses the singular for one search and one offer", () => {
    const m = model([row()]);
    m.searches = m.searches.slice(0, 1);
    const html = renderHtml(m, OPTIONS);
    expect(header(html)).toContain(
      "1 search · 1 new offer · 1 accepted · 0 rejected · 0 unjudged",
    );
  });

  it("shows no cost", () => {
    const html = renderHtml(model(), OPTIONS);
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(markup).not.toMatch(/\$|cost|usd|price/i);
    expect(pageScript(html)).not.toMatch(/cost|usd/i);
  });

  it("embeds a script that parses", () => {
    const script = pageScript(renderHtml(model(), OPTIONS));
    expect(() => new Script(script)).not.toThrow();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(script).not.toMatch(/document\.write|eval\(/);
  });

  it("runs the embedded script against the embedded data", () => {
    const html = renderHtml(model(sampleRows()), OPTIONS);
    const doc = new FakeDocument();
    const app = doc.add("main", "app");
    doc.add("script", "report-data", dataBlock(html));
    const context = createContext({
      document: doc,
      navigator: { clipboard: { writeText: async () => {} } },
      window: { prompt: () => null },
      setTimeout: () => 0,
      JSON,
    });
    runInContext(pageScript(html), context);
    const titles = app
      .byTag("tr")
      .filter((tr) => tr.className === "row")
      .map((tr) => tr.byTag("td")[1]?.textContent);
    expect(titles).toEqual(["Backend Engineer", "Java Tech Lead"]);
  });
});
