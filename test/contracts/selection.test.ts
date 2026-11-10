import { expect, test } from "bun:test";
import { formatSelection, parseSelection, type Selection } from "../../src/contracts/selection.ts";

test("a selection written to the address reads back", () => {
  const selections: Selection[] = [
    { kind: "session" },
    { kind: "agent", id: "main" },
    { kind: "tool", id: "toolu_01" },
    { kind: "prompt", id: "ref-prompt-1" },
    { kind: "file", id: "/Users/dev/code/app/src/a:b.ts" },
    { kind: "net", net: "model", id: "req_main_001" },
    { kind: "net", net: "error", id: "otel:42" },
    { kind: "net", net: "external", id: "toolu_02" },
  ];
  for (const sel of selections) expect(parseSelection(formatSelection(sel))).toEqual(sel);
  expect(formatSelection({ kind: "tool", id: "t1" })).toBe("tool:t1");
});

test("empty and unrecognized values give null", () => {
  for (const value of [null, undefined, "", "tool", "tool:", "net:model", "net:bogus:1", "bogus:1"]) expect(parseSelection(value)).toBeNull();
});
