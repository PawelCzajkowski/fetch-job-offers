import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDetailUrl,
  parseDetailPage,
} from "../../src/linkedin/detailPage.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/linkedin/${name}`, import.meta.url),
    "utf8",
  );

describe("parseDetailPage", () => {
  it("reads the salary and the criteria when the employer provides them", () => {
    const detail = parseDetailPage(fixture("job-4464163116-with-salary.html"));

    expect(detail.salary).toBe("$140,000.00/yr - $180,000.00/yr");
    expect(detail.employmentType).toBe("Full-time");
    expect(detail.jobFunction).toBe("Engineering and Information Technology");
    expect(detail.industries).toBe("Software Development");
  });

  it("leaves the salary null when the page has none", () => {
    const detail = parseDetailPage(fixture("job-4467798222-no-salary.html"));

    expect(detail.salary).toBeNull();
    expect(detail.employmentType).toBe("Full-time");
    expect(detail.jobFunction).toBe("Engineering and Information Technology");
    expect(detail.industries).toBe("Software Development");
  });

  it("does not guess the salary from the description text", () => {
    // The description says "Compensation Range: $140K - $180K"; the parsed
    // salary comes only from the compensation block, never from that text.
    const detail = parseDetailPage(fixture("job-4464163116-with-salary.html"));

    expect(detail.description).toContain("Compensation Range: $140K - $180K");
    expect(detail.salary).not.toContain("140K");
  });

  it("ignores the Seniority level criterion", () => {
    const detail = parseDetailPage(fixture("job-4464163116-with-salary.html"));

    expect(Object.keys(detail).sort()).toEqual([
      "description",
      "employmentType",
      "industries",
      "jobFunction",
      "salary",
    ]);
    expect(JSON.stringify(detail)).not.toContain("Not Applicable");
  });

  it("reads criteria by label, not by position", () => {
    const html = `
      <ul class="description__job-criteria-list">
        <li>
          <h3 class="description__job-criteria-subheader">Industries</h3>
          <span class="description__job-criteria-text">Banking</span>
        </li>
        <li>
          <h3 class="description__job-criteria-subheader">Employment type</h3>
          <span class="description__job-criteria-text">Contract</span>
        </li>
      </ul>`;

    expect(parseDetailPage(html)).toEqual({
      salary: null,
      employmentType: "Contract",
      jobFunction: null,
      industries: "Banking",
      description: "",
    });
  });

  it("turns the description into lines with list items prefixed '- '", () => {
    const { description } = parseDetailPage(
      fixture("job-4467798222-no-salary.html"),
    );
    const lines = description.split("\n");

    expect(lines[0]).toBe(
      "Redpanda is the first runtime and control plane for agent-data interaction — a unified platform that combines streaming, SQL analytics, and intelligent connectivity with the governance layer enterprise AI agents need in production.",
    );
    expect(lines).toContain("About The Role");
    expect(lines).toContain("You Will");
    expect(lines).toContain(
      "- Raise release confidence with uniform end-to-end and certification tests across environments",
    );
    expect(lines).toContain(
      "- Streaming platforms such as Redpanda or Apache Kafka as a user",
    );
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(27);
  });

  it("leaves no HTML tags, decodes entities and keeps no runs of blank lines", () => {
    for (const name of [
      "job-4464163116-with-salary.html",
      "job-4467798222-no-salary.html",
    ]) {
      const { description } = parseDetailPage(fixture(name));

      expect(description).not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(description).not.toContain("&amp;");
      expect(description).not.toMatch(/\n\s*\n\s*\n/);
      expect(description).toBe(description.trim());
    }
    const { description } = parseDetailPage(
      fixture("job-4464163116-with-salary.html"),
    );
    expect(description.split("\n")).toContain("💰 Competitive Salary & Equity");
  });

  it("keeps consecutive list items on consecutive lines", () => {
    const html = `<div class="show-more-less-html__markup"><p>Intro</p><ul><li>one</li><li>two</li></ul><p>Outro</p></div>`;

    expect(parseDetailPage(html).description).toBe(
      "Intro\n\n- one\n- two\nOutro",
    );
  });

  it("trims spaces from markup spread over several lines", () => {
    const html = `
      <div class="show-more-less-html__markup">
        <p>About The Role</p>
        <p> Build things </p>
        <ul>
          <li> one </li>
          <li>two</li>
        </ul>
      </div>`;

    expect(parseDetailPage(html).description).toBe(
      "About The Role\nBuild things\n\n- one\n- two",
    );
  });
});

describe("buildDetailUrl", () => {
  it("points at the guest job posting endpoint for the job ID", () => {
    expect(buildDetailUrl("4464163116")).toBe(
      "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4464163116",
    );
  });
});
