// Detail panel address (W4): parsing and building the address of a separate tab, the "Back to …" stack in the
// history state, loading a view by selection on the test/fixtures/dto responses.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Selection } from "../../src/contracts/selection.ts";
import { backLabel, selectionOf } from "../../web/src/components/organisms/DetailPanel/model.ts";
import {
  backLabelFromState,
  DEFAULT_PANEL_SELECTION,
  panelHistoryState,
  panelHref,
  panelSelection,
  timelineHref,
  withSelection,
} from "../../web/src/pages/panel/address.ts";
import { loadPanelItem } from "../../web/src/pages/panel/load.ts";

const SCHEMAS = "/Users/dev/code/billing-web/src/api/billing/schemas.ts";

/** One selection for each of the six views; the ids are the dto fixture keys. */
const SELECTIONS: Selection[] = [
  { kind: "session" },
  { kind: "agent", id: "gp-1" },
  { kind: "tool", id: "toolu_main_009" },
  { kind: "prompt", id: "ref-prompt-1" },
  { kind: "file", id: SCHEMAS },
  { kind: "net", net: "model", id: "req_main_001" },
  { kind: "net", net: "error", id: "ref-apierr-main" },
  { kind: "net", net: "external", id: "toolu_plan-1_008" },
];

/** The address query string as the page will see it. */
const searchOf = (href: string) => new URL(href, "http://torch.test").searchParams;

describe("parsing the address of a separate tab", () => {
  test("the sel parameter is read for every view", () => {
    expect(panelSelection(new URLSearchParams("sel=session"))).toEqual({ kind: "session" });
    expect(panelSelection(new URLSearchParams("sel=agent:gp-1"))).toEqual({ kind: "agent", id: "gp-1" });
    expect(panelSelection(new URLSearchParams("sel=tool:toolu_main_009"))).toEqual({ kind: "tool", id: "toolu_main_009" });
    expect(panelSelection(new URLSearchParams("sel=prompt:ref-prompt-1"))).toEqual({ kind: "prompt", id: "ref-prompt-1" });
    expect(panelSelection(new URLSearchParams("sel=file:/a/b.ts"))).toEqual({ kind: "file", id: "/a/b.ts" });
    expect(panelSelection(new URLSearchParams("sel=net:model:req_main_001"))).toEqual({
      kind: "net",
      net: "model",
      id: "req_main_001",
    });
  });

  test("without the parameter and with an unrecognized value the session view opens", () => {
    expect(DEFAULT_PANEL_SELECTION).toEqual({ kind: "session" });
    expect(panelSelection(new URLSearchParams(""))).toEqual(DEFAULT_PANEL_SELECTION);
    expect(panelSelection(new URLSearchParams("sel="))).toEqual(DEFAULT_PANEL_SELECTION);
    expect(panelSelection(new URLSearchParams("sel=widget:1"))).toEqual(DEFAULT_PANEL_SELECTION);
    expect(panelSelection(new URLSearchParams("sel=net:proxy:1"))).toEqual(DEFAULT_PANEL_SELECTION);
  });
});

describe("building the address", () => {
  test("a separate tab and the timeline with the same selection", () => {
    expect(panelHref("abc", { kind: "session" })).toBe("/sessions/abc/panel?sel=session");
    expect(panelHref("abc", { kind: "tool", id: "toolu_main_009" })).toBe("/sessions/abc/panel?sel=tool%3Atoolu_main_009");
    expect(timelineHref("abc", { kind: "agent", id: "gp-1" })).toBe("/sessions/abc/timeline?sel=agent%3Agp-1");
  });

  test("the session id is encoded", () => {
    expect(panelHref("a b/c", { kind: "session" })).toBe("/sessions/a%20b%2Fc/panel?sel=session");
  });

  test("the address of every view reads back into the same selection", () => {
    const awkward: Selection[] = [
      { kind: "file", id: "/Users/dev/my project/a&b=c?.ts" },
      { kind: "tool", id: "toolu:with:colons" },
      { kind: "net", net: "model", id: "req:1/2 3" },
    ];
    for (const sel of [...SELECTIONS, ...awkward]) {
      expect(panelSelection(searchOf(panelHref("abc", sel)))).toEqual(sel);
      expect(panelSelection(searchOf(timelineHref("abc", sel)))).toEqual(sel);
    }
  });

  test("navigation inside the panel changes only sel: the dock, mode and timeline zoom stay", () => {
    const before = new URLSearchParams("sel=agent:gp-1&dock=bottom&view=expanded&zoom=2");
    const after = withSelection(before, { kind: "tool", id: "toolu_gp-1_031" });
    expect(after.toString()).toBe("sel=tool%3Atoolu_gp-1_031&dock=bottom&view=expanded&zoom=2");
    // The source query string does not change.
    expect(before.get("sel")).toBe("agent:gp-1");
  });
});

describe("the \"Back to …\" stack in the history state", () => {
  test("the label is put into the entry state and read from it", () => {
    expect(backLabelFromState(panelHistoryState("Bash call"))).toBe("Bash call");
  });

  test("an entry that appeared not through a transition from the panel gives no button", () => {
    expect(backLabelFromState(null)).toBeUndefined();
    expect(backLabelFromState(undefined)).toBeUndefined();
    expect(backLabelFromState("agent")).toBeUndefined();
    expect(backLabelFromState({})).toBeUndefined();
    expect(backLabelFromState({ panelBack: "" })).toBeUndefined();
    expect(backLabelFromState({ panelBack: 3 })).toBeUndefined();
  });
});

describe("a separate tab opens the same view by address (fixture mode)", () => {
  const before = process.env.VITE_TORCH_FIXTURES;

  beforeAll(() => {
    process.env.VITE_TORCH_FIXTURES = "1";
  });

  afterAll(() => {
    if (before === undefined) delete process.env.VITE_TORCH_FIXTURES;
    else process.env.VITE_TORCH_FIXTURES = before;
  });

  /** Separate tab path: address → selection → view data. */
  const open = (href: string) => loadPanelItem("abc", panelSelection(searchOf(href)));

  test("for every selection the view of that same element is loaded", async () => {
    for (const sel of SELECTIONS) {
      const item = await open(panelHref("abc", sel));
      expect(item.kind).toBe(sel.kind);
      expect(selectionOf(item)).toEqual(sel);
    }
  });

  test("an address without a selection returns the session view with the overview data", async () => {
    const item = await open("/sessions/abc/panel");
    expect(item.kind).toBe("session");
    if (item.kind === "session") expect(item.data.agents).toHaveLength(5);
  });

  test("an unknown id is a load error, not an empty view", async () => {
    await expect(open(panelHref("abc", { kind: "tool", id: "no-such-id" }))).rejects.toThrow();
  });

  test("a chain of transitions: agent → failed call → agent; the \"Back to …\" labels along the path", async () => {
    const agent = await open(panelHref("abc", { kind: "agent", id: "gp-1" }));
    if (agent.kind !== "agent") throw new Error("an agent view was expected");
    const failed = agent.data.calls.find((call) => call.status === "error")!;

    const tool = await loadPanelItem("abc", { kind: "tool", id: failed.id });
    expect(selectionOf(tool)).toEqual({ kind: "tool", id: "toolu_gp-1_031" });
    // On the call the button returns to the agent we came from.
    expect(backLabelFromState(panelHistoryState(backLabel(agent)))).toBe("general-purpose (gp-1)");

    if (tool.kind !== "tool") throw new Error("a call view was expected");
    const back = await loadPanelItem("abc", { kind: "agent", id: tool.data.agentId });
    expect(selectionOf(back)).toEqual(selectionOf(agent));
    expect(backLabelFromState(panelHistoryState(backLabel(tool)))).toBe("Bash call");
  });
});
