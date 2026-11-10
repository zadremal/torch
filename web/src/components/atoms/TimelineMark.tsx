// Atom: a mark on a timeline lane. With `onSelect` it is a keyboard-accessible button
// (plan §9.2); without it — a sample of the same shape for the legend. The Timeline organism
// computes the position and passes it as ready CSS values.
import type { ReactNode } from "react";
import "./TimelineMark.scss";

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
    "torch-mark",
    `torch-mark--${kind}`,
    error && "torch-mark--error",
    dimmed && "torch-mark--dimmed",
    !onSelect && "torch-mark--sample",
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
