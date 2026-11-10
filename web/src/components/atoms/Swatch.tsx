// Atom: a colored legend square. The color is a primitive; the meaning of the color is known by whoever passes it
// (styles/palette.ts).
import styles from "./Swatch.module.css";

export interface SwatchProps {
  /** Any CSS color notation. */
  color: string;
}

export function Swatch({ color }: SwatchProps) {
  return <span className={styles.root} style={{ background: color }} aria-hidden="true" />;
}
