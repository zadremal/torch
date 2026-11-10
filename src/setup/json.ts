// In-place editing of JSON text: a value is inserted, replaced and removed while the rest of the
// file stays byte for byte. Removal returns exactly the text that was there before the insertion,
// and the `torch uninstall` rollback relies on that.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Node {
  kind: "object" | "array" | "scalar";
  start: number;
  /** Position past the last character of the value. */
  end: number;
  /** Object keys or array elements in order; empty for a scalar. */
  items: Item[];
}

export interface Item {
  /** Key name; an array element has none. */
  key?: string;
  /** Start of the key or element. The end is `value.end`. */
  start: number;
  value: Node;
}

const isSpace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\n" || char === "\r";

/** Tree of values with positions in the text. On invalid JSON it throws the `JSON.parse` error. */
export function parseTree(text: string): Node {
  // JSON.parse does the strict validation: below, parsing runs over text known to be valid.
  JSON.parse(text);
  let pos = 0;
  const skip = (): void => {
    while (isSpace(text[pos])) pos++;
  };
  const string = (): void => {
    pos++;
    while (text[pos] !== '"') pos += text[pos] === "\\" ? 2 : 1;
    pos++;
  };
  const value = (): Node => {
    skip();
    const start = pos;
    const open = text[pos];
    if (open !== "{" && open !== "[") {
      if (open === '"') string();
      else while (pos < text.length && !isSpace(text[pos]) && !",]}".includes(text[pos]!)) pos++;
      return { kind: "scalar", start, end: pos, items: [] };
    }
    const close = open === "{" ? "}" : "]";
    const items: Item[] = [];
    pos++;
    for (skip(); text[pos] !== close; skip()) {
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      const itemStart = pos;
      let key: string | undefined;
      if (open === "{") {
        string();
        key = JSON.parse(text.slice(itemStart, pos)) as string;
        skip();
        pos++; // colon
      }
      items.push({ key, start: itemStart, value: value() });
    }
    pos++;
    return { kind: open === "{" ? "object" : "array", start, end: pos, items };
  };
  return value();
}

/** Value at a path of object keys. For a repeated key the last one is taken, as in `JSON.parse`. */
export function find(root: Node, path: readonly string[]): Node | undefined {
  let node: Node | undefined = root;
  for (const key of path) node = node?.items.findLast((item) => item.key === key)?.value;
  return node;
}

export const read = (text: string, node: Node): Json => JSON.parse(text.slice(node.start, node.end)) as Json;

const splice = (text: string, start: number, end: number, insert: string): string => text.slice(0, start) + insert + text.slice(end);

/** Indentation of the line the position is on. */
const lineIndent = (text: string, pos: number): string => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", pos - 1) + 1, pos))![0];

/** Line break and indentation step used in the file. */
function style(text: string): { eol: string; unit: string } {
  return { eol: text.includes("\r\n") ? "\r\n" : "\n", unit: /\n([ \t]+)\S/.exec(text)?.[1] ?? "  " };
}

/** What stands between the brackets of an empty container: `remove` restores it when the container becomes empty again. */
export const emptyInner = (text: string, container: Node): string => (container.items.length === 0 ? text.slice(container.start + 1, container.end - 1) : "");

/** Appends a key with a value to the end of an object, or an element to the end of an array. */
export function append(text: string, container: Node, value: Json, key?: string): string {
  const { eol, unit } = style(text);
  const item = (indent: string): string => (key === undefined ? "" : `${JSON.stringify(key)}: `) + JSON.stringify(value, null, unit).replaceAll("\n", eol + indent);
  const outer = lineIndent(text, container.start);
  const first = container.items[0];
  if (!first) {
    const indent = outer + unit;
    return splice(text, container.start + 1, container.end - 1, eol + indent + item(indent) + eol + outer);
  }
  const end = container.items.at(-1)!.value.end;
  // A single-line container stays single-line.
  if (!text.slice(container.start, first.start).includes("\n")) return splice(text, end, end, `, ${item(outer)}`);
  const indent = lineIndent(text, first.start);
  return splice(text, end, end, `,${eol}${indent}${item(indent)}`);
}

/** Removes an element together with its comma. `inner` is what stood between the brackets while the container was empty. */
export function remove(text: string, container: Node, index: number, inner = ""): string {
  const { items } = container;
  const item = items[index]!;
  if (items.length === 1) return splice(text, container.start + 1, container.end - 1, inner);
  if (index === items.length - 1) return splice(text, items[index - 1]!.value.end, item.value.end, "");
  return splice(text, item.start, items[index + 1]!.start, "");
}

/** Replaces the text of a value. */
export const replace = (text: string, node: Node, raw: string): string => splice(text, node.start, node.end, raw);
