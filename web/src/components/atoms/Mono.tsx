// Atom: monospaced text — identifiers, model and tool names, paths, time.
import type { ReactNode } from "react";
import "./Mono.scss";

export interface MonoProps {
  children: ReactNode;
  /** sm — 12px (default), md — 13px. */
  size?: "sm" | "md";
  /** Text color; without a value it is inherited from the parent. */
  tone?: "primary" | "secondary" | "helper";
  /** Truncate with an ellipsis on a single line; the full text goes in `title`. */
  truncate?: boolean;
  title?: string;
}

export function Mono({ children, size = "sm", tone, truncate = false, title }: MonoProps) {
  const className = [
    "torch-mono",
    `torch-mono--${size}`,
    tone && `torch-mono--${tone}`,
    truncate && "torch-mono--truncate",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}
