import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { Store, secret } from "../packages/bridge/src/store.js";
import { Connection } from "../packages/connector/src/connection.js";

const capabilities = { send: true, streaming: false, interrupt: false, approvals: true, questions: false };
const frame = { type: "register" as const, version: 1 as const, nativeSessionId: "native", runtimeId: "runtime", machine: "host", cwd: "/test", capabilities };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Condition timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("malformed unauthenticated upgrade cannot crash the bridge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-upgrade-"));
  const source = `import {startBridge} from './packages/bridge/src/server.ts'; const bridge=await startBridge({database:process.env.TEST_DB,token:'test-secret',port:0}); console.log(bridge.url); process.on('SIGTERM',async()=>{await bridge.close();process.exit(0)});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { env: { ...process.env, TEST_DB: join(directory, "bridge.sqlite") }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  try {
    await until(() => output.includes("http://"));
    const url = new URL(output.trim());
    const socket = connect(Number(url.port), "127.0.0.1"); socket.on("error", () => {}); socket.resume();
    await once(socket, "connect");
    socket.end(`GET http://[ HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    await once(socket, "close");
    const response = await fetch(url.origin + "/v1/sessions", { headers: { Authorization: "Bearer test-secret" } });
    assert.equal(response.status, 200);
  } finally {
    child.kill("SIGTERM"); if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("connector retries a temporary rejected WebSocket handshake", async () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-retry-"));
  const server = createServer(); const wss = new WebSocketServer({ noServer: true }); let attempts = 0;
  server.on("upgrade", (request, socket, head) => {
    if (++attempts === 1) { socket.end("HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(request, socket, head, ws => ws.on("message", raw => {
      if (JSON.parse(raw.toString()).type === "register") ws.send(JSON.stringify({ type: "registered", bindingId: "binding", generation: "generation" }));
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  const connection = new Connection({ version: 1, adapter: "claude", url: `http://127.0.0.1:${address.port}`, bindingId: "binding", token: secret() }, join(directory, "outbox.sqlite"));
  try {
    connection.start({ ...frame, async handle() {}, async close() {} });
    await connection.ready(3000); assert.equal(attempts, 2);
  } finally {
    await connection.close(); for (const socket of wss.clients) socket.terminate(); wss.close();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true });
  }
});

test("lost dispatched send becomes unknown and requires explicit reconciliation", () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-reconcile-")); const store = new Store(join(directory, "store.sqlite"));
  try {
    const grant = store.createGrant("test", "claude"); const generation = store.register(grant.bindingId, frame);
    store.acceptEvent(grant.bindingId, "ready", { type: "status", status: "ready" });
    store.enqueue(grant.bindingId, generation, "lost", "might have reached the agent");
    store.enqueue(grant.bindingId, generation, "next", "queued next");
    const first = store.nextCommand(grant.bindingId); assert.equal(first?.type, "send");
    store.disconnect(grant.bindingId);
    assert.equal(store.message(grant.bindingId, "lost")?.state, "unknown");
    store.register(grant.bindingId, frame); store.acceptEvent(grant.bindingId, "ready-again", { type: "status", status: "ready" });
    assert.equal(store.snapshot(grant.bindingId).session.status, "unknown");
    assert.equal(store.nextCommand(grant.bindingId), undefined, "no automatic execution after uncertain delivery");
    assert.throws(() => store.reconcile(grant.bindingId, "stale", "lost"), /Stale/);
    assert.throws(() => store.reconcile(grant.bindingId, generation, "wrong-message"), /Uncertain message changed/);
    store.reconcile(grant.bindingId, generation, "lost");
    assert.equal(store.message(grant.bindingId, "lost")?.state, "unknown", "reconciliation does not fabricate completion");
    const next = store.nextCommand(grant.bindingId); assert.ok(next?.type === "send"); assert.equal(next.messageId, "next");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("ready without completion stays uncertain; late completion releases queue safely", () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-late-result-")); const store = new Store(join(directory, "store.sqlite"));
  try {
    const grant=store.createGrant("test","claude");const generation=store.register(grant.bindingId,frame);
    store.acceptEvent(grant.bindingId,"ready",{type:"status",status:"ready"});
    store.enqueue(grant.bindingId,generation,"first","test");const command=store.nextCommand(grant.bindingId);assert.ok(command?.type==="send");
    store.acceptEvent(grant.bindingId,"unexpected-ready",{type:"status",status:"ready"});
    assert.equal(store.message(grant.bindingId,"first")?.state,"unknown");
    store.acceptEvent(grant.bindingId,"late-receipt",{type:"receipt",commandId:command.commandId,messageId:"first",state:"accepted"});
    assert.equal(store.message(grant.bindingId,"first")?.state,"unknown","receipt alone is not a completed result");
    store.acceptEvent(grant.bindingId,"done",{type:"completed",messageId:"first"});
    assert.equal(store.message(grant.bindingId,"first")?.state,"completed");assert.equal(store.snapshot(grant.bindingId).session.status,"ready");
    assert.equal(store.snapshot(grant.bindingId).session.uncertainMessageId,undefined);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test("restart persists a cursor change for offline, unknown and expired state", () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-restart-events-")); const path = join(directory, "store.sqlite"); let store = new Store(path);
  try {
    const grant = store.createGrant("test", "claude"); const generation = store.register(grant.bindingId, frame);
    store.acceptEvent(grant.bindingId, "ready", { type: "status", status: "ready" });
    store.enqueue(grant.bindingId, generation, "in-flight", "test"); store.nextCommand(grant.bindingId);
    store.acceptEvent(grant.bindingId, "approval", { type: "interaction", interaction: { requestId: "request", kind: "approval", title: "Confirm", detail: "test", expiresAt: Date.now() + 30000 } });
    const cursor = store.cursor(); store.close(); store = new Store(path);
    assert.ok(store.cursor() > cursor); assert.ok(store.events(cursor).some(event => event.bindingId === grant.bindingId));
    const snapshot = store.snapshot(grant.bindingId); assert.equal(snapshot.session.online, false);
    assert.equal(snapshot.messages[0]?.state, "unknown"); assert.equal(snapshot.interactions[0]?.state, "expired");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
