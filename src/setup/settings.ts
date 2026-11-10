// What `torch setup` changes in the settings.json text and how `torch uninstall` reverts it
// (plan §7.1, spikes.md §8). Pure functions over text: index.ts reads and writes the files.

import { isDeepStrictEqual } from "node:util";
import { API_ROUTES } from "../contracts/api.ts";
import { CLEANUP_PERIOD_DAYS, DEFAULT_HOST } from "../contracts/constants.ts";
import { HOOK_EVENT_NAMES } from "../contracts/enrich.ts";
import { append, emptyInner, find, parseTree, read, remove, replace, type Json, type Node } from "./json.ts";

/**
 * A single torch edit. According to the record, an edit is reverted only while the value in the
 * file equals the recorded one: whatever the user changed themselves after setup stays theirs.
 */
export type Op =
  | {
      kind: "set";
      path: string[];
      written: Json;
      /** Previous text of the value; null means the key did not exist. */
      previous: string | null;
      /** What stood between the parent's brackets while it was empty. */
      inner?: string;
    }
  | { kind: "append"; path: string[]; written: Json; inner?: string };

/** Record of the edits: everything needed for the rollback. */
export interface SetupState {
  /** The settings.json file did not exist before setup. */
  fileCreated: boolean;
  ops: Op[];
}

export interface SetupTarget {
  port: number;
  /** The hooks handler command, as it is written in settings.json. */
  hookCommand: string;
}

interface Draft {
  text: string;
  ops: Op[];
}

const KIND_NAMES = { object: "an object", array: "an array" } as const;

function expectKind(root: Node, path: string[], kind: keyof typeof KIND_NAMES): void {
  const node = find(root, path);
  if (node && node.kind !== kind) throw new Error(`settings.json: expected ${KIND_NAMES[kind]} in ${path.join(".")}`);
}

function parseSettings(text: string): Node {
  const root = parseTree(text);
  if (root.kind !== "object") throw new Error("settings.json: expected a JSON object");
  expectKind(root, ["env"], "object");
  expectKind(root, ["hooks"], "object");
  for (const event of HOOK_EVENT_NAMES) expectKind(root, ["hooks", event], "array");
  return root;
}

const inner = (text: string, container: Node): { inner?: string } => {
  const between = emptyInner(text, container);
  return between === "" ? {} : { inner: between };
};

/** Sets a value at a path. The parent already exists; an equal value is left untouched. */
function set(draft: Draft, path: string[], value: Json): void {
  const root = parseTree(draft.text);
  const node = find(root, path);
  if (node) {
    if (isDeepStrictEqual(read(draft.text, node), value)) return;
    draft.ops.push({ kind: "set", path, written: value, previous: draft.text.slice(node.start, node.end) });
    draft.text = replace(draft.text, node, JSON.stringify(value));
    return;
  }
  const parent = find(root, path.slice(0, -1))!;
  draft.ops.push({ kind: "set", path, written: value, previous: null, ...inner(draft.text, parent) });
  draft.text = append(draft.text, parent, value, path.at(-1));
}

/** Creates an empty container if there is none. */
function ensure(draft: Draft, path: string[], empty: Json): void {
  if (!find(parseTree(draft.text), path)) set(draft, path, empty);
}

const at = (text: string, path: string[]): Json | undefined => {
  const node = find(parseTree(text), path);
  return node && read(text, node);
};

/** A hooks group without `matcher`: the handler receives every case of the event (spikes.md §8). */
const hookGroup = (command: string): Json => ({ hooks: [{ type: "command", command }] });

const runsCommand = (group: Json, command: string): boolean => {
  const handlers = (group as { hooks?: Json } | null)?.hooks;
  return Array.isArray(handlers) && handlers.some((handler) => (handler as { command?: Json } | null)?.command === command);
};

/** The `env` variables torch needs, given the current `env` block. */
function envVars(env: { [key: string]: Json }, port: number): Record<string, string> {
  const endpoint = (route: string): string => `http://${DEFAULT_HOST}:${port}${route}`;
  const vars: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint(API_ROUTES.otlpLogs),
  };
  // Metrics export without a protocol breaks the initialization of all telemetry, and logs are not
  // sent (spikes.md §8). A configured metrics export is left alone: only what is missing is added.
  if ("OTEL_METRICS_EXPORTER" in env && !("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL" in env) && !("OTEL_EXPORTER_OTLP_PROTOCOL" in env)) {
    vars.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/json";
    if (!("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT" in env) && !("OTEL_EXPORTER_OTLP_ENDPOINT" in env)) vars.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = endpoint(API_ROUTES.otlpMetrics);
  }
  return vars;
}

/** The settings.json text after `torch setup` and a record of the edits made. `current` null means there is no file. */
export function applySetup(current: string | null, target: SetupTarget): { text: string; state: SetupState } {
  const draft: Draft = { text: current ?? "{}\n", ops: [] };
  parseSettings(draft.text);

  const vars = envVars((at(draft.text, ["env"]) ?? {}) as { [key: string]: Json }, target.port);
  ensure(draft, ["env"], {});
  for (const [name, value] of Object.entries(vars)) set(draft, ["env", name], value);

  // The retention period is never reduced: a shorter one would delete transcripts the user keeps.
  const retention = at(draft.text, ["cleanupPeriodDays"]);
  if (!(typeof retention === "number" && retention >= CLEANUP_PERIOD_DAYS)) set(draft, ["cleanupPeriodDays"], CLEANUP_PERIOD_DAYS);

  ensure(draft, ["hooks"], {});
  for (const event of HOOK_EVENT_NAMES) {
    const path = ["hooks", event];
    ensure(draft, path, []);
    const groups = find(parseTree(draft.text), path)!;
    if ((read(draft.text, groups) as Json[]).some((group) => runsCommand(group, target.hookCommand))) continue;
    const written = hookGroup(target.hookCommand);
    draft.ops.push({ kind: "append", path, written, ...inner(draft.text, groups) });
    draft.text = append(draft.text, groups, written);
  }
  return { text: draft.text, state: { fileCreated: current === null, ops: draft.ops } };
}

const isObject = (value: unknown): value is { [key: string]: unknown } => typeof value === "object" && value !== null && !Array.isArray(value);

function isOp(value: unknown): value is Op {
  if (!isObject(value) || !Array.isArray(value.path) || !value.path.every((key) => typeof key === "string") || !("written" in value)) return false;
  if (value.inner !== undefined && typeof value.inner !== "string") return false;
  return value.kind === "append" || (value.kind === "set" && (value.previous === null || typeof value.previous === "string"));
}

/** The parsed edit record file has the shape of `SetupState`. */
export const isSetupState = (value: unknown): value is SetupState => isObject(value) && typeof value.fileCreated === "boolean" && Array.isArray(value.ops) && value.ops.every(isOp);

/** Setup edits found in the file without a record of them. */
export interface TorchEdits {
  /** Keys with the values that torch setup sets. */
  keys: string[];
  /** Among them is the torch handler or the address of its receiver: such values do not appear on their own. */
  own: boolean;
}

/** The value with port 0: the receiver address is recognized at any port. */
const anyPort = (value: string): string => value.replace(/:\d+\//, ":0/");

/** Looks in the file for the values that setup sets: they reveal edits whose record was lost. */
export function torchEdits(text: string, hookCommand: string): TorchEdits {
  const env = at(text, ["env"]);
  const hooks = at(text, ["hooks"]);
  // A metrics export without a protocol yields the full set of setup variables.
  const vars = envVars({ OTEL_METRICS_EXPORTER: "" }, 0);
  const envKeys = Object.keys(vars).filter((name) => {
    const value = isObject(env) ? env[name] : undefined;
    return typeof value === "string" && anyPort(value) === vars[name];
  });
  const hookKeys = Object.entries(isObject(hooks) ? hooks : {})
    .filter(([, groups]) => Array.isArray(groups) && groups.some((group) => runsCommand(group as Json, hookCommand)))
    .map(([event]) => event);
  return {
    keys: [...envKeys.map((name) => `env.${name}`), ...(at(text, ["cleanupPeriodDays"]) === CLEANUP_PERIOD_DAYS ? ["cleanupPeriodDays"] : []), ...hookKeys.map((event) => `hooks.${event}`)],
    own: hookKeys.length > 0 || envKeys.some((name) => name.endsWith("_ENDPOINT")),
  };
}

/** The settings.json text without torch edits; null means setup created the file and nothing is left in it. */
export function revertSetup(text: string, state: SetupState): string | null {
  for (const op of [...state.ops].reverse()) {
    const root = parseSettings(text);
    if (op.kind === "append") {
      const groups = find(root, op.path);
      const index = groups ? groups.items.findIndex((item) => isDeepStrictEqual(read(text, item.value), op.written)) : -1;
      if (index >= 0) text = remove(text, groups!, index, op.inner);
      continue;
    }
    const node = find(root, op.path);
    if (!node || !isDeepStrictEqual(read(text, node), op.written)) continue;
    if (op.previous !== null) {
      text = replace(text, node, op.previous);
      continue;
    }
    const parent = find(root, op.path.slice(0, -1))!;
    text = remove(text, parent, parent.items.findLastIndex((item) => item.key === op.path.at(-1)), op.inner);
  }
  return state.fileCreated && parseTree(text).items.length === 0 ? null : text;
}
