import { APIUserAbortError } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { SYSTEM_PROMPT, Verdict } from "./verdict.ts";

/** The parts of an offer the model sees, besides the profile. */
export interface OfferForJudging {
  title: string;
  company: string;
  location: string;
  /** The cleaned description text. */
  description: string;
}

type VerdictFormat = ReturnType<typeof zodTextFormat<typeof Verdict>>;

/** The body of the one `responses.parse` request made per offer. */
export interface JudgeRequest {
  model: string;
  reasoning: { effort: "low" };
  max_output_tokens: number;
  instructions: string;
  input: string;
  text: { format: VerdictFormat };
}

/** The per-request SDK options: retries and the run's abort signal. */
export interface JudgeRequestOptions {
  maxRetries: number;
  signal: AbortSignal;
}

/** The fields of a parsed Responses API response that judging reads. */
export interface JudgeResponse {
  status?: string | undefined;
  output_parsed: Verdict | null;
  output: ReadonlyArray<{
    type: string;
    content?: ReadonlyArray<{ type: string; refusal?: string }>;
  }>;
  incomplete_details?: { reason?: string | undefined } | null | undefined;
  error?: { message: string } | null | undefined;
  usage?:
    | {
        input_tokens: number;
        output_tokens: number;
        output_tokens_details: { reasoning_tokens: number };
      }
    | undefined;
}

/**
 * The subset of the OpenAI client that judging uses. A real `OpenAI`
 * instance satisfies it; tests pass a fake.
 */
export interface JudgeClient {
  responses: {
    parse(
      body: JudgeRequest,
      options: JudgeRequestOptions,
    ): PromiseLike<JudgeResponse>;
  };
}

export interface JudgeDeps {
  client: JudgeClient;
  /** The configured OpenAI model. */
  model: string;
  /** Aborts the call; an abort is rethrown rather than reported unjudged. */
  signal: AbortSignal;
}

/** Token usage of one call, which the run summary later costs. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type JudgeResult =
  | { outcome: "judged"; verdict: Verdict; usage: TokenUsage }
  | { outcome: "unjudged"; reason: string; usage: TokenUsage };

const MAX_OUTPUT_TOKENS = 4000;
const MAX_RETRIES = 2;

function buildInput(profile: string, offer: OfferForJudging): string {
  return `Profile: ${profile}

Offer
Title: ${offer.title}
Company: ${offer.company}
Location: ${offer.location}

Description:
${offer.description}`;
}

function usageOf(response: JudgeResponse): TokenUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    reasoningTokens:
      response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function findRefusal(response: JudgeResponse): string | undefined {
  for (const item of response.output) {
    for (const part of item.content ?? []) {
      if (part.type === "refusal") return part.refusal ?? "";
    }
  }
  return undefined;
}

/** Why a refused or unfinished response gives no verdict, if it is one. */
function unjudgedReason(response: JudgeResponse): string | undefined {
  const refusal = findRefusal(response);
  if (refusal !== undefined) return `The model refused: ${refusal}`;

  if (response.status !== "completed") {
    const detail =
      response.error?.message ?? response.incomplete_details?.reason;
    const status = `The response ended with status "${response.status ?? "unknown"}"`;
    return detail ? `${status}: ${detail}` : status;
  }
  return undefined;
}

const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

/**
 * Judges one offer against a profile with one Responses API call (spec
 * section 7). A refusal, a status other than completed, a missing parsed
 * output, or an SDK error after its retries gives an unjudged result with a
 * human-readable reason. An abort is not a judging failure, so it is
 * rethrown for the run to stop on.
 */
export async function judgeOffer(
  deps: JudgeDeps,
  profile: string,
  offer: OfferForJudging,
): Promise<JudgeResult> {
  const { client, model, signal } = deps;

  let response: JudgeResponse;
  try {
    response = await client.responses.parse(
      {
        model,
        reasoning: { effort: "low" },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        instructions: SYSTEM_PROMPT,
        input: buildInput(profile, offer),
        text: { format: zodTextFormat(Verdict, "verdict") },
      },
      { maxRetries: MAX_RETRIES, signal },
    );
  } catch (error) {
    if (signal.aborted || error instanceof APIUserAbortError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "unjudged",
      reason: `The OpenAI call failed: ${message}`,
      usage: NO_USAGE,
    };
  }

  const usage = usageOf(response);
  const reason = unjudgedReason(response);
  if (reason !== undefined) return { outcome: "unjudged", reason, usage };
  if (response.output_parsed === null) {
    return {
      outcome: "unjudged",
      reason: "The response had no parsed verdict.",
      usage,
    };
  }
  return { outcome: "judged", verdict: response.output_parsed, usage };
}
