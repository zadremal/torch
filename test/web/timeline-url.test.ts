// Timeline page (W5): address ↔ TimelineUrlState and the history transitions the page makes.
import { describe, expect, test } from "bun:test";
import { DEFAULT_TIMELINE_URL_STATE, type Selection, type TimelineUrlState } from "../../src/contracts/selection.ts";
import {
  closeNavigation,
  parseTimelineUrl,
  readHistoryState,
  reopenSelection,
  selectNavigation,
  selectionKey,
  timelineSearch,
  viewNavigation,
} from "../../web/src/pages/session-timeline/urlState.ts";

const state = (change: Partial<TimelineUrlState>): TimelineUrlState => ({ ...DEFAULT_TIMELINE_URL_STATE, ...change });

describe("address ↔ state", () => {
  test("an empty address is the default state, and back", () => {
    expect(parseTimelineUrl("")).toEqual(DEFAULT_TIMELINE_URL_STATE);
    expect(timelineSearch(DEFAULT_TIMELINE_URL_STATE)).toBe("");
  });

  test("explicitly written defaults do not return to the address", () => {
    expect(timelineSearch(parseTimelineUrl("dock=right&view=compact&zoom=1"))).toBe("");
  });

  const selections: [string, Selection][] = [
    ["session", { kind: "session" }],
    ["agent:gp-1", { kind: "agent", id: "gp-1" }],
    ["tool:toolu_main_001", { kind: "tool", id: "toolu_main_001" }],
    ["prompt:ref-prompt-2", { kind: "prompt", id: "ref-prompt-2" }],
    ["file:/Users/dev/code/billing-web/src/api/billing/schemas.ts", { kind: "file", id: "/Users/dev/code/billing-web/src/api/billing/schemas.ts" }],
    ["net:model:req_main_001", { kind: "net", net: "model", id: "req_main_001" }],
    ["net:error:ref-apierr-main", { kind: "net", net: "error", id: "ref-apierr-main" }],
    ["net:external:toolu_plan-1_008", { kind: "net", net: "external", id: "toolu_plan-1_008" }],
  ];

  test.each(selections)("selection %s is read from the address and written to it", (raw, sel) => {
    const search = timelineSearch(state({ sel }));
    expect(new URLSearchParams(search).get("sel")).toBe(raw);
    expect(parseTimelineUrl(search)).toEqual(state({ sel }));
    expect(parseTimelineUrl(`?sel=${encodeURIComponent(raw)}`).sel).toEqual(sel);
  });

  test("a file path with a colon, a space and an ampersand survives the address", () => {
    const sel: Selection = { kind: "file", id: "/tmp/a b/c:d&e=f.ts" };
    expect(parseTimelineUrl(timelineSearch(state({ sel }))).sel).toEqual(sel);
  });

  test.each([
    ["left", "expanded", 2],
    ["bottom", "expanded", 4],
    ["right", "compact", 1],
  ] as const)("dock %s, mode %s, scale %d", (dock, view, zoom) => {
    const s = state({ dock, view, zoom, sel: { kind: "agent", id: "main" } });
    expect(parseTimelineUrl(timelineSearch(s))).toEqual(s);
  });

  test("all four parameters in the address", () => {
    expect(timelineSearch(state({ sel: { kind: "tool", id: "t1" }, dock: "bottom", view: "expanded", zoom: 4 }))).toBe(
      "sel=tool%3At1&dock=bottom&view=expanded&zoom=4",
    );
  });

  test("unrecognized values are replaced with the default", () => {
    expect(parseTimelineUrl("sel=tool&dock=top&view=wide&zoom=3")).toEqual(DEFAULT_TIMELINE_URL_STATE);
    expect(parseTimelineUrl("sel=net:proxy:1&zoom=abc")).toEqual(DEFAULT_TIMELINE_URL_STATE);
    expect(parseTimelineUrl("zoom=2.0").zoom).toBe(1);
    expect(parseTimelineUrl(new URLSearchParams({ zoom: "4" })).zoom).toBe(4);
  });
});

describe("browser history transitions", () => {
  const agent: Selection = { kind: "agent", id: "gp-1" };
  const tool: Selection = { kind: "tool", id: "toolu_gp-1_004" };

  test("the first selection is a new entry without a way back", () => {
    expect(selectNavigation(state({ zoom: 2 }), agent)).toEqual({ search: "sel=agent%3Agp-1&zoom=2", replace: false, state: {} });
  });

  test("the next selection on the timeline is a new entry without \"Back to …\": the button is given only by transitions inside the panel", () => {
    const next = selectNavigation(state({ sel: agent, view: "expanded" }), tool);
    expect(next).toEqual({ search: "sel=tool%3Atoolu_gp-1_004&view=expanded", replace: false, state: {} });
  });

  test("selecting the same element again does not make a transition", () => {
    expect(selectNavigation(state({ sel: agent }), { kind: "agent", id: "gp-1" })).toBeNull();
  });

  test("dock, mode and scale replace the current entry and keep its state as is: the panel's \"Back to …\" stack stays", () => {
    const next = viewNavigation(state({ sel: tool }), { dock: "left" }, { panelBack: "Explore (explore-1)" });
    expect(next).toEqual({ search: "sel=tool%3Atoolu_gp-1_004&dock=left", replace: true, state: { panelBack: "Explore (explore-1)" } });
    expect(viewNavigation(state({ zoom: 4 }), { zoom: 1, view: "expanded" }, {}).search).toBe("view=expanded");
  });

  test("closing the panel removes the selection from the address and remembers it; Show details opens it again", () => {
    const closed = closeNavigation(state({ sel: tool, dock: "bottom" }));
    expect(closed).toEqual({ search: "dock=bottom", replace: false, state: { reopen: "tool:toolu_gp-1_004" } });
    expect(reopenSelection(readHistoryState(closed.state))).toEqual(tool);
  });

  test("Show details without a closed selection opens the session panel", () => {
    expect(reopenSelection({})).toEqual({ kind: "session" });
    expect(reopenSelection({ reopen: "junk" })).toEqual({ kind: "session" });
  });

  test("history entry state is read tolerantly", () => {
    expect(readHistoryState(null)).toEqual({});
    expect(readHistoryState("back")).toEqual({});
    expect(readHistoryState({ reopen: "session", usr: 1 })).toEqual({ reopen: "session" });
    expect(readHistoryState({ reopen: 5 })).toEqual({ reopen: undefined });
  });

  test("selectionKey", () => {
    expect(selectionKey(null)).toBeNull();
    expect(selectionKey({ kind: "net", net: "model", id: "r1" })).toBe("net:model:r1");
  });
});
