// Atom: a mark on a timeline lane. With `onSelect` it is a keyboard-accessible button
// (plan §9.2); without it — a sample of the same shape for the legend. The Timeline organism
// computes the position and passes it as ready CSS values.
import type { ReactNode } from "react";
import styles from "./TimelineMark.module.css";

export type TimelineMarkKind =
  | "session"
  | "agent"
  | "agent-compact"
  | "tool"
  | "prompt"
  | "file-read"
  | "file-write"
  | "model"
  | "external";

/** Class of each kind; the Timeline organism's button marks take the kind from here too. */
export const MARK_KIND_CLASS: Record<TimelineMarkKind, string | undefined> = {
  session: styles.session,
  agent: styles.agent,
  "agent-compact": styles.agentCompact,
  tool: styles.tool,
  prompt: styles.prompt,
  "file-read": styles.fileRead,
  "file-write": styles.fileWrite,
  model: styles.model,
  external: styles.external,
};

export interface TimelineMarkProps {
  kind: TimelineMarkKind;
  /** What the mark is: read by assistive technologies and shown as a tooltip. */
  label: string;
  /** Position on the lane, CSS values: `left: "12.5%"`, `width: "max(3px, 4%)"`. */
  left?: string;
  width?: string;
  /** `agent-compact` only: the row inside the lane. */
  top?: string;
  /** The call ended with an error: red fill for any kind. */
  error?: boolean;
  /** Dim: a mark of another agent while an agent is selected. */
  dimmed?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  /** Text inside the session and agent bar. */
  children?: ReactNode;
}

export function TimelineMark({
  kind,
  label,
  left,
  width,
  top,
  error = false,
  dimmed = false,
  selected = false,
  onSelect,
  children,
}: TimelineMarkProps) {
  const className = [
    styles.root,
    MARK_KIND_CLASS[kind],
    error && styles.error,
    dimmed && styles.dimmed,
    !onSelect && styles.sample,
  ]
    .filter(Boolean)
    .join(" ");

  if (!onSelect) return <span className={className} aria-hidden="true" />;

  return (
    <button
      type="button"
      className={className}
      style={{ left, width, top }}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
