import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import { z } from "zod";
import { commandSchema, id, interactionSchema, MAX_TEXT, type Status } from "../../shared/src/protocol.js";
import type { Adapter, Emit } from "./adapter.js";

const MAX_FRAME = 1024 * 1024;
const REQUEST_TIMEOUT = 30_000;
const INTERACTION_TTL = 5 * 60_000;
const nativeId = z.string().min(1).max(1000);
const rpcId = z.union([z.string().max(1000), z.number().int().safe()]);
type RpcId = z.infer<typeof rpcId>;
const record = z.record(z.string(), z.unknown());
const statusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }), z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({ type: z.literal("active"), activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).max(2) }),
]);
const turnSchema = z.object({ id: nativeId, status: z.enum(["inProgress", "completed", "interrupted", "failed"]) });
const threadSchema = z.object({
  id: nativeId, cwd: z.string().max(4000), status: statusSchema,
  name: z.string().max(MAX_TEXT).nullable().optional(), turns: z.array(turnSchema).max(10_000),
});
type Thread = z.infer<typeof threadSchema>;
const threadResponse = z.object({ thread: threadSchema });
const loadedPage = z.object({ data: z.array(nativeId).max(1000), nextCursor: z.string().max(4000).nullable() });
const key = (value: RpcId) => JSON.stringify([typeof value, value]);
const encodedId = (prefix: string, value: string) => `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
const wireId = (value: string) => id.safeParse(value).success ? value : encodedId("native", value);
const failure = () => new Error("Codex operation could not be confirmed; check the original session before retrying.");

/** Bounded RPC parser. JSONL is fake-child only; native control sockets require WebSocket framing. */
export class JsonRpc {
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private stopped = false;
  private websocket?: WebSocket;
  private ready: Promise<void> = Promise.resolve();
  onFrame: (frame: { method: string; params: Record<string, unknown>; id?: RpcId }) => void = () => {};
  onClose: (status: "offline" | "error") => void = () => {};

  constructor(private child: ChildProcessWithoutNullStreams, private timeout = REQUEST_TIMEOUT, websocket = false) {
    if (websocket) {
      // `codex app-server proxy` relays raw bytes, NOT JSONL. Upgrade over its pipes;
      // the URL supplies HTTP headers only: createConnection never opens a TCP connection.
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
      stream.on("error", () => this.stop("error"));
      this.websocket = new WebSocket("ws://localhost/", {
        createConnection: () => stream, handshakeTimeout: Math.min(timeout, 5000),
        maxPayload: MAX_FRAME, perMessageDeflate: false,
      });
      this.ready = new Promise<void>((resolve, reject) => {
        this.websocket!.once("open", resolve);
        this.websocket!.once("error", () => reject(failure()));
        this.websocket!.once("close", () => reject(failure()));
      });
      void this.ready.catch(() => this.stop("error"));
      this.websocket.on("message", (data) => {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.read(Buffer.concat([buffer, Buffer.from("\n")]));
      });
      this.websocket.on("error", () => this.stop("error"));
      this.websocket.on("close", () => this.stop("offline"));
    } else child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stdout.on("end", () => this.stop("offline"));
    child.stdout.on("error", () => this.stop("error"));
    child.stdin.on("error", () => this.stop("error"));
    child.stderr.on("error", () => this.stop("error"));
    // Drain, but never forward diagnostics: stderr can contain credentials or local conversation text.
    child.stderr.resume();
    child.on("error", () => this.stop("error"));
    child.on("exit", (code) => this.stop(code === 0 ? "offline" : "error"));
  }

  get closed() { return this.stopped; }

  private read(chunk: Buffer) {
    if (this.stopped) return;
    let offset = 0;
    while (offset < chunk.length && !this.stopped) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.bytes += part.length;
      if (this.bytes > MAX_FRAME) { this.stop("error"); return; }
      this.chunks.push(part);
      if (newline === -1) return;
      const line = Buffer.concat(this.chunks, this.bytes);
      this.chunks = []; this.bytes = 0;
      offset = newline + 1;
      try {
        const frame = record.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
        if (frame.jsonrpc !== undefined && frame.jsonrpc !== "2.0") throw failure();
        if (typeof frame.method === "string") {
          if (!frame.method.length || frame.method.length > 200 || "result" in frame || "error" in frame) throw failure();
          const params = record.parse(frame.params ?? {});
          const requestId = "id" in frame ? rpcId.parse(frame.id) : undefined;
          this.onFrame({ method: frame.method, params, ...(requestId !== undefined ? { id: requestId } : {}) });
        } else {
          const requestId = rpcId.parse(frame.id);
          if (("result" in frame) === ("error" in frame)) throw failure();
          if ("error" in frame) z.object({ code: z.number().int(), message: z.string().max(MAX_TEXT) }).parse(frame.error);
          const waiting = this.pending.get(key(requestId));
          if (!waiting) continue; // A response may arrive after another client resolves a request.
          this.pending.delete(key(requestId)); clearTimeout(waiting.timer);
          if ("error" in frame) waiting.reject(failure());
          else waiting.resolve(frame.result);
        }
      } catch { this.stop("error"); }
    }
  }

  async write(frame: unknown): Promise<void> {
    if (this.stopped) throw failure();
    await this.ready;
    if (this.stopped) throw failure();
    const line = JSON.stringify(frame) + (this.websocket ? "" : "\n");
    if (Buffer.byteLength(line) > MAX_FRAME) throw failure();
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null) => {
        if (error || this.stopped) { this.stop("error"); reject(failure()); }
        else resolve();
      };
      if (this.websocket) this.websocket.send(line, done);
      else this.child.stdin.write(line, done);
    });
  }

  async request<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    if (this.stopped || this.pending.size >= 128) throw failure();
    const requestId = ++this.sequence;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.stop("error"), this.timeout);
      this.pending.set(key(requestId), { resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id: requestId, method, params }).catch(() => this.stop("error"));
    });
    const value = await response;
    const parsed = schema.safeParse(value);
    if (!parsed.success) { this.stop("error"); throw failure(); }
    return parsed.data;
  }

  respond(requestId: RpcId, result: unknown) { return this.write({ jsonrpc: "2.0", id: requestId, result }); }
  reject(requestId: RpcId, code: number, message: string) {
    return this.write({ jsonrpc: "2.0", id: requestId, error: { code, message } });
  }
  stop(status: "offline" | "error" = "offline") {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(failure()); }
    this.pending.clear(); this.chunks = []; this.bytes = 0;
    this.websocket?.terminate();
    this.child.stdin.destroy();
    this.child.kill(); // Only our proxy process, never the shared app-server or the native turn.
    try { this.onClose(status); } catch { /* A failing event sink must not crash the host process. */ }
  }
}

interface Options {
  threadId: string;
  socket?: string;
  codexBin?: string;
  /** @internal Fake child only. Production always spawns `codex app-server proxy`. */
  transportFactory?: () => JsonRpc;
}
function transport(options: Omit<Options, "threadId">) {
  if (options.socket !== undefined && (!options.socket || options.socket.length > 4000 || options.socket.includes("\0"))) throw failure();
  if (options.transportFactory) return options.transportFactory();
  return new JsonRpc(spawn(options.codexBin ?? "codex", [
    "app-server", "proxy", ...(options.socket ? ["--sock", options.socket] : []),
  ], { stdio: ["pipe", "pipe", "pipe"] }), REQUEST_TIMEOUT, true);
}
async function initialize(rpc: JsonRpc) {
  await rpc.request("initialize", {
    clientInfo: { name: "argo", title: "Argo connector", version: "0.1.3" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  }, z.object({ userAgent: z.string().max(4000) }));
  await rpc.write({ jsonrpc: "2.0", method: "initialized", params: {} });
}
async function loadedThreads(rpc: JsonRpc): Promise<string[]> {
  const result = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await rpc.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) }, loadedPage);
    for (const threadId of page.data) result.add(threadId);
    if (result.size > 10_000 || cursors.size >= 100 || (page.nextCursor !== null && cursors.has(page.nextCursor))) throw failure();
    if (page.nextCursor !== null) cursors.add(page.nextCursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return [...result];
}
function statusOf(status: Thread["status"]): Status {
  switch (status.type) {
    case "idle": return "ready";
    case "active": return status.activeFlags.length ? "waiting" : "busy";
    case "systemError": return "error";
    case "notLoaded": return "offline";
  }
}

/** Lists only loaded runtime metadata; never reads/imports turns or message previews. */
export async function listCodexThreads(socket?: string): Promise<Array<{ id: string; cwd: string; name: string | null; status: Status }>> {
  const rpc = transport({ socket });
  rpc.onFrame = (frame) => { if (frame.id !== undefined) void rpc.reject(frame.id, -32601, "Method not supported").catch(() => rpc.stop("error")); };
  try {
    await initialize(rpc);
    const result = [];
    for (const threadId of await loadedThreads(rpc)) {
      const { thread } = await rpc.request("thread/read", { threadId, includeTurns: false }, threadResponse);
      if (thread.id !== threadId) throw failure();
      if (thread.status.type !== "notLoaded") result.push({ id: thread.id, cwd: thread.cwd, name: thread.name ?? null, status: statusOf(thread.status) });
    }
    return result;
  } finally { rpc.stop(); }
}

const pathString = z.string().min(1).max(4000);
const specialPath = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(), z.object({ kind: z.literal("minimal") }).strict(),
  z.object({ kind: z.literal("project_roots"), subpath: pathString.nullable() }).strict(),
  z.object({ kind: z.literal("tmpdir") }).strict(), z.object({ kind: z.literal("slash_tmp") }).strict(),
  z.object({ kind: z.literal("unknown"), path: pathString, subpath: pathString.nullable() }).strict(),
]);
const permissionsSchema = z.object({
  network: z.object({ enabled: z.boolean().nullable() }).strict().nullable(),
  fileSystem: z.object({
    read: z.array(pathString).max(100).nullable(), write: z.array(pathString).max(100).nullable(),
    globScanMaxDepth: z.number().int().nonnegative().optional(),
    entries: z.array(z.object({
      path: z.discriminatedUnion("type", [
        z.object({ type: z.literal("path"), path: pathString }).strict(),
        z.object({ type: z.literal("glob_pattern"), pattern: pathString }).strict(),
        z.object({ type: z.literal("special"), value: specialPath }).strict(),
      ]), access: z.enum(["read", "write", "deny"]),
    }).strict()).max(100).optional(),
  }).strict().nullable(),
}).strict();
const questionSchema = z.object({
  id: nativeId, header: z.string().max(1000), question: z.string().min(1).max(MAX_TEXT),
  isOther: z.boolean(), isSecret: z.boolean(),
  options: z.array(z.object({ label: z.string().min(1).max(1000), description: z.string().max(10_000) })).max(50).nullable(),
});
type Question = z.infer<typeof questionSchema>;
interface PendingInteraction {
  nativeId: RpcId; expiresAt: number; timer: NodeJS.Timeout; submitted: boolean;
  permissions?: z.infer<typeof permissionsSchema>; questions?: Question[]; grantRoot?: string | null;
}

/**
 * Attach only to an already loaded runtime. This is NOT an atomic attach: the native
 * runtime can unload between loaded/list, read and resume. The current protocol has
 * no conditional-resume/runtime token, so even checking the returned thread cannot
 * eliminate that race. No history, config overrides, daemon start or automatic retry.
 */
export async function createCodexAdapter(options: Options, emit: Emit): Promise<Adapter> {
  if (!id.safeParse(options.threadId).success) throw new Error("Invalid Codex thread id");
  const rpc = transport(options);
  // A proxy connection is an authority epoch: restarting the connector requires a fresh pairing/outbox.
  const runtimeId = randomUUID();
  const interactions = new Map<string, PendingInteraction>();
  const seenRequests = new Set<string>();
  const replies = new Map<string, string>();
  const messages = new Map<string, { turnId: string; text: string; final: boolean }>();
  let currentTurn: string | undefined;
  let nativeStatus: Status = "connecting";
  let sending = false;
  let buffered: Array<{ method: string; params: Record<string, unknown> }> = [];
  let bufferedBytes = 0;
  const publishStatus = (status: Status) => { nativeStatus = status; emit({ type: "status", status }); };
  const finishInteraction = (requestId: string) => {
    const pending = interactions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer); interactions.delete(requestId);
    emit({ type: "interactionResolved", requestId });
  };
  rpc.onClose = (status) => {
    const requestIds = [...interactions.keys()];
    for (const pending of interactions.values()) clearTimeout(pending.timer);
    interactions.clear();
    for (const requestId of requestIds) { try { emit({ type: "interactionResolved", requestId }); } catch { /* Keep clearing authority even when the sink is unavailable. */ } }
    buffered = []; messages.clear(); replies.clear();
    publishStatus(status);
  };
  const sendError = (requestId: RpcId, code: number, detail: string) => {
    void rpc.reject(requestId, code, detail).catch(() => rpc.stop("error"));
  };
  function serverRequest(method: string, requestId: RpcId, params: Record<string, unknown>) {
    if (params.threadId !== undefined && params.threadId !== options.threadId) return;
    const supported = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"];
    if (!supported.includes(method)) { sendError(requestId, -32601, "Method not supported"); return; }
    if (params.threadId !== options.threadId) return; // Never decide another terminal's interactions.
    const requestKey = encodedId(`codex:${runtimeId}`, key(requestId));
    if (seenRequests.has(requestKey)) return;
    if (seenRequests.size >= 10_000) { rpc.stop("error"); return; }
    seenRequests.add(requestKey);
    if (interactions.size >= 128) { sendError(requestId, -32000, "Too many pending interactions"); return; }
    try {
      z.object({ threadId: nativeId, turnId: nativeId, itemId: nativeId }).parse(params);
      let permissions: PendingInteraction["permissions"];
      let questions: Question[] | undefined;
      let grantRoot: string | null | undefined;
      let detail: string;
      let ttl = INTERACTION_TTL;
      if (method === "item/permissions/requestApproval") {
        permissions = permissionsSchema.parse(params.permissions);
        detail = JSON.stringify({ permissions, reason: z.string().max(MAX_TEXT).nullable().parse(params.reason) });
      } else if (method === "item/tool/requestUserInput") {
        questions = z.array(questionSchema).min(1).max(20).parse(params.questions);
        const deadline = z.object({ isBlocking: z.boolean(), autoResolutionMs: z.number().int().nonnegative().nullable() }).parse(params);
        if (deadline.autoResolutionMs !== null) ttl = Math.min(ttl, deadline.autoResolutionMs);
        if (questions.some((question) => question.isSecret) || new Set(questions.map((question) => question.id)).size !== questions.length) throw failure();
        detail = JSON.stringify(questions);
      } else {
        const fields = z.object({ reason: z.string().max(MAX_TEXT).nullable().optional(), command: z.string().max(MAX_TEXT).nullable().optional(), cwd: pathString.nullable().optional(), grantRoot: pathString.nullable().optional() }).parse(params);
        grantRoot = fields.grantRoot;
        if (method === "item/commandExecution/requestApproval" && params.kind !== undefined) z.enum(["command", "writeStdin"]).parse(params.kind);
        detail = JSON.stringify(params);
      }
      const expiresAt = Date.now() + ttl;
      const interaction = interactionSchema.parse({
        requestId: requestKey, kind: questions ? "question" : "approval",
        title: questions ? "Codex question" : method === "item/permissions/requestApproval" ? "Codex permissions (this turn only)" : "Codex approval (once)",
        detail, expiresAt,
        ...(questions ? { questions: questions.map((question) => ({ id: encodedId("question", question.id), question: question.question, options: question.options?.map((option) => option.label) ?? [] })) } : {}),
      });
      const timer = setTimeout(() => {
        const pending = interactions.get(requestKey);
        if (pending && !pending.submitted) sendError(pending.nativeId, -32000, "Request expired");
        try { finishInteraction(requestKey); } catch { rpc.stop("error"); }
      }, ttl);
      timer.unref();
      interactions.set(requestKey, { nativeId: requestId, timer, expiresAt, submitted: false, permissions, questions, grantRoot });
      currentTurn = nativeId.parse(params.turnId);
      emit({ type: "interaction", interaction });
      publishStatus("waiting");
    } catch { sendError(requestId, -32602, "Unsupported or invalid interaction parameters"); }
  }
  function message(turnId: string, itemId: string, text: string, final: boolean) {
    if (text.length > MAX_TEXT) throw failure();
    const messageId = encodedId("codex", JSON.stringify([options.threadId, turnId, itemId]));
    if (!messages.has(messageId) && messages.size >= 128) throw failure();
    const previous = messages.get(messageId);
    if (previous?.final) return;
    messages.set(messageId, { turnId, text, final });
    if (text) emit({ type: "message", messageId, turnId: wireId(turnId), text, final, ...(replies.has(turnId) ? { replyTo: replies.get(turnId)! } : {}) });
  }
  function notification(method: string, params: Record<string, unknown>) {
    if (params.threadId !== options.threadId) return;
    if (sending && ["item/agentMessage/delta", "item/completed", "turn/started", "turn/completed"].includes(method)) {
      bufferedBytes += Buffer.byteLength(JSON.stringify(params));
      if (buffered.length >= 1000 || bufferedBytes > MAX_FRAME) throw failure();
      buffered.push({ method, params }); return;
    }
    switch (method) {
      case "item/agentMessage/delta": {
        const p = z.object({ turnId: nativeId, itemId: nativeId, delta: z.string().max(MAX_TEXT) }).parse(params);
        const messageId = encodedId("codex", JSON.stringify([options.threadId, p.turnId, p.itemId]));
        message(p.turnId, p.itemId, (messages.get(messageId)?.text ?? "") + p.delta, false);
        break;
      }
      case "item/completed": {
        const p = z.object({ turnId: nativeId, item: z.object({ type: z.string().max(200) }).passthrough() }).parse(params);
        if (p.item.type !== "agentMessage") break;
        const item = z.object({ id: nativeId, text: z.string().max(MAX_TEXT) }).parse(p.item);
        message(p.turnId, item.id, item.text, true); // Replace streamed text, do not append it again.
        break;
      }
      case "turn/started": {
        const { turn } = z.object({ turn: turnSchema }).parse(params);
        if (turn.status !== "inProgress") throw failure();
        currentTurn = turn.id; publishStatus("busy"); break;
      }
      case "turn/completed": {
        const { turn } = z.object({ turn: turnSchema }).parse(params);
        if (turn.status === "inProgress") throw failure();
        emit({ type: "completed", turnId: wireId(turn.id), ...(replies.has(turn.id) ? { messageId: replies.get(turn.id)! } : {}), ...(turn.status === "failed" ? { error: "Codex turn failed; inspect the original session" } : {}) });
        for (const [messageId, item] of messages) if (item.turnId === turn.id) messages.delete(messageId);
        if (currentTurn === turn.id || (!currentTurn && nativeStatus !== "offline")) { currentTurn = undefined; publishStatus("ready"); }
        break;
      }
      case "thread/status/changed": {
        const status = statusOf(statusSchema.parse(params.status));
        if (status === "ready" || status === "offline" || status === "error") currentTurn = undefined;
        publishStatus(status); break;
      }
      case "serverRequest/resolved": {
        const requestId = rpcId.parse(params.requestId);
        finishInteraction(encodedId(`codex:${runtimeId}`, key(requestId))); break;
      }
    }
  }
  rpc.onFrame = (frame) => {
    if (frame.id !== undefined) serverRequest(frame.method, frame.id, frame.params);
    else notification(frame.method, frame.params);
  };
  try {
    await initialize(rpc);
    if (!(await loadedThreads(rpc)).includes(options.threadId)) throw new Error("Codex thread is not loaded; attach from its existing native runtime");
    const before = (await rpc.request("thread/read", { threadId: options.threadId, includeTurns: false }, threadResponse)).thread;
    if (before.id !== options.threadId || before.status.type === "notLoaded" || before.status.type === "systemError") throw failure();
    const { thread } = await rpc.request("thread/resume", { threadId: options.threadId, excludeTurns: true }, threadResponse);
    if (thread.id !== options.threadId || thread.cwd !== before.cwd || thread.status.type === "notLoaded" || thread.status.type === "systemError") throw failure();
    if (rpc.closed) throw failure();
    currentTurn = thread.turns.find((turn) => turn.status === "inProgress")?.id ?? currentTurn;
    publishStatus(statusOf(thread.status));
    return {
      nativeSessionId: options.threadId, runtimeId, machine: hostname(), cwd: thread.cwd,
      capabilities: { send: true, streaming: true, interrupt: true, approvals: true, questions: true },
      async handle(value) {
        const parsed = commandSchema.safeParse(value);
        if (!parsed.success) throw new Error("Invalid Codex command");
        const command = parsed.data;
        if (rpc.closed) throw failure();
        if (command.type === "send") {
          if (sending) throw new Error("A Codex submission is already pending");
          sending = true;
          try {
            const { turn } = await rpc.request("turn/start", {
              threadId: options.threadId, clientUserMessageId: command.messageId,
              input: [{ type: "text", text: command.text, text_elements: [] }],
            }, z.object({ turn: turnSchema }));
            // ponytail: bounded correlation window, not an exactly-once ledger; the connection owns deduplication.
            if (replies.size >= 1000) replies.delete(replies.keys().next().value!);
            replies.set(turn.id, command.messageId);
            emit({ type: "receipt", commandId: command.commandId, messageId: command.messageId, state: "accepted" });
            if (turn.status === "inProgress") { currentTurn = turn.id; publishStatus("busy"); }
          } finally {
            sending = false;
            const frames = buffered; buffered = []; bufferedBytes = 0;
            // If submission failed, buffered native events remain valid but have no invented replyTo.
            for (const frame of frames) {
              try { notification(frame.method, frame.params); } catch { rpc.stop("error"); }
            }
          }
        } else if (command.type === "interrupt") {
          if (!currentTurn || (nativeStatus !== "busy" && nativeStatus !== "waiting")) throw new Error("The active Codex turn is not known; interrupt it in the original session");
          await rpc.request("turn/interrupt", { threadId: options.threadId, turnId: currentTurn }, z.object({}));
          emit({ type: "receipt", commandId: command.commandId, state: "accepted" });
        } else {
          const pending = interactions.get(command.requestId);
          if (!pending || pending.submitted || pending.expiresAt <= Date.now()) throw new Error("Codex interaction is no longer pending");
          let response: unknown;
          if (pending.questions) {
            const answers = command.answer.answers;
            if (!answers || Object.keys(answers).length !== pending.questions.length) throw new Error("Answer all Codex questions");
            response = { answers: Object.fromEntries(pending.questions.map((question) => {
              const values = answers[encodedId("question", question.id)];
              if (!values?.length || (question.options?.length && !question.isOther && values.some((answer) => !question.options!.some((option) => option.label === answer)))) throw new Error("Invalid Codex question answer");
              return [question.id, { answers: values }];
            })) };
          } else {
            if (!command.answer.decision) throw new Error("A Codex approval decision is required");
            const allow = command.answer.decision === "allow";
            if (allow && pending.grantRoot) throw new Error("Session-wide file grants must be reviewed in the original Codex session");
            response = pending.permissions ? {
              permissions: allow ? { ...(pending.permissions.network ? { network: pending.permissions.network } : {}), ...(pending.permissions.fileSystem ? { fileSystem: pending.permissions.fileSystem } : {}) } : {}, scope: "turn",
            } : { decision: allow ? "accept" : "decline" };
          }
          pending.submitted = true; // Claim before awaiting the write: at most one decision per connection.
          await rpc.respond(pending.nativeId, response);
          emit({ type: "receipt", commandId: command.commandId, state: "submitted" });
        }
      },
      async close() { rpc.stop(); },
    };
  } catch (error) { rpc.stop(); throw error instanceof Error && error.message.startsWith("Codex thread is not loaded") ? error : failure(); }
}
