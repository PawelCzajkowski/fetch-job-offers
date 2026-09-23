# OpenAI structured outputs with `gpt-6-luna` from Node, and the cost of a run

Resolves #3 (part of #1). Researched 2026-09-23 against OpenAI's developer docs, its pricing and model pages, and the `openai/openai-node` repo (latest release `v7.23.0`, published 2026-09-23).

## Short answer

- Use the **Responses API** with `client.responses.parse()` and the SDK's **`zodTextFormat()`** helper. It sends a strict JSON schema, and the SDK validates the reply with Zod and gives it to you as `response.output_parsed`.
- **`gpt-6-luna` exists and supports structured outputs.** It costs **$0.10 per 1M input tokens, $0.01 per 1M cached input tokens and $0.50 per 1M output tokens**. Its context window is 1.05M tokens.
- A 50-offer run costs about **2 to 15 US cents**. Most of that range depends on how many reasoning tokens the model uses.
- Neither the Batch API nor judging several offers per call is worth it for a tool you run by hand. Each saves fractions of a cent and adds complexity or a wait of up to 24 hours.

## 1. Responses API or Chat Completions?

**Use Responses.**

- OpenAI says: "While Chat Completions remains supported, Responses is recommended for all new projects." It also claims 40% to 80% better cache use and "a richer experience" with reasoning models, and `gpt-6-luna` is a reasoning model. Source: https://developers.openai.com/api/docs/guides/migrate-to-responses
- The SDK's own docs say: "The Responses API is the recommended starting point: call `client.responses.parse()` with a parseable `text.format`". Source: https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md
- Structured-output settings go in different places. Chat Completions uses top-level `response_format`, and Responses uses `text.format`. Source: https://developers.openai.com/api/docs/guides/migrate-to-responses
- `gpt-6-luna` works with both endpoints, and also with Batch. Source: https://developers.openai.com/api/docs/models/gpt-6-luna

## 2. How JSON-schema structured outputs work, and the Zod helper

The API takes a JSON schema in `text.format` (`type: "json_schema"`, `strict: true`) and constrains the model's reply to match it. Sources: https://developers.openai.com/api/docs/guides/structured-outputs and https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md

The `zodTextFormat(schema, name)` helper, imported from `openai/helpers/zod`, turns a Zod schema into that strict JSON schema. It always sets `strict: true`. The same helper also parses the returned JSON and validates it with the Zod schema. Source: https://github.com/openai/openai-node/blob/main/src/helpers/zod.ts

- The helpers accept `zod/v3`, `zod/v4` and `zod/v4-mini` schemas. Zod is an optional peer dependency (`^3.25 || ^4.0`), and the SDK needs Node `>=22.0.0`. Sources: https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md and https://github.com/openai/openai-node/blob/main/package.json
- `standardTextFormat()` from `openai/helpers/standard-schema` does the same job for any Standard Schema validator. Source: https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md
- The Chat Completions equivalent is `zodResponseFormat()` with `client.chat.completions.parse()`, and the result is in `choices[0].message.parsed`. Source: same.

**Schema rules** (source: https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md):

- The root must be an object. Root-level unions are not supported.
- Every property must be required. For a value that can be missing, use `.nullable()`, not `.optional()`.
- Enums, arrays, nullable values and discriminated unions are fine.
- Put the descriptions the model should see in `.describe('...')`. The model never sees TypeScript comments.
- Refinements, transforms, `Date` and intersections are rejected. Validate those after parsing.
- The first request with a new schema is slower while the API processes it. Later requests with the same schema are not. Source: https://developers.openai.com/api/docs/guides/structured-outputs

### Minimal sample for this project

```ts
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod/v4';

export const Verdict = z.object({
  verdict: z.enum(['accepted', 'rejected']),
  reason: z.string().describe('One line explaining the verdict against the profile'),
  details: z.object({
    salary: z.string().nullable().describe('As stated in the offer, e.g. "20-25k PLN B2B"; null if absent'),
    techStack: z.array(z.string()),
    workMode: z.enum(['remote', 'hybrid', 'onsite']).nullable(),
    seniority: z.string().nullable(),
  }),
});
export type Verdict = z.infer<typeof Verdict>;

const client = new OpenAI(); // reads OPENAI_API_KEY

export async function judge(profile: string, offer: string): Promise<Verdict> {
  const response = await client.responses.parse({
    model: 'gpt-6-luna',
    reasoning: { effort: 'low' },   // default is 'medium'; see cost section
    max_output_tokens: 4_000,
    // Static part first, so the prefix can be cached (see section 6)
    instructions: `Judge the job offer against this candidate profile.\n\nPROFILE:\n${profile}`,
    input: offer,
    text: { format: zodTextFormat(Verdict, 'verdict') },
  });

  if (response.status === 'incomplete') {
    throw new Error(`Verdict incomplete: ${response.incomplete_details?.reason}`);
  }
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const c of item.content) {
      if (c.type === 'refusal') throw new Error(`Model refused: ${c.refusal}`);
    }
  }
  if (!response.output_parsed) throw new Error('No parsed verdict');
  return response.output_parsed;
}
```

This follows the patterns at https://developers.openai.com/api/docs/guides/structured-outputs and https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md.

**Testing note:** the call goes through one method, `client.responses.parse`. A test mock only has to return `{ status, output, output_parsed }`, so tests can cover the refusal and incomplete branches without the network. This comes from reading the SDK's parser; the pattern itself is not an official doc.

## 3. Does `gpt-6-luna` support structured outputs?

**Yes.** The model page lists "Structured outputs" and "Function calling" as supported features, and Chat Completions, Responses and Batch as supported endpoints. Source: https://developers.openai.com/api/docs/models/gpt-6-luna

The structured-outputs guide says only "available in our latest large language models, starting with GPT-4o", and its code samples use `gpt-6-astra`. The guide does not name `gpt-6-luna`, but the model page is the authority here. Source: https://developers.openai.com/api/docs/guides/structured-outputs

## 4. Refusals and truncated replies

**Refusals.** A safety refusal does not follow your schema. In Responses, it shows up as a message content item with `type: "refusal"` and a `refusal` string, where you would otherwise get `output_text`. The docs recommend checking for it in code. Source: https://developers.openai.com/api/docs/guides/structured-outputs

**Truncation.** When the reply is cut off, `response.status === "incomplete"` and `incomplete_details.reason` is either `"max_output_tokens"` or `"content_filter"`. Source: https://developers.openai.com/api/docs/guides/structured-outputs

This matters more for reasoning models. Hidden reasoning tokens count toward `max_output_tokens`, so a low limit can run out before any JSON is written. OpenAI suggests reserving at least 25,000 tokens for reasoning and output while you experiment. Source: https://developers.openai.com/api/docs/guides/reasoning

**What the SDK does.** The two APIs behave differently, and this is easy to miss:

- **Responses: `responses.parse()` does not throw on an incomplete reply.** It parses only when `status` is `completed`. For an incomplete reply, `output_parsed` is `null`, and `status` and `incomplete_details` are left for you to inspect. Sources: https://github.com/openai/openai-node/blob/main/src/lib/ResponsesParser.ts and https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md
- A reply that completes but contains invalid JSON throws `SyntaxError('Error reading response: invalid structured output JSON.')`. A reply that fails Zod validation throws from the helper's Zod parse. Sources: https://github.com/openai/openai-node/blob/main/src/lib/parser.ts and https://github.com/openai/openai-node/blob/main/src/helpers/zod.ts
- **Chat Completions: `chat.completions.parse()` does throw.** A `finish_reason` of `length` raises `LengthFinishReasonError`, and `content_filter` raises `ContentFilterFinishReasonError`. Source: https://github.com/openai/openai-node/blob/main/docs/helpers.md

**Recommended handling for this CLI.** Treat refusal, incomplete and parse failure as a third outcome, "could not judge", with the cause attached. Do not count them as `rejected`.

- On `max_output_tokens`, retry once with a higher limit or a lower reasoning effort.
- On `content_filter` or a refusal, don't retry. Report the offer as skipped.
- The guide also advises telling the model in the prompt what to do when the input can't produce a valid answer, for example an empty or non-job page. Source: https://developers.openai.com/api/docs/guides/structured-outputs

## 5. `gpt-6-luna` facts

All from https://developers.openai.com/api/docs/models/gpt-6-luna unless noted otherwise.

| Item | Value |
|---|---|
| Model ID / snapshot | `gpt-6-luna` (no dated snapshot listed) |
| Description | "our most efficient model for focused, high-volume tasks" |
| Input price | **$0.10 / 1M tokens** |
| Cached input price | **$0.01 / 1M tokens** |
| Cache write price | $0.125 / 1M tokens (1.25x input) |
| Output price | **$0.50 / 1M tokens** (reasoning tokens are billed as output) |
| Batch and Flex | 50% of Standard: $0.05 in, $0.005 cached, $0.25 out ([pricing](https://developers.openai.com/api/docs/pricing)) |
| Long context | Prompts over 272K input tokens cost 2x input and cache rates and 1.5x output for the whole request |
| Context window | 1,050,000 tokens (at most 922,000 input); max output 128,000 |
| Knowledge cutoff | 2026-05-18 |
| Reasoning | Yes. `reasoning.effort` can be `none`, `low`, `medium` (default), `high`, `xhigh` or `max` |
| Modalities | Text and image in, text out |

Reasoning tokens are billed as output tokens and appear in `usage.output_tokens_details.reasoning_tokens`. Source: https://developers.openai.com/api/docs/guides/reasoning

**Rate limits**, per usage tier of your organization:

| Tier | RPM | TPM | Batch queue |
|---|---|---|---|
| 1 | 500 | 500,000 | 5,000,000 |
| 2 | 5,000 | 2,000,000 | 20,000,000 |
| 3 | 5,000 | 4,000,000 | 40,000,000 |
| 4 | 10,000 | 10,000,000 | 1,000,000,000 |
| 5 | 30,000 | 180,000,000 | 15,000,000,000 |

Even at Tier 1, a 50-offer run (about 190K tokens) fits inside one minute's TPM budget, so running a few calls in parallel is safe.

Not verified:

- The announcement post (https://openai.com/index/introducing-gpt-6-sol-and-luna/) returned HTTP 403, so its claims were not checked. The model page and pricing page, both first-party, were readable and are the sources above.
- The pricing page gives no release date for the model.
- The 272K threshold for long-context pricing comes from the model page. The pricing page does not state it for this model.

## 6. Several offers per call, the Batch API, Flex and caching

**Several offers per call: not worth it.** Only the instructions and profile (about 300 to 500 tokens) would be shared. Each description (about 3K tokens) is paid for either way. Sending 10 offers per call saves about 20K input tokens per 50-offer run, which is **about $0.002**. In exchange you get a root-level array schema to wrap in an object, verdicts that can influence each other, and one failure that loses 10 verdicts. This is our own arithmetic from the prices above.

**Batch API: not worth it for a run by hand.** It is 50% cheaper and supports `/v1/responses`, but the only completion window is 24 hours. You upload a JSONL file (up to 50,000 requests or 200 MB) and poll for results. Source: https://developers.openai.com/api/docs/guides/batch. On a run that costs a few cents, it saves 1 to 7 cents and adds a wait and a whole second code path.

**Flex processing is a cheap option to consider later.** Setting `service_tier: "flex"` on an ordinary Responses call gets Batch prices while staying synchronous. The trade-offs are slower replies and occasional `429 Resource Unavailable` errors, which are not charged. OpenAI suggests raising the SDK timeout to 15 minutes. Source: https://developers.openai.com/api/docs/guides/flex-processing. `gpt-6-luna` has Flex rows on the [pricing page](https://developers.openai.com/api/docs/pricing). A `--flex` flag could be added later.

**Prompt caching won't apply by default.** For GPT-5.6 and later, a prefix has to be at least 1,024 tokens to be cached. A cached prefix lasts 30 minutes. Writes cost 1.25x the input rate and reads cost 0.1x. Source: https://developers.openai.com/api/docs/guides/prompt-caching. Our shared prefix (instructions plus a 300-token profile) is below 1,024, so every request pays full input price. It's still worth putting the instructions and profile first: they would start caching if the profile grows past about 1K tokens.

## 7. Cost of a 50-offer run

Assumptions:

- Each call has about 3,000 tokens of description, 300 of profile and about 300 of instructions and schema, so **about 3,600 input tokens**.
- The visible JSON verdict is about 150 output tokens.
- There is no caching (see section 6).

These are estimates. Actual reasoning-token use is not published and has to be measured from `usage`.

- Input: 50 × 3,600 = 180,000 tokens × $0.10/1M = **$0.018**

| Reasoning tokens per offer (assumed) | Output tokens (50 offers) | Output cost | **Total per run** | With Flex/Batch |
|---|---|---|---|---|
| ~0 (`effort: 'none'`) | 7,500 | $0.004 | **~$0.022** | ~$0.011 |
| ~500 (`low`) | 32,500 | $0.016 | **~$0.034** | ~$0.017 |
| ~1,500 (`medium`, default) | 82,500 | $0.041 | **~$0.06** | ~$0.03 |
| ~5,000 (`high` or above) | 257,500 | $0.129 | **~$0.15** | ~$0.07 |

So a run costs a few cents. At 100 runs a month, that's roughly $2 to $15. If every request were billed a cache write at $0.125/1M, input would rise from $0.018 to $0.0225. That doesn't change the conclusion. The docs don't make clear whether write charges apply when there's no cacheable prefix.

## Recommendations for the build

1. Use `client.responses.parse` + `zodTextFormat` and a Zod v4 schema with nullable fields rather than optional ones.
2. Start with `reasoning.effort: 'low'`. Make the model and effort configurable, with `gpt-6-luna` as the default. Log `usage` so the real cost per run can be printed.
3. Treat refusal, incomplete and parse errors as a third outcome, "could not judge". `responses.parse` won't throw on an incomplete reply, so check `status` explicitly.
4. Make one call per offer with modest concurrency. Skip the Batch API and don't put several offers in one call. Flex can be an opt-in flag later.
