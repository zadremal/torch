// Timeline organism: lanes, axis with gaps, button marks (plan §9.2). Package W5.
//
// Data, view state and selection arrive as props; the organism reports a click through onSelect.
// The layout is computed by model.ts, the position on the axis by axis.ts, the DOM contents and focus moves by window.ts.
//
// Keyboard: each lane has one Tab stop (the focused mark, otherwise the selected one, otherwise
// the first in the window); ← → move through time within the lane, Home and End — to its edges, ↑ ↓ — to
// the nearest-in-time mark of the adjacent lane.
import type { TimelineResponse } from "@contracts/api.ts";
import { type Selection, type TimelineView, type TimelineZoom, formatSelection } from "@contracts/selection.ts";
import { type CSSProperties, type FocusEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatClock, formatDuration } from "../../../lib/format.ts";
import { GAP_WIDTH, axisTicks, cssLeft, locate, timeToPx } from "./axis.ts";
import { LaneRow } from "./LaneRow.tsx";
import { AXIS_HEIGHT, LABEL_WIDTH, buildModel, contentWidthCss, laneSelection, selectionContext } from "./model.ts";
import { useViewport } from "./useViewport.ts";
import { type MarkRef, NAV_KEYS, type NavKey, type ScrollMetrics, anchoredScrollLeft, moveFocus, revealScroll, visibleRows } from "./window.ts";
import "./Timeline.scss";

export interface TimelineProps {
  data: TimelineResponse;
  selection: Selection | null;
  view: TimelineView;
  zoom: TimelineZoom;
  onSelect: (sel: Selection) => void;
}

/** The focused mark: by identifiers, to survive a data refresh. */
interface FocusedMark {
  lane: string;
  key: string;
}

/** The mark on which the event occurred: row and mark numbers from the markup. */
function markRefOf(target: EventTarget): MarkRef | null {
  if (!(target instanceof HTMLElement)) return null;
  const mark = target.dataset.i;
  const row = target.closest<HTMLElement>("[data-row]")?.dataset.row;
  return mark === undefined || row === undefined ? null : { row: Number(row), mark: Number(mark) };
}

export function Timeline({ data, selection, view, zoom, onSelect }: TimelineProps) {
  const model = useMemo(() => buildModel(data, view), [data, view]);
  const { axis, rows, offsets } = model;
  // The selection arrives from the address as a new object on every render: its record is compared.
  const selKey = selection ? formatSelection(selection) : null;
  const context = useMemo(() => selectionContext(data, selection, view), [data, selKey, view]);

  const scroller = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // The lane width changed: the moment under the middle of the window (or the cursor, if it was visible) stays in place.
  const keepAnchor = useRef((_before: ScrollMetrics) => {});
  useLayoutEffect(() => {
    keepAnchor.current = (before) => {
      const outer = scroller.current;
      const inner = content.current;
      if (!outer || !inner) return;
      outer.scrollLeft = anchoredScrollLeft(
        axis,
        { scrollLeft: before.scrollLeft, trackWidth: before.contentWidth - LABEL_WIDTH, visibleWidth: before.clientWidth - LABEL_WIDTH },
        { trackWidth: inner.offsetWidth - LABEL_WIDTH, visibleWidth: outer.clientWidth - LABEL_WIDTH },
        context.cursorTs,
      );
    };
  });
  const { viewport, measure } = useViewport(scroller, content, keepAnchor);

  // Rows get the same handler for their whole lifetime: a change of the page's function does not redraw them.
  const latestOnSelect = useRef(onSelect);
  useLayoutEffect(() => {
    latestOnSelect.current = onSelect;
  });
  /** Record of a selection made by a click in the timeline itself: no need to scroll to it, it is at hand. */
  const ownSelection = useRef<string | null>(null);
  const select = useCallback((sel: Selection) => {
    ownSelection.current = formatSelection(sel);
    latestOnSelect.current(sel);
  }, []);

  // ── Focus ────────────────────────────────────────────────────────────────────────────────
  const [focus, setFocus] = useState<FocusedMark | null>(null);
  /** Focus was moved by a key: after rendering it must be placed on the new mark. */
  const moveDomFocus = useRef(false);
  const focusRow = focus === null ? -1 : rows.findIndex((row) => row.type === "lane" && row.id === focus.lane);

  const focusAt = (at: MarkRef): boolean => {
    const row = rows[at.row];
    const mark = row?.type === "lane" ? row.marks[at.mark] : undefined;
    if (!row || !mark) return false;
    setFocus((previous) => (previous?.lane === row.id && previous.key === mark.key ? previous : { lane: row.id, key: mark.key }));
    return true;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !NAV_KEYS.includes(event.key as NavKey)) return;
    const at = markRefOf(event.target);
    if (!at) return;
    // On a mark the arrows move between marks and do not scroll the area.
    event.preventDefault();
    const to = moveFocus(rows, at, event.key as NavKey);
    if (to && focusAt(to)) moveDomFocus.current = true;
  };

  const onFocus = (event: FocusEvent) => {
    const at = markRefOf(event.target);
    if (at) focusAt(at);
  };

  useLayoutEffect(() => {
    if (!moveDomFocus.current || focus === null) return;
    moveDomFocus.current = false;
    const row = rows[focusRow];
    const mark = row?.type === "lane" ? row.index.get(focus.key) : undefined;
    const button = mark === undefined ? null : scroller.current?.querySelector<HTMLElement>(`[data-row="${focusRow}"] [data-i="${mark}"]`);
    if (!button) return;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focus]);

  // ── Scroll ───────────────────────────────────────────────────────────────────────────────
  // A zoom change changes the lane width: the window is recomputed before the frame is drawn, with no empty gaps.
  useLayoutEffect(measure, [zoom, measure]);

  // A selection coming from outside (from the address, from the detail panel) and a mode change: the selected item must be
  // on screen. A click on a mark does not move the timeline.
  const revealedView = useRef(view);
  useEffect(() => {
    const outer = scroller.current;
    const inner = content.current;
    const sameView = revealedView.current === view;
    revealedView.current = view;
    if (!outer || !inner || context.key === null) return;
    if (sameView && context.key === ownSelection.current) return;
    ownSelection.current = null;
    // The panel may have opened along with the selection and narrowed the lane: account for the new width first.
    measure();
    if (context.cursorTs !== null) {
      const x = timeToPx(axis, context.cursorTs, inner.offsetWidth - LABEL_WIDTH);
      const left = revealScroll(x, x, outer.scrollLeft, outer.clientWidth - LABEL_WIDTH);
      if (left !== null) outer.scrollLeft = left;
    }
    const row = rows.findIndex((r) => r.type === "lane" && r.keys.has(context.key!));
    if (row >= 0) {
      const top = revealScroll(offsets[row]!, offsets[row + 1]!, outer.scrollTop, outer.clientHeight - AXIS_HEIGHT);
      if (top !== null) outer.scrollTop = top;
    }
    measure();
  }, [context.key, view]);

  // ── Rendering ────────────────────────────────────────────────────────────────────────────
  const ticks = useMemo(() => axisTicks(axis, zoom).map((tick) => ({ ...tick, left: cssLeft(axis, locate(axis, tick.ts)) })), [axis, zoom]);
  // Tick lines are the background of each lane: under the marks, above the fill of the highlighted lane.
  // The background is set on the lane itself, not by a variable on a common ancestor: an inherited variable on
  // a zoom change would make the browser recalculate the styles of every mark.
  const gridStyle = useMemo<CSSProperties>(
    () => ({
      backgroundImage: ticks.map(() => "linear-gradient(var(--torch-timeline-grid-color), var(--torch-timeline-grid-color))").join(", ") || "none",
      backgroundPosition: ticks.map((tick) => `${tick.left} 0`).join(", ") || "0 0",
    }),
    [ticks],
  );
  const gaps = useMemo(
    () =>
      axis.gaps.map((gap) => ({
        key: gap.start,
        left: cssLeft(axis, locate(axis, gap.start)),
        duration: formatDuration(gap.end - gap.start),
        hint: `No activity for ${formatDuration(gap.end - gap.start)}: ${formatClock(gap.start)}–${formatClock(gap.end)}`,
      })),
    [axis],
  );

  const range = visibleRows(offsets, viewport.y0, viewport.y1);
  // The row with focus stays in the DOM outside the window too: otherwise scrolling would carry the focus away.
  // DOM order is row order: Tab follows it.
  const shownRows: number[] = [];
  if (focusRow >= 0 && focusRow < range.first) shownRows.push(focusRow);
  for (let i = range.first; i < range.last; i++) shownRows.push(i);
  if (focusRow >= range.last) shownRows.push(focusRow);

  return (
    <section
      ref={scroller}
      aria-label="Timeline"
      className="torch-timeline"
      style={{ "--torch-timeline-label": `${LABEL_WIDTH}px`, "--torch-timeline-axis": `${AXIS_HEIGHT}px` } as CSSProperties}
      onScroll={measure}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <div ref={content} className="torch-timeline__content" style={{ width: contentWidthCss(axis, zoom) }}>
        <div className="torch-timeline__axis" style={{ height: AXIS_HEIGHT }}>
          <div className="torch-timeline__label torch-timeline__label--axis">{model.startLabel}</div>
          <div className="torch-timeline__ticks">
            {ticks.map((tick) => (
              <span key={tick.ts} className="torch-timeline__tick" style={{ left: tick.left }} aria-hidden="true">
                {tick.label}
              </span>
            ))}
            {gaps.map((gap) => (
              <span key={gap.key} className="torch-timeline__gap-label" style={{ left: gap.left, width: GAP_WIDTH }} title={gap.hint}>
                {gap.duration}
              </span>
            ))}
          </div>
        </div>
        <div className="torch-timeline__rows" style={{ height: offsets[rows.length] }}>
          {shownRows.map((index) => {
            const row = rows[index]!;
            if (row.type === "group") {
              return (
                <div key={row.id} className="torch-timeline__group" style={{ top: offsets[index], height: row.height }}>
                  <span className="torch-timeline__group-title">{row.title}</span>
                </div>
              );
            }
            return (
              <LaneRow
                key={row.id}
                lane={row}
                row={index}
                top={offsets[index]!}
                axis={axis}
                trackWidth={viewport.trackWidth}
                x0={viewport.x0}
                x1={viewport.x1}
                gridStyle={gridStyle}
                {...laneSelection(row, context)}
                focusKey={index === focusRow ? focus!.key : null}
                onSelect={select}
              />
            );
          })}
          <div className="torch-timeline__overlay" aria-hidden="true">
            {gaps.map((gap) => (
              <span key={gap.key} className="torch-timeline__gap" style={{ left: gap.left, width: GAP_WIDTH }} />
            ))}
            {context.cursorTs !== null && <span className="torch-timeline__cursor" style={{ left: cssLeft(axis, locate(axis, context.cursorTs)) }} />}
          </div>
        </div>
      </div>
    </section>
  );
}
