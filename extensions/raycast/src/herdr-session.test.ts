import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { HcConversation } from "./herdr-conversation.js";
import { safeMarkdown } from "./core.js";
import { messageMarkdown } from "./message-format.js";
import { HcError, hcImageAgent, hcProgramFingerprint, hcTargetKey, type HcTarget, type HcTerminal } from "./herdr.js";
import { literal } from "./interaction-format.js";
import { imageAttachmentSchema, type ImageUpload } from "./protocol.js";
import type { HcLocalState as LocalState, HcScreen } from "./herdr-session.js";

const source = ts.createSourceFile(
  "herdr-session.tsx",
  readFileSync(new URL("./herdr-session.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function logic(names: string[], globals: Record<string, unknown> = {}) {
  const declarations = source.statements.filter(
    (node) =>
      ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.includes(node.name?.text || "")) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && names.includes(item.name.text))),
  );
  assert.equal(declarations.length, names.length, `Missing production declarations: ${names.join(", ")}`);
  return runInNewContext(
    ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
        jsx: ts.JsxEmit.React,
        jsxFactory: "element",
        jsxFragmentFactory: "Fragment",
      },
    }).outputText + `\n({${names.join(",")}})`,
    {
      exports: {},
      Error,
      createHash,
      randomUUID,
      HcError,
      hcImageAgent,
      imageAttachmentSchema,
      hcProgramFingerprint,
      hcTargetKey,
      stripVTControlCharacters,
      literal,
      ...globals,
    },
  );
}
const helpers = logic([
  "sanitizeTerminalText",
  "hcScreenFingerprint",
  "hcReportedReady",
  "hcStatus",
  "hcKeyToken",
  "hcScreenMarkdown",
]);
const target: HcTarget = {
  kind: "hc",
  socketPath: "/private/hc.sock",
  hostCoreId: "host",
  coreId: "remote",
  terminalId: "t1",
};
const terminal = (patch: Partial<HcTerminal> = {}): HcTerminal => ({
  address: "remote/t1",
  labels: {},
  argv: ["agent"],
  cwd: "/work",
  state: "running",
  pid: 100,
  created_ms: 1,
  reported: true,
  status: { state: "blocked", title: "Permission" },
  ...patch,
});
const screen = (patch: Partial<HcScreen> = {}): HcScreen => ({
  terminal: terminal(),
  capture: { text: "Allow read?\n1. Allow\n2. Deny", complete: true, how: "screen" },
  capturedAt: 1,
  event: 0,
  stable: true,
  ...patch,
});
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    async getItem(key: string) {
      return data.get(key);
    },
    async setItem(key: string, value: string) {
      data.set(key, value);
    },
    async removeItem(key: string) {
      data.delete(key);
    },
  };
}
const localLogic = logic(["hcOperationLocks", "hcDraftWrites", "MAX_INPUT", "HcLocalState"]);
function local(key: string, store: ReturnType<typeof storage>): LocalState {
  return new localLogic.HcLocalState(key, store);
}

test("screen reviews bind full raw capture, status, process and lifecycle, not capture time", () => {
  const original = screen(),
    fingerprint = helpers.hcScreenFingerprint(original);
  assert.equal(helpers.hcScreenFingerprint({ ...original, capturedAt: 99 }), fingerprint);
  for (const changed of [
    screen({ capture: { ...original.capture, text: "Different prompt" } }),
    screen({ capture: { ...original.capture, complete: false } }),
    screen({ terminal: terminal({ pid: 101 }) }),
    screen({ terminal: terminal({ foreground: { pid: 12, name: "sh", argv: ["sh"], cwd: "/" } }) }),
    screen({ terminal: terminal({ status: { state: "idle" } }) }),
    screen({ terminal: terminal({ status_ms: 20 }) }),
    screen({ terminal: terminal({ turn: 2 }) }),
    screen({ event: 1 }),
    screen({ stable: false }),
  ])
    assert.notEqual(helpers.hcScreenFingerprint(changed), fingerprint);
  assert.equal(helpers.hcReportedReady(terminal({ status: { state: "idle" } })), true);
  for (const reported of [undefined, false]) {
    assert.equal(helpers.hcReportedReady(terminal({ status: { state: "idle" }, reported })), false);
    assert.match(helpers.hcStatus(terminal({ status: { state: "idle" }, reported })), /Unknown/);
  }
});

test("keys are explicit single HC tokens; uppercase preserves Shift and no implicit Enter", () => {
  for (const value of [
    "up",
    "down",
    "tab",
    "shift+tab",
    "enter",
    "esc",
    "a",
    "7",
    "ctrl+c",
    "f12",
    "shift+super+a",
    "[",
    "\\",
    ",",
    "=",
    "shift+1",
    "shift+8",
  ])
    assert.equal(helpers.hcKeyToken(value), value);
  assert.equal(helpers.hcKeyToken("Y"), "shift+y");
  assert.equal(helpers.hcKeyToken("cmd+Y"), "shift+super+y");
  assert.equal(helpers.hcKeyToken("return"), "enter");
  for (const value of [
    "",
    " ",
    "allow",
    "down enter",
    "down,enter",
    "down+enter",
    "ctrl++",
    "f13",
    "a\n",
    "shift+shift+a",
    "CTRL+c",
    "🙂",
    "*",
    "!",
    "?",
    "@",
    "_",
    "|",
    ":",
    "~",
    "+",
    "{",
    "}",
  ])
    assert.throws(() => helpers.hcKeyToken(value));
});

test("terminal output removes VT and C0 but preserves Unicode, tabs and literal malicious Markdown", () => {
  const raw =
    "\x1b[31m你好\x1b[0m\t🙂\r\n\x00\x07\x08\x1b]8;;https://evil.test\x07LINK\x1b]8;;\x07\n````\n![x](https://evil.test/a)\n<script>bad</script>";
  const text = helpers.sanitizeTerminalText(raw);
  assert.match(text, /你好\t🙂\nLINK/);
  for (const code of [27, 0, 7, 8]) assert.equal(text.includes(String.fromCharCode(code)), false);
  const result = helpers.hcScreenMarkdown(
    screen({ capture: { text: raw, complete: false, how: "screen", why: "Only visible rows" } }),
  );
  assert.ok(result.includes("`````\n" + text + "\n`````"));
  assert.match(result, /Incomplete capture/);
  assert.match(result, /Only visible rows/);
  assert.doesNotMatch(result, /no selected option is inferred/);
  assert.match(helpers.hcScreenMarkdown(screen(), "Current Terminal Dialog"), /no selected option is inferred/);
});

test("HC draft kinds and core identities are isolated; delayed success cannot erase newer edit", async () => {
  const store = storage(),
    a = local("a", store),
    b = local("b", store);
  a.change("task", "not loaded");
  assert.equal(store.data.size, 0);
  await Promise.all([a.load(), b.load()]);
  a.change("task", "original");
  a.change("answer", "dialog answer");
  b.change("task", "other core");
  const response = deferred<void>();
  const sending = a.run(
    "task",
    "original",
    async () => true,
    () => response.promise,
    () => true,
  );
  await settle();
  assert.ok(store.data.has(a.attemptKey), "durable marker exists before network completion");
  a.change("task", "newer edit");
  response.resolve();
  await sending;
  assert.equal(a.drafts.task, "newer edit");
  assert.equal(a.drafts.answer, "dialog answer");
  const reopened = local("a", store);
  await reopened.load();
  assert.equal(reopened.drafts.task, "newer edit");
  assert.equal(reopened.attempt, undefined);
  assert.equal(b.drafts.task, "other core");
});

test("all HC operations synchronously lock a target, including acknowledgment across two views", async () => {
  const store = storage(),
    a = local("serial", store),
    b = local("serial", store);
  await Promise.all([a.load(), b.load()]);
  const response = deferred<void>();
  let requests = 0;
  const first = a.run(
    "key",
    "down",
    async () => true,
    () => {
      requests++;
      return response.promise;
    },
    () => true,
  );
  await assert.rejects(
    b.run(
      "interrupt",
      undefined,
      async () => true,
      async () => {
        requests++;
      },
      () => true,
    ),
    /Another terminal operation/,
  );
  await assert.rejects(b.acknowledge(), /Wait for the current operation/);
  await settle();
  assert.equal(requests, 1);
  response.resolve();
  await first;
  assert.equal(a.attempt, undefined);
});

test("possibly-sent errors retain journal and drafts through reopening; acknowledgment never replays", async () => {
  const store = storage(),
    a = local("uncertain", store);
  await a.load();
  a.change("answer", "yes");
  let requests = 0;
  await assert.rejects(
    a.run(
      "answer",
      "yes",
      async () => true,
      async () => {
        requests++;
        throw new Error("timeout");
      },
      () => true,
    ),
    /Delivery is uncertain/,
  );
  assert.equal(a.drafts.answer, "yes");
  assert.ok(store.data.has(a.attemptKey));
  const reopened = local("uncertain", store);
  await reopened.load();
  await assert.rejects(
    reopened.run(
      "answer",
      "yes",
      async () => true,
      async () => {
        requests++;
      },
      () => true,
    ),
    /Previous input/,
  );
  assert.equal(requests, 1);
  await reopened.acknowledge();
  assert.equal(requests, 1);
  assert.equal(reopened.attempt, undefined);
  assert.equal(reopened.drafts.answer, "yes");
});

test("preflight/storage failures and leaving before I/O send nothing; pending journal failure cannot unlock", async () => {
  const store = storage(),
    a = local("preflight", store);
  await a.load();
  let requests = 0;
  const request = async () => {
    requests++;
  };
  assert.equal(
    (
      await a.run(
        "key",
        "enter",
        async () => false,
        request,
        () => true,
      )
    ).sent,
    false,
  );
  assert.equal(store.data.has(a.attemptKey), false);
  const check = deferred<boolean>();
  let active = true;
  const sending = a.run(
    "key",
    "enter",
    () => check.promise,
    request,
    () => active,
  );
  active = false;
  check.resolve(true);
  await sending;
  assert.equal(requests, 0);
  const failing = storage();
  failing.setItem = async () => {
    throw new Error("disk full");
  };
  const b = local("disk", failing);
  await b.load();
  await assert.rejects(
    b.run(
      "key",
      "enter",
      async () => true,
      request,
      () => true,
    ),
    /disk full/,
  );
  assert.equal(requests, 0);
  const draftFail = local("draft-disk", failing);
  await draftFail.load();
  draftFail.change("task", "keep");
  await assert.rejects(
    draftFail.run(
      "task",
      "keep",
      async () => true,
      request,
      () => true,
    ),
    /disk full/,
  );
  assert.equal(requests, 0);
});

type View = { type: unknown; props: Record<string, any> };
function views(value: any): View[] {
  if (Array.isArray(value)) return value.flatMap(views);
  if (!value || typeof value !== "object" || !value.props) return [];
  return [value, ...views(value.props.children), ...views(value.props.actions)];
}
function componentHarness(names: string[], globals: Record<string, unknown>) {
  const states: any[] = [],
    refs: any[] = [],
    effects: Array<{ run: () => void | (() => void); deps?: any[]; cleanup?: () => void }> = [],
    scheduled: number[] = [];
  let cursor = 0,
    refCursor = 0,
    effectCursor = 0;
  const member = (name: string) => ({ name });
  const Metadata = Object.assign(member("Metadata"), { Label: "Label" });
  const context = {
    ...helpers,
    ...localLogic,
    HcConversation,
    safeMarkdown,
    messageMarkdown,
    ...logic(["hcMessageMarkdown"], {
      safeMarkdown,
      messageMarkdown,
      sanitizeTerminalText: helpers.sanitizeTerminalText,
    }),
    element: (type: unknown, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    Fragment: "Fragment",
    Action: Object.assign(member("Action"), {
      Push: "Push",
      SubmitForm: "SubmitForm",
      CopyToClipboard: "Copy",
      Style: {},
    }),
    ActionPanel: "ActionPanel",
    List: Object.assign(member("List"), {
      Section: "Section",
      Item: Object.assign(member("Item"), { Detail: Object.assign(member("ItemDetail"), { Metadata }) }),
    }),
    Form: Object.assign(member("Form"), { TextField: "TextField", Description: "Description" }),
    Detail: "Detail",
    HcCompose: "HcCompose",
    ImageActions: "ImageActions",
    ImageAccessory: "ImageAccessory",
    CustomKey: "CustomKey",
    Icon: {},
    Color: {},
    Alert: { ActionStyle: {} },
    Toast: { Style: {} },
    Keyboard: { Shortcut: { Common: { New: {}, Refresh: {} } } },
    showToast: async () => {},
    confirmAlert: async () => true,
    openHerdr: async () => {},
    useState(initial: any) {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [
        states[i],
        (v: any) => {
          states[i] = typeof v === "function" ? v(states[i]) : v;
        },
      ];
    },
    useRef(initial: any) {
      const i = refCursor++;
      return refs[i] ?? (refs[i] = { current: initial });
    },
    useEffect(run: () => void, deps?: any[]) {
      const i = effectCursor++,
        prior = effects[i];
      if (!prior || !deps || deps.some((d, j) => d !== prior.deps?.[j])) {
        effects[i] = { run, deps, cleanup: prior?.cleanup };
        scheduled.push(i);
      }
    },
    ...globals,
  };
  const production = logic(names, context);
  return {
    production,
    context,
    render(name: string, ...args: any[]) {
      cursor = 0;
      refCursor = 0;
      effectCursor = 0;
      return production[name](...args);
    },
    flush() {
      for (const i of scheduled.splice(0)) {
        effects[i]!.cleanup?.();
        effects[i]!.cleanup = effects[i]!.run() || undefined;
      }
    },
    cleanup() {
      effects.forEach((e) => e.cleanup?.());
    },
  };
}
function viewHarness(initial: HcScreen = screen(), onAllSessions?: (onPop?: () => void) => void, captureId?: string) {
  const store = storage();
  const requests: Array<{ method: string; params: any }> = [];
  const toasts: Array<{ title: string; message?: string }> = [];
  const confirmations = { result: true, calls: [] as Array<{ title: string }> };
  const feed = {
    screen: initial,
    latest: { current: initial },
    pin: { current: hcProgramFingerprint(initial.terminal) },
    mounted: { current: true },
    invalidRef: { current: undefined as string | undefined },
    client: {
      current: {
        methods: new Set(["terminal.put"]),
        async put(_target: HcTarget, image: ImageUpload) {
          requests.push({
            method: "terminal.put",
            params: { terminal: `${_target.coreId}/${_target.terminalId}`, name: image.name, data: image.data },
          });
          return { path: "/agent-machine/attachments/image.png", bytes: image.size };
        },
        async request(method: string, params: any) {
          requests.push({ method, params });
          return { status: "blocked", turn: 1, outcome: "still_working", key: "ctrl+c" };
        },
      },
    },
    loading: false,
    observing: { current: true },
    refresh: async () => feed.latest.current,
    visible: true,
  };
  let child: View | undefined;
  const children: View[] = [];
  const images = new Map<string, ImageUpload>();
  const released: string[] = [];
  const h = componentHarness(["keyRows", "HcSessionView"], {
    useHcScreen: (_target: HcTarget, visible: boolean) => {
      feed.visible = visible;
      return feed;
    },
    LocalStorage: store,
    readImage: async (id: string) => {
      const image = images.get(id);
      if (!image) throw new Error("Image missing or unreadable. Nothing was sent.");
      return image;
    },
    getImage: async (id: string) => {
      const image = images.get(id);
      if (!image) throw new Error("Image missing or unreadable. Nothing was sent.");
      return { ...imageMetadata(image), id, path: `/private/mac-cache/${id}.png` };
    },
    releaseImage: async (id: string) => {
      released.push(id);
    },
    showToast: async (toast: { title: string; message?: string }) => {
      toasts.push(toast);
    },
    confirmAlert: async (alert: { title: string }) => {
      confirmations.calls.push(alert);
      return confirmations.result;
    },
    useNavigation: () => ({
      push(view: View) {
        child = view;
        children.push(view);
      },
    }),
  });
  const render = () => {
    const view = h.render("HcSessionView", { target, onAllSessions, captureId, reopen() {} });
    h.flush();
    return view;
  };
  const action = (title: string) => {
    const action = views(render()).find((v) => v.props.title === title && typeof v.props.onAction === "function");
    assert.ok(action, `Action ${title}`);
    return action.props.onAction();
  };
  return {
    ...h,
    feed,
    store,
    requests,
    toasts,
    confirmations,
    images,
    released,
    children,
    render,
    action,
    child: () => child,
  };
}

test("real HC view defaults to refresh, sends one explicit key, and changed screen requires another activation", async () => {
  const h = viewHarness();
  h.render();
  h.flush();
  await settle();
  await h.action("Review Current Prompt");
  const view = h.render();
  assert.equal(view.props.selectedItemId, "review-screen");
  const screenRow = views(view).find((v) => v.props.id === "review-screen")!;
  assert.equal(views(screenRow.props.actions).find((v) => v.props.onAction)?.props.title, "Refresh Current Screen");
  const changed = screen({ capture: { text: "New dialog", complete: true, how: "screen" } });
  h.feed.latest.current = changed;
  h.feed.screen = changed;
  await h.action("Send Enter");
  assert.equal(h.requests.length, 0);
  await h.action("Send Enter");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.method, "terminal.keys");
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0]!.params)), { terminal: "remote/t1", keys: ["enter"] });
  assert.doesNotMatch(
    views(h.render())
      .map((v) => v.props.markdown || "")
      .join("\n"),
    /approved|approval resolved/i,
  );
});

test("real HC view ordinary sends are idle-conditioned; prompt response requires separate full-screen text review", async () => {
  const idle = screen({ terminal: terminal({ status: { state: "idle" } }) });
  const h = viewHarness(idle);
  let view = h.render();
  h.flush();
  await settle();
  view = h.render();
  view.props.onSearchTextChange("task");
  await settle();
  await h.action("Send Message");
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0]!.params)), {
    terminal: "remote/t1",
    text: "task",
    force: false,
    if: "idle",
    wait: false,
  });
  h.feed.latest.current = screen();
  h.feed.screen = screen();
  await h.action("Respond to Current Prompt");
  const child = h.child()!;
  assert.equal(child.props.title, "Respond to Current Prompt");
  child.props.change("my answer");
  await child.props.send("my answer", () => true);
  assert.equal(h.requests.length, 1, "form prepares review, never sends force input");
  view = h.render();
  assert.equal(view.props.selectedItemId, "submit-text");
  const answerRow = views(view).find((v) => v.props.id === "submit-text")!;
  const detail = views(answerRow.props.detail).find((v) => v.props.markdown)!;
  assert.match(detail.props.markdown, /my answer/);
  assert.match(detail.props.markdown, /Allow read/);
  await h.action("Submit Response to This Dialog");
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[1]!.params)), {
    terminal: "remote/t1",
    text: "my answer",
    force: true,
    wait: false,
  });
});

test("real HC view blocked task routes into Raycast controls without sending; stale program disables review", async () => {
  const h = viewHarness();
  h.render();
  h.flush();
  await settle();
  await h.action("Compose Message");
  const child = h.child()!;
  child.props.change("future task");
  assert.equal(
    await child.props.send("future task", () => true),
    true,
    "composer closes into in-Raycast control review",
  );
  assert.equal(h.requests.length, 0);
  assert.equal(h.render().props.selectedItemId, "review-screen");
  h.feed.invalidRef.current = "Shell replaced the Agent";
  await h.action("Send Enter");
  assert.equal(h.requests.length, 0);
});

test("real HC view checks child lifetime after preflight and does not send abandoned compose input", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "idle" } }) }));
  h.render();
  h.flush();
  await settle();
  await h.action("Compose Message");
  const child = h.child()!;
  child.props.change("don't send");
  const pending = deferred<HcScreen>();
  h.feed.refresh = () => pending.promise;
  let active = true;
  const sending = child.props.send("don't send", () => active);
  await settle();
  active = false;
  pending.resolve(h.feed.latest.current);
  await sending;
  assert.equal(h.requests.length, 0);
});

test("real screen hook coalesces selected-view reads, stops polling when covered and invalidates shell/disconnect", async () => {
  let change!: (event?: { type: string; terminal?: string }) => void, disconnect!: () => void;
  let current = terminal(),
    reading = 0,
    maxReading = 0,
    count = 0,
    closed = 0,
    stopped = 0;
  let waiting: ReturnType<typeof deferred<{ text: string; complete: boolean; how: string }>> | undefined;
  const timers = new Map<number, () => Promise<void>>();
  let timer = 0;
  const client = {
    core: { id: "host", name: "Host" },
    async get() {
      return current;
    },
    async read(_target: HcTarget, lines: number) {
      assert.equal(lines, 0);
      reading++;
      count++;
      maxReading = Math.max(maxReading, reading);
      try {
        return waiting ? await waiting.promise : { text: "screen", complete: true, how: "screen" };
      } finally {
        reading--;
      }
    },
    async observe(a: typeof change, b: typeof disconnect) {
      change = a;
      disconnect = b;
      return () => {
        stopped++;
      };
    },
    close() {
      closed++;
    },
  };
  const h = componentHarness(["useHcScreen"], {
    HcClient: { connect: async () => client },
    setTimeout(fn: () => Promise<void>) {
      const id = ++timer;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  h.render("useHcScreen", target, true);
  h.flush();
  await settle();
  let feed = h.render("useHcScreen", target, true);
  assert.equal(feed.pin.current, hcProgramFingerprint(current));
  waiting = deferred();
  const first = feed.refresh();
  const second = feed.refresh();
  await settle();
  assert.equal(reading, 1);
  waiting.resolve({ text: "new screen", complete: true, how: "screen" });
  await Promise.all([first, second]);
  assert.equal(maxReading, 1);
  waiting = undefined;
  const before = count;
  h.render("useHcScreen", target, false);
  for (const [id, fn] of [...timers]) {
    timers.delete(id);
    await fn();
  }
  assert.equal(count, before, "covered view does not auto-read");
  change({ type: "status", terminal: "remote/t1" });
  await settle();
  assert.equal(count, before, "covered view events do not issue reads");
  localLogic.hcOperationLocks.add(hcTargetKey(target));
  h.render("useHcScreen", target, true);
  change({ type: "status", terminal: "remote/t1" });
  for (const [id, fn] of [...timers]) {
    timers.delete(id);
    await fn();
  }
  await settle();
  assert.equal(count, before, "locked mutation suppresses polling and event reads before React rerenders");
  localLogic.hcOperationLocks.delete(hcTargetKey(target));
  h.render("useHcScreen", target, true);
  change({ type: "status", terminal: "other/t1" });
  await settle();
  assert.equal(count, before);
  current = terminal({ foreground: { pid: 999, name: "sh", argv: ["sh"], cwd: "/" } });
  await feed.refresh();
  feed = h.render("useHcScreen", target, true);
  assert.match(feed.invalid, /program changed/);
  disconnect();
  assert.equal(feed.client.current, undefined);
  h.cleanup();
  assert.equal(timers.size, 0);
  assert.equal(stopped, 1);
  assert.ok(closed >= 1);
});

test("real HC view unknown status requires explicit reviewed terminal input without force or idle fiction", async () => {
  const h = viewHarness(screen({ terminal: terminal({ reported: false, status: undefined }) }));
  h.render();
  h.flush();
  await settle();
  await h.action("Review Unreported Terminal Input");
  const child = h.child()!;
  child.props.change("echo hello");
  await child.props.send("echo hello", () => true);
  assert.equal(h.requests.length, 0);
  await h.action("Submit Reviewed Terminal Input");
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0]!.params)), {
    terminal: "remote/t1",
    text: "echo hello",
    force: false,
    wait: false,
  });
  assert.equal(Object.hasOwn(h.requests[0]!.params, "if"), false);
});

test("real HC view uncertain acknowledgment first displays inspected output, never replays input", async () => {
  const h = viewHarness();
  const attemptKey = `hc-attempt-v1:${hcTargetKey(target)}`;
  h.store.data.set(attemptKey, JSON.stringify({ id: "unknown-attempt", kind: "answer", text: "maybe sent", at: 1 }));
  h.render();
  h.flush();
  await settle();
  await h.action("Acknowledge Uncertain Input…");
  assert.ok(h.store.data.has(attemptKey), "first activation only reveals latest screen");
  assert.equal(h.render().props.selectedItemId, "screen");
  h.feed.latest.current = screen({ capture: { text: "Now another output", complete: true, how: "screen" } });
  h.feed.screen = h.feed.latest.current;
  await h.action("Acknowledge Uncertain Input…");
  assert.ok(h.store.data.has(attemptKey), "changed output requires inspection again");
  await h.action("Acknowledge Uncertain Input…");
  assert.equal(h.store.data.has(attemptKey), false);
  assert.equal(h.requests.length, 0);
});

test("journal cleanup failure preserves text, stays locked and restores text when reopened", async () => {
  const store = storage(),
    a = local("cleanup", store);
  await a.load();
  a.change("task", "original");
  store.removeItem = async () => {
    throw new Error("cannot remove marker");
  };
  await assert.rejects(
    a.run(
      "task",
      "original",
      async () => true,
      async () => {},
      () => true,
    ),
    /uncertain/,
  );
  assert.equal(a.drafts.task, "original");
  assert.ok(a.attempt);
  const reopened = local("cleanup", store);
  await reopened.load();
  assert.equal(reopened.drafts.task, "original");
  assert.ok(reopened.attempt);
});

test("real HC view distinguishes an in-flight journal from delivery uncertainty", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "idle" } }) }));
  h.render();
  h.flush();
  await settle();
  h.render().props.onSearchTextChange("task");
  await settle();
  const pending = deferred<any>();
  h.feed.client.current.request = async () => pending.promise;
  const sending = h.action("Send Message");
  await settle();
  let journal = views(h.render()).find((v) => v.props.id === "uncertain")!;
  assert.equal(h.feed.visible, false, "automatic screen reads pause during terminal mutation");
  assert.equal(journal.props.title, "Submitting Terminal Input");
  assert.equal(journal.props.subtitle, "Waiting for HC response · No automatic retry");
  let reads = 0;
  h.feed.refresh = async () => {
    reads++;
    return h.feed.latest.current;
  };
  await h.action("Refresh Current Screen");
  await h.action("Inspect Latest Output");
  assert.equal(reads, 0, "manual actions cannot queue reads behind HC's serial mutation");
  assert.ok(
    views(h.render()).some((v) => v.props.id === "screen"),
    "cached terminal screen stays available",
  );
  pending.reject(new Error("timeout"));
  await sending;
  journal = views(h.render()).find((v) => v.props.id === "uncertain")!;
  assert.equal(h.feed.visible, true, "screen polling resumes after mutation settles");
  assert.equal(journal.props.title, "Input Result Uncertain");
  assert.equal(journal.props.subtitle, "Inspect output before unlocking");
});

test("ordinary output keeps metadata in inspection while dialog controls retain compact context", async () => {
  const h = viewHarness();
  h.render();
  h.flush();
  await settle();
  const view = h.render(),
    row = views(view).find((v) => v.props.id === "screen")!;
  assert.equal(row.props.detail.props.metadata, undefined);
  const identity = views(row.props.actions).find((v) => v.props.title === "Terminal Identity")!;
  assert.equal(identity.type, "Push");
  assert.match(identity.props.target.props.markdown, /remote\/t1/);
  assert.match(identity.props.target.props.markdown, /Host Core: host/);
  assert.match(identity.props.target.props.markdown, /Directory: \/work/);
  await h.action("Review Current Prompt");
  const review = views(h.render()).find((v) => v.props.id === "review-screen")!;
  assert.deepEqual(
    views(review.props.detail.props.metadata)
      .filter((v) => v.type === "Label")
      .map((v) => v.props.title),
    ["State", "Connection", "Machine"],
  );
  for (const keyRow of views(h.render()).filter((v) => v.props.id?.startsWith("key:")))
    assert.equal(keyRow.props.subtitle, undefined);
});

test("stale acknowledgment cannot delete a newer uncertain attempt or allow replay", async () => {
  const store = storage(),
    a = local("stale-ack", store);
  await a.load();
  let requests = 0;
  const fail = async () => {
    requests++;
    throw new Error("timeout");
  };
  await assert.rejects(
    a.run(
      "answer",
      "X",
      async () => true,
      fail,
      () => true,
    ),
    /uncertain/,
  );
  const firstId = a.attempt!.id,
    b = local("stale-ack", store);
  await b.load();
  await b.acknowledge();
  await assert.rejects(
    b.run(
      "answer",
      "Y",
      async () => true,
      fail,
      () => true,
    ),
    /uncertain/,
  );
  const secondId = b.attempt!.id;
  assert.notEqual(firstId, secondId);
  await assert.rejects(a.acknowledge(), /different input attempt/);
  assert.equal(JSON.parse(store.data.get(a.attemptKey)!).id, secondId);
  assert.equal(a.attempt!.id, secondId, "stale view refreshes from durable journal");
  await assert.rejects(
    a.run(
      "answer",
      "X",
      async () => true,
      fail,
      () => true,
    ),
    /Previous input/,
  );
  assert.equal(requests, 2, "neither acknowledgment nor stale run sends again");
});

test("All Sessions navigation pauses HC output polling until the pushed list is popped", async () => {
  let resume: (() => void) | undefined;
  const h = viewHarness(screen(), (onPop) => {
    resume = onPop;
  });
  h.render();
  h.flush();
  await settle();
  assert.equal(h.feed.visible, true);
  await h.action("All Sessions");
  h.render();
  assert.equal(h.feed.visible, false);
  assert.ok(resume);
  resume();
  h.render();
  assert.equal(h.feed.visible, true);
});

test("ordinary messages continue across idle, working and done turns with supported fresh status conditions", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "idle" } }) }));
  h.render();
  h.flush();
  await settle();
  for (const state of ["idle", "done", "done"] as const) {
    const next = screen({ terminal: terminal({ status: { state }, turn: h.requests.length }) });
    h.feed.latest.current = next;
    h.feed.screen = next;
    h.render().props.onSearchTextChange(`message ${h.requests.length + 1}`);
    await settle();
    await h.action("Send Message");
    assert.equal(h.requests.at(-1)!.params.if, state === "idle" ? "idle" : undefined);
    assert.equal(h.requests.at(-1)!.params.force, false);
    assert.equal(h.render().props.searchText, "", "successful message clears only its submitted draft");
    assert.equal(
      [...h.store.data.keys()].some((key) => key.startsWith("hc-attempt-v1:")),
      false,
    );
    const working = screen({ terminal: terminal({ status: { state: "working" } }) });
    h.feed.latest.current = working;
    h.feed.screen = working;
    h.render().props.onSearchTextChange("next draft while working");
    await settle();
    assert.ok(
      !views(h.render()).some((v) => v.props.title === "Send Message"),
      "working never exposes ordinary terminal send",
    );
  }
  assert.equal(h.requests.length, 3, "every explicit message sent once without a forced dialog path");
});

test("send checks fresh readiness instead of a stale cached state and does not send an unsupported done condition", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "working" } }) }));
  h.render();
  h.flush();
  await settle();
  await h.action("Compose Message");
  const child = h.child()!;
  assert.equal(child.props.title, "Compose Message");
  const done = screen({ terminal: terminal({ status: { state: "done" } }) });
  h.feed.refresh = async () => (h.feed.latest.current = done);
  child.props.change("follow-up");
  assert.equal(await child.props.send("follow-up", () => true), true);
  assert.equal(h.requests.length, 1);
  assert.equal(Object.hasOwn(h.requests[0]!.params, "if"), false);
  assert.equal(h.requests[0]!.params.force, false);
});

test("working composer keeps the draft without mistaking work for a blocked dialog", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "working" } }) }));
  h.render();
  h.flush();
  await settle();
  await h.action("Compose Message");
  const child = h.child()!;
  child.props.change("keep for later");
  assert.equal(await child.props.send("keep for later", () => true), false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.render().props.selectedItemId, "screen");
  assert.equal(h.render().props.searchText, "keep for later");
});

test("known no-write status rejection preserves draft without leaving a false uncertain-input lock", async () => {
  const store = storage(),
    state = local("status-rejected", store);
  await state.load();
  state.change("task", "keep me");
  await assert.rejects(
    state.run(
      "task",
      "keep me",
      async () => true,
      async () => {
        throw new HcError("changed", "The terminal changed. Nothing was written.");
      },
      () => true,
    ),
    /terminal changed/,
  );
  assert.equal(state.attempt, undefined);
  assert.equal(store.data.has(state.attemptKey), false);
  assert.equal(state.drafts.task, "keep me");
  let writes = 0;
  assert.equal(
    (
      await state.run(
        "task",
        "keep me",
        async () => true,
        async () => ++writes,
        () => true,
      )
    ).sent,
    true,
  );
  assert.equal(writes, 1, "only the later explicit action writes input");
});

test("ordinary send uses a transient confirmation and clears stale notices without covering output", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "working" } }) }));
  h.render();
  h.flush();
  await settle();
  await h.action("Compose Message");
  const child = h.child()!;
  child.props.change("next message");
  assert.equal(await child.props.send("next message", () => true), false);
  const markdown = () =>
    views(h.render())
      .map((v) => v.props.detail?.props.markdown || v.props.markdown || "")
      .join("\n");
  assert.match(markdown(), /Agent is still working/);
  const ready = screen({
    terminal: terminal({ status: { state: "done" } }),
    capture: { text: "Latest Agent answer", complete: true, how: "screen" },
  });
  h.feed.latest.current = ready;
  h.feed.screen = ready;
  await h.action("Send Message");
  assert.equal(h.requests.length, 1);
  assert.match(markdown(), /Latest Agent answer/);
  assert.doesNotMatch(markdown(), /Recent Operation|Message submitted|Agent is still working/);
  assert.equal(h.toasts.at(-1)?.title, "Message Submitted");
});

test("failed ordinary send keeps its persistent notice and uncertain-input safeguard", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "idle" } }) }));
  h.render();
  h.flush();
  await settle();
  h.render().props.onSearchTextChange("keep this draft");
  await settle();
  h.feed.client.current.request = async () => {
    throw new Error("socket disconnected");
  };
  await h.action("Send Message");
  const view = h.render();
  assert.match(
    views(view)
      .map((v) => v.props.detail?.props.markdown || v.props.markdown || "")
      .join("\n"),
    /Recent Operation/,
  );
  assert.ok(views(view).some((v) => v.props.id === "uncertain" && v.props.title === "Input Result Uncertain"));
  assert.equal(view.props.searchText, "keep this draft");
  assert.ok([...h.store.data.keys()].some((key) => key.startsWith("hc-attempt-v1:")));
});

test("ordinary output omits the duplicate heading while dialog review keeps its context", async () => {
  assert.doesNotMatch(helpers.hcScreenMarkdown(), /^# /m);
  assert.match(helpers.hcScreenMarkdown(), /Waiting for a current-screen capture/);
  assert.doesNotMatch(helpers.hcScreenMarkdown(screen()), /^# /m);
  const h = viewHarness();
  h.render();
  h.flush();
  await settle();
  const row = views(h.render()).find((v) => v.props.id === "screen")!;
  assert.equal(row.props.title, "Terminal Output");
  assert.doesNotMatch(row.props.detail.props.markdown, /^# Terminal Output/m);
  assert.match(row.props.detail.props.markdown, /Allow read/);
  await h.action("Review Current Prompt");
  const review = views(h.render()).find((v) => v.props.id === "review-screen")!;
  assert.match(review.props.detail.props.markdown, /^# Current Terminal Dialog/m);
});

test("healthy output is only literal content; exceptional capture warnings stay visible", () => {
  const text = "中文长句保持原换行\n  aligned code\n| A | B |\n| 1 | 2 |";
  assert.equal(helpers.hcScreenMarkdown(screen({ capture: { text, complete: true, how: "screen" } })), literal(text));
  const warning = helpers.hcScreenMarkdown(
    screen({ capture: { text, complete: false, how: "screen", why: "Only visible rows" }, stable: false }),
  );
  assert.match(warning, /Incomplete capture/);
  assert.match(warning, /Only visible rows/);
  assert.match(warning, /State changed during capture/);
  assert.doesNotMatch(warning, /Captured:|Method:|Terminal text is literal/);
});

test("full-width reading shares live output and keeps draft, refresh and reviewed controls", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "done" } }) }));
  h.render();
  h.flush();
  await settle();
  h.render().props.onSearchTextChange("saved draft");
  await settle();
  await h.action("Read Full Width");
  let view = h.render();
  assert.equal(view.type, "Detail");
  assert.equal(view.props.metadata, undefined);
  assert.equal(h.feed.visible, true);
  const next = screen({
    terminal: terminal({ status: { state: "done" } }),
    capture: { text: "Latest wide reply", complete: true, how: "screen" },
  });
  h.feed.screen = next;
  h.feed.latest.current = next;
  assert.equal(h.render().props.markdown, literal("Latest wide reply"));
  await h.action("Back to Split View");
  assert.equal(h.render().props.searchText, "saved draft");
  await h.action("Read Full Width");
  await h.action("Review Terminal Controls");
  view = h.render();
  assert.equal(view.props.selectedItemId, "review-screen");
  assert.match(
    views(view).find((v) => v.props.id === "review-screen")!.props.detail.props.markdown,
    /Current Terminal Dialog/,
  );
  assert.equal(h.requests.length, 0, "reading and navigation send no terminal input");
});

test("full-width reading cannot conceal disconnect or durable uncertain-input state", async () => {
  const h = viewHarness();
  h.render();
  h.flush();
  await settle();
  await h.action("Read Full Width");
  assert.equal(h.render().type, "Detail");
  h.feed.invalidRef.current = "Terminal replaced";
  (h.feed as any).invalid = "Terminal replaced";
  assert.ok(views(h.render()).some((v) => v.props.id === "connection"));
  const locked = viewHarness();
  locked.store.data.set(
    `hc-attempt-v1:${hcTargetKey(target)}`,
    JSON.stringify({ id: "pending", kind: "key", text: "enter", at: 1 }),
  );
  locked.render();
  locked.flush();
  await settle();
  assert.ok(views(locked.render()).some((v) => v.props.id === "uncertain"));
  assert.ok(!views(locked.render()).some((v) => v.props.title === "Read Full Width"));
});

test("HC conversation renders individual Raycast questions and derived replies without importing old screen history", async () => {
  const baseline = screen({
    terminal: terminal({ status: { state: "idle" }, turn: 0 }),
    capture: { text: "old question\nold reply\n", complete: true, how: "screen" },
  });
  const h = viewHarness(baseline);
  h.render();
  await settle();
  h.render().props.onSearchTextChange("first new question");
  await settle();
  await h.action("Send Message");
  const next = screen({
    terminal: terminal({ status: { state: "done" }, turn: 1 }),
    capture: { text: baseline.capture.text + "first new reply", complete: true, how: "screen" },
  });
  h.feed.latest.current = next;
  h.feed.screen = next;
  h.render();
  await settle();
  let view = h.render();
  const replies = views(view).filter((v) => v.props.id?.startsWith("reply:"));
  const users = views(view).filter((v) => v.props.id?.startsWith("user:"));
  assert.equal(replies.length, 1);
  assert.equal(users.length, 1);
  assert.match(users[0]!.props.detail.props.markdown, /first new question/);
  assert.match(replies[0]!.props.detail.props.markdown, /first new reply/);
  assert.doesNotMatch(replies[0]!.props.detail.props.markdown, /old question|old reply/);
  assert.equal(view.props.selectedItemId, replies[0]!.props.id);
  h.render().props.onSearchTextChange("second question");
  await settle();
  await h.action("Send Message");
  const last = screen({
    terminal: terminal({ status: { state: "done" }, turn: 2 }),
    capture: { text: next.capture.text + "\nsecond reply", complete: true, how: "screen" },
  });
  h.feed.latest.current = last;
  h.feed.screen = last;
  h.render();
  await settle();
  view = h.render();
  const rows = views(view).filter((v) => v.props.id?.startsWith("reply:"));
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.props.detail.props.markdown, /second reply/);
  assert.doesNotMatch(rows[0]!.props.detail.props.markdown, /first new reply|old reply/);
  assert.equal(h.requests.length, 2);
  const send = views(rows[0]!.props.actions).find((v) => typeof v.props.onAction === "function");
  assert.equal(send!.props.title, "View Raw Terminal");
  await h.action("View Raw Terminal");
  assert.equal(h.render().props.selectedItemId, "screen");
});

test("HC derived reply full-width view stays per-message and ambiguous output requires raw review", async () => {
  const baseline = screen({
    terminal: terminal({ status: { state: "idle" }, turn: 0 }),
    capture: { text: "old history\n", complete: true, how: "screen" },
  });
  const h = viewHarness(baseline);
  h.render();
  await settle();
  h.render().props.onSearchTextChange("new question");
  await settle();
  await h.action("Send Message");
  const next = screen({
    terminal: terminal({ status: { state: "done" }, turn: 1 }),
    capture: { text: "entirely unrelated redraw", complete: true, how: "screen" },
  });
  h.feed.latest.current = next;
  h.feed.screen = next;
  h.render();
  await settle();
  await h.action("Read Full Width");
  let view = h.render();
  assert.equal(view.type, "Detail");
  assert.match(view.props.markdown, /could not be separated reliably/);
  assert.doesNotMatch(view.props.markdown, /entirely unrelated redraw/);
  await h.action("View Raw Terminal");
  view = h.render();
  assert.equal(view.props.selectedItemId, "screen");
  assert.match(
    views(view).find((v) => v.props.id === "screen")!.props.detail.props.markdown,
    /entirely unrelated redraw/,
  );
  assert.equal(h.requests.length, 1);
});

test("HC history write failure sends nothing and confirmed rejection differs from unknown delivery", async () => {
  for (const scenario of ["history", "rejected", "unknown"]) {
    const h = viewHarness(screen({ terminal: terminal({ status: { state: "idle" }, turn: 0 }) }));
    h.render();
    await settle();
    h.render().props.onSearchTextChange("keep draft");
    await settle();
    const save = h.store.setItem;
    if (scenario === "history")
      h.store.setItem = async (key, value) => {
        if (key.startsWith("hc-conversation")) throw new Error("disk full");
        await save(key, value);
      };
    else
      h.feed.client.current.request = async () => {
        throw scenario === "rejected" ? new HcError("blocked", "blocked before input") : new Error("connection lost");
      };
    await h.action("Send Message");
    const view = h.render();
    assert.equal(view.props.searchText, "keep draft");
    const reply = views(view).find((v) => v.props.id?.startsWith("reply:"))!;
    assert.match(reply.props.detail.props.markdown, scenario === "unknown" ? /delivery is uncertain/ : /not submitted/);
    assert.equal(
      views(view).some((v) => v.props.id === "uncertain"),
      scenario === "unknown",
    );
    if (scenario === "history") assert.equal(h.requests.length, 0);
  }
});

test("HC view restores completed local rows for the same program without attributing current history", async () => {
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "done" }, turn: 4 }) }));
  const c = new HcConversation(hcTargetKey(target), h.feed.pin.current, h.store);
  await c.load();
  await c.begin("saved", "saved question", { text: "old\n", turn: 0, state: "idle", complete: true });
  c.submitted("saved");
  c.observe({ text: "old\nsaved answer", turn: 1, state: "done", complete: true });
  await settle();
  h.render();
  await settle();
  let view = h.render();
  const reply = views(view).find((v) => v.props.id === "reply:saved")!;
  assert.match(reply.props.detail.props.markdown, /saved answer/);
  assert.doesNotMatch(reply.props.detail.props.markdown, /Allow read/);
  assert.equal(view.props.selectedItemId, "reply:saved");
  view.props.onSelectionChange("user:saved");
  await h.action("Read Full Width");
  view = h.render();
  assert.match(view.props.markdown, /saved question/);
  assert.doesNotMatch(view.props.markdown, /saved answer/);
  assert.equal(h.requests.length, 0);
});

test("All Sessions return refreshes saved messages from another view without sending", async () => {
  let resume: (() => void) | undefined;
  const h = viewHarness(screen({ terminal: terminal({ status: { state: "done" }, turn: 1 }) }), (onPop) => {
    resume = onPop;
  });
  h.render();
  await settle();
  h.render();
  await h.action("All Sessions");
  const other = new HcConversation(hcTargetKey(target), h.feed.pin.current, h.store);
  await other.load();
  await other.begin("other-view", "message in another view", { text: "old\n", state: "idle", turn: 0, complete: true });
  other.submitted("other-view");
  other.observe({ text: "old\nanswer in another view", state: "done", turn: 1, complete: true });
  await settle();
  assert.ok(resume);
  resume();
  await settle();
  const view = h.render();
  assert.equal(h.feed.visible, true);
  assert.match(
    views(view).find((v) => v.props.id === "reply:other-view")!.props.detail.props.markdown,
    /answer in another view/,
  );
  assert.equal(h.requests.length, 0);
});

test("derived HC replies render Markdown tables while raw screens and dialog review stay literal", async () => {
  const baseline = screen({
    terminal: terminal({ status: { state: "idle" }, turn: 0 }),
    capture: { text: "old history\n", complete: true, how: "screen" },
  });
  const h = viewHarness(baseline);
  h.render();
  await settle();
  h.render().props.onSearchTextChange("show table");
  await settle();
  await h.action("Send Message");
  const body =
    "## 检查结果\n\n| 项目 | 状态 |\n| :--- | ---: |\n| SSH | 正常 |\n\n```typescript\nconst url = 'https://example.test';\n```";
  const next = screen({
    terminal: terminal({ status: { state: "done" }, turn: 1 }),
    capture: { text: baseline.capture.text + body, complete: true, how: "screen" },
  });
  h.feed.latest.current = next;
  h.feed.screen = next;
  h.render();
  await settle();
  let view = h.render();
  const reply = views(view).find((v) => v.props.id?.startsWith("reply:"))!;
  assert.match(reply.props.detail.props.markdown, /^## 检查结果/);
  assert.match(reply.props.detail.props.markdown, /\| :--- \| ---: \|/);
  assert.match(reply.props.detail.props.markdown, /const url = 'https:\/\/example.test';/);
  await h.action("Read Full Width");
  assert.equal(h.render().props.markdown, reply.props.detail.props.markdown);
  await h.action("View Raw Terminal");
  view = h.render();
  assert.equal(
    views(view).find((v) => v.props.id === "screen")!.props.detail.props.markdown,
    literal(next.capture.text),
  );
  await h.action("Review Terminal Controls");
  view = h.render();
  const reviewed = views(view).find((v) => v.props.id === "review-screen")!;
  assert.match(reviewed.props.detail.props.markdown, /Current Terminal Dialog/);
  assert.ok(reviewed.props.detail.props.markdown.includes(literal(next.capture.text)));
  assert.equal(h.requests.length, 1);
});

const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=",
  "base64",
);
const imageFixture: ImageUpload = {
  name: "screenshot.png",
  mimeType: "image/png",
  size: imageBytes.length,
  sha256: createHash("sha256").update(imageBytes).digest("hex"),
  data: imageBytes.toString("base64"),
};
const imageMetadata = (image: ImageUpload) => ({
  name: image.name,
  mimeType: image.mimeType,
  size: image.size,
  sha256: image.sha256,
});
const imageScreen = (agent = "claude") =>
  screen({
    terminal: terminal({ argv: [agent], status: { state: "idle", app: agent }, turn: 0 }),
    capture: { text: "Earlier question\nEarlier answer\n", complete: true, how: "screen" },
  });
async function imageComposer(h: ReturnType<typeof viewHarness>, id = randomUUID(), text = "Explain this screenshot") {
  h.images.set(id, imageFixture);
  h.render();
  await settle();
  h.render();
  await settle();
  await h.action("Compose Message");
  const child = h.child()!;
  child.props.change(text);
  await child.props.changeImage(id);
  return { child, id, text };
}
const journal = (h: ReturnType<typeof viewHarness>) => {
  const raw = h.store.data.get(`hc-attempt-v1:${hcTargetKey(target)}`);
  return raw ? JSON.parse(raw) : undefined;
};

test("HC image draft identity survives reopen, differs by image, and delayed success keeps the whole newer draft", async () => {
  const store = storage(),
    state = local("image-draft", store),
    id = randomUUID();
  await state.load();
  state.change("task", "same comment");
  await state.changeImage(id);
  const reopened = local("image-draft", store);
  await reopened.load();
  assert.equal(reopened.drafts.imageId, id);
  const response = deferred<void>();
  let firstFingerprint: string | undefined;
  const sending = state.run(
    "task",
    "same comment",
    async () => true,
    async () => {
      firstFingerprint = state.attempt!.fingerprint;
      assert.equal(state.attempt!.phase, "uploading");
      await state.imagePhase("uploaded", "/remote/image.png");
      await state.imagePhase("sending");
      await response.promise;
    },
    () => true,
    { imageId: id, image: imageMetadata(imageFixture), program: "program" },
  );
  await settle();
  state.change("task", "newer comment");
  await assert.rejects(reopened.changeImage(randomUUID()), /Wait for the current terminal operation/);
  response.resolve();
  await sending;
  assert.equal(state.drafts.task, "newer comment");
  assert.equal(state.drafts.imageId, id, "never clear half of a newer image+text draft");
  const otherId = randomUUID();
  await state.changeImage(otherId);
  state.change("task", "same comment");
  await state.run(
    "task",
    "same comment",
    async () => true,
    async () => {
      assert.notEqual(state.attempt!.fingerprint, firstFingerprint);
    },
    () => true,
    { imageId: otherId, image: { ...imageMetadata(imageFixture), sha256: "b".repeat(64) }, program: "program" },
  );
  assert.equal(state.drafts.task, "");
  assert.equal(state.drafts.imageId, undefined);
});

test("HC image send persists upload then fresh baseline then input, with original comment and metadata in history", async () => {
  for (const agent of ["claude", "codex"]) {
    const h = viewHarness(imageScreen(agent)),
      { child, id, text } = await imageComposer(h);
    const put = h.feed.client.current.put;
    const afterUpload = imageScreen(agent);
    afterUpload.capture.text = "Upload screen activity\nReady for input\n";
    h.feed.client.current.put = async (target, image) => {
      assert.equal(journal(h).phase, "uploading");
      assert.equal(journal(h).imageId, id);
      assert.ok(journal(h).fingerprint);
      assert.equal(h.store.data.get(`hc-image-bytes-v1:${hcTargetKey(target)}`), String(image.size));
      assert.equal(
        [...h.store.data.keys()].some((key) => key.startsWith("hc-conversation")),
        false,
        "baseline is not saved before upload",
      );
      h.feed.latest.current = afterUpload;
      h.feed.screen = afterUpload;
      return put(target, image);
    };
    const request = h.feed.client.current.request;
    h.feed.client.current.request = async (method, params) => {
      assert.equal(journal(h).phase, "sending");
      assert.equal(journal(h).remotePath, "/agent-machine/attachments/image.png");
      assert.ok([...h.store.data.keys()].some((key) => key.startsWith("hc-conversation")));
      return request(method, params);
    };
    assert.equal(await child.props.send(text, () => true, id), true);
    assert.deepEqual(
      h.requests.map((r) => r.method),
      ["terminal.put", "terminal.send"],
    );
    const sent = h.requests[1]!.params;
    assert.equal(sent.terminal, "remote/t1");
    assert.equal(sent.force, false);
    assert.equal(sent.if, "idle");
    assert.match(sent.text, agent === "claude" ? /Use the Read tool/ : /Use view_image/);
    assert.match(sent.text, /agent-machine\/attachments\/image.png/);
    assert.doesNotMatch(sent.text, /private\/mac-cache/);
    assert.equal(h.render().props.searchText, "");
    assert.deepEqual(h.released, [id]);
    assert.equal(journal(h), undefined);
    const reply = screen({
      terminal: { ...afterUpload.terminal, status: { state: "done", app: agent }, turn: 1 },
      capture: { text: `${afterUpload.capture.text}❯ ${sent.text}\nA fixture answer.`, complete: true, how: "screen" },
    });
    h.feed.latest.current = reply;
    h.feed.screen = reply;
    h.render();
    await settle();
    const rows = views(h.render());
    assert.match(rows.find((v) => v.props.id?.startsWith("user:"))!.props.detail.props.markdown, /Image attached/);
    const output = rows.find((v) => v.props.id?.startsWith("reply:"))!.props.detail.props.markdown;
    assert.match(output, /A fixture answer/);
    assert.doesNotMatch(output, /Upload screen activity|agent-machine|Use the Read|Use view_image/);
    for (const saved of h.store.data.values())
      assert.ok(!saved.includes(imageFixture.data), "no image body in local storage");
  }
});

test("HC image upload never inputs after the target becomes busy, blocked, unreported, replaced, disconnected or closed", async () => {
  for (const mode of ["working", "blocked", "unreported", "program", "app", "disconnected", "closed"]) {
    const h = viewHarness(imageScreen()),
      { child, id, text } = await imageComposer(h);
    let active = true;
    const put = h.feed.client.current.put;
    h.feed.client.current.put = async (target, image) => {
      const result = await put(target, image);
      const next = imageScreen();
      if (mode === "working" || mode === "blocked") next.terminal.status!.state = mode;
      if (mode === "unreported") next.terminal.reported = false;
      if (mode === "program") next.terminal.pid = 101;
      if (mode === "app") next.terminal.status!.app = "codex";
      if (mode === "disconnected") h.feed.observing.current = false;
      if (mode === "closed") active = false;
      h.feed.latest.current = next;
      h.feed.screen = next;
      return result;
    };
    assert.equal(await child.props.send(text, () => active, id), false, mode);
    assert.deepEqual(
      h.requests.map((r) => r.method),
      ["terminal.put"],
      mode,
    );
    assert.equal(h.render().props.searchText, text);
    assert.equal(JSON.parse(h.store.data.get(`hc-drafts-v1:${hcTargetKey(target)}`)!).imageId, id);
    assert.deepEqual(h.released, []);
    assert.match(h.toasts.at(-1)!.message!, /Image uploaded.*[Nn]o message input was sent/);
    assert.equal(
      [...h.store.data.keys()].some((key) => key.startsWith("hc-conversation")),
      false,
    );
  }
});

test("HC image failures distinguish upload from input, preserve references, and never retry unknown phases", async () => {
  for (const mode of ["upload", "uploaded-journal", "sending-journal", "history", "send", "blocked"]) {
    const h = viewHarness(imageScreen()),
      { child, id, text } = await imageComposer(h);
    if (mode === "upload")
      h.feed.client.current.put = async () => {
        throw new Error("upload transport closed");
      };
    if (mode === "send" || mode === "blocked")
      h.feed.client.current.request = async () => {
        throw mode === "blocked" ? new HcError("blocked") : new Error("input transport closed");
      };
    const save = h.store.setItem;
    h.store.setItem = async (key, value) => {
      if (
        (mode === "history" && key.startsWith("hc-conversation")) ||
        (key.startsWith("hc-attempt") &&
          ((mode === "uploaded-journal" && JSON.parse(value).phase === "uploaded") ||
            (mode === "sending-journal" && JSON.parse(value).phase === "sending")))
      )
        throw new Error("disk full");
      await save(key, value);
    };
    assert.equal(await child.props.send(text, () => true, id), false);
    const phase =
      mode === "upload" || mode === "uploaded-journal"
        ? "uploading"
        : mode === "sending-journal"
          ? "uploaded"
          : "sending";
    const known = mode === "history" || mode === "blocked";
    assert.equal(journal(h)?.phase, known ? undefined : phase);
    assert.match(
      h.toasts.at(-1)!.message!,
      mode === "send"
        ? /Image uploaded.*delivery is uncertain/
        : mode === "upload"
          ? /upload was not confirmed.*No message input was sent/
          : /Image uploaded.*[Nn]o message input was sent/,
    );
    assert.equal(h.render().props.searchText, text);
    assert.deepEqual(h.released, []);
    if (!known) {
      const restored = local(hcTargetKey(target), h.store);
      await restored.load();
      assert.equal(restored.attempt!.imageId, id);
      assert.equal(restored.drafts.imageId, id);
      await assert.rejects(
        restored.run(
          "task",
          text,
          async () => true,
          async () => {
            assert.fail("unknown image attempts must not replay");
          },
          () => true,
        ),
        /Previous input/,
      );
    }
    for (const saved of h.store.data.values()) assert.ok(!saved.includes(imageFixture.data));
  }
});

test("HC image budget is durable and rejects uploads beyond 100 MiB without terminal input", async () => {
  const h = viewHarness(imageScreen()),
    { child, id, text } = await imageComposer(h);
  h.store.data.set(`hc-image-bytes-v1:${hcTargetKey(target)}`, String(100 * 1024 * 1024 - imageFixture.size + 1));
  assert.equal(await child.props.send(text, () => true, id), false);
  assert.equal(h.requests.length, 0);
  assert.equal(journal(h), undefined);
  assert.match(h.toasts.at(-1)!.message!, /100 MiB/);
  assert.equal(JSON.parse(h.store.data.get(`hc-drafts-v1:${hcTargetKey(target)}`)!).imageId, id);
});

test("old HC and unidentified programs preserve images while text still sends; dialog controls never accept images", async () => {
  for (const mode of ["old", "unidentified"]) {
    const h = viewHarness(imageScreen(mode === "unidentified" ? "agent" : "claude"));
    if (mode === "old") h.feed.client.current.methods.clear();
    const { child, id, text } = await imageComposer(h);
    assert.ok(child.props.imageUnavailable);
    assert.equal(await child.props.send(text, () => true, id), false);
    assert.equal(h.requests.length, 0);
    await child.props.changeImage(undefined);
    assert.equal(await child.props.send(text, () => true), true);
    assert.deepEqual(
      h.requests.map((r) => r.method),
      ["terminal.send"],
    );
  }
  const h = viewHarness(imageScreen());
  h.render();
  await settle();
  h.render();
  await settle();
  await h.action("Respond to Current Prompt");
  assert.equal(h.child()!.props.changeImage, undefined);
  assert.equal(await h.child()!.props.send("answer", () => true, randomUUID()), false);
  assert.equal(h.requests.length, 0);
});

test("captured image stays beside the ordinary input without opening a composer or sending", async () => {
  for (const offline of [false, true]) {
    const id = randomUUID(),
      h = viewHarness(imageScreen(), undefined, id);
    h.images.set(id, imageFixture);
    if (offline) {
      h.feed.pin.current = undefined as any;
      h.feed.observing.current = false;
    }
    h.render();
    await settle();
    h.render();
    await settle();
    h.render();
    await settle();
    assert.equal(h.children.length, 0);
    assert.equal(h.render().props.searchBarAccessory.type, "ImageAccessory");
    assert.equal(JSON.parse(h.store.data.get(`hc-drafts-v1:${hcTargetKey(target)}`)!).imageId, id);
    assert.equal(h.requests.length, 0, "capturing opens a draft and never sends");
    if (offline) {
      h.render().props.onSearchTextChange("comment");
      assert.equal(
        views(h.render()).some((v) => v.props.title === "Send Message"),
        false,
      );
      await h.action("Compose Message");
      assert.equal(await h.child()!.props.send("comment", () => true, id), false);
      assert.equal(h.requests.length, 0);
    } else {
      h.render().props.onSearchTextChange("inline comment");
      await settle();
      await h.action("Send Message");
      assert.deepEqual(
        h.requests.map((r) => r.method),
        ["terminal.put", "terminal.send"],
      );
      assert.equal(h.requests[0]!.params.data, imageFixture.data);
      assert.match(h.requests[1]!.params.text, /inline comment/);
      assert.equal(h.children.length, 0);
    }
  }
});

test("capture replacement requires confirmation and canceled or uncertain screenshots remain explicitly accessible", async () => {
  const id = randomUUID(),
    oldId = randomUUID(),
    h = viewHarness(imageScreen(), undefined, id);
  h.images.set(id, imageFixture);
  h.images.set(oldId, imageFixture);
  h.store.data.set(
    `hc-drafts-v1:${hcTargetKey(target)}`,
    JSON.stringify({ task: "existing comment", answer: "", terminal: "", imageId: oldId }),
  );
  h.confirmations.result = false;
  h.render();
  await settle();
  h.render();
  await settle();
  h.render();
  assert.equal(h.children.length, 0);
  assert.equal(JSON.parse(h.store.data.get(`hc-drafts-v1:${hcTargetKey(target)}`)!).imageId, oldId);
  assert.equal(h.confirmations.calls[0]!.title, "Replace Draft Image?");
  h.confirmations.result = true;
  await h.action("Attach Captured Image");
  assert.equal(h.children.length, 0);
  assert.equal(h.render().props.searchText, "existing comment");
  assert.equal(h.render().props.searchBarAccessory.type, "ImageAccessory");
  assert.deepEqual(h.released, [oldId]);
  assert.equal(h.requests.length, 0);

  const pendingId = randomUUID(),
    pending = viewHarness(imageScreen(), undefined, pendingId);
  pending.images.set(pendingId, imageFixture);
  pending.store.data.set(
    `hc-attempt-v1:${hcTargetKey(target)}`,
    JSON.stringify({ id: "uncertain", kind: "task", text: "pending comment", at: 1 }),
  );
  pending.render();
  await settle();
  pending.render();
  await settle();
  pending.render();
  assert.equal(pending.children.length, 0);
  assert.match(pending.toasts.at(-1)!.message!, /Previous input is uncertain/);
  assert.ok(views(pending.render()).some((v) => v.props.title === "Attach Captured Image"));
  await pending.action("Inspect Latest Output");
  await pending.action("Acknowledge Uncertain Input…");
  await pending.action("Attach Captured Image");
  assert.equal(pending.children.length, 0);
  assert.equal(pending.render().props.searchText, "pending comment");
  assert.equal(pending.render().props.searchBarAccessory.type, "ImageAccessory");
  assert.equal(pending.requests.length, 0);
});

test("missing captures do not change drafts, and HcCompose forwards image identity with child lifetime", async () => {
  const h = viewHarness(imageScreen(), undefined, randomUUID());
  h.render();
  await settle();
  h.render();
  await settle();
  assert.equal(h.children.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.store.data.has(`hc-drafts-v1:${hcTargetKey(target)}`), false);
  const calls: Array<{ text: string; imageId?: string; active: boolean }> = [];
  const wrapper = componentHarness(["HcCompose"], { Compose: "Compose" });
  const child = wrapper.render("HcCompose", {
    text: "comment",
    change() {},
    send: async (text: string, active: () => boolean, imageId?: string) => {
      calls.push({ text, imageId, active: active() });
      return false;
    },
  });
  wrapper.flush();
  const imageId = randomUUID();
  await child.props.send("comment", imageId);
  wrapper.cleanup();
  await child.props.send("comment", imageId);
  assert.deepEqual(calls, [
    { text: "comment", imageId, active: true },
    { text: "comment", imageId, active: false },
  ]);
});

test("typing or finishing a stale view cannot erase another view's durable image draft", async () => {
  const store = storage(),
    a = local("image-shared-draft", store),
    b = local("image-shared-draft", store),
    id = randomUUID();
  await Promise.all([a.load(), b.load()]);
  await a.changeImage(id);
  b.change("task", "edited in second view");
  await settle();
  const reopened = local("image-shared-draft", store);
  await reopened.load();
  assert.equal(reopened.drafts.imageId, id, "typing must merge the latest attachment");
  assert.equal(reopened.drafts.task, "edited in second view");
  assert.equal(b.drafts.imageId, id, "the writing view adopts the saved attachment");
  const response = deferred<void>();
  const sending = b.run(
    "task",
    "edited in second view",
    async () => true,
    () => response.promise,
    () => true,
    { imageId: id, image: imageMetadata(imageFixture), program: "program" },
  );
  await settle();
  a.change("task", "newer text from first view");
  await settle();
  response.resolve();
  await sending;
  const final = local("image-shared-draft", store);
  await final.load();
  assert.equal(final.drafts.task, "newer text from first view", "success clears only the submitted durable pair");
  assert.equal(final.drafts.imageId, id);
});

test("successful HC image input with failed marker cleanup keeps the complete draft and private cache reference", async () => {
  const h = viewHarness(imageScreen()),
    { child, id, text } = await imageComposer(h);
  h.store.removeItem = async () => {
    throw new Error("cannot remove marker");
  };
  assert.equal(await child.props.send(text, () => true, id), false);
  assert.deepEqual(
    h.requests.map((r) => r.method),
    ["terminal.put", "terminal.send"],
  );
  assert.equal(h.render().props.searchText, text);
  assert.equal(JSON.parse(h.store.data.get(`hc-drafts-v1:${hcTargetKey(target)}`)!).imageId, id);
  assert.equal(journal(h).phase, "sending");
  assert.deepEqual(h.released, []);
  const restored = local(hcTargetKey(target), h.store);
  await restored.load();
  assert.equal(restored.drafts.task, text);
  assert.equal(restored.drafts.imageId, id);
});

test("restoring after marker cleanup failure preserves newer draft text from a different view", async () => {
  const store = storage(),
    a = local("image-cleanup-shared", store),
    b = local("image-cleanup-shared", store),
    id = randomUUID();
  await a.load();
  a.change("task", "submitted text");
  await a.changeImage(id);
  await b.load();
  store.removeItem = async () => {
    b.change("task", "newer separate draft");
    await settle();
    throw new Error("cannot remove marker");
  };
  await assert.rejects(
    a.run(
      "task",
      "submitted text",
      async () => true,
      async () => {
        await a.imagePhase("uploaded", "/remote/image.png");
        await a.imagePhase("sending");
      },
      () => true,
      { imageId: id, image: imageMetadata(imageFixture), program: "program" },
    ),
    /delivery is uncertain/,
  );
  const restored = local("image-cleanup-shared", store);
  await restored.load();
  assert.equal(restored.drafts.task, "newer separate draft");
  assert.equal(restored.attempt!.imageId, id, "uncertain image remains referenced by its original attempt");
});

test("right attachment control clears the restored HC image durably without clearing text or bypassing uncertainty", async () => {
  for (const uncertain of [false, true]) {
    const h = viewHarness(imageScreen()),
      id = randomUUID();
    const key = hcTargetKey(target);
    h.store.data.set(
      `hc-drafts-v1:${key}`,
      JSON.stringify({ task: "comment kept on reopen", answer: "", terminal: "", imageId: id }),
    );
    if (uncertain)
      h.store.data.set(
        `hc-attempt-v1:${key}`,
        JSON.stringify({ id: "pending", kind: "task", text: "comment kept on reopen", imageId: id, at: 1 }),
      );
    h.render();
    await settle();
    const view = h.render();
    assert.equal(view.props.searchBarAccessory.props.imageId, id);
    if (uncertain) await assert.rejects(view.props.searchBarAccessory.props.changeImage(undefined), /uncertain/i);
    else await view.props.searchBarAccessory.props.changeImage(undefined);
    const restored = local(key, h.store);
    await restored.load();
    assert.equal(restored.drafts.imageId, uncertain ? id : undefined);
    assert.equal(restored.drafts.task, "comment kept on reopen");
    assert.equal(h.render().props.searchText, "comment kept on reopen");
    assert.equal(Boolean(h.render().props.searchBarAccessory), uncertain);
    assert.equal(h.requests.length, 0);
  }
});
