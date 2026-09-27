import { describe, expect, it } from "vitest";
import {
  buildSearchUrl,
  postedWithinToSeconds,
} from "../../src/linkedin/searchUrl.ts";

describe("postedWithinToSeconds", () => {
  it.each([
    ["1h", 3600],
    ["24h", 86400],
    ["3d", 259200],
    ["7d", 604800],
  ])("converts %s to %d seconds", (duration, seconds) => {
    expect(postedWithinToSeconds(duration)).toBe(seconds);
  });

  it.each(["abc", "", "10x", "-1d", "1w", "1.5d"])(
    "rejects an invalid duration %j",
    (duration) => {
      expect(() => postedWithinToSeconds(duration)).toThrow();
    },
  );
});

describe("buildSearchUrl", () => {
  it("carries only keywords, location, f_TPR and start", () => {
    const url = new URL(
      buildSearchUrl(
        {
          keywords: "Java Backend Developer",
          location: "Warsaw, Poland",
          postedWithin: "7d",
        },
        0,
      ),
    );

    expect(url.origin + url.pathname).toBe(
      "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search",
    );
    expect([...url.searchParams.keys()].sort()).toEqual([
      "f_TPR",
      "keywords",
      "location",
      "start",
    ]);
    expect(url.searchParams.get("keywords")).toBe("Java Backend Developer");
    expect(url.searchParams.get("location")).toBe("Warsaw, Poland");
    expect(url.searchParams.get("f_TPR")).toBe("r604800");
    expect(url.searchParams.get("start")).toBe("0");
  });

  it("uses the given page offset", () => {
    const url = new URL(
      buildSearchUrl(
        { keywords: "TypeScript", location: "Poland", postedWithin: "1h" },
        20,
      ),
    );

    expect(url.searchParams.get("start")).toBe("20");
    expect(url.searchParams.get("f_TPR")).toBe("r3600");
  });
});
