// Rules for editing settings.json and rolling it back (plan §7.1, spikes.md §8): pure functions over text.
import { describe, expect, test } from "bun:test";
import { HOOK_EVENT_NAMES } from "../../src/contracts/enrich.ts";
import { applySetup, revertSetup } from "../../src/setup/settings.ts";

const COMMAND = "/home/user/.torch/hooks/record.sh";
const TARGET = { port: 4820, hookCommand: COMMAND };
const TORCH_GROUP = { hooks: [{ type: "command", command: COMMAND }] };

const LOGS_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4820/otlp/v1/logs",
};

const file = (settings: unknown): string => `${JSON.stringify(settings, null, 2)}\n`;

/** Editing a file with the given content: the text before, the parsed result and the text after the rollback. */
function applied(settings: unknown, target = TARGET) {
  const before = file(settings);
  const { text, state } = applySetup(before, target);
  return { before, text, state, json: JSON.parse(text), reverted: revertSetup(text, state) };
}

describe("CLAUDE_CODE_ENABLE_TELEMETRY", () => {
  for (const previous of ["0", "true", "", "1"]) {
    test(`from the previous value ${JSON.stringify(previous)} it is set to "1", the rollback restores the previous one`, () => {
      const result = applied({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: previous, OTHER: "x" } });

      expect(result.json.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
      expect(result.reverted).toBe(result.before);
    });
  }

  test("the key did not exist: it is added, the rollback removes it", () => {
    const result = applied({ env: { OTHER: "x" } });

    expect(result.json.env).toEqual({ OTHER: "x", ...LOGS_ENV });
    expect(result.reverted).toBe(result.before);
    expect(JSON.parse(result.reverted!).env).toEqual({ OTHER: "x" });
  });

  test("the env block did not exist: it is created, the rollback removes it whole", () => {
    const result = applied({ model: "opus" });

    expect(result.json.env).toEqual(LOGS_ENV);
    expect(result.reverted).toBe(result.before);
    expect(JSON.parse(result.reverted!)).toEqual({ model: "opus" });
  });
});

describe("logs export", () => {
  test("the receiver address is built from the port", () => {
    expect(applied({}, { ...TARGET, port: 5001 }).json.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("http://127.0.0.1:5001/otlp/v1/logs");
  });

  test("foreign values of the logs variables are replaced and restored by the rollback", () => {
    const result = applied({ env: { OTEL_LOGS_EXPORTER: "console", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector:4318/v1/logs" } });

    expect(result.json.env).toEqual(LOGS_ENV);
    expect(result.reverted).toBe(result.before);
  });
});

describe("metrics export", () => {
  test("OTEL_METRICS_EXPORTER without a protocol: the http/json protocol and the torch receiver metrics address are added", () => {
    const result = applied({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0", OTEL_METRICS_EXPORTER: "otlp" } });

    expect(result.json.env).toEqual({
      ...LOGS_ENV,
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4820/otlp/v1/metrics",
    });
    expect(result.reverted).toBe(result.before);
  });

  for (const protocol of ["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "OTEL_EXPORTER_OTLP_PROTOCOL"]) {
    test(`the protocol is already set in ${protocol}: the metrics variables are not added`, () => {
      const env = { OTEL_METRICS_EXPORTER: "otlp", [protocol]: "grpc" };
      const result = applied({ env });

      expect(result.json.env).toEqual({ ...env, ...LOGS_ENV });
    });
  }

  test("metrics export is not set: the metrics variables are not added", () => {
    expect(applied({ env: { OTHER: "x" } }).json.env).toEqual({ OTHER: "x", ...LOGS_ENV });
    expect(applied({}).json.env).toEqual(LOGS_ENV);
  });

  for (const endpoint of ["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"]) {
    test(`a custom metrics address in ${endpoint} stays: only the protocol is added`, () => {
      const env = { OTEL_METRICS_EXPORTER: "otlp", [endpoint]: "http://collector:4318" };
      const result = applied({ env });

      expect(result.json.env).toEqual({ ...env, ...LOGS_ENV, OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json" });
      expect(result.reverted).toBe(result.before);
    });
  }
});

describe("cleanupPeriodDays", () => {
  test("the key did not exist: 365 is set, the rollback removes it", () => {
    const result = applied({ model: "opus" });

    expect(result.json.cleanupPeriodDays).toBe(365);
    expect(result.reverted).toBe(result.before);
  });

  test("a shorter period is replaced, the rollback restores the previous value", () => {
    const result = applied({ cleanupPeriodDays: 30 });

    expect(result.json.cleanupPeriodDays).toBe(365);
    expect(JSON.parse(result.reverted!).cleanupPeriodDays).toBe(30);
    expect(result.reverted).toBe(result.before);
  });

  test("a period of at least 365 is left untouched", () => {
    for (const days of [365, 1000]) {
      const result = applied({ cleanupPeriodDays: days });

      expect(result.json.cleanupPeriodDays).toBe(days);
      expect(result.state.ops.some((op) => op.path[0] === "cleanupPeriodDays")).toBe(false);
    }
  });

  test("the previous value is restored as the same text", () => {
    const before = '{\n  "cleanupPeriodDays": 3.0e1\n}\n';
    const { text, state } = applySetup(before, TARGET);

    expect(JSON.parse(text).cleanupPeriodDays).toBe(365);
    expect(revertSetup(text, state)).toBe(before);
  });
});

describe("hooks", () => {
  test("each of the five events gets a group without matcher with the handler command", () => {
    const result = applied({});

    expect(HOOK_EVENT_NAMES).toHaveLength(5);
    expect(result.json.hooks).toEqual(Object.fromEntries(HOOK_EVENT_NAMES.map((event) => [event, [{ hooks: [{ type: "command", command: COMMAND }] }]])));
    expect(result.text).not.toContain("matcher");
    expect(result.reverted).toBe(result.before);
  });

  test("foreign events and foreign groups stay in place, the torch group is appended after them", () => {
    const foreign = { matcher: "startup", hooks: [{ type: "command", command: "echo started", timeout: 5 }] };
    const audit = { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/audit.sh" }] };
    const result = applied({ hooks: { PreToolUse: [audit], SessionStart: [foreign] } });

    expect(result.json.hooks.PreToolUse).toEqual([audit]);
    expect(result.json.hooks.SessionStart).toEqual([foreign, TORCH_GROUP]);
    expect(Object.keys(result.json.hooks)).toEqual(["PreToolUse", "SessionStart", "InstructionsLoaded", "SessionEnd", "PreCompact", "PostCompact"]);
    expect(result.reverted).toBe(result.before);
  });

  test("an event where the torch handler is already present does not get a second group", () => {
    const tuned = { hooks: [{ type: "command", command: COMMAND, timeout: 10 }] };
    const result = applied({ hooks: { SessionEnd: [tuned], PreCompact: [TORCH_GROUP] } });

    expect(result.json.hooks.SessionEnd).toEqual([tuned]);
    expect(result.json.hooks.PreCompact).toEqual([TORCH_GROUP]);
    expect(result.json.hooks.SessionStart).toEqual([TORCH_GROUP]);
  });

  test("empty hooks and an empty event list accept the group, the rollback returns them empty", () => {
    const result = applied({ hooks: { SessionStart: [] } });

    expect(result.json.hooks.SessionStart).toEqual([TORCH_GROUP]);
    expect(result.reverted).toBe(result.before);
  });
});

describe("rollback", () => {
  test("a value the user changed after setup stays theirs", () => {
    const { text, state } = applySetup(file({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0" }, cleanupPeriodDays: 30 }), TARGET);
    const edited = text.replace('"OTEL_LOGS_EXPORTER": "otlp"', '"OTEL_LOGS_EXPORTER": "console"').replace('"cleanupPeriodDays": 365', '"cleanupPeriodDays": 500');

    expect(JSON.parse(revertSetup(edited, state)!)).toEqual({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0", OTEL_LOGS_EXPORTER: "console" }, cleanupPeriodDays: 500 });
  });

  test("a torch group the user changed, and the groups next to it, stay", () => {
    const { text, state } = applySetup(file({}), TARGET);
    const settings = JSON.parse(text);
    settings.hooks.SessionStart[0].hooks[0].timeout = 10;
    settings.hooks.SessionEnd.push({ hooks: [{ type: "command", command: "echo bye" }] });

    const reverted = JSON.parse(revertSetup(file(settings), state)!);

    expect(reverted).toEqual({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: COMMAND, timeout: 10 }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }],
      },
    });
  });

  test("what the user already removed themselves is not searched for by the rollback", () => {
    const { state } = applySetup(file({ model: "opus" }), TARGET);
    const cleaned = file({ model: "opus", hooks: { Stop: [] } });

    expect(revertSetup(cleaned, state)).toBe(cleaned);
    expect(revertSetup(file({ model: "opus" }), state)).toBe(file({ model: "opus" }));
  });

  test("the file did not exist: a rollback with nothing left gives null, with the user's keys it gives the text with them", () => {
    const { text, state } = applySetup(null, TARGET);

    expect(state.fileCreated).toBe(true);
    expect(revertSetup(text, state)).toBeNull();
    expect(revertSetup(text.replace("{\n", '{\n  "model": "opus",\n'), state)).toBe('{\n  "model": "opus"\n}\n');
  });
});

describe("a file that cannot be edited", () => {
  test("the root is not an object", () => {
    expect(() => applySetup("[]\n", TARGET)).toThrow("settings.json: expected a JSON object");
  });

  test("env, hooks or an event list of another kind", () => {
    expect(() => applySetup(file({ env: "A=1" }), TARGET)).toThrow("expected an object in env");
    expect(() => applySetup(file({ hooks: [] }), TARGET)).toThrow("expected an object in hooks");
    expect(() => applySetup(file({ hooks: { SessionEnd: {} } }), TARGET)).toThrow("expected an array in hooks.SessionEnd");
  });
});
