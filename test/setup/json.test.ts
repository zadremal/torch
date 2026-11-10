// In-place editing of JSON text: value positions, insertion and removal that restores the previous text.
import { describe, expect, test } from "bun:test";
import { append, emptyInner, find, parseTree, read, remove, replace } from "../../src/setup/json.ts";

const slice = (text: string, node: { start: number; end: number }): string => text.slice(node.start, node.end);

describe("parseTree", () => {
  test("gives the positions of keys and values", () => {
    const text = '{ "a": 1, "b": { "c": [true, null, "x"] } }';
    const root = parseTree(text);

    expect(root).toMatchObject({ kind: "object", start: 0, end: text.length });
    expect(root.items.map((item) => item.key)).toEqual(["a", "b"]);
    expect(text.slice(root.items[1]!.start)).toStartWith('"b": {');
    expect(slice(text, find(root, ["a"])!)).toBe("1");
    expect(slice(text, find(root, ["b"])!)).toBe('{ "c": [true, null, "x"] }');
    const array = find(root, ["b", "c"])!;
    expect(array.kind).toBe("array");
    expect(array.items.map((item) => slice(text, item.value))).toEqual(["true", "null", '"x"']);
    expect(array.items.every((item) => item.key === undefined)).toBe(true);
  });

  test("brackets, commas and quotes inside strings are not markup", () => {
    const text = '{"a }\\" ,": "x ] \\\\", "b": "{[,"}';
    const root = parseTree(text);

    expect(root.items.map((item) => item.key)).toEqual(['a }" ,', "b"]);
    expect(read(text, find(root, ['a }" ,'])!)).toBe("x ] \\");
    expect(read(text, find(root, ["b"])!)).toBe("{[,");
  });

  test("for a repeated key the last value is taken, as in JSON.parse", () => {
    const text = '{"a": 1, "a": 2}';

    expect(read(text, find(parseTree(text), ["a"])!)).toBe(2);
  });

  test("a missing path and a path through a scalar give undefined", () => {
    const root = parseTree('{"a": {"b": 1}, "list": [{"b": 1}]}');

    expect(find(root, ["a", "x"])).toBeUndefined();
    expect(find(root, ["a", "b", "c"])).toBeUndefined();
    expect(find(root, ["list", "b"])).toBeUndefined();
  });

  test("invalid JSON is an error", () => {
    expect(() => parseTree('{"a": 1,}')).toThrow();
    expect(() => parseTree("")).toThrow();
  });
});

describe("append", () => {
  test("into a multi-line object: on a separate line with the neighbors' indentation", () => {
    const text = '{\n    "a": 1\n}\n';

    expect(append(text, parseTree(text), "x", "b")).toBe('{\n    "a": 1,\n    "b": "x"\n}\n');
  });

  test("into a single-line object: on the same line", () => {
    const text = '{"env": {"a": "1"}}';

    expect(append(text, find(parseTree(text), ["env"])!, "2", "b")).toBe('{"env": {"a": "1", "b": "2"}}');
  });

  test("into an empty container: indented one step deeper than its line", () => {
    const text = '{\n\t"hooks": {}\n}\n';

    expect(append(text, find(parseTree(text), ["hooks"])!, [], "Stop")).toBe('{\n\t"hooks": {\n\t\t"Stop": []\n\t}\n}\n');
  });

  test("a nested value is written with the file's indentation step and line break", () => {
    const text = '{\r\n    "list": [\r\n        1\r\n    ]\r\n}\r\n';

    expect(append(text, find(parseTree(text), ["list"])!, { a: [2] })).toBe('{\r\n    "list": [\r\n        1,\r\n        {\r\n            "a": [\r\n                2\r\n            ]\r\n        }\r\n    ]\r\n}\r\n');
  });
});

describe("remove", () => {
  const text = '{\n  "a": 1,\n  "b": [1, 2],\n  "c": 3\n}\n';
  const root = parseTree(text);

  test("the first and a middle element go together with their comma", () => {
    expect(remove(text, root, 0)).toBe('{\n  "b": [1, 2],\n  "c": 3\n}\n');
    expect(remove(text, root, 1)).toBe('{\n  "a": 1,\n  "c": 3\n}\n');
  });

  test("the last element goes together with the comma before it", () => {
    expect(remove(text, root, 2)).toBe('{\n  "a": 1,\n  "b": [1, 2]\n}\n');
  });

  test("the only element leaves an empty container", () => {
    const one = '{\n  "a": {\n    "b": 1\n  }\n}\n';

    expect(remove(one, find(parseTree(one), ["a"])!, 0)).toBe('{\n  "a": {}\n}\n');
  });
});

describe("insertion and removal are inverse to each other", () => {
  const cases: [name: string, text: string, path: string[]][] = [
    ["multi-line object", '{\n  "env": {\n    "A": "1"\n  }\n}\n', ["env"]],
    ["single-line object", '{ "env": { "A": "1" } }', ["env"]],
    ["compact file", '{"env":{"A":"1"}}', ["env"]],
    ["empty object", '{\n  "env": {}\n}\n', ["env"]],
    ["empty object with a space inside", '{\n  "env": { }\n}\n', ["env"]],
    ["empty object with a line break inside", '{\n  "env": {\n  }\n}\n', ["env"]],
    ["root", "{}", []],
    ["tab and CRLF", '{\r\n\t"env": {\r\n\t\t"A": "1"\r\n\t}\r\n}\r\n', ["env"]],
    ["array", '{\n  "list": [\n    {"a": 1}\n  ]\n}', ["list"]],
    ["empty array", '{"list": [ ]}', ["list"]],
  ];

  for (const [name, text, path] of cases) {
    test(name, () => {
      const container = find(parseTree(text), path)!;
      const inner = emptyInner(text, container);
      const added = append(text, container, { nested: ["x"] }, container.kind === "object" ? "NEW" : undefined);
      const grown = find(parseTree(added), path)!;

      expect(grown.items.length).toBe(container.items.length + 1);
      expect(read(added, grown.items.at(-1)!.value)).toEqual({ nested: ["x"] });
      expect(remove(added, grown, grown.items.length - 1, inner)).toBe(text);
    });
  }
});

test("replace changes only the text of the value", () => {
  const text = '{\n  "days": 30,\n  "x": "30"\n}\n';

  expect(replace(text, find(parseTree(text), ["days"])!, "365")).toBe('{\n  "days": 365,\n  "x": "30"\n}\n');
});
