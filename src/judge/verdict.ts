import { z } from "zod";

/** Most technologies a verdict lists in its tech stack (spec section 7). */
export const MAX_TECH_STACK = 8;

/**
 * What the model returns for one offer: the verdict with its one-line reason,
 * plus the judged fields read from the offer in the same call. The
 * `techStack` cap becomes `maxItems` in the strict JSON schema sent to the
 * API, so the model is constrained to it, and the SDK re-checks it on parse.
 */
export const Verdict = z.object({
  reason: z.string(),
  verdict: z.enum(["accepted", "rejected"]),
  workMode: z.enum(["remote", "hybrid", "on-site"]).nullable(),
  seniority: z
    .enum(["intern", "junior", "mid", "senior", "lead", "principal"])
    .nullable(),
  techStack: z.array(z.string()).max(MAX_TECH_STACK),
});
export type Verdict = z.infer<typeof Verdict>;

/** The prompt validated on 24 real offers (issue #5). Keep the text as is. */
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
