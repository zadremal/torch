// The bedrock provider: gateway call keys, gateway model names, api_request events without request_id.
import { describe, expect, test } from "bun:test";
import { API_REQUEST_MATCH_WINDOW_MS } from "../../src/contracts/constants.ts";
import { bedrock } from "../../src/providers/bedrock.ts";
import { call, event, pairs, response, T0, tokens } from "./support.ts";

describe("callKey", () => {
  test("a gateway response: the message id shared by all its lines", () => {
    const { lines, key } = response({ gateway: true });
    expect(key).toStartWith("msg_bdrk_");
    expect(lines.map(bedrock.callKey)).toEqual([key, key]);
  });

  test("a direct-API-shaped line keeps its requestId, not the message id", () => {
    const { lines, key } = response();
    expect(key).toStartWith("req_");
    expect(lines.map(bedrock.callKey)).toEqual([key, key]);
  });

  test("a line with neither has no key", () => {
    const [line] = response({ gateway: true }).lines;
    expect(bedrock.callKey({ ...line!, messageId: null })).toBeNull();
  });
});

describe("canonicalModel", () => {
  test.each([
    ["claude-align-aws-opus-5-5", "claude-opus-5-5"],
    ["claude-align-aws-opus-5-5[1m]", "claude-opus-5-5"],
    ["claude-align-aws-sonnet-5-5", "claude-sonnet-5-5"],
    ["align-aws-haiku-4-5", "claude-haiku-4-5"],
    ["us.anthropic.claude-sonnet-5-5-v1:0", "claude-sonnet-5-5"],
    ["global.anthropic.claude-opus-5-5-v2:0", "claude-opus-5-5"],
    ["eu.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5-20251001"],
    ["anthropic.claude-fable-5-2", "claude-fable-5-2"],
    ["claude-opus-5-5@20261001", "claude-opus-5-5"],
    ["Claude-Opus-5-5", "claude-opus-5-5"],
    ["claude.align_aws.opus-5.5", "claude-opus-5-5"],
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["claude-opus-5", "claude-opus-5"],
    ["claude-align-aws-opus-5", "claude-opus-5"],
    ["claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20241022"],
    ["mythos-1", "claude-mythos-1"],
  ])("%s → %s", (reported, canonical) => {
    expect(bedrock.canonicalModel(reported)).toBe(canonical);
  });

  test("a name without a Claude family is returned unchanged", () => {
    for (const model of ["gpt-5", "<synthetic>", "us.amazon.nova-pro-v1:0", "Claude-Instant"]) expect(bedrock.canonicalModel(model)).toBe(model);
  });
});

test("declaredContextWindow: 1M for a [1m] name in any case, otherwise the price table decides", () => {
  expect(bedrock.declaredContextWindow("claude-align-aws-opus-5-5[1m]")).toBe(1_000_000);
  expect(bedrock.declaredContextWindow("claude-opus-5-5[1M]")).toBe(1_000_000);
  expect(bedrock.declaredContextWindow("claude-align-aws-opus-5-5")).toBeNull();
  expect(bedrock.declaredContextWindow("claude-opus-5-5-1m")).toBeNull();
});

describe("matchApiRequests", () => {
  test("a requestId pairs first, as on the direct API, even with a call outside the window", () => {
    const calls = [call("req_a", { tsEnd: T0 + 60_000, durationExact: true }), call("msg_bdrk_b")];
    expect(pairs(bedrock.matchApiRequests([event(1, { requestId: "req_a" })], calls))).toEqual([[1, "req_a"]]);
  });

  test("without requestId: the call of the same model ending near the event; the reported names differ", () => {
    const calls = [call("msg_bdrk_a", { tsEnd: T0 + 800 })];
    expect(pairs(bedrock.matchApiRequests([event(1, { model: "align-aws-opus-5-5" })], calls))).toEqual([[1, "msg_bdrk_a"]]);
  });

  test("the window is inclusive at its boundary, on both sides", () => {
    const at = (gap: number) => bedrock.matchApiRequests([event(1)], [call("c", { tsEnd: T0 + gap })]).size;
    expect(at(API_REQUEST_MATCH_WINDOW_MS)).toBe(1);
    expect(at(-API_REQUEST_MATCH_WINDOW_MS)).toBe(1);
    expect(at(API_REQUEST_MATCH_WINDOW_MS + 1)).toBe(0);
    expect(at(-API_REQUEST_MATCH_WINDOW_MS - 1)).toBe(0);
  });

  test("another model, an event without a model and a call with an exact duration do not pair", () => {
    expect(bedrock.matchApiRequests([event(1, { model: "align-aws-haiku-4-5" })], [call("c")]).size).toBe(0);
    expect(bedrock.matchApiRequests([event(1, { model: null })], [call("c")]).size).toBe(0);
    expect(bedrock.matchApiRequests([event(1)], [call("c", { durationExact: true })]).size).toBe(0);
  });

  test("a call already taken by a requestId is not paired again by time", () => {
    const matched = bedrock.matchApiRequests([event(1, { requestId: "c" }), event(2)], [call("c")]);
    expect(pairs(matched)).toEqual([[1, "c"]]);
  });

  test("an event whose requestId names no call still pairs by time", () => {
    expect(pairs(bedrock.matchApiRequests([event(1, { requestId: "req_gone" })], [call("c")]))).toEqual([[1, "c"]]);
  });

  test("one-to-one by nearest time: two events and two calls do not both take the nearer call", () => {
    const calls = [call("c1", { tsEnd: T0 + 100 }), call("c2", { tsEnd: T0 + 2100 })];
    const events = [event(1, { ts: T0 + 1900 }), event(2, { ts: T0 })];
    expect(pairs(bedrock.matchApiRequests(events, calls))).toEqual([
      [1, "c2"],
      [2, "c1"],
    ]);
    // More events than calls: the farther one stays unmatched.
    expect(pairs(bedrock.matchApiRequests([event(1, { ts: T0 + 50 }), event(2, { ts: T0 + 300 })], [calls[0]!]))).toEqual([[1, "c1"]]);
  });

  test("parallel subagents on one model finishing within the same second: equal tokens outrank nearer time", () => {
    const a = tokens(3, 410, 52_000, 1200);
    const b = tokens(5, 90, 18_000, 0);
    const calls = [call("msg_bdrk_a", { tsEnd: T0 + 200, ...a.call }), call("msg_bdrk_b", { tsEnd: T0 + 600, ...b.call })];
    // Each event is nearer in time to the other agent's call.
    const events = [event(1, { ts: T0 + 550, ...a.event }), event(2, { ts: T0 + 250, ...b.event })];
    expect(pairs(bedrock.matchApiRequests(events, calls))).toEqual([
      [1, "msg_bdrk_a"],
      [2, "msg_bdrk_b"],
    ]);
  });

  test("tokens only rank: an event with unknown or differing counts still pairs by time", () => {
    const calls = [call("c", { tsEnd: T0 + 300, ...tokens(1, 2, 3, 4).call })];
    expect(pairs(bedrock.matchApiRequests([event(1, { ...tokens(1, 2, 3, 5).event })], calls))).toEqual([[1, "c"]]);
    expect(pairs(bedrock.matchApiRequests([event(1, { ...tokens(1, 2, 3, 4).event, cacheCreationTokens: null })], calls))).toEqual([[1, "c"]]);
  });

  test("an event with partly unknown counts does not outrank by tokens: the nearer call wins", () => {
    const near = call("near", { tsEnd: T0 + 10 });
    const far = call("far", { tsEnd: T0 + 900, ...tokens(0, 0, 0, 0).call });
    // All-zero call counts equal a null-free zero event, but this event has a null count.
    expect(pairs(bedrock.matchApiRequests([event(1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })], [far, near]))).toEqual([[1, "near"]]);
  });

  test("equal rank and distance: input order decides, the same result every time", () => {
    const calls = [call("c1", { tsEnd: T0 - 100 }), call("c2", { tsEnd: T0 + 100 })];
    const events = [event(1), event(2)];
    for (let i = 0; i < 3; i++) {
      expect(pairs(bedrock.matchApiRequests(events, calls))).toEqual([
        [1, "c1"],
        [2, "c2"],
      ]);
    }
  });

  test("a side request that never reaches the transcript (title generation on haiku) stays unmatched", () => {
    const calls = [call("msg_bdrk_main", { tsEnd: T0 + 400, ...tokens(2, 300, 40_000, 500).call })];
    const events = [
      event(1, { ts: T0 + 100, model: "align-aws-haiku-4-5", ...tokens(150, 12, 0, 0).event }),
      event(2, { ts: T0 + 450, model: "align-aws-opus-5-5", ...tokens(2, 300, 40_000, 500).event }),
    ];
    expect(pairs(bedrock.matchApiRequests(events, calls))).toEqual([[2, "msg_bdrk_main"]]);
  });
});
