// Atom: a share bar inside a table or list row. It does not count as a chart (plan §9.4):
// it has no axes and no legend, the value sits next to it as text, so the bar itself is hidden from
// assistive technologies.
import styles from "./Meter.module.css";

export interface MeterProps {
  /** Fill share, 0…1; out-of-range values are clamped. */
  ratio: number;
  /** Fill color; by default the table bar color (blue-60). */
  color?: string;
  /** false — no track and a rounded end, as in Calls and Tool usage. */
  track?: boolean;
}

export function Meter({ ratio, color, track = true }: MeterProps) {
  const percent = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0)) * 100;
  return (
    <span className={track ? styles.root : `${styles.root} ${styles.bare}`} aria-hidden="true">
      <span className={styles.fill} style={{ inlineSize: `${percent}%`, background: color }} />
    </span>
  );
}
