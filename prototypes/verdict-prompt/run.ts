// PROTOTYPE, throwaway. Run: pnpm start --profile "Java development"
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { detail, searchPage, sleep, type Card, type Detail } from "./linkedin.ts";
import { judgeOffer, SYSTEM_PROMPT, type JudgeResult } from "./verdict.ts";

const { values: args } = parseArgs({
  options: {
    profile: { type: "string", default: "Java development" },
    keywords: { type: "string", default: "Java Backend Developer" },
    location: { type: "string", default: "Warsaw, Poland" },
    tpr: { type: "string", default: "r604800" },
    count: { type: "string", default: "12" },
    model: { type: "string", default: "gpt-6-luna" },
    refetch: { type: "boolean", default: false },
  },
});

type Offer = Card & Detail;
const slug = args.keywords!.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const CACHE = `PROTOTYPE-offers-cache-${slug}.json`; // avoids re-hitting LinkedIn while iterating on the prompt

async function fetchOffers(): Promise<Offer[]> {
  if (existsSync(CACHE) && !args.refetch) {
    console.log(`Using cached offers from ${CACHE} (pass --refetch to refresh)`);
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
  const want = Number(args.count);
  const cards: Card[] = [];
  for (let start = 0; cards.length < want && start < 50; start += 10) {
    const page = await searchPage(args.keywords!, args.location!, args.tpr!, start);
    if (page.length === 0) break;
    for (const c of page) if (!cards.some((x) => x.id === c.id)) cards.push(c);
    await sleep(1500);
  }
  const offers: Offer[] = [];
  for (const card of cards.slice(0, want)) {
    process.stdout.write(`fetching ${card.id} ${card.title}\n`);
    offers.push({ ...card, ...(await detail(card.id)) });
    await sleep(1500);
  }
  writeFileSync(CACHE, JSON.stringify(offers, null, 2));
  return offers;
}

const offers = await fetchOffers();
const client = new OpenAI();
const results: { offer: Offer; result: JudgeResult }[] = [];
for (const offer of offers) {
  const result = await judgeOffer(client, args.model!, args.profile!, offer);
  results.push({ offer, result });
  const line =
    result.kind === "judged"
      ? `${result.verdict.verdict.toUpperCase().padEnd(8)} ${offer.title} @ ${offer.company}\n         ${result.verdict.reason}`
      : `UNJUDGED ${offer.title} @ ${offer.company}\n         ${result.why}`;
  console.log(line);
}

const inTok = results.reduce((s, r) => s + (r.result.kind === "judged" ? r.result.inputTokens : 0), 0);
const outTok = results.reduce((s, r) => s + (r.result.kind === "judged" ? r.result.outputTokens : 0), 0);
const cost = (inTok * 0.1 + outTok * 0.5) / 1_000_000;
console.log(`\n${inTok} input + ${outTok} output tokens, about $${cost.toFixed(4)}`);

const data = {
  profile: args.profile,
  search: { keywords: args.keywords, location: args.location, tpr: args.tpr },
  model: args.model,
  systemPrompt: SYSTEM_PROMPT,
  tokens: { inTok, outTok, cost },
  results,
};
const template = readFileSync(new URL("./review-template.html", import.meta.url), "utf8");
writeFileSync(`review-${slug}.html`, template.replace("/*DATA*/null", JSON.stringify(data).replace(/</g, "\\u003c")));
console.log(`Wrote review-${slug}.html`);
