// Atom: a colored legend square. The color is a primitive; the meaning of the color is known by whoever passes it
// (styles/palette.ts).
import "./Swatch.scss";

export interface SwatchProps {
  /** Any CSS color notation. */
  color: string;
}

export function Swatch({ color }: SwatchProps) {
  return <span className="torch-swatch" style={{ background: color }} aria-hidden="true" />;
}
