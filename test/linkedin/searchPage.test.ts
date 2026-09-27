import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSearchPage } from "../../src/linkedin/searchPage.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../fixtures/linkedin/${name}`, import.meta.url),
    "utf8",
  );

describe("parseSearchPage", () => {
  it("parses each card's job ID, title, company, location and posted date", () => {
    const cards = parseSearchPage(
      fixture("search-typescript-poland-start0.html"),
    );

    expect(cards).toHaveLength(10);
    expect(cards[0]).toEqual({
      jobId: "4467798222",
      title: "Staff Software Engineer, UI Platform",
      company: "Redpanda Data",
      location: "Warsaw, Mazowieckie, Poland",
      postedDate: "2026-09-15",
    });
  });

  it("parses recent posts (the --new date class) the same way", () => {
    const cards = parseSearchPage(
      fixture("search-typescript-poland-f_TPR-r3600.html"),
    );

    expect(cards).toHaveLength(10);
    for (const card of cards) {
      expect(card.postedDate).toBe("2026-09-23");
    }
  });

  it("parses an empty page (past the end of the results) to no cards", () => {
    expect(parseSearchPage(fixture("search-empty-past-end.html"))).toEqual([]);
  });
});
