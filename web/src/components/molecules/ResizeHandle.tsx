// Molecule: the draggable edge of a docked panel. It is placed inside the panel, on the edge that faces the
// rest of the workspace (the panel's parent); dragging it or the arrow keys change the panel's width (side docks)
// or height (bottom dock). Double-click returns the default size.
// While dragging, the size goes straight to the panel's style, so the workspace does not re-render on every
// pointer move; the page gets the size once, on release, and keeps it in the panel's style via `panelSizeStyle`.
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef } from "react";
import styles from "./ResizeHandle.module.css";

/** The panel edge the handle sits on: `left` for the right dock, `right` for the left dock, `top` for the bottom one. */
export type ResizeEdge = "left" | "right" | "top";

/** The panel reads its size from this property: `var(--torch-panel-size, <default>)`. */
const SIZE_PROPERTY = "--torch-panel-size";

/** The panel's style for a chosen size; without one the panel keeps its default size from CSS. */
export function panelSizeStyle(size: number | undefined): CSSProperties | undefined {
  return size === undefined ? undefined : ({ "--torch-panel-size": `${size}px` } as CSSProperties);
}

export interface ResizeHandleProps {
  edge: ResizeEdge;
  /** The chosen size in pixels; `undefined` is the default size. */
  size: number | undefined;
  /** The smallest panel size. */
  min: number;
  /** Space the panel leaves to its neighbour in the workspace: the panel grows at most to the rest. */
  reserve: number;
  onResize: (size: number | undefined) => void;
}

const EDGE_CLASS: Record<ResizeEdge, string> = {
  left: `${styles.handle} ${styles.left}`,
  right: `${styles.handle} ${styles.right}`,
  top: `${styles.handle} ${styles.top}`,
};

/** Arrow keys move the edge by this many pixels, with Shift by the larger step. */
const STEP = 16;
const LARGE_STEP = 64;

interface Drag {
  start: number;
  from: number;
  size: number;
}

export function ResizeHandle({ edge, size, min, reserve, onResize }: ResizeHandleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // A vertical bar changes the width, a horizontal one the height.
  const vertical = edge !== "top";
  // Moving the edge towards the neighbour grows the panel.
  const sign = edge === "right" ? 1 : -1;
  const [grow, shrink] = vertical ? (edge === "left" ? ["ArrowLeft", "ArrowRight"] : ["ArrowRight", "ArrowLeft"]) : ["ArrowUp", "ArrowDown"];

  const panel = () => ref.current?.parentElement ?? null;
  const current = () => {
    const rect = panel()?.getBoundingClientRect();
    return rect ? (vertical ? rect.width : rect.height) : min;
  };
  const clamp = (value: number) => {
    const workspace = panel()?.parentElement;
    const room = workspace ? (vertical ? workspace.clientWidth : workspace.clientHeight) - reserve : value;
    return Math.round(Math.max(min, Math.min(value, room)));
  };
  const position = (e: PointerEvent) => (vertical ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // No text selection while dragging.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const from = current();
    drag.current = { start: position(e), from, size: from };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.size = clamp(d.from + sign * (position(e) - d.start));
    panel()?.style.setProperty(SIZE_PROPERTY, `${d.size}px`);
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.size !== d.from) onResize(d.size);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? LARGE_STEP : STEP;
    let next: number;
    if (e.key === grow) next = current() + step;
    else if (e.key === shrink) next = current() - step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = Number.POSITIVE_INFINITY;
    else return;
    e.preventDefault();
    onResize(clamp(next));
  };

  return (
    <div
      ref={ref}
      role="separator"
      aria-label="Resize panel"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={min}
      aria-valuenow={size}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className={EDGE_CLASS[edge]}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onResize(undefined)}
      onKeyDown={onKeyDown}
    />
  );
}
