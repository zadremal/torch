// Thresholds and constants of torch. The single place for each value (plan §4.2).

/** Default port: the UI, the API and the OTLP receiver. */
export const DEFAULT_PORT = 4820;
export const DEFAULT_HOST = "127.0.0.1";

/** Identifier of a session's main agent in tables and addresses. */
export const MAIN_AGENT_ID = "main";

/** A session counts as running if its last event is younger than this and there is no SessionEnd. */
export const RUNNING_WINDOW_MS = 5 * 60_000;

/** An idle stretch longer than this with no running calls collapses into a gap on the timeline. */
export const IDLE_GAP_MS = 5 * 60_000;

/** Width of a dashboard column in the "day" range, hours. */
export const DAY_BUCKET_HOURS = 2;

/** Page size of the session list. */
export const SESSIONS_PAGE_SIZE = 50;

/** Length of each top list on the dashboard. */
export const LEADERBOARD_SIZE = 5;

/** Tool error rate above which it is highlighted. */
export const ERROR_RATE_HIGHLIGHT = 0.05;

/** Bodies in `contents` larger than this are compressed with gzip. */
export const CONTENT_COMPRESS_MIN_BYTES = 4096;

/** How many characters of a body the panel gets immediately; the whole body via /api/contents/:id. */
export const BODY_PREVIEW_CHARS = 4000;

/** Estimate of the token count from the text size: bytes per token. */
export const BYTES_PER_TOKEN_EST = 4;

/** Estimate of the token count from the text size in bytes. */
export const estimateTokens = (bytes: number): number => Math.ceil(bytes / BYTES_PER_TOKEN_EST);

/** How many characters of the first prompt become the session name when there are no other names (decision 7). */
export const PROMPT_NAME_MAX_CHARS = 80;

/** Value of `permissionDecision.decision` for a denial; for an approval it is `accept` (spikes.md §2). */
export const PERMISSION_REJECT = "reject";

/**
 * Beginnings of the text of `user` lines that Claude Code wrote rather than the user typing: local
 * command output and shell command output, the interruption marker (spikes.md §2). Such lines are not prompts.
 */
export const NON_PROMPT_TEXT_PREFIXES: readonly string[] = ["<local-command-", "<bash-", "[Request interrupted by user"];

/** `origin.kind` of `user` lines sent by neither a human nor another session: such lines are not prompts. */
export const NON_PROMPT_ORIGINS: readonly string[] = ["task-notification"];

/** Heartbeat of the OTel receiver's working window. */
export const RECEIVER_HEARTBEAT_MS = 30_000;

/** API errors from two sources without a request_id are merged if closer than this in time. */
export const API_ERROR_DEDUP_WINDOW_MS = 1000;

/** A working directory with such a beginning is temporary (decision 6). */
export const TEMP_DIR_PREFIXES = ["/private/var/folders/", "/private/tmp/"] as const;

/** Model of lines that Claude Code appended itself, without an API call. */
export const SYNTHETIC_MODEL = "<synthetic>";

/** Transcript retention period that `torch setup` sets. */
export const CLEANUP_PERIOD_DAYS = 365;

/** Allowed values of the timeline state in the page address (plan §9.1). */
export const TIMELINE_ZOOMS = [1, 2, 4] as const;
export const TIMELINE_VIEWS = ["compact", "expanded"] as const;
export const PANEL_DOCKS = ["right", "left", "bottom"] as const;

/** Buckets of the "Agents" filter in the session list: the agent-count bounds are inclusive. */
export const AGENT_BUCKETS = {
  any: [0, null],
  one: [1, 1],
  few: [2, 3],
  many: [4, null],
} as const satisfies Record<string, readonly [number, number | null]>;
