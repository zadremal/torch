// Series colors from the mockup (references.md §2): Carbon palette tokens assigned a meaning.
// The only place of this mapping for code: charts, Meter bars, Swatch squares.
// Timeline mark colors are set in the styles of the TimelineMark atom.
import { blue40, blue60, blue80, cyan40, purple60, teal50 } from "@carbon/colors";
import type { ContextCategory } from "@contracts/api.ts";

/** Token kinds: Token usage and Token mix. */
export const TOKEN_COLORS = {
  input: purple60,
  output: cyan40,
  cacheRead: blue60,
  cacheWrite: teal50,
} as const;

/** Dashboard charts. */
export const ACTIVITY_COLORS = {
  modelCalls: purple60,
  toolCalls: blue60,
} as const;

/**
 * Context at peak. The mockup has five categories; "System and tools" merges the first two
 * (plan §9.3) and takes the color of the larger of them, the other three keep the mockup colors.
 */
export const CONTEXT_COLORS: Record<ContextCategory, string> = {
  system_tools: purple60,
  instructions: cyan40,
  messages: blue60,
  tool_results: teal50,
};

/** Agent context: first call, last, peak. */
export const CONTEXT_STAGE_COLORS = {
  first: blue40,
  last: blue60,
  peak: blue80,
} as const;

/** Tool usage bars in the agent panel. */
export const TOOL_USAGE_COLOR = teal50;
