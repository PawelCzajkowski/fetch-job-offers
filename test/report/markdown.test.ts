import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/report/markdown.ts";
import type {
  ReportModel,
  ReportRow,
  ReportSearch,
} from "../../src/report/model.ts";

// The header shows the run's start in local time. Pin the zone for these
// tests so the output is the same on every machine, and pick one that isn't
// UTC so a test proves local time is used. Node picks up a changed TZ at
// once; the old value is restored so other test files in the same worker
// keep theirs.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Warsaw";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// 08:30 UTC is 10:30 in Warsaw (CEST).
const STARTED_AT = new Date("2026-09-27T08:30:00.000Z");

function row(overrides: Partial<ReportRow> = {}): ReportRow {
  const jobId = overrides.jobId ?? "4467798222";
  return {
    rowId: jobId,
    jobId,
    url: `https://www.linkedin.com/jobs/view/${jobId}`,
    title: "Senior Java Developer",
    company: "Acme",
    location: "Warsaw, Mazowieckie, Poland",
    postedDate: "2026-09-22",
    salary: null,
    employmentType: "Full-time",
    jobFunction: "Engineering",
    industries: "Software Development",
    verdict: "accepted",
    reason: "Java backend role",
    workMode: "hybrid",
    seniority: "senior",
    techStack: ["Java", "Spring"],
    foundBy: "java-warsaw",
    alsoFoundBy: [],
    descriptionLines: ["About us", "", "We build things."],
    ...overrides,
  };
}

const SEARCHES: ReportSearch[] = [
  {
    label: "java-warsaw",
    keywords: "Java Backend Developer",
    location: "Warsaw, Poland",
    postedWithin: "7d",
    profile: "Java development",
  },
  {
    label: "se-warsaw",
    keywords: "Software Engineer",
    location: "Warsaw, Poland",
    postedWithin: "7d",
    profile: "Java development",
  },
  {
    label: "lead-remote",
    keywords: "Tech Lead",
    location: "European Union",
    postedWithin: "24h",
    profile: "Tech lead",
  },
];

function model(
  rows: ReportRow[],
  overrides: Partial<ReportModel> = {},
): ReportModel {
  const countOf = (verdict: ReportRow["verdict"]) =>
    rows.filter((r) => r.verdict === verdict).length;
  return {
    startedAt: STARTED_AT,
    searches: SEARCHES,
    counts: {
      rows: rows.length,
      new: rows.length,
      accepted: countOf("accepted"),
      rejected: countOf("rejected"),
      unjudged: countOf("unjudged"),
    },
    rowsNewestFirst: rows,
    rowsByVerdict: rows,
    hasRows: rows.length > 0,
    judgedAny: rows.length > 0,
    dryRun: false,
    ...overrides,
  };
}

// Already in the Markdown order: accepted, unjudged, rejected, newest first.
const REPRESENTATIVE_ROWS: ReportRow[] = [
  row({
    jobId: "4458683273",
    title: "Middle/Senior Java Developer",
    company: "Veeam Software",
    postedDate: "2026-09-23",
    salary: "22,000 - 28,000 PLN/month",
    reason: "Backend Java work with Spring Boot and Kafka.",
    techStack: ["Java", "Spring Boot", "Kafka"],
    alsoFoundBy: ["se-warsaw"],
    descriptionLines: [
      "About the role",
      "",
      "You will build payment services.",
      "",
      "What you'll do",
      "- Design APIs",
      "- Own services end to end",
      "",
      "Apply today.",
    ],
  }),
  // The same job ID under a second profile: its own row and anchor.
  row({
    rowId: "4458683273-2",
    jobId: "4458683273",
    title: "Middle/Senior Java Developer",
    company: "Veeam Software",
    postedDate: "2026-09-23",
    salary: "22,000 - 28,000 PLN/month",
    reason: "Hands-on lead role over a Java team.",
    seniority: "lead",
    workMode: "remote",
    techStack: ["Java"],
    foundBy: "lead-remote",
    descriptionLines: ["Short description."],
  }),
  row({
    jobId: "4460330656",
    title: "Senior IT Developer (Backend Developer)",
    company: "Nordea",
    postedDate: "2026-09-19",
    verdict: "unjudged",
    reason: "OpenAI timed out",
    workMode: null,
    seniority: null,
    techStack: [],
    employmentType: null,
    jobFunction: null,
    industries: null,
    descriptionLines: [],
  }),
  row({
    jobId: "4458083241",
    title: "C# .NET Developer | Business Delivery Solutions",
    company: "Deloitte",
    postedDate: "2026-09-19",
    verdict: "rejected",
    reason: "The role is .NET, not Java.",
    seniority: "mid",
    techStack: [".NET", "C#"],
    foundBy: "se-warsaw",
    descriptionLines: ["We need a .NET developer."],
  }),
];

const render = (rows: ReportRow[], overrides: Partial<ReportModel> = {}) =>
  renderMarkdown(model(rows, overrides));

const tableRows = (markdown: string) =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Verdict"));

describe("renderMarkdown", () => {
  it("renders a representative report", async () => {
    await expect(render(REPRESENTATIVE_ROWS)).toMatchFileSnapshot(
      "__snapshots__/markdown-report.md",
    );
  });

  describe("header", () => {
    it("uses the singular for one search and one offer", () => {
      expect(
        render([row()], { searches: SEARCHES.slice(0, 1) }).split("\n")[2],
      ).toBe("1 search · 1 new offer · 1 accepted · 0 rejected · 0 unjudged");
    });

    it("counts the seen offers shown by --all apart from the new ones", () => {
      const rows = [row(), row({ jobId: "2", rowId: "2" })];
      const base = model(rows);
      const markdown = renderMarkdown({
        ...base,
        counts: { ...base.counts, new: 1 },
      });
      expect(markdown.split("\n")[2]).toBe(
        "3 searches · 2 offers (1 new) · 2 accepted · 0 rejected · 0 unjudged",
      );
    });
  });

  describe("index table", () => {
    it("lists rows in the model's by-verdict order, not newest first", () => {
      const markdown = render(REPRESENTATIVE_ROWS, {
        rowsNewestFirst: [...REPRESENTATIVE_ROWS].reverse(),
      });
      const anchors = tableRows(markdown).map(
        (line) => line.match(/\]\(#([^)]+)\)/)?.[1],
      );
      expect(anchors).toEqual(
        REPRESENTATIVE_ROWS.map((r) => `offer-${r.rowId}`),
      );
    });

    it("shows absent values as a dash", () => {
      const [line] = tableRows(
        render([
          row({
            verdict: "unjudged",
            workMode: null,
            seniority: null,
            salary: null,
            company: "",
          }),
        ]),
      );
      expect(line).toBe(
        "| unjudged | [Senior Java Developer](#offer-4467798222) | — | java-warsaw | — | — | — | 2026-09-22 |",
      );
    });

    it("escapes pipes so a cell can't split the row", () => {
      const [line] = tableRows(
        render([
          row({
            title: "Java | Kotlin Developer",
            company: "A|B",
            salary: "10 | 20k",
          }),
        ]),
      );
      expect(line).toContain("[Java \\| Kotlin Developer](#offer-4467798222)");
      expect(line).toContain("| A\\|B |");
      expect(line).toContain("| 10 \\| 20k |");
      // Every unescaped pipe is a cell border: 8 columns, 9 borders.
      expect(line?.match(/(?<!\\)\|/g)).toHaveLength(9);
    });

    it("keeps newlines and HTML in a cell from breaking the row", () => {
      const markdown = render([
        row({ title: "Java\nDeveloper <b>now</b>", company: "Acme\r\nLtd" }),
      ]);
      const [line] = tableRows(markdown);
      expect(line).toContain("[Java Developer \\<b>now\\</b>](#offer-");
      expect(line).toContain("| Acme Ltd |");
    });

    it("escapes Markdown in a title so the link survives", () => {
      const [line] = tableRows(
        render([row({ title: "[Senior] *Java* dev_ops `x`" })]),
      );
      expect(line).toContain(
        "[\\[Senior\\] \\*Java\\* dev\\_ops \\`x\\`](#offer-4467798222)",
      );
    });
  });

  describe("details", () => {
    it("links every title to an anchor in the details, one per row", () => {
      const markdown = render(REPRESENTATIVE_ROWS);
      const links = [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
      const anchors = [...markdown.matchAll(/<a id="([^"]+)"><\/a>/g)].map(
        (m) => m[1],
      );
      expect(links).toEqual([
        "offer-4458683273",
        "offer-4458683273-2",
        "offer-4460330656",
        "offer-4458083241",
      ]);
      expect(anchors).toEqual(links);
    });

    it("shows the verdict and reason, facts, stack and a LinkedIn link", () => {
      expect(
        render([row({ alsoFoundBy: ["se-warsaw", "java-krakow"] })]),
      ).toContain(
        [
          '<a id="offer-4467798222"></a>',
          "### Senior Java Developer, Acme",
          "",
          "**accepted**: Java backend role  ",
          "Warsaw, Mazowieckie, Poland · Full-time · Engineering · Software Development · also found by: se-warsaw, java-krakow  ",
          "Stack: Java, Spring  ",
          "[Open on LinkedIn](https://www.linkedin.com/jobs/view/4467798222)",
        ].join("\n"),
      );
    });

    it("keeps bullets and paragraphs in the description, inside <details>", () => {
      expect(
        render([
          row({
            descriptionLines: [
              "What you'll do",
              "- Design APIs",
              "- Ship *fast*",
              "",
              "Apply.",
            ],
          }),
        ]),
      ).toContain(
        [
          "<details><summary>Description</summary>",
          "",
          "What you'll do",
          "- Design APIs",
          "- Ship \\*fast\\*",
          "",
          "Apply.",
          "",
          "</details>",
        ].join("\n"),
      );
    });

    it("ends a list before a following paragraph line", () => {
      expect(
        render([row({ descriptionLines: ["- One", "- Two", "After"] })]),
      ).toContain("- One\n- Two\n\nAfter\n");
    });

    it("keeps description lines from turning into other Markdown blocks", () => {
      const markdown = render([
        row({
          descriptionLines: [
            "# Not a heading",
            "> not a quote",
            "1. not a list",
            "+ not a list",
            "    not code",
            "---",
            "</details> & <script>",
          ],
        }),
      ]);
      expect(markdown).toContain(
        [
          "\\# Not a heading",
          "\\> not a quote",
          "1\\. not a list",
          "\\+ not a list",
          "not code",
          "\\---",
          "\\</details> & \\<script>",
        ].join("\n"),
      );
      expect(markdown.match(/(?<!\\)<\/details>/g)).toHaveLength(1);
    });

    it("keeps a bullet's text from starting another block inside it", () => {
      expect(
        render([
          row({
            descriptionLines: [
              "- > 5 years of Java",
              "- 2024. Joined",
              "- - nested",
              "- ---",
            ],
          }),
        ]),
      ).toContain(
        "- \\> 5 years of Java\n- 2024\\. Joined\n- \\- nested\n- \\---\n",
      );
    });

    it("escapes the title and company in the heading", () => {
      expect(
        render([row({ title: "Dev <img src=x> #1 #", company: "A_B" })]),
      ).toContain("### Dev \\<img src=x> \\#1 \\#, A\\_B\n");
    });
  });
});
