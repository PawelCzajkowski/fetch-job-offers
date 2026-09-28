import { describe, expect, it, vi } from "vitest";
import {
  boot,
  descriptionBlocks,
  filterRows,
  isLinkedInUrl,
  type PageData,
  type PageEnv,
  sortRows,
} from "../../src/report/htmlPage.ts";
import type { ReportRow } from "../../src/report/model.ts";
import { FakeDocument, type FakeElement } from "./fakeDom.ts";
import { row, sampleRows } from "./htmlFixture.ts";

const ids = (rows: ReportRow[]) => rows.map((r) => r.rowId);

const ANY = { verdict: "", search: "", mode: "", text: "" } as const;

describe("filterRows", () => {
  const rows = sampleRows();

  it("keeps every row with no filter set", () => {
    expect(ids(filterRows(rows, ANY))).toEqual(ids(rows));
  });

  it("filters by verdict", () => {
    expect(ids(filterRows(rows, { ...ANY, verdict: "accepted" }))).toEqual([
      "1001",
      "1004",
    ]);
    expect(ids(filterRows(rows, { ...ANY, verdict: "unjudged" }))).toEqual([
      "1003",
    ]);
  });

  it("filters by search, counting the searches that also found a row", () => {
    expect(ids(filterRows(rows, { ...ANY, search: "kotlin-remote" }))).toEqual([
      "1001",
      "1004",
    ]);
    expect(
      ids(filterRows(rows, { ...ANY, search: "architect-warsaw" })),
    ).toEqual(["1004-2"]);
  });

  it("filters by work mode, with 'none' for not stated", () => {
    expect(ids(filterRows(rows, { ...ANY, mode: "remote" }))).toEqual(["1001"]);
    expect(ids(filterRows(rows, { ...ANY, mode: "none" }))).toEqual([
      "1003",
      "1004",
    ]);
  });

  it("matches free text case-insensitively over title, company, stack and description", () => {
    const text = (t: string) => ids(filterRows(rows, { ...ANY, text: t }));
    expect(text("platform")).toEqual(["1003"]);
    expect(text("GLOBEX")).toEqual(["1001"]);
    expect(text("postgres")).toEqual(["1001"]);
    expect(text("we need react")).toEqual(["1002"]);
    expect(text("  initech  ")).toEqual(["1002"]);
  });

  it("doesn't match free text in fields outside the four", () => {
    expect(filterRows(rows, { ...ANY, text: "Frontend role" })).toEqual([]);
    expect(filterRows(rows, { ...ANY, text: "Warsaw" })).toEqual([]);
  });

  it("combines filters", () => {
    expect(
      ids(filterRows(rows, { ...ANY, verdict: "rejected", text: "java" })),
    ).toEqual(["1004-2"]);
  });
});

describe("sortRows", () => {
  const rows = sampleRows();

  it("keeps the model's newest-first order for posted descending", () => {
    expect(ids(sortRows(rows, { key: "postedDate", dir: -1 }))).toEqual(
      ids(rows),
    );
  });

  it("sorts oldest first for posted ascending, keeping ties stable", () => {
    expect(ids(sortRows(rows, { key: "postedDate", dir: 1 }))).toEqual([
      "1004",
      "1004-2",
      "1003",
      "1002",
      "1001",
    ]);
  });

  it("sorts text columns alphabetically, ignoring case", () => {
    const sorted = sortRows(
      [
        row({ rowId: "a", company: "beta" }),
        row({ rowId: "b", company: "Alpha" }),
      ],
      { key: "company", dir: 1 },
    );
    expect(ids(sorted)).toEqual(["b", "a"]);
  });

  it("puts missing values last in both directions", () => {
    const asc = sortRows(rows, { key: "workMode", dir: 1 });
    const desc = sortRows(rows, { key: "workMode", dir: -1 });
    expect(asc.map((r) => r.workMode)).toEqual([
      "hybrid",
      "on-site",
      "remote",
      null,
      null,
    ]);
    expect(desc.map((r) => r.workMode)).toEqual([
      "remote",
      "on-site",
      "hybrid",
      null,
      null,
    ]);
  });

  it("sorts seniority by rank, not alphabetically", () => {
    const sorted = sortRows(rows, { key: "seniority", dir: 1 });
    expect(sorted.map((r) => r.seniority)).toEqual([
      "mid",
      "senior",
      "lead",
      "lead",
      null,
    ]);
  });

  it("sorts verdicts accepted, unjudged, rejected", () => {
    const sorted = sortRows(rows, { key: "verdict", dir: 1 });
    expect(sorted.map((r) => r.verdict)).toEqual([
      "accepted",
      "accepted",
      "unjudged",
      "rejected",
      "rejected",
    ]);
  });

  it("sorts by search label and by stack text", () => {
    expect(
      sortRows(rows, { key: "search", dir: 1 }).map((r) => r.foundBy),
    ).toEqual([
      "architect-warsaw",
      "java-warsaw",
      "java-warsaw",
      "java-warsaw",
      "kotlin-remote",
    ]);
    expect(ids(sortRows(rows, { key: "techStack", dir: 1 }))).toEqual([
      "1004",
      "1004-2",
      "1001",
      "1002",
      "1003",
    ]);
  });

  it("doesn't mutate its input", () => {
    const before = ids(rows);
    sortRows(rows, { key: "title", dir: 1 });
    expect(ids(rows)).toEqual(before);
  });
});

describe("descriptionBlocks", () => {
  it("turns '- ' lines into lists and other lines into paragraphs", () => {
    expect(
      descriptionBlocks([
        "About us",
        "We build things.",
        "",
        "- Java",
        "- Spring",
        "Nice to have:",
        "- Kafka",
      ]),
    ).toEqual([
      { kind: "p", text: "About us" },
      { kind: "p", text: "We build things." },
      { kind: "ul", items: ["Java", "Spring"] },
      { kind: "p", text: "Nice to have:" },
      { kind: "ul", items: ["Kafka"] },
    ]);
  });

  it("splits a list on an empty line and trims lines", () => {
    expect(
      descriptionBlocks(["  - a", "- b", "   ", "- c", "  text  "]),
    ).toEqual([
      { kind: "ul", items: ["a", "b"] },
      { kind: "ul", items: ["c"] },
      { kind: "p", text: "text" },
    ]);
  });

  it("gives no blocks for no description", () => {
    expect(descriptionBlocks([])).toEqual([]);
    expect(descriptionBlocks(["", ""])).toEqual([]);
  });

  it("keeps a lone '-' or a dash without a space as text", () => {
    expect(descriptionBlocks(["-", "-5% fee"])).toEqual([
      { kind: "p", text: "-" },
      { kind: "p", text: "-5% fee" },
    ]);
  });
});

describe("isLinkedInUrl", () => {
  it("accepts https www.linkedin.com URLs", () => {
    expect(isLinkedInUrl("https://www.linkedin.com/jobs/view/123")).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "http://www.linkedin.com/jobs/view/123",
    "https://www.linkedin.com.evil.test/jobs/view/1",
    "https://linkedin.com/jobs/view/1",
    "https://evil.test/?https://www.linkedin.com/",
    " https://www.linkedin.com/jobs/view/1",
    "HTTPS://WWW.LINKEDIN.COM/jobs/view/1",
    "",
  ])("rejects %j", (url) => {
    expect(isLinkedInUrl(url)).toBe(false);
  });
});

// ---------- boot: the page driven through a fake DOM ----------

interface Page {
  doc: FakeDocument;
  app: FakeElement;
  env: PageEnv & {
    copyText: ReturnType<typeof vi.fn>;
    fallbackCopy: ReturnType<typeof vi.fn>;
  };
  later: Array<() => void>;
}

function pageData(rows: ReportRow[] = sampleRows()): PageData {
  const countOf = (v: ReportRow["verdict"]) =>
    rows.filter((r) => r.verdict === v).length;
  return {
    rows,
    searches: ["java-warsaw", "kotlin-remote", "architect-warsaw"],
    counts: {
      rows: rows.length,
      new: rows.length,
      accepted: countOf("accepted"),
      rejected: countOf("rejected"),
      unjudged: countOf("unjudged"),
    },
  };
}

function open(data: PageData = pageData()): Page {
  const doc = new FakeDocument();
  const app = doc.add("main", "app");
  const later: Array<() => void> = [];
  const env = {
    document: doc,
    copyText: vi.fn(async (_: string) => {}),
    fallbackCopy: vi.fn((_: string) => {}),
    later: (fn: () => void) => {
      later.push(fn);
    },
  };
  boot(env as unknown as PageEnv, data);
  return { doc, app, env, later };
}

const bodyRows = (page: Page) => page.app.byTag("tbody")[0]?.byTag("tr") ?? [];
const dataRows = (page: Page) =>
  bodyRows(page).filter((tr) => tr.className === "row");
const titles = (page: Page) =>
  dataRows(page).map((tr) => tr.byTag("td")[1]?.textContent);
const segButton = (page: Page, label: string) => {
  const button = page.app
    .byClass("seg")[0]
    ?.byTag("button")
    .find((b) => b.textContent.startsWith(label));
  if (!button) throw new Error(`no ${label} button`);
  return button;
};
const selects = (page: Page) => page.app.byTag("select");
const textInput = (page: Page) => {
  const input = page.app.byTag("input")[0];
  if (!input) throw new Error("no text input");
  return input;
};
const header = (page: Page, label: string) => {
  const th = page.app.byTag("th").find((t) => t.textContent.startsWith(label));
  if (!th) throw new Error(`no ${label} header`);
  return th;
};
const status = (page: Page) => page.app.byClass("status")[0]?.textContent;

describe("boot", () => {
  it("renders the spec's columns", () => {
    const page = open();
    expect(page.app.byTag("th").map((th) => th.textContent)).toEqual([
      "Posted ▼",
      "Title",
      "Company",
      "Search",
      "Mode",
      "Seniority",
      "Salary",
      "Stack",
      "Verdict",
    ]);
  });

  it("shows accepted offers by default, newest first", () => {
    const page = open();
    expect(titles(page)).toEqual(["Backend Engineer", "Java Tech Lead"]);
    expect(segButton(page, "Accepted").className).toBe("on");
    expect(status(page)).toContain("Showing 2 of 5");
  });

  it("shows counts on the verdict buttons", () => {
    const page = open();
    const labels = page.app
      .byClass("seg")[0]
      ?.byTag("button")
      .map((b) => b.textContent);
    expect(labels).toEqual(["All 5", "Accepted 2", "Rejected 2", "Unjudged 1"]);
  });

  it("fills one table row's cells from the row", () => {
    const page = open();
    const cells = dataRows(page)[0]
      ?.byTag("td")
      .map((td) => td.textContent);
    expect(cells).toEqual([
      "2026-09-26",
      "Backend Engineer",
      "Globex",
      "java-warsaw",
      "remote",
      "senior",
      "25 000-30 000 PLN",
      "Kotlin, Postgres",
      "accepted",
    ]);
  });

  it("shows a dash for missing values", () => {
    const page = open();
    segButton(page, "Unjudged").fire("click");
    const cells = dataRows(page)[0]
      ?.byTag("td")
      .map((td) => td.textContent);
    expect(cells?.slice(4)).toEqual(["–", "–", "–", "–", "unjudged"]);
  });

  it("switches verdicts with the filter buttons", () => {
    const page = open();
    segButton(page, "All").fire("click");
    expect(dataRows(page)).toHaveLength(5);
    expect(segButton(page, "All").className).toBe("on");
    expect(segButton(page, "Accepted").className).toBe("");
    segButton(page, "Rejected").fire("click");
    expect(titles(page)).toEqual(["React Developer", "Java Tech Lead"]);
  });

  it("offers every search and the four work modes in the pickers", () => {
    const page = open();
    const [search, mode] = selects(page);
    expect(search?.byTag("option").map((o) => o.textContent)).toEqual([
      "All searches",
      "java-warsaw",
      "kotlin-remote",
      "architect-warsaw",
    ]);
    expect(mode?.byTag("option").map((o) => o.textContent)).toEqual([
      "Any work mode",
      "remote",
      "hybrid",
      "on-site",
      "not stated",
    ]);
    expect(mode?.byTag("option").map((o) => o.getAttribute("value"))).toEqual([
      "",
      "remote",
      "hybrid",
      "on-site",
      "none",
    ]);
  });

  it("filters by the search and work mode pickers", () => {
    const page = open();
    segButton(page, "All").fire("click");
    const [search, mode] = selects(page);
    if (!search || !mode) throw new Error("no pickers");
    search.value = "architect-warsaw";
    search.fire("change");
    expect(titles(page)).toEqual(["Java Tech Lead"]);
    search.value = "";
    search.fire("change");
    mode.value = "none";
    mode.fire("change");
    expect(titles(page)).toEqual(["Platform Engineer", "Java Tech Lead"]);
  });

  it("filters by free text and keeps the same input element", () => {
    const page = open();
    segButton(page, "All").fire("click");
    const input = textInput(page);
    input.value = "react";
    input.fire("input");
    expect(titles(page)).toEqual(["React Developer"]);
    expect(textInput(page)).toBe(input);
    expect(status(page)).toContain("Showing 1 of 5");
  });

  it("says so when nothing matches", () => {
    const page = open();
    const input = textInput(page);
    input.value = "cobol";
    input.fire("input");
    expect(dataRows(page)).toHaveLength(0);
    expect(bodyRows(page)[0]?.textContent).toBe(
      "No offers match these filters.",
    );
  });

  it("sorts by a clicked header and flips on a second click", () => {
    const page = open();
    segButton(page, "All").fire("click");
    header(page, "Company").fire("click");
    expect(dataRows(page).map((tr) => tr.byTag("td")[2]?.textContent)).toEqual([
      "Globex",
      "Hooli",
      "Hooli",
      "Initech",
      "Umbrella",
    ]);
    expect(header(page, "Company").textContent).toBe("Company ▲");
    expect(header(page, "Company").getAttribute("aria-sort")).toBe("ascending");
    expect(header(page, "Posted").textContent).toBe("Posted");
    header(page, "Company").fire("click");
    expect(dataRows(page)[0]?.byTag("td")[2]?.textContent).toBe("Umbrella");
    expect(header(page, "Company").textContent).toBe("Company ▼");
  });

  it("expands a row on click with its details", () => {
    const page = open();
    dataRows(page)[0]?.fire("click");
    const detail = bodyRows(page).find((tr) => tr.className === "detail");
    if (!detail) throw new Error("no detail row");
    const text = detail.textContent;
    expect(text).toContain("Java backend role");
    expect(text).toContain("Warsaw, Poland");
    expect(detail.byClass("chip").map((c) => c.textContent)).toEqual([
      "Full-time",
      "Engineering",
      "Software Development",
    ]);
    expect(text).toContain("Also found by: kotlin-remote");
    const link = detail.byTag("a")[0];
    expect(link?.textContent).toBe("Open on LinkedIn");
    expect(link?.getAttribute("href")).toBe(
      "https://www.linkedin.com/jobs/view/1001",
    );
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    const desc = detail.byClass("desc")[0];
    expect(desc?.children.map((c) => (c as FakeElement).tagName)).toEqual([
      "p",
      "p",
      "ul",
    ]);
    expect(desc?.byTag("li").map((li) => li.textContent)).toEqual([
      "Java",
      "Spring",
    ]);
    expect(dataRows(page)[0]?.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses an expanded row on a second click", () => {
    const page = open();
    dataRows(page)[0]?.fire("click");
    dataRows(page)[0]?.fire("click");
    expect(bodyRows(page).some((tr) => tr.className === "detail")).toBe(false);
  });

  it("expands a row with Enter from the keyboard", () => {
    const page = open();
    const tr = dataRows(page)[0];
    expect(tr?.getAttribute("tabindex")).toBe("0");
    tr?.fire("keydown", { key: "Enter" });
    expect(bodyRows(page).some((r) => r.className === "detail")).toBe(true);
  });

  it("keeps two rows of one job apart by row ID", () => {
    const page = open();
    segButton(page, "All").fire("click");
    const lead = dataRows(page).filter((tr) =>
      tr.textContent.includes("Java Tech Lead"),
    );
    lead[1]?.fire("click");
    const details = bodyRows(page).filter((tr) => tr.className === "detail");
    expect(details).toHaveLength(1);
    expect(details[0]?.textContent).toContain("Too managerial");
  });

  it("leaves out empty details for an unjudged row", () => {
    const page = open();
    segButton(page, "Unjudged").fire("click");
    dataRows(page)[0]?.fire("click");
    const detail = bodyRows(page).find((tr) => tr.className === "detail");
    expect(detail?.byClass("chip")).toEqual([]);
    expect(detail?.textContent).not.toContain("Also found by");
    expect(detail?.textContent).toContain("OpenAI timed out");
    expect(detail?.textContent).toContain("No description.");
  });

  it("copies the description as its lines", async () => {
    const page = open();
    dataRows(page)[0]?.fire("click");
    const button = page.app
      .byTag("button")
      .find((b) => b.textContent === "Copy description");
    if (!button) throw new Error("no copy button");
    button.fire("click");
    expect(page.env.copyText).toHaveBeenCalledWith(
      "About us\n\nWe build things.\n- Java\n- Spring",
    );
    await vi.waitFor(() => expect(button.textContent).toBe("Copied"));
    for (const fn of page.later) fn();
    expect(button.textContent).toBe("Copy description");
  });

  it("falls back when the clipboard refuses", async () => {
    const page = open();
    page.env.copyText.mockRejectedValue(new Error("denied"));
    dataRows(page)[0]?.fire("click");
    const button = page.app
      .byTag("button")
      .find((b) => b.textContent === "Copy description");
    button?.fire("click");
    await vi.waitFor(() =>
      expect(page.env.fallbackCopy).toHaveBeenCalledWith(
        "About us\n\nWe build things.\n- Java\n- Spring",
      ),
    );
  });

  it("falls back when the clipboard throws straight away", async () => {
    const page = open();
    page.env.copyText.mockImplementation(() => {
      throw new Error("no clipboard");
    });
    dataRows(page)[0]?.fire("click");
    const button = page.app
      .byTag("button")
      .find((b) => b.textContent === "Copy description");
    if (!button) throw new Error("no copy button");
    expect(() => button.fire("click")).not.toThrow();
    await vi.waitFor(() =>
      expect(page.env.fallbackCopy).toHaveBeenCalledWith(
        "About us\n\nWe build things.\n- Java\n- Spring",
      ),
    );
    expect(button.textContent).toBe("Copy description");
  });

  it("keeps markup in offer text as plain text", () => {
    const evil = "</script><script>alert(1)</script><b>x</b>";
    const page = open(
      pageData([
        row({
          title: evil,
          company: evil,
          reason: evil,
          descriptionLines: [evil, `- ${evil}`],
        }),
      ]),
    );
    expect(titles(page)).toEqual([evil]);
    dataRows(page)[0]?.fire("click");
    expect(page.app.byTag("script")).toEqual([]);
    expect(page.app.byTag("b").map((b) => b.textContent)).toEqual([evil]);
  });

  it("gives no link for a URL that isn't LinkedIn's", () => {
    const page = open(pageData([row({ url: "javascript:alert(1)" })]));
    dataRows(page)[0]?.fire("click");
    expect(page.app.byTag("a")).toEqual([]);
    expect(page.app.find((el) => el.getAttribute("href") !== null)).toEqual([]);
  });
});
