// Timeline legend: samples of the TimelineMark atom marks with labels from the artboard.
import { TimelineMark, type TimelineMarkKind } from "../../atoms/TimelineMark.tsx";
import styles from "./Timeline.module.css";

const ITEMS: { kind: TimelineMarkKind; label: string; error?: boolean }[] = [
  { kind: "agent-compact", label: "Agent run" },
  { kind: "tool", label: "Tool call" },
  { kind: "tool", label: "Error (any item that failed)", error: true },
  { kind: "prompt", label: "Prompt" },
  { kind: "file-read", label: "File read" },
  { kind: "file-write", label: "File edit or write" },
  { kind: "model", label: "Model API call" },
  { kind: "external", label: "External request" },
];

export function TimelineLegend() {
  return (
    <ul aria-label="Legend" className={styles.legend}>
      {ITEMS.map((item) => (
        <li key={item.label} className={styles.legendItem}>
          <TimelineMark kind={item.kind} label={item.label} error={item.error} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
