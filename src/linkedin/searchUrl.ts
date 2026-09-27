const SEARCH_ENDPOINT =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

const DURATION_PATTERN = /^(\d+)(h|d)$/;
const SECONDS_PER_UNIT: Record<"h" | "d", number> = {
  h: 3600,
  d: 86400,
};

/**
 * Converts a duration string ("1h", "24h", "3d", "7d", ...) into the number
 * of seconds LinkedIn's `f_TPR=r<seconds>` parameter expects. Throws on
 * anything that doesn't match `<integer><h|d>`.
 */
export function postedWithinToSeconds(duration: string): number {
  const match = DURATION_PATTERN.exec(duration);
  if (!match) {
    throw new Error(
      `Invalid postedWithin duration: ${JSON.stringify(duration)}`,
    );
  }

  const amount = match[1] as string;
  const unit = match[2] as "h" | "d";
  return Number(amount) * SECONDS_PER_UNIT[unit];
}

export interface SearchCriteria {
  keywords: string;
  location: string;
  postedWithin: string;
}

/**
 * Builds the LinkedIn guest search URL for one page of results. Only the
 * parameters LinkedIn's guest endpoint actually honors (see the spec's
 * section 5) are sent: keywords, location, f_TPR and start.
 */
export function buildSearchUrl(
  criteria: SearchCriteria,
  start: number,
): string {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("keywords", criteria.keywords);
  url.searchParams.set("location", criteria.location);
  url.searchParams.set(
    "f_TPR",
    `r${postedWithinToSeconds(criteria.postedWithin)}`,
  );
  url.searchParams.set("start", String(start));
  return url.toString();
}
