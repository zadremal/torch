// Drives the installed Google Chrome over the DevTools protocol, with no dependencies: Chrome
// runs headless with its own temporary profile, commands go over WebSocket.
// Elements are found the way an assistive-technology user sees them: by role and name
// from the accessibility tree (Accessibility.queryAXTree), not by classes and markup.
//
//   const browser = await launchBrowser(chromePath, profileDir);
//   const page = await browser.page();
//   await page.goto("http://127.0.0.1:4821/sessions");
//   await (await page.find("link", "Fix flaky checkout test")).click();

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How long to wait for an element or a page state to appear. */
const WAIT_MS = 10_000;
const POLL_MS = 100;
const CHROME_START_MS = 20_000;

const MAC_CHROME = join("Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome");

/** Path to the installed Google Chrome; null if there is none. */
export function findChrome(): string | null {
  const candidates = [join("/", MAC_CHROME), join(homedir(), MAC_CHROME), Bun.which("google-chrome"), Bun.which("google-chrome-stable")];
  return candidates.find((path): path is string => path !== null && existsSync(path)) ?? null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
  * Waits until `probe` returns a value other than undefined; otherwise throws an error with the expectation text.
  * A failure of the probe itself (the page is re-rendering, the node vanished) means "not ready yet", not an error.
 */
export async function waitFor<T>(expectation: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  let lastError = "";
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
      lastError = "";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) throw new Error(`${expectation} — gave up waiting after ${WAIT_MS / 1000} s${lastError ? ` (${lastError})` : ""}`);
    await sleep(POLL_MS);
  }
}

// ── Connection ──────────────────────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;
type Listener = (params: Params, sessionId: string | undefined) => void;

interface Wire {
  id?: number;
  method?: string;
  params?: Params;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
}

class Connection {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }>();
  private readonly listeners = new Map<string, Listener[]>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Wire;
      if (message.id === undefined) {
        for (const listener of this.listeners.get(message.method ?? "") ?? []) listener(message.params ?? {}, message.sessionId);
        return;
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error(`${waiting.method}: connection to Chrome closed`));
      this.pending.clear();
    });
  }

  static open(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Connection(socket)));
      socket.addEventListener("error", () => reject(new Error(`Could not connect to Chrome: ${url}`)));
    });
  }

  send<T>(method: string, params: Params = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method: string, listener: Listener): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  close(): void {
    this.socket.close();
  }
}

// ── Page ────────────────────────────────────────────────────────────────────────────────────

interface AxValue {
  value?: unknown;
}

interface AxNode {
  ignored: boolean;
  name?: AxValue;
  properties?: { name: string; value: AxValue }[];
  backendDOMNodeId?: number;
}

const nameOf = (node: AxNode): string => String(node.name?.value ?? "");

/** Where elements are searched: the whole page or the descendants of one element. */
export interface Scope {
  /** Elements with a role (and name) in document order, without waiting. Elements hidden from the user are excluded. */
  all(role: string, name?: string | RegExp): Promise<Item[]>;
  /** Waits for an element with a role and name. */
  find(role: string, name?: string | RegExp): Promise<Item>;
  /** Accessible names of elements with a role, in document order. */
  names(role: string): Promise<string[]>;
}

/** How a person would name the element in an error message. */
function describe(role: string, name?: string | RegExp): string {
  return name === undefined ? role : `${role} «${name instanceof RegExp ? name.source : name}»`;
}

/**
  * A page element specified by role and name. The node is looked up again on every action: the page
  * re-renders, and a node found earlier may have been replaced with a new one by then.
 */
export class Item implements Scope {
  constructor(
    private readonly page: Page,
    private readonly parent: Item | null,
    private readonly role: string,
    private readonly name: string | RegExp | undefined,
    /** Index among the matching elements of the scope. */
    private readonly index: number,
  ) {}

  /** Role, name and location of the element: for messages. */
  get label(): string {
    const own = describe(this.role, this.name);
    return this.parent ? `${this.parent.label} → ${own}` : own;
  }

  private async node(): Promise<AxNode> {
    const nodes = await this.page.query(this.role, this.name, this.parent ? await this.parent.target() : undefined);
    const node = nodes[this.index];
    if (!node) throw new Error(`element ${this.label} is not on the page`);
    return node;
  }

  private async target(): Promise<Params> {
    return { backendNodeId: (await this.node()).backendDOMNodeId };
  }

  /** State from the accessibility tree: `pressed`, `disabled`, `checked`. */
  async state(property: string): Promise<unknown> {
    return (await this.node()).properties?.find((p) => p.name === property)?.value.value;
  }

  /** Calls a function in the page with the element as `this`. */
  private async call<T>(body: string): Promise<T> {
    const { object } = await this.page.send<{ object: { objectId: string } }>("DOM.resolveNode", await this.target());
    const { result } = await this.page.send<{ result: { value: T } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: `function () { ${body} }`, returnByValue: true });
    return result.value;
  }

  /** Mouse click at the middle of the element: like a user, scrolling to the element. */
  async click(): Promise<void> {
    const target = await this.target();
    await this.page.send("DOM.scrollIntoViewIfNeeded", target);
    const { quads } = await this.page.send<{ quads: number[][] }>("DOM.getContentQuads", target);
    const quad = quads[0];
    if (!quad) throw new Error(`${this.label}: element is not visible, nowhere to click`);
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) await this.page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }

  /** Replaces the contents of the input field with the typed text. */
  async fill(value: string): Promise<void> {
    await this.page.send("DOM.focus", await this.target());
    await this.call("this.select();");
    await this.page.send("Input.insertText", { text: value });
  }

  async all(role: string, name?: string | RegExp): Promise<Item[]> {
    const found = await this.page.query(role, name, await this.target());
    return found.map((_, index) => new Item(this.page, this, role, name, index));
  }

  find(role: string, name?: string | RegExp): Promise<Item> {
    return waitFor(`there must be an element ${this.label} → ${describe(role, name)}`, async () => (await this.all(role, name))[0]);
  }

  async names(role: string): Promise<string[]> {
    return (await this.page.query(role, undefined, await this.target())).map(nameOf);
  }
}

/** A page failure the user might not have noticed: a script exception, a console error or an API error. */
export interface PageProblem {
  kind: "exception" | "console" | "server response";
  text: string;
}

export class Page implements Scope {
  /** Failures since the last `takeProblems` call. */
  private problems: PageProblem[] = [];

  constructor(
    private readonly connection: Connection,
    readonly targetId: string,
    private readonly sessionId: string,
  ) {}

  send<T>(method: string, params: Params = {}): Promise<T> {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  record(problem: PageProblem): void {
    this.problems.push(problem);
  }

  /** Returns the accumulated page failures and forgets them. */
  takeProblems(): PageProblem[] {
    return this.problems.splice(0);
  }

  async goto(url: string): Promise<void> {
    const { errorText } = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (errorText) throw new Error(`Page ${url} did not open: ${errorText}`);
  }

  /** An expression in the page; the result is returned as a value. */
  async evaluate<T>(expression: string): Promise<T> {
    const { result } = await this.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true });
    return result.value;
  }

  /** Makes the tab active: only an active page considers itself visible. */
  async activate(): Promise<void> {
    await this.send("Page.bringToFront");
  }

  /** Waits for an address matching the condition. */
  async waitForUrl(expectation: string, matches: (url: URL) => boolean): Promise<void> {
    let seen = "";
    try {
      await waitFor(expectation, async () => (matches(new URL((seen = await this.evaluate<string>("location.href")))) ? true : undefined));
    } catch {
      throw new Error(`page address: expected ${expectation}, the browser has ${seen}`);
    }
  }

  /** Accessibility tree nodes with a role (and name) under the root `root`; without it, in the whole document. */
  async query(role: string, name?: string | RegExp, root?: Params): Promise<AxNode[]> {
    const scope = root ?? { objectId: (await this.send<{ result: { objectId: string } }>("Runtime.evaluate", { expression: "document" })).result.objectId };
    const { nodes } = await this.send<{ nodes: AxNode[] }>("Accessibility.queryAXTree", { ...scope, role, ...(typeof name === "string" ? { accessibleName: name } : {}) });
    return nodes.filter((node) => !node.ignored && node.backendDOMNodeId !== undefined && (!(name instanceof RegExp) || name.test(nameOf(node))));
  }

  async all(role: string, name?: string | RegExp): Promise<Item[]> {
    return (await this.query(role, name)).map((_, index) => new Item(this, null, role, name, index));
  }

  find(role: string, name?: string | RegExp): Promise<Item> {
    return waitFor(`there must be an element ${describe(role, name)}`, async () => (await this.all(role, name))[0]);
  }

  async names(role: string): Promise<string[]> {
    return (await this.query(role)).map(nameOf);
  }

  /** Waits until there is no element with the role and name. */
  async gone(role: string, name?: string | RegExp): Promise<void> {
    await waitFor(`there must be no element ${describe(role, name)}`, async () => ((await this.query(role, name)).length === 0 ? true : undefined));
  }
}

// ── Browser ─────────────────────────────────────────────────────────────────────────────────

export interface Browser {
  /** The first tab. */
  page(): Promise<Page>;
  /** Waits for a tab opened by the page after the `opened` call (a link with target="_blank"). */
  newPage(opened: () => Promise<void>): Promise<Page>;
  closePage(page: Page): Promise<void>;
  close(): Promise<void>;
}

interface TargetInfo {
  targetId: string;
  type: string;
}

/** Launches Chrome headless with a separate profile in `profileDir`. */
export async function launchBrowser(chromePath: string, profileDir: string): Promise<Browser> {
  const proc = Bun.spawn(
    [chromePath, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,1000", "about:blank"],
    { stdout: "ignore", stderr: "pipe" },
  );
  const quit = async (): Promise<void> => {
    proc.kill();
    await proc.exited;
  };

  try {
    const connection = await Connection.open(await debuggerUrl(proc.stderr));
    const attached = new Map<string, Page>();

    const attach = async (targetId: string): Promise<Page> => {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      const page = new Page(connection, targetId, sessionId);
      attached.set(sessionId, page);
      // Page exceptions and console, server responses: page failures are put together from them.
      for (const domain of ["Runtime", "Network"]) await page.send(`${domain}.enable`);
      return page;
    };

    connection.on("Runtime.exceptionThrown", (params, sessionId) => {
      const details = params.exceptionDetails as { text: string; exception?: { description?: string } };
      attached.get(sessionId ?? "")?.record({ kind: "exception", text: details.exception?.description ?? details.text });
    });
    connection.on("Runtime.consoleAPICalled", (params, sessionId) => {
      if (params.type !== "error") return;
      const args = params.args as { value?: unknown; description?: string }[];
      attached.get(sessionId ?? "")?.record({ kind: "console", text: args.map((arg) => arg.description ?? String(arg.value)).join(" ") });
    });
    connection.on("Network.responseReceived", (params, sessionId) => {
      const { status, url } = params.response as { status: number; url: string };
      // API only: the tab icon and other optional files are requested by the browser itself.
      if (status >= 400 && new URL(url).pathname.startsWith("/api/")) attached.get(sessionId ?? "")?.record({ kind: "server response", text: `${status} ${url}` });
    });

    const created: string[] = [];
    connection.on("Target.targetCreated", (params) => {
      const info = params.targetInfo as TargetInfo;
      if (info.type === "page") created.push(info.targetId);
    });

    const { targetInfos } = await connection.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    const first = targetInfos.find((info) => info.type === "page");
    if (!first) throw new Error("Chrome started without a tab");
    await connection.send("Target.setDiscoverTargets", { discover: true });
    const known = new Set([first.targetId]);

    return {
      page: () => attach(first.targetId),
      async newPage(opened) {
        await opened();
        const targetId = await waitFor("a new tab must open", async () => created.find((id) => !known.has(id)));
        known.add(targetId);
        return attach(targetId);
      },
      async closePage(page) {
        await connection.send("Target.closeTarget", { targetId: page.targetId });
      },
      async close() {
        // Chrome closes itself and finishes writing the profile; the signal is for the case it did not respond.
        await connection.send("Browser.close").catch(() => {});
        connection.close();
        await quit();
      },
    };
  } catch (error) {
    await quit();
    throw error;
  }
}

/** Debug address from the line "DevTools listening on ws://…" that Chrome prints on startup. */
async function debuggerUrl(stderr: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let printed = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Chrome did not open the debug port within ${CHROME_START_MS / 1000} s:\n${printed}`)), CHROME_START_MS);
  });
  const read = async (): Promise<string> => {
    for await (const chunk of stderr) {
      printed += decoder.decode(chunk, { stream: true });
      const url = /DevTools listening on (ws:\/\/\S+)/.exec(printed)?.[1];
      if (url) return url;
    }
    throw new Error(`Chrome exited without opening the debug port:\n${printed}`);
  };
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
