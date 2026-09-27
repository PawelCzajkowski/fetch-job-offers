import type OpenAI from "openai";
import { APIConnectionError, APIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";
import {
  type JudgeClient,
  type JudgeRequest,
  type JudgeRequestOptions,
  type JudgeResponse,
  judgeOffer,
  type OfferForJudging,
} from "../../src/judge/judge.ts";
import { SYSTEM_PROMPT, type Verdict } from "../../src/judge/verdict.ts";

// Type-level check: the real SDK client satisfies the injected subset.
const realClientFits = (client: OpenAI): JudgeClient => client;
void realClientFits;

const offer: OfferForJudging = {
  title: "Senior TypeScript Developer",
  company: "Acme",
  location: "Warsaw, Poland",
  description: "Build Node.js services in TypeScript.\nFully remote.",
};

const profile = "TypeScript backend development";

const verdict: Verdict = {
  reason: "Day-to-day work is building TypeScript Node.js services.",
  verdict: "accepted",
  workMode: "remote",
  seniority: "senior",
  techStack: ["TypeScript", "Node.js"],
};

const usage = {
  input_tokens: 812,
  output_tokens: 240,
  output_tokens_details: { reasoning_tokens: 128 },
};

const expectedUsage = {
  inputTokens: 812,
  outputTokens: 240,
  reasoningTokens: 128,
};

const zeroUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

function completed(overrides: Partial<JudgeResponse> = {}): JudgeResponse {
  return {
    status: "completed",
    output_parsed: verdict,
    output: [
      {
        type: "message",
        content: [{ type: "output_text" }],
      },
    ],
    incomplete_details: null,
    error: null,
    usage,
    ...overrides,
  };
}

interface Call {
  body: JudgeRequest;
  options: JudgeRequestOptions;
}

function fakeClient(respond: () => Promise<JudgeResponse>) {
  const calls: Call[] = [];
  const client: JudgeClient = {
    responses: {
      parse(body, options) {
        calls.push({ body, options });
        return respond();
      },
    },
  };
  return { client, calls };
}

function judge(client: JudgeClient, signal = new AbortController().signal) {
  return judgeOffer({ client, model: "gpt-5-mini", signal }, profile, offer);
}

describe("judgeOffer", () => {
  it("sends one parse request with the configured model, low reasoning, 4000 max tokens, the verdict format, 2 retries and the signal", async () => {
    const { client, calls } = fakeClient(async () => completed());
    const signal = new AbortController().signal;

    await judge(client, signal);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.body.model).toBe("gpt-5-mini");
    expect(call?.body.reasoning).toEqual({ effort: "low" });
    expect(call?.body.max_output_tokens).toBe(4000);
    expect(call?.body.instructions).toBe(SYSTEM_PROMPT);
    expect(call?.body.text.format).toMatchObject({
      type: "json_schema",
      name: "verdict",
      strict: true,
    });
    expect(call?.options).toEqual({ maxRetries: 2, signal });
    expect(call?.options.signal).toBe(signal);
  });

  it("puts the profile and the offer's title, company, location and description in the input", async () => {
    const { client, calls } = fakeClient(async () => completed());

    await judge(client);

    expect(calls[0]?.body.input).toBe(
      [
        "Profile: TypeScript backend development",
        "",
        "Offer",
        "Title: Senior TypeScript Developer",
        "Company: Acme",
        "Location: Warsaw, Poland",
        "",
        "Description:",
        "Build Node.js services in TypeScript.",
        "Fully remote.",
      ].join("\n"),
    );
  });

  it("asks for the verdict fields, with techStack capped at 8 in the JSON schema", async () => {
    const { client, calls } = fakeClient(async () => completed());

    await judge(client);

    const format = calls[0]?.body.text.format as unknown as {
      schema: {
        properties: Record<string, Record<string, unknown>>;
        required: string[];
      };
    };
    expect(format.schema.required).toEqual([
      "reason",
      "verdict",
      "workMode",
      "seniority",
      "techStack",
    ]);
    expect(format.schema.properties.techStack).toMatchObject({
      type: "array",
      maxItems: 8,
    });
  });

  it("returns the verdict and the input, output and reasoning token usage", async () => {
    const { client } = fakeClient(async () => completed());

    const result = await judge(client);

    expect(result).toEqual({
      outcome: "judged",
      verdict,
      usage: expectedUsage,
    });
  });

  it("gives an unjudged result when the response is incomplete, keeping its usage", async () => {
    const { client } = fakeClient(async () =>
      completed({
        status: "incomplete",
        output_parsed: null,
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );

    const result = await judge(client);

    expect(result).toEqual({
      outcome: "unjudged",
      reason: 'The response ended with status "incomplete": max_output_tokens',
      usage: expectedUsage,
    });
  });

  it("gives an unjudged result with the API's error message when the response failed", async () => {
    const { client } = fakeClient(async () =>
      completed({
        status: "failed",
        output_parsed: null,
        error: { message: "The server had an error." },
      }),
    );

    const result = await judge(client);

    expect(result).toMatchObject({
      outcome: "unjudged",
      reason:
        'The response ended with status "failed": The server had an error.',
    });
  });

  it("gives an unjudged result with the model's refusal text when it refuses", async () => {
    const { client } = fakeClient(async () =>
      completed({
        output_parsed: null,
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "I can't help with that." }],
          },
        ],
      }),
    );

    const result = await judge(client);

    expect(result).toEqual({
      outcome: "unjudged",
      reason: "The model refused: I can't help with that.",
      usage: expectedUsage,
    });
  });

  it("treats a refusal as unjudged even when a parsed output is present", async () => {
    const { client } = fakeClient(async () =>
      completed({
        output: [
          { type: "reasoning" },
          { type: "message", content: [{ type: "refusal", refusal: "No." }] },
        ],
      }),
    );

    const result = await judge(client);

    expect(result).toMatchObject({
      outcome: "unjudged",
      reason: "The model refused: No.",
    });
  });

  it("gives an unjudged result when a completed response has no parsed output", async () => {
    const { client } = fakeClient(async () =>
      completed({ output_parsed: null }),
    );

    const result = await judge(client);

    expect(result).toMatchObject({
      outcome: "unjudged",
      reason: "The response had no parsed verdict.",
    });
  });

  it("gives an unjudged result with zero usage when the SDK throws after its retries", async () => {
    const { client } = fakeClient(async () => {
      throw new APIConnectionError({ message: "Connection error." });
    });

    const result = await judge(client);

    expect(result).toEqual({
      outcome: "unjudged",
      reason: "The OpenAI call failed: Connection error.",
      usage: zeroUsage,
    });
  });

  it("gives an unjudged result when parsing the output throws", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("Too big: expected array to have <=8 items");
    });

    const result = await judge(client);

    expect(result).toMatchObject({
      outcome: "unjudged",
      reason:
        "The OpenAI call failed: Too big: expected array to have <=8 items",
    });
  });

  it("rethrows when the signal is aborted, instead of reporting the offer unjudged", async () => {
    const controller = new AbortController();
    const { client } = fakeClient(async () => {
      controller.abort();
      throw new APIUserAbortError();
    });

    await expect(judge(client, controller.signal)).rejects.toBeInstanceOf(
      APIUserAbortError,
    );
  });

  it("rethrows whatever the SDK throws once the signal is aborted", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    const { client } = fakeClient(async () => {
      controller.abort();
      throw abortError;
    });

    await expect(judge(client, controller.signal)).rejects.toBe(abortError);
  });

  it("rethrows an SDK abort error even if the signal is not marked aborted", async () => {
    const { client } = fakeClient(async () => {
      throw new APIUserAbortError();
    });

    await expect(judge(client)).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it("defaults missing usage to zero", async () => {
    const { client } = fakeClient(async () => {
      const { usage: _, ...rest } = completed();
      return rest;
    });

    const result = await judge(client);

    expect(result).toMatchObject({ outcome: "judged", usage: zeroUsage });
  });
});
