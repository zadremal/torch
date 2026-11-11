// The anthropic provider: today's behaviour of the direct API, unchanged.
import { describe, expect, test } from "bun:test";
import { anthropic } from "../../src/providers/anthropic.ts";
import { call, event, pairs, response, T0 } from "./support.ts";

describe("callKey", () => {
  test("is the requestId shared by all lines of the response", () => {
    const { lines, key } = response();
    expect(lines).toHaveLength(2);
    expect(lines.map(anthropic.callKey)).toEqual([key, key]);
  });

  test("a gateway line without requestId has no key", () => {
    const { lines } = response({ gateway: true });
    expect(lines.map(anthropic.callKey)).toEqual([null, null]);
  });
});

test("model names are kept as reported and declare no context window", () => {
  for (const model of ["claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-align-aws-opus-5-5[1m]"]) {
    expect(anthropic.canonicalModel(model)).toBe(model);
    expect(anthropic.declaredContextWindow(model)).toBeNull();
  }
});

describe("matchApiRequests", () => {
  test("an event pairs with the call of its requestId, also one whose duration is already exact", () => {
    const calls = [call("req_a"), call("req_b", { durationExact: true })];
    const events = [event(1, { requestId: "req_b" }), event(2, { requestId: "req_a" })];
    expect(pairs(anthropic.matchApiRequests(events, calls))).toEqual([
      [1, "req_b"],
      [2, "req_a"],
    ]);
  });

  test("model, time and tokens do not matter", () => {
    const calls = [call("req_a", { model: "claude-sonnet-5-5", tsEnd: T0 + 3_600_000 })];
    expect(pairs(anthropic.matchApiRequests([event(1, { requestId: "req_a", model: "claude-opus-5-5" })], calls))).toEqual([[1, "req_a"]]);
  });

  test("an event without requestId or with an unknown one matches nothing", () => {
    const calls = [call("req_a")];
    expect(anthropic.matchApiRequests([event(1), event(2, { requestId: "req_other" })], calls).size).toBe(0);
  });

  test("a call is matched at most once: the first event in input order takes it", () => {
    const matched = anthropic.matchApiRequests([event(1, { requestId: "req_a" }), event(2, { requestId: "req_a" })], [call("req_a")]);
    expect(pairs(matched)).toEqual([[1, "req_a"]]);
  });
});
