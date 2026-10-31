import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Message } from "../../../packages/shared/src/protocol.js";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consumeEvents, Hub, HubError, parseConfig, readConfig, remotePrompt, safeMarkdown } from "./core.js";

const token = "a".repeat(64);

test("configuration accepts only credential-free loopback origins", () => {
  for (const url of ["http://127.0.0.1:48123", "http://localhost:48123", "http://[::1]:48123"]) {
    assert.equal(parseConfig({ url, token }).token, token);
  }
  for (const url of ["https://example.com", "http://192.168.1.2", "http://127.0.0.1.evil.com", "http://user:pass@localhost", "http://localhost/?token=secret", "http://localhost/path", "file:///tmp/private"]) {
    assert.throws(() => parseConfig({ url, token }));
  }
  assert.throws(() => parseConfig({ url: "http://localhost", token: "" }));
});

test("configuration file is private and malformed secrets never appear in errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "argo-raycast-"));
  const path = join(directory, "client.json");
  try {
    await writeFile(path, JSON.stringify({ url: "http://127.0.0.1:48123", token }), { mode: 0o600 });
    assert.equal((await readConfig(path)).token, token);
    await chmod(path, 0o644);
    await assert.rejects(readConfig(path), /private permissions/);
    await chmod(path, 0o600);
    await writeFile(path, `{"token":"${token}`);
    await assert.rejects(readConfig(path), (error: unknown) => error instanceof Error && !error.message.includes(token));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("agent markdown cannot create image, link, HTML, or autolink syntax", () => {
  const hostile = "![inline](https://evil.test/pixel) ![ref][id]\n[id]: https://evil.test/pixel\n<img src='https://evil.test/pixel'> <https://evil.test> [open](file:///private) \\![escaped](https://evil.test) &#33;[entity](https://evil.test)";
  const result = safeMarkdown(hostile);
  assert.ok(!/[!\[\]<>:\\]/.test(result));
  assert.match(result, /&amp;#33;/);
  assert.equal(safeMarkdown("**bold**\n\nplain"), "**bold**\n\nplain");
});

test("SSE parser handles fragmented CRLF, comments, and multiline data", async () => {
  const input = ': heartbeat\r\nid: 42\r\ndata: {"cursor":42,\r\ndata: "bindingId":"session", "type":"message", "createdAt":1}\r\n\r\n';
  const bytes = new TextEncoder().encode(input);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
  });
  const events: unknown[] = [];
  await consumeEvents(stream, (event) => events.push(event));
  assert.deepEqual(events, [{ cursor: 42, bindingId: "session", type: "message", createdAt: 1 }]);
});

test("hub uses bearer auth, rejects redirects, and releases in-flight fetch on close", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.ok(!request.url?.includes(token));
    if (request.url === "/v1/sessions") response.writeHead(302, { Location: "http://localhost/secret" }).end();
    else if (request.url === "/v1/sessions/missing") response.writeHead(404).end();
    else if (request.url === "/v1/sessions/wait") { response.writeHead(200, { "Content-Type": "application/json" }); response.flushHeaders(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const hub = new Hub({ url: `http://127.0.0.1:${address.port}`, token });
  try {
    await assert.rejects(hub.sessions());
    await assert.rejects(hub.snapshot("missing"), (error: unknown) => error instanceof HubError && error.status === 404);
    const waiting = hub.snapshot("wait");
    const assertion = assert.rejects(waiting);
    hub.close();
    await assertion;
  } finally { hub.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

// Raycast supplies its runtime inside the app, not Node. Evaluate only the pure
// selection function from the actual view, without loading Raycast or hooks.
function selectionLogic(): typeof import("./sessions.js").conversationSelection {
  const source = ts.createSourceFile("sessions.tsx", readFileSync(new URL("./sessions.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "conversationSelection");
  assert.ok(declaration, "Conversation must explicitly control its selected reply instead of defaulting to the status row");
  const exports = {} as { conversationSelection: typeof import("./sessions.js").conversationSelection };
  runInNewContext(ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, { exports });
  return exports.conversationSelection;
}

test("conversation selects the newest assistant and follows only its actively sent reply until history is selected", () => {
  const select = selectionLogic();
  const message = (id: string, createdAt: number, role: Message["role"] = "assistant", replyTo?: string): Message => ({
    id, createdAt, role, replyTo, text: id, state: "accepted",
  });
  const history = [message("old", 1), message("latest", 3), message("user", 4, "user"), message("middle", 2)];
  let state = select({}, { type: "select", id: "status" });
  assert.equal(state.selectedItemId, undefined, "the loading status default must not count as browsing history");
  state = select(state, { type: "snapshot", generation: "g1", messages: history });
  assert.equal(state.selectedItemId, "latest", "first snapshot selects the newest assistant, not status or a newer user message");
  state = select(state, { type: "select", id: "latest" });
  state = select(state, { type: "send", messageId: "sent-1" });
  state = select(state, { type: "select", id: "latest" });
  state = select(state, { type: "select", id: null });
  state = select(state, { type: "snapshot", generation: "g1", messages: [...history, message("unrelated", 5, "assistant", "another-send")] });
  assert.equal(state.selectedItemId, "latest", "unrelated replies do not satisfy the active send");
  const reply = message("reply-1", 6, "assistant", "sent-1");
  state = select(state, { type: "snapshot", generation: "g1", messages: [...history, reply] });
  assert.equal(state.selectedItemId, "reply-1", "the matching reply is selected as soon as it appears");
  state = select(state, { type: "select", id: "reply-1" });
  const streaming = [...history, { ...reply, text: "streamed text", state: "completed" as const }];
  assert.equal(select(state, { type: "snapshot", generation: "g1", messages: streaming }).selectedItemId, "reply-1");
  state = select(state, { type: "snapshot", generation: "g1", messages: [...streaming, message("reply-2", 7, "assistant", "sent-1")] });
  assert.equal(state.selectedItemId, "reply-2", "programmatic selection callbacks must not disable following subsequent reply items");
  state = select(state, { type: "select", id: "old" });
  state = select(state, { type: "snapshot", generation: "g1", messages: [...streaming, message("reply-3", 8, "assistant", "sent-1")] });
  assert.equal(state.selectedItemId, "old", "browsing history disables following, even while the old reply streams");
  state = select(state, { type: "send", messageId: "sent-2" });
  state = select(state, { type: "snapshot", generation: "g1", messages: [...streaming, message("late-old-reply", 9, "assistant", "sent-1")] });
  assert.equal(state.selectedItemId, "old");
  state = select(state, { type: "snapshot", generation: "g1", messages: [...streaming, message("new-reply", 10, "assistant", "sent-2")] });
  assert.equal(state.selectedItemId, "new-reply", "a new explicit send restarts following");
  state = select(state, { type: "select", id: "request:approval" });
  assert.equal(select(state, { type: "snapshot", generation: "g1", messages: streaming }).selectedItemId, "request:approval");
  state = select(state, { type: "snapshot", generation: "g2", messages: [message("rebound-reply", 11)] });
  assert.equal(state.selectedItemId, "rebound-reply", "a new binding generation resets selection and old reply tracking");
  assert.equal(state.replyTo, undefined);
});

test("conversation initializes empty and user-only snapshots once without stealing focus on refresh", () => {
  const select = selectionLogic();
  let state = select({}, { type: "snapshot", generation: "g1", messages: [] });
  assert.equal(state.selectedItemId, "status");
  state = select(state, { type: "select", id: "older" });
  assert.equal(select(state, { type: "snapshot", generation: "g1", messages: [] }).selectedItemId, "older");
  const user: Message = { id: "user", role: "user", createdAt: 1, text: "prompt", state: "queued" };
  state = select({}, { type: "snapshot", generation: "g1", messages: [user] });
  assert.equal(state.selectedItemId, "user");
  assert.equal(select(state, { type: "snapshot", generation: "g1", messages: [user] }), state);
});


test("remote setup prompt keeps names as data and clearly discloses pull handoff",()=>{
  const code="ARGO-"+"a".repeat(32);
  const prompt=remotePrompt("backend\nnot a shell command","http://127.0.0.1:49123",code);
  assert.ok(prompt.includes("https://github.com/MatrixA/argo/blob/v0.1.0/docs/connect.md"));
  assert.ok(prompt.includes(JSON.stringify("backend\nnot a shell command")));
  assert.ok(prompt.includes(code));assert.match(prompt,/waiting occupies this session/);assert.match(prompt,/stdin/);
  assert.throws(()=>remotePrompt("backend","https://public.example",code));
  assert.throws(()=>remotePrompt("backend","http://127.0.0.1:49123","invalid"));
});

test("Raycast pairing uses admin authentication only for creation and cancellation",async()=>{
  const code="ARGO-"+"b".repeat(32);const seen:string[]=[];
  const server=createServer(async(request,response)=>{
    assert.equal(request.headers.authorization,`Bearer ${token}`);
    assert.equal(request.url,"/v1/pairings");seen.push(request.method!);
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(request.method==="POST"){assert.deepEqual(body,{name:"backend",adapter:"claude"});response.writeHead(201,{"Content-Type":"application/json"}).end(JSON.stringify({code,expiresAt:Date.now()+600000}));}
    else{assert.deepEqual(body,{code});response.writeHead(200).end("{}");}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address==="object");
  const hub=new Hub({url:`http://127.0.0.1:${address.port}`,token});
  try{assert.equal((await hub.createPairing("backend")).code,code);await hub.cancelPairing(code);assert.deepEqual(seen,["POST","DELETE"]);}
  finally{hub.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
