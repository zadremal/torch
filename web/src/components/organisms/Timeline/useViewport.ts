// Timeline render window: tracks scroll and size and returns a window rounded to a step
// (window.ts). The state changes only when the scroll crosses a step boundary or the lane width
// changes, so an ordinary scroll event does not trigger a redraw.
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { type ScrollMetrics, type Viewport, quantizeViewport, sameViewport } from "./window.ts";

/** Before the first measurement (and when rendering on the server): a window the size of the artboard's timeline area, scroll at the start. */
const INITIAL_METRICS: ScrollMetrics = { scrollLeft: 0, scrollTop: 0, clientWidth: 1240, clientHeight: 880, contentWidth: 1240 };

export interface ViewportState {
  viewport: Viewport;
  /** Re-read scroll and size: the scroll event handler, called after our own scroll and zoom changes. */
  measure: () => void;
}

/**
 * `onWidthChange` is called when the content width has changed (zoom, panel opening,
 * window size), with the measurements from before the change: the organism restores the scroll. It is called
 * before the new scroll is read, so the render window is computed from the corrected one.
 */
export function useViewport(
  scroller: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  onWidthChange: RefObject<(before: ScrollMetrics) => void>,
): ViewportState {
  const [viewport, setViewport] = useState(() => quantizeViewport(INITIAL_METRICS));
  const metrics = useRef<ScrollMetrics | null>(null);

  const measure = useCallback(() => {
    const outer = scroller.current;
    const inner = content.current;
    if (!outer || !inner) return;
    const before = metrics.current;
    if (before && before.contentWidth !== inner.offsetWidth) onWidthChange.current(before);
    const next: ScrollMetrics = {
      scrollLeft: outer.scrollLeft,
      scrollTop: outer.scrollTop,
      clientWidth: outer.clientWidth,
      clientHeight: outer.clientHeight,
      contentWidth: inner.offsetWidth,
    };
    metrics.current = next;
    const quantized = quantizeViewport(next);
    setViewport((previous) => (sameViewport(previous, quantized) ? previous : quantized));
  }, [scroller, content, onWidthChange]);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (scroller.current) observer.observe(scroller.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [measure, scroller, content]);

  return { viewport, measure };
}
