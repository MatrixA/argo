import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { startBridge } from "../packages/bridge/src/server.js";
import { hash, readBridgeId, secret } from "../packages/bridge/src/store.js";

type Bridge = Awaited<ReturnType<typeof startBridge>>;
type Invitation = { code: string; expiresAt: number; bridgeId: string };
type Client = { token: string; bridgeId: string };
type Discovery = { service: "argo"; protocol: 1; bridgeId: string; publicKey: string; challenge: string; signature: string };
function request(bridge: Bridge, path: string, method = "GET", body?: unknown, token?: string, headers: Record<string,string> = {}) {
  return fetch(bridge.url + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function invite(bridge: Bridge, admin: string): Promise<Invitation> {
  const response = await request(bridge, "/v1/client-pairings", "POST", {}, admin);
  assert.equal(response.status, 201);
  return response.json() as Promise<Invitation>;
}
async function claim(bridge: Bridge, code: string): Promise<Client> {
  const response = await request(bridge, "/v1/client-pairings/claim", "POST", { code });
  assert.equal(response.status, 201);
  return response.json() as Promise<Client>;
}
function connectorStatus(bridge: Bridge, binding: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridge.url.replace("http:", "ws:") + `/v1/connectors/${binding}`, { headers: { Authorization: `Bearer ${token}` } });
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
    ws.once("open", () => { ws.terminate(); reject(new Error("UI token unexpectedly opened a connector")); });
  });
}

test("signed discovery exposes only persistent public identity and rejects invalid/native-boundary requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-discovery-"));
  const database = join(directory, "bridge.sqlite"), admin = secret();
  let bridge = await startBridge({ database, token: admin, port: 0 });
  try {
    const invitation = await invite(bridge, admin);
    const client = await claim(bridge, invitation.code);
    bridge.store.createGrant("private session name", "claude");
    const challenge = randomBytes(16).toString("hex");
    const response = await request(bridge, `/v1/discovery?challenge=${challenge}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const discovery = await response.json() as Discovery;
    assert.deepEqual(Object.keys(discovery).sort(), ["service", "protocol", "bridgeId", "publicKey", "challenge", "signature"].sort());
    assert.equal(discovery.service, "argo"); assert.equal(discovery.protocol, 1); assert.equal(discovery.challenge, challenge);
    assert.match(discovery.bridgeId, /^[a-f0-9]{64}$/);
    const publicDer = Buffer.from(discovery.publicKey, "base64");
    assert.equal(createHash("sha256").update(publicDer).digest("hex"), discovery.bridgeId);
    assert.equal(readBridgeId(database), discovery.bridgeId);
    const persisted = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(persisted.prepare("SELECT value FROM metadata WHERE key='bridge_public_key'").get()?.value, discovery.publicKey); }
    finally { persisted.close(); }
    const key = createPublicKey({ key: publicDer, format: "der", type: "spki" });
    assert.equal(key.asymmetricKeyType, "ed25519");
    const signature = Buffer.from(discovery.signature, "base64");
    const payload = (nonce: string, id = discovery.bridgeId) => Buffer.from(`argo-discovery-v1\n${nonce}\n${id}`, "utf8");
    assert.ok(verify(null, payload(challenge), key, signature));
    assert.equal(verify(null, payload("0".repeat(32)), key, signature), false);
    assert.equal(verify(null, payload(challenge, "0".repeat(64)), key, signature), false);
    signature[0] = signature[0]! ^ 1;
    assert.equal(verify(null, payload(challenge), key, signature), false);
    for (const value of [admin, client.token, invitation.code, "private session name", String(bridge.store.db.prepare("SELECT value FROM metadata WHERE key='bridge_identity'").get()?.value)]) {
      assert.ok(!JSON.stringify(discovery).includes(value));
    }
    for (const query of ["", "?challenge=short", `?challenge=${"A".repeat(32)}`, `?challenge=${"0".repeat(33)}`, `?challenge=${challenge}&challenge=${challenge}`]) {
      assert.equal((await request(bridge, "/v1/discovery" + query)).status, 409);
    }
    for (const origin of ["https://evil.example", ""]) assert.equal((await request(bridge, `/v1/discovery?challenge=${challenge}`, "GET", undefined, undefined, { Origin: origin })).status, 403);
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(bridge.url + `/v1/discovery?challenge=${challenge}`, { headers: { Host: "evil.example" } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostStatus, 403);
    await bridge.close(); bridge = await startBridge({ database, token: admin, port: 0 });
    const restarted = await (await request(bridge, `/v1/discovery?challenge=${challenge}`)).json();
    assert.deepEqual(restarted, discovery, "identity and deterministic Ed25519 signature survive restart");
    assert.equal((await request(bridge, "/v1/sessions", "GET", undefined, client.token)).status, 200, "client authority is durable");
  } finally { await bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("client pairing is hashed, atomic, expiring, restart-safe and never returns the admin token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-client-pairing-"));
  const database = join(directory, "bridge.sqlite"), admin = secret();
  let bridge = await startBridge({ database, token: admin, port: 0 });
  try {
    assert.equal((await request(bridge, "/v1/client-pairings", "POST", {})).status, 401);
    assert.equal((await request(bridge, "/v1/client-pairings", "POST", { unexpected: true }, admin)).status, 409);
    const before = Date.now(), invitation = await invite(bridge, admin);
    assert.deepEqual(Object.keys(invitation).sort(), ["code", "expiresAt", "bridgeId"].sort());
    assert.match(invitation.code, new RegExp(`^ARGO-CLIENT-${invitation.bridgeId}-[a-f0-9]{32}$`));
    assert.ok(invitation.expiresAt >= before + 600_000 && invitation.expiresAt <= Date.now() + 600_000);
    assert.equal(bridge.store.db.prepare("SELECT hash FROM client_pairings").get()?.hash, hash(invitation.code));
    assert.equal(bridge.store.list().length, 0, "UI invitation does not create a connector/session");
    for (const path of ["/v1/client-pairings", "/v1/client-pairings/claim"]) {
      assert.equal((await request(bridge, path, "POST", path.endsWith("claim") ? { code: invitation.code } : {}, admin, { Origin: "https://evil.example" })).status, 403);
    }
    assert.equal((await request(bridge, "/v1/client-pairings/claim", "POST", { code: invitation.code, name: "override" })).status, 409);
    const attempts = await Promise.all([request(bridge, "/v1/client-pairings/claim", "POST", { code: invitation.code }), request(bridge, "/v1/client-pairings/claim", "POST", { code: invitation.code })]);
    assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409]);
    const client = await attempts.find(response => response.status === 201)!.json() as Client;
    assert.deepEqual(Object.keys(client).sort(), ["token", "bridgeId"].sort());
    assert.equal(client.bridgeId, invitation.bridgeId); assert.match(client.token, /^[a-f0-9]{64}$/); assert.notEqual(client.token, admin);
    assert.equal(bridge.store.db.prepare("SELECT hash FROM clients").get()?.hash, hash(client.token));
    assert.equal(bridge.store.db.prepare("SELECT count(*) AS n FROM client_pairings").get()?.n, 0);
    assert.ok(!JSON.stringify(bridge.store.db.prepare("SELECT * FROM clients").all()).includes(client.token));
    assert.ok(!JSON.stringify(bridge.store.db.prepare("SELECT * FROM client_pairings").all()).includes(invitation.code));
    const pending = await invite(bridge, admin);
    await bridge.close(); bridge = await startBridge({ database, token: admin, port: 0 });
    assert.equal((await request(bridge, "/v1/sessions", "GET", undefined, client.token)).status, 200);
    assert.equal((await request(bridge, "/v1/client-pairings/claim", "POST", { code: invitation.code })).status, 409);
    assert.equal((await claim(bridge, pending.code)).bridgeId, invitation.bridgeId);
    const expired = await invite(bridge, admin);
    bridge.store.db.prepare("UPDATE client_pairings SET expires=1 WHERE hash=?").run(hash(expired.code));
    assert.equal((await request(bridge, "/v1/client-pairings/claim", "POST", { code: expired.code })).status, 409);
    for (const code of ["sensitive-malformed-code", `ARGO-CLIENT-${"f".repeat(64)}-${"0".repeat(32)}`]) {
      const invalid = await request(bridge, "/v1/client-pairings/claim", "POST", { code });
      assert.equal(invalid.status, 409); assert.ok(!(await invalid.text()).includes(code));
    }
    const syntaxSecret = "private-secret-in-broken-json";
    const invalidJson = await fetch(bridge.url + "/v1/client-pairings/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: `{"code":"${syntaxSecret}"` });
    assert.equal(invalidJson.status, 400); assert.ok(!(await invalidJson.text()).includes(syntaxSecret));
  } finally { await bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("paired UI authority supports session administration but cannot invite clients, revoke clients or bind connectors; revocation closes only client SSE", async () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-client-authority-")), admin = secret();
  const bridge = await startBridge({ database: join(directory, "bridge.sqlite"), token: admin, port: 0 });
  const controller = new AbortController();
  try {
    const client = await claim(bridge, (await invite(bridge, admin)).code);
    const second = await claim(bridge, (await invite(bridge, admin)).code);
    assert.equal((await request(bridge, "/v1/client-pairings", "POST", {}, client.token)).status, 403);
    assert.equal((await request(bridge, "/v1/clients", "DELETE", undefined, client.token)).status, 403);
    assert.equal((await request(bridge, "/v1/clients", "DELETE")).status, 401);
    assert.equal((await request(bridge, "/v1/clients", "DELETE", undefined, admin, { Origin: "https://evil.example" })).status, 403);
    const grantResponse = await request(bridge, "/v1/grants", "POST", { name: "UI-owned session", adapter: "claude" }, client.token);
    assert.equal(grantResponse.status, 201);
    const grant = await grantResponse.json() as { bindingId: string; token: string };
    assert.equal((await request(bridge, "/v1/client-pairings", "POST", {}, grant.token)).status, 401);
    assert.equal((await request(bridge, "/v1/clients", "DELETE", undefined, grant.token)).status, 401);
    assert.equal((await request(bridge, "/v1/sessions", "GET", undefined, grant.token)).status, 401);
    assert.equal(await connectorStatus(bridge, grant.bindingId, client.token), 401);
    assert.equal(await connectorStatus(bridge, grant.bindingId, admin), 401);
    assert.equal(bridge.store.authenticate(grant.bindingId, grant.token), true);
    const snapshot = await request(bridge, `/v1/sessions/${grant.bindingId}`, "GET", undefined, client.token);
    assert.equal(snapshot.status, 200); assert.ok(!(await snapshot.text()).includes(client.token));
    assert.equal((await request(bridge, "/v1/sessions", "GET", undefined, client.token, { Origin: "https://evil.example" })).status, 403);
    const pairing = await request(bridge, "/v1/pairings", "POST", { name: "connector", adapter: "codex" }, client.token);
    assert.equal(pairing.status, 201);
    assert.equal((await request(bridge, "/v1/pairings", "DELETE", { code: (await pairing.json() as { code: string }).code }, client.token)).status, 200);
    const cursor = bridge.store.cursor();
    const subscribe = (token: string) => fetch(bridge.url + `/v1/events?after=${cursor}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    const streams = await Promise.all([subscribe(client.token), subscribe(second.token), subscribe(admin)]);
    assert.ok(streams.every(response => response.status === 200));
    const readers = streams.map(response => response.body!.getReader());
    for (const reader of readers) assert.match(new TextDecoder().decode((await reader.read()).value), /: connected/);
    assert.equal((await request(bridge, "/v1/clients", "DELETE", undefined, admin)).status, 200);
    for (const reader of readers.slice(0, 2)) assert.equal((await reader.read()).done, true, "revoked clients cannot retain an SSE subscription");
    for (const token of [client.token, second.token]) {
      assert.equal((await request(bridge, "/v1/sessions", "GET", undefined, token)).status, 401);
      assert.equal((await request(bridge, "/v1/events", "GET", undefined, token)).status, 401);
    }
    assert.equal((await request(bridge, `/v1/sessions/${grant.bindingId}`, "DELETE", undefined, admin)).status, 200);
    assert.match(new TextDecoder().decode((await readers[2]!.read()).value), /"type":"revoked"/, "admin SSE remains active");
    assert.equal((await request(bridge, "/v1/sessions", "GET", undefined, admin)).status, 200);
    assert.equal((await claim(bridge, (await invite(bridge, admin)).code)).bridgeId, bridge.store.bridgeId, "admin can pair again after recovery");
  } finally { controller.abort(); await bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("client invitations cap pending codes at 20, prune expired entries and bound all unauthenticated claim attempts to 60 per minute", async () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-client-bounds-")), admin = secret();
  const bridge = await startBridge({ database: join(directory, "bridge.sqlite"), token: admin, port: 0 });
  try {
    for (let index = 0; index < 20; index++) await invite(bridge, admin);
    assert.equal((await request(bridge, "/v1/client-pairings", "POST", {}, admin)).status, 409);
    assert.equal(bridge.store.db.prepare("SELECT count(*) AS n FROM client_pairings").get()?.n, 20);
    bridge.store.db.prepare("UPDATE client_pairings SET expires=1").run();
    const fresh = await invite(bridge, admin);
    assert.equal(bridge.store.db.prepare("SELECT count(*) AS n FROM client_pairings").get()?.n, 1);
    const wrong = `ARGO-CLIENT-${bridge.store.bridgeId}-${"0".repeat(32)}`;
    for (let index = 0; index < 60; index++) {
      // Malformed requests consume attempts too, across connector and UI exchanges.
      const path = index % 2 ? "/v1/client-pairings/claim" : "/v1/pairings/claim";
      assert.equal((await request(bridge, path, "POST", { code: wrong })).status, 409);
    }
    assert.equal((await request(bridge, "/v1/client-pairings/claim", "POST", { code: fresh.code })).status, 429);
    assert.equal((await request(bridge, "/v1/pairings/claim", "POST", { code: "ARGO-" + "0".repeat(32) })).status, 429);
    assert.equal((await request(bridge, "/v1/sessions", "GET", undefined, admin)).status, 200);
    assert.equal((await request(bridge, `/v1/discovery?challenge=${"0".repeat(32)}`)).status, 200);
  } finally { await bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("failed bridge port binds release resources and preserve EADDRINUSE for bootstrap retries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-client-bind-")), admin = secret();
  const bridge = await startBridge({ database: join(directory, "bridge.sqlite"), token: admin, port: 0 });
  try {
    // A child must naturally exit; leaked heartbeat intervals keep this check alive.
    const source = `import assert from 'node:assert/strict';
      import {startBridge} from './packages/bridge/src/server.ts';
      for(let i=0;i<2;i++) await assert.rejects(startBridge({database:process.env.TEST_DB,token:'unused',port:Number(process.env.TEST_PORT)}),{code:'EADDRINUSE'});
      console.log('released');`;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      env: { ...process.env, TEST_DB: join(directory, "retry.sqlite"), TEST_PORT: new URL(bridge.url).port }, timeout: 5000,
    });
    assert.match(result.stdout, /released/);
    assert.equal((await request(bridge, "/v1/sessions", "GET", undefined, admin)).status, 200);
  } finally { await bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("public bridge identity pinning is read-only, handles legacy state and rejects corruption", () => {
  const directory = mkdtempSync(join(tmpdir(), "argo-client-pin-")), database = join(directory, "legacy.sqlite");
  try {
    assert.equal(readBridgeId(database), undefined); assert.equal(existsSync(database), false);
    const db = new DatabaseSync(database);
    try {
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
      db.prepare("INSERT INTO sessions VALUES ('untouched',?)").run('{"online":true}');
      assert.equal(readBridgeId(database), undefined);
      db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      assert.equal(readBridgeId(database), undefined);
      db.prepare("INSERT INTO metadata VALUES ('bridge_public_key',?)").run("not-a-public-key");
      assert.throws(() => readBridgeId(database), /Invalid persisted bridge public identity/);
      assert.equal(db.prepare("SELECT data FROM sessions").get()?.data, '{"online":true}', "pinning never recovers a live session");
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
