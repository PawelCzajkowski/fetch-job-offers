// PROTOTYPE, throwaway. Three report layouts from real sample data. Run: node generate.ts
import { readFileSync, writeFileSync } from "node:fs";

type Offer = {
  id: string; search: string; alsoFoundBy: string[]; title: string; company: string; location: string;
  postedDate: string | null; url: string; verdict: "accepted" | "rejected" | "unjudged"; reason: string;
  workMode: string | null; seniority: string | null; techStack: string[]; salary: string | null;
  employmentType: string | null; jobFunction: string | null; industries: string | null; description: string;
};
type Search = { name: string; keywords: string; location: string; postedWithin: string; profile: string };
type Data = { run: { startedAt: string; model: string; costUsd: number; searches: Search[] }; offers: Offer[] };

const data: Data = JSON.parse(readFileSync("sample-data.json", "utf8"));
const { run, offers } = data;
const count = (v: Offer["verdict"]) => offers.filter((o) => o.verdict === v).length;
const when = run.startedAt.slice(0, 16).replace("T", " ");
const summary = `${run.searches.length} saved searches · ${offers.length} new offers · ${count("accepted")} accepted · ${count("rejected")} rejected · ${count("unjudged")} unjudged · $${run.costUsd.toFixed(4)}`;
const facts = (o: Offer) =>
  [o.location, o.postedDate && `posted ${o.postedDate}`, o.workMode, o.seniority, o.employmentType, o.salary].filter(Boolean).join(" · ");
const searchLine = (s: Search) => `${s.keywords} · ${s.location} · posted within ${s.postedWithin} · profile: "${s.profile}"`;

// Markdown A: digest, one section per saved search
function markdownA(): string {
  const out = [`# Job offers, ${when}`, "", summary, ""];
  for (const s of run.searches) {
    const mine = offers.filter((o) => o.search === s.name);
    out.push(`## ${s.name}`, "", searchLine(s), "");
    for (const o of mine.filter((o) => o.verdict === "accepted")) {
      out.push(`### [${o.title}](${o.url}), ${o.company}`, "", facts(o), "");
      if (o.techStack.length) out.push(`**Stack:** ${o.techStack.join(", ")}  `);
      out.push(`**Why:** ${o.reason}`, "");
      if (o.alsoFoundBy.length) out.push(`_Also found by: ${o.alsoFoundBy.join(", ")}_`, "");
      out.push("<details><summary>Description</summary>", "", o.description, "", "</details>", "");
    }
    const rejected = mine.filter((o) => o.verdict === "rejected");
    out.push(`<details><summary>Rejected (${rejected.length})</summary>`, "");
    for (const o of rejected) out.push(`- [${o.title}](${o.url}), ${o.company}: ${o.reason}`);
    out.push("", "</details>", "");
  }
  const unjudged = offers.filter((o) => o.verdict === "unjudged");
  out.push(`## Unjudged (${unjudged.length})`, "", "These could not be judged and will not be retried.", "");
  for (const o of unjudged) out.push(`- [${o.title}](${o.url}), ${o.company}: ${o.reason}`);
  return out.join("\n") + "\n";
}

// Markdown B: one index table across all searches, details below
function markdownB(): string {
  const cell = (s: string | null) => (s ?? "").replace(/\|/g, "\\|");
  const order = { accepted: 0, unjudged: 1, rejected: 2 };
  const sorted = [...offers].sort((a, b) => order[a.verdict] - order[b.verdict] || (b.postedDate ?? "").localeCompare(a.postedDate ?? ""));
  const out = [`# Job offers, ${when}`, "", summary, ""];
  for (const s of run.searches) out.push(`- **${s.name}**: ${searchLine(s)}`);
  out.push("", "| Verdict | Title | Company | Search | Mode | Seniority | Salary | Posted |", "|---|---|---|---|---|---|---|---|");
  for (const o of sorted)
    out.push(`| ${o.verdict} | [${cell(o.title)}](#offer-${o.id}) | ${cell(o.company)} | ${o.search} | ${o.workMode ?? ""} | ${o.seniority ?? ""} | ${cell(o.salary)} | ${o.postedDate ?? ""} |`);
  out.push("", "## Details", "");
  for (const o of sorted) {
    out.push(`<a id="offer-${o.id}"></a>`, `### ${o.title}, ${o.company}`, "", `**${o.verdict}**: ${o.reason}  `, facts(o) + "  ");
    if (o.techStack.length) out.push(`Stack: ${o.techStack.join(", ")}  `);
    out.push(`[Open on LinkedIn](${o.url})`, "", "<details><summary>Description</summary>", "", o.description, "", "</details>", "");
  }
  return out.join("\n") + "\n";
}

writeFileSync("report-prototype-A.md", markdownA());
writeFileSync("report-prototype-B.md", markdownB());
const template = readFileSync("variants.html", "utf8");
writeFileSync("report-prototype.html", template.replace("/*DATA*/null", JSON.stringify(data).replace(/</g, "\\u003c")));
console.log("Wrote report-prototype.html (?variant=A|B|C), report-prototype-A.md, report-prototype-B.md");
