import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { z } from "zod";
import { createCodexAdapter, JsonRpc, listCodexThreads } from "../packages/connector/src/codex.js";
import { agentEventSchema, type AgentEvent } from "../packages/shared/src/protocol.js";

const THREAD = "019b1234-1234-7123-8123-123456789abc";
const TURN = "019b1234-1234-7123-8123-123456789def";

// This is a fake Codex child, not a live runtime/model test. One real pipe in each direction.
const fakeSource = String.raw`
const readline = require('node:readline');
const threadId = '${THREAD}', turnId = '${TURN}';
const mode = process.argv[1];
const thread = {id: threadId, cwd: '/fake/project', name: 'metadata only', turns: [], status: {type: mode === 'busy' ? 'active' : 'idle', ...(mode === 'busy' ? {activeFlags: []} : {})}};
const output = value => process.stdout.write(JSON.stringify(value)+'\n');
const notification = (method, params) => output({method, params:{threadId,...params}});
const request = (method, id, params={}) => output({id,method,params:{threadId,turnId,itemId:'item-1',...params}});
const ok = (id,result) => output({id,result});
let started = false;
readline.createInterface({input: process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  const p = frame.params;
  const check = (value, expected) => { if(JSON.stringify(value)!==JSON.stringify(expected)) process.exit(77); };
  if(!frame.method) {
    // Echo server responses as agent text; tests can inspect the exact native id/type and payload.
    notification('item/completed',{turnId,item:{id:'response-'+JSON.stringify(frame.id),type:'agentMessage',text:JSON.stringify(frame)}});
    return;
  }
  switch(frame.method) {
    case 'initialize':
      if(mode === 'exit') {process.stderr.write('TOP SECRET credentials');process.exit(8);}
      if(mode === 'malformed') {process.stdout.write('{bad json}\n');return;}
      if(mode === 'oversized') {process.stdout.write('x'.repeat(1024*1024+1));return;}
      if(mode === 'timeout') return;
      ok(frame.id,{userAgent:'fake-codex'});break;
    case 'initialized': break;
    case 'thread/loaded/list':
      if(!p.cursor) ok(frame.id,{data:['other-thread'],nextCursor:'page-2'});
      else ok(frame.id,{data:mode==='unloaded'?[]:[threadId],nextCursor:null});
      break;
    case 'thread/read':
      check(p,{threadId,includeTurns:false});
      if(mode==='notLoaded') thread.status={type:'notLoaded'};
      ok(frame.id,{thread});break;
    case 'thread/resume':
      check(p,{threadId,excludeTurns:true});
      if(mode==='mismatch') thread.id='unexpected';
      ok(frame.id,{thread});
      if(mode==='interactions') {
        request('item/commandExecution/requestApproval',7,{kind:'command',command:'echo safe',reason:null,cwd:'/fake/project'});
        request('item/commandExecution/requestApproval','7',{kind:'writeStdin',command:'stdin content',reason:null});
        request('item/fileChange/requestApproval','file/id with spaces',{reason:'edit one file',grantRoot:null});
        request('item/permissions/requestApproval','permissions',{reason:'read',permissions:{network:{enabled:true},fileSystem:{read:['/requested'],write:null}}});
        request('item/tool/requestUserInput','question',{isBlocking:true,autoResolutionMs:null,questions:[{id:'native question / 1',header:'Pick',question:'Which?',isOther:false,isSecret:false,options:[{label:'one',description:'first'}]}]});
        request('item/tool/requestUserInput','expired',{isBlocking:true,autoResolutionMs:10,questions:[{id:'q',header:'Soon',question:'Soon?',isOther:true,isSecret:false,options:null}]});
        request('item/fileChange/requestApproval','terminal',{reason:'terminal resolves',grantRoot:null});
        request('item/tool/call','unknown',{name:'unsupported'});
        request('item/fileChange/requestApproval','foreign',{threadId:'other-thread',reason:'ignore'});
        request('item/permissions/requestApproval','invalid',{permissions:{network:{enabled:true,unexpected:true},fileSystem:null}});
        request('item/fileChange/requestApproval','session-root',{reason:'session scope',grantRoot:'/'});
        request('item/tool/requestUserInput','secret',{isBlocking:true,autoResolutionMs:null,questions:[{id:'secret',header:'Secret',question:'Password?',isOther:true,isSecret:true,options:null}]});
        setTimeout(()=>notification('serverRequest/resolved',{requestId:'terminal'}),50);
      }
      break;
    case 'turn/start':
      check(p,{threadId,clientUserMessageId:'user-1',input:[{type:'text',text:'hello',text_elements:[]}]});
      started=true;
      notification('turn/started',{turn:{id:turnId,status:'inProgress'}});
      notification('item/agentMessage/delta',{turnId,itemId:'native item / 1',delta:'hel'});
      notification('item/agentMessage/delta',{threadId:'other-thread',turnId,itemId:'foreign',delta:'LEAK'});
      notification('item/agentMessage/delta',{turnId,itemId:'native item / 1',delta:'lo'});
      notification('item/completed',{turnId,item:{id:'native item / 1',type:'agentMessage',text:'hello final'}});
      if(mode==='send-error') output({id:frame.id,error:{code:-1,message:'TOP SECRET provider failure'}});
      else ok(frame.id,{turn:{id:turnId,status:'inProgress'}});
      if(mode==='complete') setTimeout(()=>{
        notification('turn/completed',{turn:{id:turnId,status:'completed'}});
        const next='native-terminal-turn';
        notification('turn/started',{turn:{id:next,status:'inProgress'}});
        notification('item/completed',{turnId:next,item:{id:'terminal-item',type:'agentMessage',text:'terminal answer'}});
        notification('turn/completed',{turn:{id:next,status:'completed'}});
        notification('thread/status/changed',{status:{type:'idle'}});
      },15);
      break;
    case 'turn/interrupt':
      check(p,{threadId,turnId});
      if(!started) process.exit(78);
      ok(frame.id,{});notification('turn/completed',{turn:{id:turnId,status:'interrupted'}});break;
    case 'test/exit': ok(frame.id,{});process.exit(9);break;
  }
});
`;
function fake(mode = "default") { return spawn(process.execPath, ["-e", fakeSource, mode], { stdio: ["pipe", "pipe", "pipe"] }); }
async function waitFor(predicate: () => boolean, label = "event") {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await delay(5); }
}
function sink() {
  const events: AgentEvent[] = [];
  return { events, emit: (event: AgentEvent) => { agentEventSchema.parse(event); events.push(event); } };
}
const send = { type: "send" as const, commandId: "command-1", messageId: "user-1", text: "hello" };

test("loaded pagination, metadata-only resume and confirmed send/interrupt on the same native thread", async () => {
  const { events, emit } = sink();
  const child = fake();
  const adapter = await createCodexAdapter({ threadId: THREAD, transportFactory: () => new JsonRpc(child) }, emit);
  try {
    assert.equal(adapter.nativeSessionId, THREAD);
    assert.equal(adapter.cwd, "/fake/project");
    assert.deepEqual(events.at(-1), { type: "status", status: "ready" });
    await adapter.handle(send);
    const receipt = events.findIndex((event) => event.type === "receipt");
    const message = events.findIndex((event) => event.type === "message");
    assert.ok(receipt >= 0 && receipt < message, "receipt follows RPC confirmation, then buffered output");
    const messages = events.filter((event) => event.type === "message");
    assert.deepEqual(messages.map((event) => event.text), ["hel", "hello", "hello final"]);
    assert.equal(new Set(messages.map((event) => event.messageId)).size, 1);
    assert.ok(messages.every((event) => event.replyTo === "user-1" && event.turnId === TURN));
    assert.equal(messages.at(-1)?.final, true);
    await adapter.handle({ type: "interrupt", commandId: "interrupt-1" });
    await waitFor(() => events.some((event) => event.type === "completed"));
    assert.ok(events.some((event) => event.type === "completed" && event.messageId === "user-1"));
    await assert.rejects(adapter.handle({ type: "interrupt", commandId: "interrupt-2" }), /active Codex turn/);
  } finally { await adapter.close(); }
  assert.ok(events.some((event) => event.type === "status" && event.status === "offline"));
});

test("native completion restores ready; terminal future messages do not invent replyTo", async () => {
  const { events, emit } = sink();
  const adapter = await createCodexAdapter({ threadId: THREAD, transportFactory: () => new JsonRpc(fake("complete")) }, emit);
  try {
    await adapter.handle(send);
    await waitFor(() => events.filter((event) => event.type === "completed").length === 2);
    const terminal = events.find((event) => event.type === "message" && event.text === "terminal answer");
    assert.ok(terminal?.type === "message"); assert.equal(terminal.replyTo, undefined);
    const completed = events.filter((event) => event.type === "completed");
    assert.equal(completed[0]?.messageId, "user-1"); assert.equal(completed[1]?.messageId, undefined);
    assert.deepEqual(events.at(-1), { type: "status", status: "ready" });
  } finally { await adapter.close(); }
});

test("initial busy comes from native status, but interrupt refuses an unknown current turn", async () => {
  const { events, emit } = sink();
  const adapter = await createCodexAdapter({ threadId: THREAD, transportFactory: () => new JsonRpc(fake("busy")) }, emit);
  try {
    assert.deepEqual(events.at(-1), { type: "status", status: "busy" });
    await assert.rejects(adapter.handle({ type: "interrupt", commandId: "stop" }), /not known/);
  } finally { await adapter.close(); }
});

test("refuses unloaded, inconsistent, malformed and oversized transports without leaking stderr", async () => {
  for (const mode of ["unloaded", "notLoaded", "mismatch", "exit", "malformed", "oversized"]) {
    const { events, emit } = sink();
    await assert.rejects(createCodexAdapter({ threadId: THREAD, transportFactory: () => new JsonRpc(fake(mode)) }, emit), (error: Error) => {
      assert.doesNotMatch(error.message, /TOP SECRET/); return true;
    });
    assert.ok(events.some((event) => event.type === "status" && ["offline", "error"].includes(event.status)));
  }
});

test("server error is safe and does not pretend a submission was accepted", async () => {
  const { events, emit } = sink();
  const adapter = await createCodexAdapter({ threadId: THREAD, transportFactory: () => new JsonRpc(fake("send-error")) }, emit);
  try {
    await assert.rejects(adapter.handle(send), /could not be confirmed/);
    assert.ok(!events.some((event) => event.type === "receipt"));
    assert.ok(events.filter((event) => event.type === "message").every((event) => event.replyTo === undefined));
  } finally { await adapter.close(); }
});

test("JSONL request timeout rejects and closes; child exit never crashes the parent", async () => {
  const child = fake("timeout");
  const exit = once(child, "exit");
  const rpc = new JsonRpc(child, 20);
  let status: string | undefined;
  rpc.onClose = (value) => { status = value; };
  await assert.rejects(rpc.request("initialize", {}, z.unknown()), /could not be confirmed/);
  assert.equal(status, "error"); assert.equal(rpc.closed, true);
  await exit;
  const next = new JsonRpc(fake());
  await next.request("test/exit", {}, z.object({}));
  await waitFor(() => next.closed);
});

test("approvals, permissions and question decisions preserve native RPC ids and resolve once", async () => {
  const { events, emit } = sink();
  const adapter = await createCodexAdapter({ threadId: THREAD, transportFactory: () => new JsonRpc(fake("interactions")) }, emit);
  try {
    await waitFor(() => events.filter((event) => event.type === "interaction").length === 8);
    const interactions = events.filter((event) => event.type === "interaction").map((event) => event.interaction);
    assert.equal(new Set(interactions.map((item) => item.requestId)).size, interactions.length);
    assert.ok(interactions.every((item) => /^[\w:.-]+$/.test(item.requestId)));
    const responses = () => events.filter((event) => event.type === "message").map((event) => JSON.parse(event.text) as { id: string | number; result?: any; error?: { code: number } });
    for (const [index, decision] of [[0, "allow"], [1, "deny"], [2, "allow"], [3, "allow"]] as const) {
      const item = interactions[index]!;
      await adapter.handle({ type: "answer", commandId: `answer-${index}`, requestId: item.requestId, answer: { decision } });
      await assert.rejects(adapter.handle({ type: "answer", commandId: `duplicate-${index}`, requestId: item.requestId, answer: { decision } }), /no longer pending/);
    }
    const question = interactions[4]!;
    await assert.rejects(adapter.handle({ type: "answer", commandId: "bad", requestId: question.requestId, answer: { answers: { [question.questions![0]!.id]: ["invalid"] } } }), /Invalid Codex/);
    await adapter.handle({ type: "answer", commandId: "question", requestId: question.requestId, answer: { answers: { [question.questions![0]!.id]: ["one"] } } });
    const sessionGrant = interactions.find((item) => item.detail.includes('"grantRoot":"/"'))!;
    await assert.rejects(adapter.handle({ type: "answer", commandId: "root", requestId: sessionGrant.requestId, answer: { decision: "allow" } }), /Session-wide/);
    const terminal = interactions[6]!;
    await waitFor(() => events.some((event) => event.type === "interactionResolved" && event.requestId === terminal.requestId));
    await assert.rejects(adapter.handle({ type: "answer", commandId: "late-terminal", requestId: terminal.requestId, answer: { decision: "allow" } }), /no longer pending/);
    const expired = interactions[5]!;
    await waitFor(() => events.some((event) => event.type === "interactionResolved" && event.requestId === expired.requestId));
    await assert.rejects(adapter.handle({ type: "answer", commandId: "late", requestId: expired.requestId, answer: { answers: {} } }), /no longer pending/);
    await waitFor(() => responses().some((response) => response.id === "question"));
    assert.deepEqual(responses().find((response) => response.id === 7)?.result, { decision: "accept" });
    assert.deepEqual(responses().find((response) => response.id === "7")?.result, { decision: "decline" });
    assert.deepEqual(responses().find((response) => response.id === "file/id with spaces")?.result, { decision: "accept" });
    assert.deepEqual(responses().find((response) => response.id === "permissions")?.result, { permissions: { network: { enabled: true }, fileSystem: { read: ["/requested"], write: null } }, scope: "turn" });
    assert.deepEqual(responses().find((response) => response.id === "question")?.result, { answers: { "native question / 1": { answers: ["one"] } } });
    assert.equal(responses().find((response) => response.id === "unknown")?.error?.code, -32601);
    assert.equal(responses().find((response) => response.id === "invalid")?.error?.code, -32602);
    assert.equal(responses().find((response) => response.id === "secret")?.error?.code, -32602);
    assert.ok(!responses().some((response) => response.id === "foreign"));
    await adapter.close();
    await assert.rejects(adapter.handle({ type: "answer", commandId: "disconnected", requestId: sessionGrant.requestId, answer: { decision: "allow" } }), /could not be confirmed/);
  } finally { await adapter.close(); }
});

test("native WebSocket framing over proxy-style pipes uses ws upgrade and bounds payloads", async () => {
  const source = String.raw`
    const { Duplex } = require('node:stream');
    const { createServer } = require('node:http');
    const { WebSocketServer } = require('ws');
    const stream = Duplex.from({readable: process.stdin, writable: process.stdout});
    const server = createServer();
    const wss = new WebSocketServer({noServer:true});
    server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => {
      ws.on('message', buffer => {
        const frame = JSON.parse(buffer.toString());
        if(frame.method==='oversized') ws.send('x'.repeat(1024*1024+1));
        else ws.send(JSON.stringify({id:frame.id,result:{userAgent:'fake-native-ws'}}));
      });
    }));
    server.emit('connection',stream);
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  const rpc = new JsonRpc(child, 2000, true);
  try {
    const result = await rpc.request("initialize", {}, z.object({ userAgent: z.string() }));
    assert.equal(result.userAgent, "fake-native-ws");
    await assert.rejects(rpc.request("oversized", {}, z.unknown()), /could not be confirmed/);
    assert.equal(rpc.closed, true);
  } finally { rpc.stop(); }
});

// Explicit opt-in: isolated CODEX_HOME, empty thread/start, second proxy resume; NO turn/start/model call.
// Uses a short /tmp socket because macOS Unix-domain paths have a 104-byte ceiling.
test("live isolated app-server rejoin (no model requests)", { skip: process.env.ARGO_CODEX_LIVE !== "1", timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".context/codex-live-"));
  const socketDir = await mkdtemp("/tmp/argo-codex-");
  const socket = join(socketDir, "control.sock");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CODEX_|OPENAI_|AZURE_OPENAI_)/.test(name)));
  env.CODEX_HOME = root;
  const server = spawn("codex", ["app-server", "--listen", `unix://${socket}`], { env, stdio: ["pipe", "pipe", "pipe"] });
  server.stdout.resume(); server.stderr.resume();
  let primary: JsonRpc | undefined;
  let adapter: Awaited<ReturnType<typeof createCodexAdapter>> | undefined;
  try {
    const { existsSync } = await import("node:fs");
    await waitFor(() => existsSync(socket), "isolated socket");
    t.diagnostic("isolated socket ready");
    primary = new JsonRpc(spawn("codex", ["app-server", "proxy", "--sock", socket], { env, stdio: ["pipe", "pipe", "pipe"] }), 5000, true);
    await primary.request("initialize", { clientInfo: { name: "argo_live_primary", title: null, version: "0.1.0" }, capabilities: { experimentalApi: true, requestAttestation: false } }, z.object({ userAgent: z.string() }));
    t.diagnostic("primary initialized");
    await primary.write({ method: "initialized", params: {} });
    const started = await primary.request("thread/start", { cwd: root, ephemeral: false }, z.object({ thread: z.object({ id: z.string(), cwd: z.string(), status: z.object({ type: z.string() }) }) }));
    t.diagnostic("empty thread started without model turn");
    const threadId = started.thread.id;
    const { events, emit } = sink();
    // A fresh 0.157.1 thread has no rollout until a user turn, so this native
    // server rejects resume with -32600 "no rollout found" even while loaded.
    // Do not materialize it with a paid turn or silently call that a successful rejoin.
    const listing = await listCodexThreads(socket);
    assert.ok(listing.some((thread) => thread.id === threadId && thread.status === "ready"));
    t.diagnostic("real metadata listing passed; next is empty-thread resume (0.157.1 requires a rollout)");
    adapter = await createCodexAdapter({ threadId, socket, transportFactory: () => new JsonRpc(spawn("codex", ["app-server", "proxy", "--sock", socket], { env, stdio: ["pipe", "pipe", "pipe"] }), 5000, true) }, emit);
    t.diagnostic("second proxy rejoined existing thread");
    assert.equal(adapter.nativeSessionId, threadId); assert.equal(adapter.cwd, started.thread.cwd);
    assert.ok(events.some((event) => event.type === "status" && event.status === "ready"));
    const read = await primary.request("thread/read", { threadId, includeTurns: false }, z.object({ thread: z.object({ id: z.string(), status: z.object({ type: z.string() }) }) }));
    assert.equal(read.thread.id, threadId); assert.equal(read.thread.status.type, "idle");
    t.diagnostic("primary still sees same loaded idle thread");
  } finally {
    await adapter?.close(); primary?.stop(); server.kill();
    if (server.exitCode === null && server.signalCode === null) {
      await Promise.race([once(server, "exit"), delay(1000)]);
      if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await once(server, "exit"); }
    }
    await rm(root, { recursive: true, force: true }); await rm(socketDir, { recursive: true, force: true });
  }
});

test("Raycast HTTP decisions reach Codex RPC with colon-bearing IDs and cannot execute twice", async () => {
  const { startBridge } = await import("../packages/bridge/src/server.js");
  const { secret } = await import("../packages/bridge/src/store.js");
  const { Connection } = await import("../packages/connector/src/connection.js");
  const { Hub } = await import("../extensions/raycast/src/core.js");
  const root = await mkdtemp(join((await import("node:os")).tmpdir(), "argo-codex-http-"));
  const token = secret();
  const bridge = await startBridge({ database: join(root, "bridge.sqlite"), token, port: 0 });
  const grant = bridge.store.createGrant("Synthetic Codex HTTP", "codex");
  const connection = new Connection({ version: 1, adapter: "codex", ...grant, url: bridge.url }, join(root, "outbox.sqlite"));
  const hub = new Hub({ url: bridge.url, token });
  const events: AgentEvent[] = [];
  let adapter: Awaited<ReturnType<typeof createCodexAdapter>> | undefined;
  try {
    adapter = await createCodexAdapter({ threadId: THREAD, transportFactory: () => new JsonRpc(fake("interactions")) }, event => {
      events.push(event); connection.emit(event);
    });
    connection.start(adapter);
    await connection.ready();
    await waitFor(() => bridge.store.snapshot(grant.bindingId).interactions.length === 8);
    const snapshot = await hub.snapshot(grant.bindingId);
    const approvals = snapshot.interactions.filter(i => i.title === "Codex approval (once)" && !i.detail.includes('"grantRoot":"/"') && !i.detail.includes("terminal resolves"));
    const question = snapshot.interactions.find(i => i.kind === "question" && i.questions?.[0]?.question === "Which?")!;
    assert.equal(approvals.length, 3);
    for (const request of [...approvals, question]) {
      assert.match(request.requestId, /^codex:[\w-]+:[a-f0-9]{64}$/);
      const answer = request.kind === "question" ? { answers: { [request.questions![0]!.id]: ["one"] } } : { decision: request.detail.includes('"kind":"writeStdin"') ? "deny" as const : "allow" as const };
      await hub.answerInteraction(grant.bindingId, snapshot.session.generation, request, answer);
      await assert.rejects(hub.answerInteraction(grant.bindingId, snapshot.session.generation, request, answer), /already submitted/);
    }
    const responses = () => events.filter(e => e.type === "message").map(e => JSON.parse(e.text) as { id: string | number; result?: any });
    await waitFor(() => [7, "7", "file/id with spaces", "question"].every(id => responses().some(r => r.id === id)));
    assert.deepEqual(responses().find(r => r.id === 7)?.result, { decision: "accept" });
    assert.deepEqual(responses().find(r => r.id === "7")?.result, { decision: "decline" });
    assert.deepEqual(responses().find(r => r.id === "file/id with spaces")?.result, { decision: "accept" });
    assert.deepEqual(responses().find(r => r.id === "question")?.result, { answers: { "native question / 1": { answers: ["one"] } } });
    for (const nativeId of [7, "7", "file/id with spaces", "question"]) assert.equal(responses().filter(r => r.id === nativeId).length, 1);
  } finally {
    hub.close();
    await adapter?.close();
    await connection.close();
    // Stop the fake native transport before closing the bridge database.
    // Connection.close deliberately does not stop the original Agent.
    await waitFor(() => !bridge.store.get(grant.bindingId).online);
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
