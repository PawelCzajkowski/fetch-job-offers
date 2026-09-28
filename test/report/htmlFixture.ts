import type { ReportModel, ReportRow } from "../../src/report/model.ts";

export function row(overrides: Partial<ReportRow> = {}): ReportRow {
  const jobId = overrides.jobId ?? "4467798222";
  return {
    rowId: jobId,
    jobId,
    url: `https://www.linkedin.com/jobs/view/${jobId}`,
    title: "Senior Java Developer",
    company: "Acme",
    location: "Warsaw, Poland",
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
    descriptionLines: [
      "About us",
      "",
      "We build things.",
      "- Java",
      "- Spring",
    ],
    ...overrides,
  };
}

/**
 * Five rows over three searches, newest first, all three verdicts; job 1004
 * has two rows under two profiles.
 */
export function sampleRows(): ReportRow[] {
  return [
    row({
      jobId: "1001",
      rowId: "1001",
      title: "Backend Engineer",
      company: "Globex",
      postedDate: "2026-09-26",
      salary: "25 000-30 000 PLN",
      workMode: "remote",
      techStack: ["Kotlin", "Postgres"],
      alsoFoundBy: ["kotlin-remote"],
    }),
    row({
      jobId: "1002",
      rowId: "1002",
      title: "React Developer",
      company: "Initech",
      postedDate: "2026-09-25",
      verdict: "rejected",
      reason: "Frontend role",
      workMode: "on-site",
      seniority: "mid",
      techStack: ["React"],
      descriptionLines: ["We need React."],
    }),
    row({
      jobId: "1003",
      rowId: "1003",
      title: "Platform Engineer",
      company: "Umbrella",
      postedDate: "2026-09-24",
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
      jobId: "1004",
      rowId: "1004",
      title: "Java Tech Lead",
      company: "Hooli",
      postedDate: "2026-09-23",
      seniority: "lead",
      workMode: null,
      foundBy: "kotlin-remote",
    }),
    row({
      jobId: "1004",
      rowId: "1004-2",
      title: "Java Tech Lead",
      company: "Hooli",
      postedDate: "2026-09-23",
      verdict: "rejected",
      reason: "Too managerial for this profile",
      seniority: "lead",
      foundBy: "architect-warsaw",
    }),
  ];
}

export function model(rows: ReportRow[] = sampleRows()): ReportModel {
  const countOf = (verdict: ReportRow["verdict"]) =>
    rows.filter((r) => r.verdict === verdict).length;
  return {
    startedAt: new Date("2026-09-27T08:30:00.000Z"),
    searches: [
      {
        label: "java-warsaw",
        keywords: "java",
        location: "Warsaw",
        postedWithin: "week",
        profile: "Java development",
      },
      {
        label: "kotlin-remote",
        keywords: "kotlin",
        location: "Poland",
        postedWithin: "week",
        profile: "Java development",
      },
      {
        label: "architect-warsaw",
        keywords: "architect",
        location: "Warsaw",
        postedWithin: "month",
        profile: "Architecture",
      },
    ],
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
  };
}
