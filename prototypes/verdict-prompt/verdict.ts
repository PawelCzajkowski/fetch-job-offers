// The liftable part of the prototype: prompt, schema and one call per offer.
import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

export const Verdict = z.object({
  reason: z.string(),
  verdict: z.enum(["accepted", "rejected"]),
  workMode: z.enum(["remote", "hybrid", "on-site"]).nullable(),
  seniority: z.enum(["intern", "junior", "mid", "senior", "lead", "principal"]).nullable(),
  techStack: z.array(z.string()),
});
export type Verdict = z.infer<typeof Verdict>;

export const SYSTEM_PROMPT = `You screen LinkedIn job offers for one job seeker.

The seeker's profile is a short statement of the kind of work they are looking for. It says nothing about the seeker themselves, so never judge the seeker's experience or fit. Judge only whether the job is the kind of work the profile describes.

Accept when the job's main, day-to-day work is what the profile describes.
Reject when:
- the profile's technology or role appears only as a secondary skill, a "nice to have", or one item in a long list;
- the job is a different discipline (for example QA, DevOps, data engineering, support, management, sales) even if it mentions the profile's technology, unless the profile asks for that discipline;
- the posting is not a job offer (for example a training course or a talent pool).

reason: one sentence of at most 20 words naming the decisive fact from the offer.

Also read these from the title, location and description:
- workMode: remote, hybrid or on-site as stated in the offer; null if not stated.
- seniority: from the title and description; null if unclear.
- techStack: the main technologies the job uses, at most 8, as named in the offer.`;

export type OfferForJudging = {
  title: string;
  company: string;
  location: string;
  description: string;
};

export type JudgeResult =
  | { kind: "judged"; verdict: Verdict; inputTokens: number; outputTokens: number }
  | { kind: "unjudged"; why: string };

export async function judgeOffer(
  client: OpenAI,
  model: string,
  profile: string,
  offer: OfferForJudging,
): Promise<JudgeResult> {
  const input = `Profile: ${profile}

Offer
Title: ${offer.title}
Company: ${offer.company}
Location: ${offer.location}

Description:
${offer.description}`;

  try {
    const res = await client.responses.parse({
      model,
      reasoning: { effort: "low" },
      max_output_tokens: 4000,
      instructions: SYSTEM_PROMPT,
      input,
      text: { format: zodTextFormat(Verdict, "verdict") },
    });
    // responses.parse does not throw on truncation; it leaves output_parsed null.
    if (res.status !== "completed" || !res.output_parsed) {
      return { kind: "unjudged", why: `status=${res.status} ${JSON.stringify(res.incomplete_details ?? "")}` };
    }
    return {
      kind: "judged",
      verdict: res.output_parsed,
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    return { kind: "unjudged", why: String(err) };
  }
}
