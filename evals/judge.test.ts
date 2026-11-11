import { describe, expect, it } from "vitest";
import bundleJson from "../knowledge/bundle.json" with { type: "json" };
import type { Bundle } from "../src/knowledge/types";
import { DEFECT_TYPES, JUDGE_MODEL, JudgeSetSchema, judgeAnswer, type Verdict } from "./judge";
import judgeSet from "./judge-set.json" with { type: "json" };

const BUNDLE: Bundle = bundleJson;
type Call = { url: string; init: RequestInit };

/** A fake fetch that answers each call with the next scripted response. */
function fakeFetch(...replies: (() => Response)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    if (!reply) throw new Error("no scripted reply");
    return reply();
  };
  return { fetch: f as typeof fetch, calls };
}

/** A Messages API reply whose text block is `text`. */
const message = (text: string, stopReason = "end_turn") => () =>
  new Response(
    JSON.stringify({
      type: "message",
      model: JUDGE_MODEL,
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text },
      ],
      stop_reason: stopReason,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const good: Verdict = { score: 5, defects: [] };
const flagged: Verdict = { score: 2, defects: [{ type: "wrong_number", quote: "50%" }] };

const input = (f: typeof fetch) => ({
  apiKey: "test-key",
  bundle: BUNDLE,
  question: "What did Yash do at Amazon?",
  answer: "At Amazon, Yash cut the ticket queue by 50%.",
  refs: ["role:amazon"],
  rubric: "Names the role and real outcomes.",
  fetch: f,
});

describe("judgeAnswer", () => {
  it("parses a verdict", async () => {
    const { fetch } = fakeFetch(message(JSON.stringify(flagged)));
    expect(await judgeAnswer(input(fetch))).toEqual({ ok: true, verdict: flagged });
  });

  it("sends one Messages request with the knowledge, the cited refs, the question, the answer and the rubric", async () => {
    const { fetch, calls } = fakeFetch(message(JSON.stringify(good)));
    await judgeAnswer(input(fetch));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown> & {
      system: string;
      messages: { role: string; content: string }[];
      output_config: { effort: string; format: { type: string; schema: { required: string[] } } };
    };
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body).not.toHaveProperty("temperature"); // Sonnet 5.5 rejects non-default sampling values
    expect(body).not.toHaveProperty("thinking");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.required).toEqual(["score", "defects"]);
    expect(body.system).toContain(BUNDLE.text);
    for (const type of DEFECT_TYPES) expect(body.system).toContain(type);
    const content = body.messages[0]?.content ?? "";
    expect(body.messages).toHaveLength(1);
    expect(content).toContain("<cited_refs>role:amazon</cited_refs>");
    expect(content).toContain("What did Yash do at Amazon?");
    expect(content).toContain("cut the ticket queue by 50%");
    expect(content).toContain("Names the role and real outcomes.");
  });

  it("says when the answer cited nothing", async () => {
    const { fetch, calls } = fakeFetch(message(JSON.stringify(good)));
    await judgeAnswer({ ...input(fetch), refs: [], rubric: undefined });
    const body = JSON.parse(String(calls[0]?.init.body)) as { messages: { content: string }[] };
    expect(body.messages[0]?.content).toContain("<cited_refs>none</cited_refs>");
    expect(body.messages[0]?.content).not.toContain("<rubric>");
  });

  it("retries malformed JSON once", async () => {
    const { fetch, calls } = fakeFetch(message("Score: 5, looks good"), message(JSON.stringify(good)));
    expect(await judgeAnswer(input(fetch))).toEqual({ ok: true, verdict: good });
    expect(calls).toHaveLength(2);
  });

  it("records a judge error after a second malformed reply, without throwing", async () => {
    const { fetch, calls } = fakeFetch(message("{not json"), message(JSON.stringify({ score: 7, defects: [] })));
    const result = await judgeAnswer(input(fetch));
    expect(calls).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/schema/);
  });

  it.each([
    ["an HTTP error", () => new Response('{"error":{"type":"overloaded_error"}}', { status: 529 })],
    ["a refusal", message("", "refusal")],
    ["a cut-off reply", message('{"score":', "max_tokens")],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("turns %s into a judge error after one retry", async (_, reply) => {
    const { fetch, calls } = fakeFetch(reply);
    const result = await judgeAnswer(input(fetch));
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("never puts the API key in an error", async () => {
    const { fetch } = fakeFetch(() => new Response("bad key test-key", { status: 401 }));
    const result = await judgeAnswer(input(fetch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("test-key");
  });
});

describe("judge-set.json", () => {
  const set = JudgeSetSchema.parse(judgeSet);

  it("has 15 good answers, each with one planted defect, covering every defect type", () => {
    expect(set).toHaveLength(15);
    expect(new Set(set.map((e) => e.planted.type))).toEqual(new Set(DEFECT_TYPES));
    for (const e of set) expect(e.planted.answer).not.toBe(e.good);
  });

  it("cites only refs in the bundle", () => {
    const known = new Set(BUNDLE.refs);
    for (const e of set) for (const ref of [...e.refs, ...(e.planted.refs ?? [])]) expect(known).toContain(ref);
  });

  it("uses no pronouns for Yash in the good answers", () => {
    for (const e of set) expect(e.good).not.toMatch(/\b(he|him|his|himself|she|her|hers|herself)\b/i);
  });
});
