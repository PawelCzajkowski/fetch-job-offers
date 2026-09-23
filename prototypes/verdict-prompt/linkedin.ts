// PROTOTYPE: bare-minimum LinkedIn guest fetch + parse, just enough to feed real offers to the prompt.
import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const BASE = "https://www.linkedin.com/jobs-guest/jobs/api";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.text();
}

export type Card = { id: string; title: string; company: string; location: string; postedDate: string | null };

export async function searchPage(keywords: string, location: string, fTPR: string, start: number): Promise<Card[]> {
  const q = new URLSearchParams({ keywords, location, f_TPR: fTPR, start: String(start) });
  const $ = cheerio.load(await get(`${BASE}/seeMoreJobPostings/search?${q}`));
  return $("li")
    .map((_, li) => {
      const urn = $(li).find("[data-entity-urn]").attr("data-entity-urn") ?? "";
      return {
        id: urn.split(":").pop() ?? "",
        title: $(li).find("h3.base-search-card__title").text().trim(),
        company: $(li).find("h4.base-search-card__subtitle").text().trim(),
        location: $(li).find(".job-search-card__location").text().trim(),
        postedDate: $(li).find("time").attr("datetime") ?? null,
      };
    })
    .get()
    .filter((c) => c.id);
}

export type Detail = { description: string; salary: string | null; criteria: Record<string, string> };

export async function detail(id: string): Promise<Detail> {
  const $ = cheerio.load(await get(`${BASE}/jobPosting/${id}`));
  const html = $("div.show-more-less-html__markup").html() ?? "";
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|div|h\d|ul|ol)>/gi, "\n");
  const description = cheerio
    .load(`<div>${withBreaks}</div>`)("div")
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  const criteria: Record<string, string> = {};
  $("ul.description__job-criteria-list > li").each((_, li) => {
    criteria[$(li).find("h3").text().trim()] = $(li).find("span").text().trim();
  });
  const salary = $("div.salary.compensation__salary").text().trim() || null;
  return { description, salary, criteria };
}
