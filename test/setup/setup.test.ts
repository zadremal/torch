// `torch setup` and `torch uninstall` on a copy of settings.json in a temporary directory (plan §7.1,
// decision 27): showing the difference, confirmation, backup copy, writing and byte-for-byte rollback.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOOK_EVENT_NAMES } from "../../src/contracts/enrich.ts";
import { runSetup, runUninstall, type SetupOptions } from "../../src/setup/index.ts";

const NOW = Date.UTC(2026, 10, 10, 9, 30, 0);
const REPO = join(import.meta.dir, "..", "..");

/** A file modeled on the owner's settings: telemetry off, metrics export without a protocol, foreign hooks and env. */
const SETTINGS = `{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "OTEL_METRICS_EXPORTER": "otlp",
    "MY_PROXY": "http://proxy.local:8080"
  },
  "permissions": {
    "allow": ["Bash(git status)", "Read"],
    "deny": []
  },
  "cleanupPeriodDays": 30,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "/usr/local/bin/audit.sh" }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo started"
          }
        ]
      }
    ]
  },
  "model": "opus"
}
`;

/** The command environment: a settings.json copy and the torch data directory in a temporary directory. */
function sandbox(initial: string | null, overrides: Partial<SetupOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "torch-setup-"));
  const settingsPath = join(root, "claude", "settings.json");
  mkdirSync(dirname(settingsPath));
  if (initial !== null) writeFileSync(settingsPath, initial);
  const diffs: string[] = [];
  const state = { answer: true };
  const options: SetupOptions = {
    settingsPath,
    backupsDir: join(root, "torch", "backups"),
    hookPath: join(root, "torch", "hooks", "record.sh"),
    port: 4820,
    now: () => NOW,
    confirm: async (diff) => {
      diffs.push(diff);
      return state.answer;
    },
    ...overrides,
  };
  return {
    root,
    options,
    diffs,
    state,
    setup: (extra: Partial<SetupOptions> = {}) => runSetup({ ...options, ...extra }),
    uninstall: (extra: Partial<SetupOptions> = {}) => runUninstall({ ...options, ...extra }),
    read: () => readFileSync(settingsPath, "utf8"),
    json: () => JSON.parse(readFileSync(settingsPath, "utf8")),
    write: (text: string) => writeFileSync(settingsPath, text),
    /** Names of the settings.json copies in the backups directory. */
    backups: () => (existsSync(options.backupsDir) ? readdirSync(options.backupsDir).filter((name) => name.startsWith("settings.json.")).sort() : []),
  };
}

const torchGroup = (hookPath: string) => ({ hooks: [{ type: "command", command: hookPath }] });

describe("torch setup", () => {
  test("shows the difference, after consent saves a copy and writes the file", async () => {
    const s = sandbox(SETTINGS);

    const result = await s.setup();

    expect(s.diffs).toHaveLength(1);
    const diff = s.diffs[0]!.split("\n");
    // Three of the previous lines change: telemetry, the retention period and the comma after the last foreign variable.
    expect(diff.filter((line) => line.startsWith("-"))).toEqual(['-     "CLAUDE_CODE_ENABLE_TELEMETRY": "0",', '-     "MY_PROXY": "http://proxy.local:8080"', '-   "cleanupPeriodDays": 30,']);
    expect(diff).toContain('+     "CLAUDE_CODE_ENABLE_TELEMETRY": "1",');
    expect(diff).toContain('+     "MY_PROXY": "http://proxy.local:8080",');
    expect(diff).toContain('+     "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:4820/otlp/v1/logs",');
    expect(diff).toContain('+   "cleanupPeriodDays": 365,');
    expect(diff).toContain(`+             "command": "${s.options.hookPath}"`);
    // Every plus line is in the written file: what is shown is what is written.
    const written = s.read().split("\n");
    for (const line of diff.filter((row) => row.startsWith("+"))) expect(written).toContain(line.slice(2));

    expect(result).toEqual({ status: "written", backupPath: join(s.options.backupsDir, "settings.json.2026-11-10T09-30-00-000Z") });
    expect(s.json()).toEqual({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
        MY_PROXY: "http://proxy.local:8080",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4820/otlp/v1/logs",
        OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:4820/otlp/v1/metrics",
      },
      permissions: { allow: ["Bash(git status)", "Read"], deny: [] },
      cleanupPeriodDays: 365,
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/audit.sh" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo started" }] }, torchGroup(s.options.hookPath)],
        InstructionsLoaded: [torchGroup(s.options.hookPath)],
        SessionEnd: [torchGroup(s.options.hookPath)],
        PreCompact: [torchGroup(s.options.hookPath)],
        PostCompact: [torchGroup(s.options.hookPath)],
      },
      model: "opus",
    });
  });

  test("foreign hooks, env variables and the other keys stay the same lines", async () => {
    const s = sandbox(SETTINGS);

    await s.setup();

    const after = s.read();
    for (const fragment of [
      '    "OTEL_METRICS_EXPORTER": "otlp",\n    "MY_PROXY": "http://proxy.local:8080",\n',
      '  "permissions": {\n    "allow": ["Bash(git status)", "Read"],\n    "deny": []\n  },\n',
      '    "PreToolUse": [\n      {\n        "matcher": "Bash",\n        "hooks": [{ "type": "command", "command": "/usr/local/bin/audit.sh" }]\n      }\n    ],\n',
      '    "SessionStart": [\n      {\n        "hooks": [\n          {\n            "type": "command",\n            "command": "echo started"\n          }\n        ]\n      },\n',
      '  },\n  "model": "opus"\n}\n',
    ]) {
      expect(after).toContain(fragment);
    }
  });

  test("the copy is the previous file byte for byte, closed to others", async () => {
    const s = sandbox(SETTINGS);

    const { backupPath } = await s.setup();

    expect(s.backups()).toEqual(["settings.json.2026-11-10T09-30-00-000Z"]);
    expect(readFileSync(backupPath!, "utf8")).toBe(SETTINGS);
    expect(statSync(backupPath!).mode & 0o777).toBe(0o600);
    expect(statSync(s.options.backupsDir).mode & 0o777).toBe(0o700);
  });

  test("refusal: the file does not change, and there is no copy, edit record or handler", async () => {
    const s = sandbox(SETTINGS);
    s.state.answer = false;

    expect(await s.setup()).toEqual({ status: "declined", backupPath: null });

    expect(s.diffs).toHaveLength(1);
    expect(s.read()).toBe(SETTINGS);
    expect(existsSync(s.options.backupsDir)).toBe(false);
    expect(existsSync(s.options.hookPath)).toBe(false);
  });

  test("a repeated run does not change the file, does not ask and makes no copy", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();
    const first = s.read();

    expect(await s.setup({ now: () => NOW + 60_000 })).toEqual({ status: "unchanged", backupPath: null });

    expect(s.read()).toBe(first);
    expect(s.diffs).toHaveLength(1);
    expect(s.backups()).toHaveLength(1);
  });

  test("a repeated run does not change the file even after the user appended their own keys", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();
    // The user appended their own keys after the torch keys: to the end of the file and the end of env.
    const edited = s
      .read()
      .replace(/\n}\n$/, ',\n  "outputStyle": "concise"\n}\n')
      .replace(/("env": \{[^}]*?)(\n  \})/, '$1,\n    "USER_LATER": "1"$2');
    expect(Object.keys(JSON.parse(edited).env).at(-1)).toBe("USER_LATER");
    s.write(edited);

    expect((await s.setup()).status).toBe("unchanged");
    expect(s.read()).toBe(edited);
    expect(s.diffs).toHaveLength(1);
  });

  test("installs the hooks handler as an executable file and writes its path into a group without matcher", async () => {
    const s = sandbox("{}\n");

    await s.setup();

    expect(readFileSync(s.options.hookPath, "utf8")).toBe(readFileSync(join(REPO, "hooks", "record.sh"), "utf8"));
    expect(statSync(s.options.hookPath).mode & 0o111).toBe(0o111);
    expect(s.json().hooks).toEqual(Object.fromEntries(HOOK_EVENT_NAMES.map((event) => [event, [{ hooks: [{ type: "command", command: s.options.hookPath }] }]])));
  });

  test("a handler path with a space and a quote is written as a single shell word", async () => {
    const s = sandbox("{}\n");
    const hookPath = join(s.root, "John's Mac", "hooks", "record.sh");

    await s.setup({ hookPath });

    const command: string = s.json().hooks.SessionStart[0].hooks[0].command;
    expect(command).toBe(`'${join(s.root, "John'\\''s Mac", "hooks", "record.sh")}'`);
    // The command from the settings puts the event into the spool next to the handler directory; there are no torch variables in the environment.
    const run = Bun.spawnSync(["sh", "-c", command], { stdin: Buffer.from('{"hook_event_name":"SessionStart"}'), env: { PATH: process.env.PATH, HOME: join(s.root, "home") } });
    expect(run.exitCode).toBe(0);
    expect(readdirSync(join(s.root, "John's Mac", "spool")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  test("with no changes in the file, puts a deleted handler back in place", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();
    rmSync(s.options.hookPath);

    expect((await s.setup()).status).toBe("unchanged");

    expect(readFileSync(s.options.hookPath, "utf8")).toBe(readFileSync(join(REPO, "hooks", "record.sh"), "utf8"));
    expect(statSync(s.options.hookPath).mode & 0o111).toBe(0o111);
  });

  test("the file did not exist: it is created closed to others, and there is no copy", async () => {
    const s = sandbox(null);

    expect(await s.setup()).toEqual({ status: "written", backupPath: null });

    expect(s.diffs[0]!.split("\n").every((line) => line.startsWith("+ "))).toBe(true);
    expect(Object.keys(s.json())).toEqual(["env", "cleanupPeriodDays", "hooks"]);
    expect(statSync(s.options.settingsPath).mode & 0o777).toBe(0o600);
    expect(s.backups()).toEqual([]);
  });

  test("file permissions are preserved, a symbolic link stays a link", async () => {
    const s = sandbox(null);
    const real = join(s.root, "dotfiles", "settings.json");
    mkdirSync(dirname(real));
    writeFileSync(real, SETTINGS);
    // Permissions wider than the default umask leaves: they are restored to the file after creation.
    chmodSync(real, 0o664);
    symlinkSync(real, s.options.settingsPath);

    await s.setup();

    expect(lstatSync(s.options.settingsPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(statSync(real).mode & 0o777).toBe(0o664);
    expect(readdirSync(dirname(real))).toEqual(["settings.json"]);
  });

  test("the file changed while the confirmation was pending: an error, the foreign edit is intact", async () => {
    const s = sandbox(SETTINGS);
    const concurrent = SETTINGS.replace('"model": "opus"', '"model": "sonnet"');

    const attempt = s.setup({
      confirm: async () => {
        s.write(concurrent);
        return true;
      },
    });

    await expect(attempt).rejects.toThrow("changed while the confirmation was pending");
    expect(s.read()).toBe(concurrent);
    expect(s.backups()).toEqual([]);
  });

  test("a file that does not parse or is shaped differently is left untouched", async () => {
    for (const [text, problem] of [
      ['{ "env": { ', "file does not parse as JSON"],
      ['{ "env": "A=1" }', "expected an object in env"],
      ["[]", "expected a JSON object"],
    ] as const) {
      const s = sandbox(text);

      await expect(s.setup()).rejects.toThrow(problem);
      expect(s.read()).toBe(text);
      expect(s.diffs).toEqual([]);
      expect(existsSync(s.options.backupsDir)).toBe(false);
    }
  });

  test("a file that is not UTF-8 is left untouched: writing it as text would change its bytes", async () => {
    const s = sandbox(null);
    const bytes = Buffer.concat([Buffer.from('{"model": "'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
    writeFileSync(s.options.settingsPath, bytes);

    await expect(s.setup()).rejects.toThrow("file is not UTF-8");
    expect(readFileSync(s.options.settingsPath).equals(bytes)).toBe(true);
    expect(s.diffs).toEqual([]);
  });

  test("the write failed: the file and the edit record stay as they were, the rollback works from the previous record", async () => {
    const s = sandbox(SETTINGS);
    const statePath = join(s.options.backupsDir, "setup-state.json");
    const claudeDir = dirname(s.options.settingsPath);

    // The directory is write-protected: a temporary file next to settings.json cannot be created.
    chmodSync(claudeDir, 0o500);
    await expect(s.setup()).rejects.toThrow();
    expect(s.read()).toBe(SETTINGS);
    expect(existsSync(statePath)).toBe(false);

    chmodSync(claudeDir, 0o700);
    await s.setup();
    const state = readFileSync(statePath, "utf8");
    const configured = s.read();
    chmodSync(claudeDir, 0o500);
    await expect(s.setup({ port: 5001 })).rejects.toThrow();
    expect(s.read()).toBe(configured);
    expect(readFileSync(statePath, "utf8")).toBe(state);

    chmodSync(claudeDir, 0o700);
    await s.uninstall();
    expect(s.read()).toBe(SETTINGS);
  });

  test("the edit record is corrupted or of another shape: an error with its path, the file is left untouched", async () => {
    for (const broken of ["{ broken", "{}", "[]", '"text"', "null", '{"ops":{}}', '{"ops":[]}','{"fileCreated":false,"ops":{}}', '{"fileCreated":false,"ops":[{"kind":"set"}]}', '{"fileCreated":false,"ops":[{"kind":"move","path":["env"],"written":1}]}']) {
      const s = sandbox(SETTINGS);
      await s.setup();
      const configured = s.read();
      const statePath = join(s.options.backupsDir, "setup-state.json");
      writeFileSync(statePath, broken);

      await expect(s.setup({ port: 5001 })).rejects.toThrow(`${statePath}: the setup edit record is corrupted`);
      await expect(s.uninstall()).rejects.toThrow(`${statePath}: the setup edit record is corrupted`);
      expect(s.read()).toBe(configured);
      expect(readFileSync(statePath, "utf8")).toBe(broken);
      expect(s.diffs).toHaveLength(1);
    }
  });

  test("a dangling symbolic link in place of the file: an error, the link is intact, no file is created", async () => {
    const s = sandbox(null);
    const target = join(s.root, "dotfiles", "settings.json");
    symlinkSync(target, s.options.settingsPath);

    await expect(s.setup()).rejects.toThrow(`${s.options.settingsPath}: symbolic link points to a nonexistent file`);
    await expect(s.uninstall()).rejects.toThrow("symbolic link points to a nonexistent file");

    expect(lstatSync(s.options.settingsPath).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dirname(s.options.settingsPath))).toEqual(["settings.json"]);
    expect(s.diffs).toEqual([]);
    expect(existsSync(s.options.backupsDir)).toBe(false);
  });

  test("a temporary file left by an earlier failure does not interfere with the write and does not pass its permissions to the file", async () => {
    const s = sandbox(SETTINGS);
    chmodSync(s.options.settingsPath, 0o600);
    const stale = `${s.options.settingsPath}.torch-tmp`;
    writeFileSync(stale, "fragment");
    chmodSync(stale, 0o644);

    await s.setup();

    expect(s.json().env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(statSync(s.options.settingsPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(s.options.settingsPath))).toEqual(["settings.json"]);
  });

  test("the edit record is replaced by a rename: a write-protected record file does not interfere", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();
    const statePath = join(s.options.backupsDir, "setup-state.json");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    chmodSync(statePath, 0o400);

    await s.setup({ port: 5001 });

    expect(readFileSync(statePath, "utf8")).toContain("http://127.0.0.1:5001/otlp/v1/logs");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(s.options.backupsDir).filter((name) => name.endsWith("-tmp"))).toEqual([]);
    await s.uninstall();
    expect(s.read()).toBe(SETTINGS);
  });

  test("a run with another port changes only the addresses; the rollback restores the original file", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();

    expect((await s.setup({ port: 5001, now: () => NOW + 60_000 })).status).toBe("written");

    expect(s.diffs[1]!.split("\n").filter((line) => /^[-+]/.test(line))).toEqual([
      '-     "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:4820/otlp/v1/logs",',
      '+     "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:5001/otlp/v1/logs",',
      '-     "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://127.0.0.1:4820/otlp/v1/metrics"',
      '+     "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://127.0.0.1:5001/otlp/v1/metrics"',
    ]);
    expect(s.backups()).toHaveLength(2);

    await s.uninstall();
    expect(s.read()).toBe(SETTINGS);
  });
});

describe("torch uninstall", () => {
  const formats: [name: string, text: string][] = [
    ["file modeled on the owner's settings", SETTINGS],
    ["empty object", "{}"],
    ["empty object with a line break", "{}\n"],
    ["empty object with whitespace inside", "{\n}\n"],
    ["no trailing line break", '{\n  "model": "opus"\n}'],
    ["four-space indentation", '{\n    "env": {\n        "CLAUDE_CODE_ENABLE_TELEMETRY": "0"\n    },\n    "cleanupPeriodDays": 30\n}\n'],
    ["tab and CRLF", '{\r\n\t"env": {\r\n\t\t"OTEL_METRICS_EXPORTER": "otlp"\r\n\t},\r\n\t"hooks": {\r\n\t\t"SessionEnd": []\r\n\t}\r\n}\r\n'],
    ["single-line file", '{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"0","A":"1"},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}'],
    ["empty env and hooks with a space inside", '{\n  "env": { },\n  "hooks": { },\n  "cleanupPeriodDays": 1000\n}\n'],
    ["non-Latin values", '{\n  "env": {\n    "日本語": "世界 — 🌍"\n  }\n}\n'],
  ];

  for (const [name, text] of formats) {
    test(`after setup it restores the file byte for byte: ${name}`, async () => {
      const s = sandbox(text);
      const before = readFileSync(s.options.settingsPath);
      await s.setup();
      expect(s.json().env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
      expect(s.json().hooks.PostCompact).toEqual([torchGroup(s.options.hookPath)]);

      expect((await s.uninstall({ now: () => NOW + 60_000 })).status).toBe("written");

      expect(readFileSync(s.options.settingsPath).equals(before)).toBe(true);
    });
  }

  test("removes only what torch added: keys the user appended after setup stay", async () => {
    /** User edits: keys at the start and end of the file, a variable at the end of env, their own event at the end of hooks. */
    const userEdits = (text: string): string =>
      text
        .replace("{\n", '{\n  "theme": "dark",\n')
        .replace(/\n}\n$/, ',\n  "outputStyle": "concise"\n}\n')
        .replace(/("env": \{[^}]*?)(\n  \})/, '$1,\n    "USER_LATER": "1"$2')
        .replace('    ]\n  },\n  "model"', '    ],\n    "Stop": [\n      {\n        "hooks": [{ "type": "command", "command": "echo stop" }]\n      }\n    ]\n  },\n  "model"');
    const s = sandbox(SETTINGS);
    await s.setup();
    s.write(userEdits(s.read()));
    expect(s.json()).toMatchObject({ theme: "dark", outputStyle: "concise", env: { USER_LATER: "1", OTEL_LOGS_EXPORTER: "otlp" }, hooks: { Stop: [{}], PostCompact: [{}] } });

    await s.uninstall();

    expect(s.read()).toBe(userEdits(SETTINGS));
  });

  test("shows the difference, asks and saves a copy of the file with the edits", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();
    const configured = s.read();

    const result = await s.uninstall({ now: () => NOW + 60_000 });

    expect(s.diffs).toHaveLength(2);
    expect(s.diffs[1]).toContain('-     "CLAUDE_CODE_ENABLE_TELEMETRY": "1",\n+     "CLAUDE_CODE_ENABLE_TELEMETRY": "0",');
    expect(s.diffs[1]).toContain('-     "OTEL_LOGS_EXPORTER": "otlp",');
    expect(result).toEqual({ status: "written", backupPath: join(s.options.backupsDir, "settings.json.2026-11-10T09-31-00-000Z") });
    expect(readFileSync(result.backupPath!, "utf8")).toBe(configured);
    // The edit record does not remain after the rollback: the directory holds only two copies.
    expect(readdirSync(s.options.backupsDir).sort()).toEqual(["settings.json.2026-11-10T09-30-00-000Z", "settings.json.2026-11-10T09-31-00-000Z"]);
  });

  test("copies from the same moment do not overwrite each other", async () => {
    const s = sandbox(SETTINGS);

    const first = await s.setup();
    const second = await s.uninstall();

    expect(s.backups()).toEqual(["settings.json.2026-11-10T09-30-00-000Z", "settings.json.2026-11-10T09-30-00-000Z-1"]);
    expect(readFileSync(first.backupPath!, "utf8")).toBe(SETTINGS);
    expect(readFileSync(second.backupPath!, "utf8")).not.toBe(SETTINGS);
  });

  test("refusal leaves the file with the edits, and the rollback can be repeated", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();
    const configured = s.read();
    s.state.answer = false;

    expect((await s.uninstall()).status).toBe("declined");
    expect(s.read()).toBe(configured);

    s.state.answer = true;
    expect((await s.uninstall()).status).toBe("written");
    expect(s.read()).toBe(SETTINGS);
  });

  test("without setup and after a rollback there is nothing to change: no question", async () => {
    const s = sandbox(SETTINGS);

    expect(await s.uninstall()).toEqual({ status: "unchanged", backupPath: null });
    await s.setup();
    await s.uninstall();
    expect(await s.uninstall()).toEqual({ status: "unchanged", backupPath: null });

    expect(s.diffs).toHaveLength(2);
    expect(s.read()).toBe(SETTINGS);
  });

  test("settings.json is temporarily missing: an error, the edit record stays, after the file returns the rollback goes through", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();
    const statePath = join(s.options.backupsDir, "setup-state.json");
    const state = readFileSync(statePath, "utf8");
    const away = join(s.root, "settings.away.json");
    renameSync(s.options.settingsPath, away);

    await expect(s.uninstall()).rejects.toThrow(`${s.options.settingsPath} not found, but a record of torch setup edits exists (${statePath})`);
    // setup does not create a new file over the edit record of the old one either.
    await expect(s.setup()).rejects.toThrow("not found, but a record of torch setup edits exists");
    expect(readFileSync(statePath, "utf8")).toBe(state);
    expect(existsSync(s.options.settingsPath)).toBe(false);
    expect(s.diffs).toHaveLength(1);

    renameSync(away, s.options.settingsPath);
    expect((await s.uninstall()).status).toBe("written");
    expect(s.read()).toBe(SETTINGS);
    expect(existsSync(statePath)).toBe(false);
  });

  test("setup created the file and the user deleted it: nothing to roll back, the edit record is removed", async () => {
    const s = sandbox(null);
    await s.setup();
    rmSync(s.options.settingsPath);

    expect(await s.uninstall()).toEqual({ status: "unchanged", backupPath: null });

    expect(existsSync(join(s.options.backupsDir, "setup-state.json"))).toBe(false);
    expect(existsSync(s.options.settingsPath)).toBe(false);
  });

  describe("there is no edit record, but the torch edits are in the file", () => {
    /** The file after setup, with the edit record deleted manually. */
    async function orphaned() {
      const s = sandbox(SETTINGS);
      const { backupPath } = await s.setup();
      const statePath = join(s.options.backupsDir, "setup-state.json");
      rmSync(statePath);
      return { ...s, statePath, backupPath: backupPath!, configured: s.read() };
    }

    test("uninstall: an error with the torch keys, the backups directory and the latest copy; the file is left untouched", async () => {
      const s = await orphaned();

      const error: Error = await s.uninstall().then(
        () => {
          throw new Error("uninstall finished without an error");
        },
        (thrown) => thrown,
      );

      expect(error.message).toBe(
        `${s.options.settingsPath} contains torch setup edits, but there is no record of them (${s.statePath}): the previous values are unknown. ` +
          "Keys set by torch: env.CLAUDE_CODE_ENABLE_TELEMETRY, env.OTEL_LOGS_EXPORTER, env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, " +
          "env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, cleanupPeriodDays, hooks.SessionStart, hooks.InstructionsLoaded, hooks.SessionEnd, hooks.PreCompact, hooks.PostCompact. " +
          `Restore them manually. File copies are in ${s.options.backupsDir}; the latest: ${s.backupPath}.`,
      );
      expect(s.read()).toBe(s.configured);
      expect(s.diffs).toHaveLength(1);
      expect(existsSync(s.statePath)).toBe(false);
    });

    test("setup with no changes still reports that the file is configured", async () => {
      const s = await orphaned();

      expect(await s.setup()).toEqual({ status: "unchanged", backupPath: null });

      expect(s.read()).toBe(s.configured);
      expect(existsSync(s.statePath)).toBe(false);
    });

    test("setup with another port: the same error, the torch address is not remembered as \"previous\"", async () => {
      const s = await orphaned();

      await expect(s.setup({ port: 5001 })).rejects.toThrow(`${s.options.settingsPath} contains torch setup edits, but there is no record of them (${s.statePath})`);

      expect(s.read()).toBe(s.configured);
      expect(s.diffs).toHaveLength(1);
      expect(existsSync(s.statePath)).toBe(false);
      expect(s.backups()).toHaveLength(1);
    });

    test("a single torch receiver address with any port is enough; there are no copies, and it says so", async () => {
      const text = '{\n  "env": {\n    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:5999/otlp/v1/logs"\n  }\n}\n';
      const s = sandbox(text);

      await expect(s.uninstall()).rejects.toThrow(`Keys set by torch: env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT. Restore them manually. File copies are in ${s.options.backupsDir}; there are no copies there.`);
      await expect(s.setup()).rejects.toThrow("contains torch setup edits, but there is no record of them");
      expect(s.read()).toBe(text);
      expect(s.diffs).toEqual([]);
    });

    test("a single torch handler is enough; the latest copy is chosen by write time, not by name", async () => {
      const s = sandbox(null);
      const text = `${JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: s.options.hookPath }] }] } }, null, 2)}\n`;
      s.write(text);
      mkdirSync(s.options.backupsDir, { recursive: true });
      const [old, recent] = ["settings.json.zz-manual", "settings.json.2026-11-10T09-30-00-000Z"].map((name) => join(s.options.backupsDir, name));
      writeFileSync(old!, "{}");
      utimesSync(old!, new Date(NOW - 86_400_000), new Date(NOW - 86_400_000));
      writeFileSync(recent!, "{}");
      utimesSync(recent!, new Date(NOW), new Date(NOW));

      await expect(s.uninstall()).rejects.toThrow(`Keys set by torch: hooks.SessionEnd. Restore them manually. File copies are in ${s.options.backupsDir}; the latest: ${recent}.`);
      expect(s.read()).toBe(text);
    });

    test("values that also occur without torch are not counted as torch edits", async () => {
      const text = '{\n  "env": {\n    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",\n    "OTEL_LOGS_EXPORTER": "otlp",\n    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://collector:4318/v1/logs"\n  },\n  "cleanupPeriodDays": 365,\n  "hooks": {\n    "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo hi" }] }]\n  }\n}\n';
      const s = sandbox(text);

      expect(await s.uninstall()).toEqual({ status: "unchanged", backupPath: null });
      expect((await s.setup()).status).toBe("written");
      await s.uninstall();
      expect(s.read()).toBe(text);
    });
  });

  test("a file created by setup is deleted; with the user's keys it stays with them", async () => {
    const created = sandbox(null);
    await created.setup();
    await created.uninstall();
    expect(existsSync(created.options.settingsPath)).toBe(false);

    const kept = sandbox(null);
    await kept.setup();
    kept.write(kept.read().replace("{\n", '{\n  "model": "opus",\n'));
    await kept.uninstall();
    expect(kept.read()).toBe('{\n  "model": "opus"\n}\n');
  });

  test("setup after a rollback remembers the previous values again", async () => {
    const s = sandbox(SETTINGS);
    await s.setup();
    await s.uninstall();
    await s.setup();
    expect(s.json().env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");

    await s.uninstall();

    expect(s.read()).toBe(SETTINGS);
  });
});
