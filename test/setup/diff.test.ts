// The line-by-line difference that `torch setup` shows before writing.
import { expect, test } from "bun:test";
import { lineDiff } from "../../src/setup/diff.ts";

const text = (...lines: string[]): string => `${lines.join("\n")}\n`;

test("equal texts give an empty difference", () => {
  expect(lineDiff(text("a", "b"), text("a", "b"))).toBe("");
});

test("a changed line: the old one with a minus, the new one with a plus, two lines around", () => {
  const before = text("1", "2", "3", "old", "5", "6", "7");
  const after = text("1", "2", "3", "new", "5", "6", "7");

  expect(lineDiff(before, after).split("\n")).toEqual(["  ...", "  2", "  3", "- old", "+ new", "  5", "  6", "  ..."]);
});

test("distant edits are separated by a gap, close ones go in a row", () => {
  const before = text("a", "1", "2", "3", "4", "5", "b", "c");
  const after = text("A", "1", "2", "3", "4", "5", "b", "c", "d");

  expect(lineDiff(before, after).split("\n")).toEqual(["- a", "+ A", "  1", "  2", "  ...", "  b", "  c", "+ d"]);
});

test("added and removed lines inside shared text", () => {
  expect(lineDiff(text("{", '  "a": 1', "}"), text("{", '  "a": 1,', '  "b": 2', "}")).split("\n")).toEqual(["  {", '-   "a": 1', '+   "a": 1,', '+   "b": 2', "  }"]);
  expect(lineDiff(text("x", "gone", "y"), text("x", "y")).split("\n")).toEqual(["  x", "- gone", "  y"]);
});

test("a new file is all plus lines, a deleted one all minus lines", () => {
  expect(lineDiff("", text("{", "}"))).toBe("+ {\n+ }");
  expect(lineDiff(text("{", "}"), "")).toBe("- {\n- }");
});

test("the CRLF line break does not get into the difference", () => {
  expect(lineDiff("a\r\nb\r\n", "a\r\nc\r\n")).toBe("  a\n- b\n+ c");
});
