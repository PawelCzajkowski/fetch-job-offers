import * as cheerio from "cheerio";

export interface OfferCard {
  jobId: string;
  title: string;
  company: string;
  location: string;
  postedDate: string;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Turns a LinkedIn guest search page (an HTML fragment of `<li>` job cards)
 * into offer cards. A page past the end of the results has no cards and
 * parses to an empty array. See the spec's section 5 for which fields the
 * card carries.
 */
export function parseSearchPage(html: string): OfferCard[] {
  const $ = cheerio.load(html);

  return $("div.base-card[data-entity-urn]")
    .map((_, element) => {
      const card = $(element);
      const entityUrn = card.attr("data-entity-urn") ?? "";
      const jobId = entityUrn.split(":").pop() ?? "";

      return {
        jobId,
        title: collapseWhitespace(
          card.find("h3.base-search-card__title").text(),
        ),
        company: collapseWhitespace(
          card.find("h4.base-search-card__subtitle a").text(),
        ),
        location: collapseWhitespace(
          card.find("span.job-search-card__location").text(),
        ),
        postedDate:
          card
            .find(
              "time.job-search-card__listdate, time.job-search-card__listdate--new",
            )
            .attr("datetime") ?? "",
      };
    })
    .get();
}
