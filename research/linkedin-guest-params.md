# LinkedIn guest endpoints: which search criteria filter in the request?

Resolves #2 (part of #1). Researched 2026-09-23 with 49 real, unauthenticated requests
(no cookies carried between requests, desktop Chrome 128 User-Agent, `Accept-Language: en-US`,
1.5 s between requests). The primary source is the endpoints themselves. Every claim below comes
from comparing the job IDs returned with a parameter against the IDs returned without it. The full
request log is at the end.

Endpoints:

- Search: `GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?...` returns an HTML fragment of `<li>` job cards
- Detail: `GET https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jobId}` returns an HTML fragment of one posting

## Short answer

| Parameter | Filters? | Values / notes |
|---|---|---|
| `keywords` | Yes | Free text. `rust` and `typescript` return disjoint sets. Words like `remote` also change results, but only as a text match. |
| `location` | Yes | Free text (`Poland`, `Warsaw`, `United States`). Omitting it gives US-centric results. |
| `geoId` | Yes | `105072130` (Poland) returns the same IDs as `location=Poland`. `101282230` returns only German cards. |
| `distance` | Yes (with a city `location`) | `distance=0` drops cards located only as "Poland". `distance=100` pulls them in. Unit is presumably miles (not verified). |
| `f_TPR` | Yes | `r<seconds>` with any number of seconds: `r3600` (all cards 1-54 minutes old), `r86400` (1-21 hours), `r259200` (up to 3 days), `r604800`. An invalid value (`abc`) is silently ignored. |
| `start` | Yes | Any integer offset, not only multiples of 10 (`start=5` shifts by 5). 10 cards per page, fixed. Cap: `start=800` works, `start=900`/`990`/`999` return an empty fragment (26 bytes, HTTP 200) even for queries with 8,000+ matches, and `start>=1000` returns **HTTP 400**. So at most about 810-900 results per query. |
| `f_WT` (1 on-site / 2 remote / 3 hybrid, `2,3`, `2%2C3`) | **No, silently ignored** | Every value returns exactly the baseline IDs in the same order, with `location` or with `geoId`, and with or without `f_TPR`. The public `/jobs/search` page also ignores `f_WT=2`. |
| `f_E` (tested `2`, `4`) | **No, silently ignored** | Baseline IDs, in order. |
| `f_JT` (tested `F`, `C`, `I`) | **No, silently ignored** | Baseline IDs, in order. |
| `sortBy` (`DD`, `R`) | **No, silently ignored** | Same order as the baseline, with and without `f_TPR`. The cards are not date-ordered. |

Consequence for the "criteria in the request" rule: only keywords, location/geoId, distance,
posting age and pagination can be pushed into the request. Work mode, seniority and job type
must be judged after fetching. Seniority and job type come from the detail page's criteria list
(below). Work mode is not a structured field anywhere, so it has to come from the title,
location or description text, which means the LLM. Sorting by date has to happen client-side,
using the card's `datetime`.

Values of `f_E` (1, 3, 5, 6) and `f_JT` (P, T) were not tried one by one. With identical results
for every value tested, across two base queries, the parameters themselves are being dropped.
This is not a problem with particular values. If LinkedIn turns them back on, re-check with the
same method: diff the ID lists.

## Evidence (selected)

Baseline `keywords=typescript&location=Poland` first IDs: `4467798222, 4458742343, 4441055010, ...`

- `&f_WT=1`, `=2`, `=3`, `=2%2C3`, `=2,3`, `&f_E=2`, `&f_E=4`, `&f_JT=C`, `&f_JT=F`, `&sortBy=DD`, `&sortBy=R`, `&f_TPR=abc` all return exactly the baseline list. The responses differ from the baseline only in the per-request `data-reference-id`/`trackingId` tokens (checked with `diff`).
- `geoId=105072130&f_TPR=r604800` compared with the same plus `&f_WT=2`, `&f_E=2` or `&f_JT=I`: identical lists (`4466907487, 4468925187, ...`).
- `&f_TPR=r3600`: all 10 cards say "N minutes ago" (1-54). `&f_TPR=r86400`: "1 hour ago" to "21 hours ago". The baseline contains cards from 2025-10-28 onward.
- `location=Warsaw` compared with `&distance=0`: `4469924834` (location "Warsaw, Mazowieckie, Poland", but matched loosely) drops out and the rest shift. With `&distance=100`, cards located as just "Poland" appear (`4466135499`, `4461133952`).
- `start=10` and `start=5` overlap as expected (`start=5` cards 6-10 equal `start=10` cards 1-5).

## Fields: search card vs detail page

Search card (`li > div.base-card.job-search-card`):

| Field | Selector | Notes |
|---|---|---|
| Job ID | `data-entity-urn="urn:li:jobPosting:<id>"` | |
| URL | `a.base-card__full-link[href]` | Carries tracking query params. Strip them. |
| Title | `h3.base-search-card__title` | |
| Company + URL | `h4.base-search-card__subtitle a` | |
| Location | `span.job-search-card__location` | Free text: "Warsaw, Mazowieckie, Poland", "Poland", "Torun Metropolitan Area". No work-mode marker. |
| Posted date | `time.job-search-card__listdate[datetime]` | **ISO date only (`2026-09-15`), no time.** Posts under 24 h old use class `job-search-card__listdate--new`. The text gives a relative age ("50 minutes ago", "1 week ago"). |
| Badge | `span.job-posting-benefits__text` | Optional: "Actively Hiring", "Be an early applicant". |
| Logo | `img[data-delayed-url]` | |
| Salary | none | No salary on any of the roughly 380 cards seen, including US cards whose detail page has a pay range. |

Detail page (`jobPosting/{id}`):

| Field | Selector | Notes |
|---|---|---|
| Title | `h2.top-card-layout__title` | |
| Company | `a.topcard__org-name-link` | |
| Location | second `span.topcard__flavor` | Same free text as on the card. |
| Posted | `span.posted-time-ago__text` | **Relative text only ("1 week ago"). No ISO date or timestamp anywhere on the page, and no JSON-LD.** Take the date from the search card. |
| Applicants | `.num-applicants__caption` | e.g. "48 applicants", "Over 200 applicants". |
| Salary | `div.salary.compensation__salary` inside `section.compensation` | Present only when the employer provides it (e.g. Replit: "$140,000.00/yr - $180,000.00/yr"). Otherwise absent, but it may still be in the description text (Reddit). |
| Description | `div.show-more-less-html__markup` | Full HTML description (3-7 KB of text). |
| Criteria list | `ul.description__job-criteria-list > li`: `h3.description__job-criteria-subheader` + `span.description__job-criteria-text` | Always 4 items: **Seniority level** (e.g. "Mid-Senior level", "Not Applicable"), **Employment type** ("Full-time", "Contract"), **Job function**, **Industries**. |
| Work mode | none | Not a structured field. "Remote" appears only in titles or descriptions. |

Note: "Seniority level" is often "Not Applicable", even for a role titled "New Grad" (Replit)
or "Staff" (Redpanda). The LLM should fall back to the title and description when it is.

Unknown job ID (`jobPosting/1`): **HTTP 404**, empty body.

## Rate limiting

No 429, no redirect to an auth wall, and no CAPTCHA across 49 requests in about 8 minutes,
spaced 1.5-2 s apart in bursts of 5-7. Responses come through Cloudflare (`server: cloudflare`,
`__cf_bm` cookie) and set `JSESSIONID`, `bcookie` and `lidc`. The thresholds were not probed.
The only non-200 codes were caused by the requests themselves: **400** for `start>=1000` and
**404** for an unknown job ID. The client should treat 429 and 999 (LinkedIn's historical
anti-bot code) as retry-later signals.

## Fixtures

Saved raw under `research/fixtures/linkedin/`:

- `search-typescript-poland-start0.html`: baseline search page, 10 cards, some with benefit badges
- `search-typescript-poland-f_TPR-r3600.html`: 10 cards all under 1 h old (`--new` date class, "N minutes ago")
- `search-empty-past-end.html`: the 26-byte empty fragment returned past the pagination cap
- `job-4467798222-no-salary.html`: detail page, no compensation section
- `job-4464163116-with-salary.html`: detail page with `compensation__salary`

## Request log

All requests below returned 200 unless marked otherwise. Search base = `seeMoreJobPostings/search?`.

```
keywords=typescript&location=Poland&start=0            baseline
  ...&f_TPR=r86400 | r604800 | r3600 | r259200 | abc
  ...&sortBy=DD | R
  ...&f_WT=1 | 2 | 3 | 2%2C3 | 2,3
  ...&f_TPR=r604800&sortBy=DD
keywords=typescript&geoId=105072130  (+ &f_WT=2)
keywords=typescript&location=Poland&f_E=2 | f_E=4 | f_JT=C | f_JT=F
keywords=rust&location=Poland
keywords=typescript&geoId=101282230
keywords=typescript                                     (no location)
keywords=typescript&location=Warsaw (+ &distance=0 | &distance=100)
keywords=typescript&geoId=105072130&f_TPR=r604800 (+ &f_WT=2 | &f_E=2 | &f_JT=I)
keywords=typescript%20remote&geoId=105072130&f_TPR=r604800
keywords=typescript&location=Poland&start=10 | 5 | 990(empty) | 1000(400) | 500
keywords=rust&location=Poland&start=100
keywords=software%20engineer&location=United%20States&start=990(empty) | 999(empty) | 900(empty) | 800 | 700
jobPosting/4467798222 | 4457250851 | 4466443420 | 4464163116 | 1 (404)
www.linkedin.com/jobs/search?keywords=typescript&location=Poland (+ &f_WT=2)   public page, "8,000+" results, f_WT ignored
```
