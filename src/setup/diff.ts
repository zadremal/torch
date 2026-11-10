// Line-by-line difference of two texts, shown before settings.json is written (decision 27).

/** How many unchanged lines are shown around the changed ones. */
const CONTEXT = 2;
/** The line that stands in for skipped unchanged lines. */
const GAP = "  ...";

type Row = { tag: " " | "-" | "+"; line: string };

const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/));

/** Changed lines with `-` and `+` and the nearest unchanged lines; an empty string if the texts are equal. */
export function lineDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = lines(before);
  const b = lines(after);
  // The common head and tail do not take part in the comparison: an edit to settings.json touches a few lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);

  // common[i][j] is the length of the common subsequence of lines x[i..] and y[j..].
  const common = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) common[i]![j] = x[i] === y[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  }
  const rows: Row[] = a.slice(0, head).map((line) => ({ tag: " ", line }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      rows.push({ tag: " ", line: x[i++]! });
      j++;
    } else if (j === y.length || (i < x.length && common[i + 1]![j]! >= common[i]![j + 1]!)) rows.push({ tag: "-", line: x[i++]! });
    else rows.push({ tag: "+", line: y[j++]! });
  }
  for (const line of a.slice(a.length - tail)) rows.push({ tag: " ", line });

  const out: string[] = [];
  let shown = -1;
  rows.forEach((row, index) => {
    if (!rows.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((near) => near.tag !== " ")) return;
    if (index !== shown + 1) out.push(GAP);
    out.push(`${row.tag} ${row.line}`);
    shown = index;
  });
  if (shown !== rows.length - 1) out.push(GAP);
  return out.join("\n");
}
