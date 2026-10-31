import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startBridge } from "../packages/bridge/src/server.js";
import { Store, secret } from "../packages/bridge/src/store.js";
import { privateWrite } from "../packages/connector/src/config.js";
import type { ServerReady } from "../packages/connector/src/bootstrap.js";

const entry = resolve("bin/argo.mjs");
const prefix = "ARGO_SERVER_READY ";
function isolated() {
  const root = mkdtempSync(join(tmpdir(), "argo-bootstrap-")), home = join(root, "argo"), bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "native.log");
  for (const binary of ["claude", "codex", "dsh", "npx", "npm", "ssh"]) writeFileSync(join(bin, binary), `#!/bin/sh\nprintf 'unexpected launch\\n' >> '${log}'\nexit 97\n`, { mode: 0o700 });
  mkdirSync(join(root, ".claude")); mkdirSync(join(root, ".codex"));
  const settings = [[join(root, ".claude", "settings.json"), '{"permissions":{"ask":["Bash(*)"]}}\n'], [join(root, ".codex", "config.toml"), 'approval_policy = "untrusted"\n']] as const;
  for (const [path, value] of settings) writeFileSync(path, value);
  const checkUntouched = () => { for (const [path, value] of settings) assert.equal(readFileSync(path, "utf8"), value); assert.equal(existsSync(log), false, "bootstrap launched a native/model executable"); };
  const env = { ...process.env, HOME: root, ARGO_HOME: home, CODEX_HOME: join(root, ".codex"), PATH: bin };
  const cli = (...args: string[]) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
    return {
      child, exited, get stdout() { return stdout; }, get stderr() { return stderr; },
      async ready() {
        await until(() => stdout.includes("\n") || child.exitCode !== null || child.signalCode !== null);
        const line = stdout.split("\n").find(line => line.startsWith(prefix));
        assert.ok(line, `missing ready line: ${stdout}\n${stderr}`);
        return JSON.parse(line.slice(prefix.length)) as ServerReady;
      },
      async stop() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await Promise.race([exited, new Promise((_, reject) => setTimeout(() => { child.kill("SIGKILL"); reject(new Error("owned CLI did not stop")); }, 5000).unref())]); },
    };
  };
  return { root, home, cli, checkUntouched, clean: () => rmSync(root, { recursive: true, force: true }) };
}
async function until(predicate: () => boolean | Promise<boolean>) { const deadline = Date.now() + 10000; while (!await predicate()) { if (Date.now() > deadline) throw new Error("Condition timed out"); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function finished(run: ReturnType<ReturnType<typeof isolated>["cli"]>) {
  const result = await Promise.race([run.exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("CLI did not exit")), 15000).unref())]);
  return { ...result, stdout: run.stdout, stderr: run.stderr };
}
function noSecrets(output: { stdout: string; stderr: string }, ...tokens: string[]) { for (const token of tokens) assert.ok(!(output.stdout + output.stderr).includes(token), "CLI exposed a credential"); }
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void, port = 0) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, port: address.port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
async function request(url: string, path: string, token?: string, method = "GET", body?: unknown) { return fetch(url + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) }); }

// These tests run the built public CLI, not an in-process bootstrap substitute.
test("cold bootstrap skips occupied preferred ports, starts only bridge, pairs UI and reuses identity", async t => {
  const box = isolated();
  const reserved: Awaited<ReturnType<typeof endpoint>>[] = []; let hits = 0;
  for (let port = 49120; port <= 49139; port++) { try { reserved.push(await endpoint((_req, res) => { hits++; json(res, { unrelated: true }); }, port)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; } }
  if (reserved.length < 2) { for (const listener of reserved) await listener.close(); box.clean(); t.skip("preferred range has fewer than two free test ports"); return; }
  const unrelated = reserved[0]!, expectedPort = reserved[1]!.port;
  for (const listener of reserved.slice(1)) await listener.close();
  const run = box.cli("server-bootstrap", "--agent", "codex", "--name", "Existing Codex");
  try {
    const ready = await run.ready();
    assert.deepEqual(Object.keys(ready).sort(), ["bridgeId", "clientPairing", "credential", "port", "reused", "url"].sort());
    assert.equal(ready.port, expectedPort); assert.equal(ready.url, `http://127.0.0.1:${expectedPort}`); assert.equal(ready.reused, false);
    assert.equal(run.child.exitCode, null, "new server must remain foreground");
    assert.equal(readFileSync(join(box.home, "bridge.lock"), "utf8"), String(run.child.pid));
    assert.match(ready.bridgeId, /^[a-f0-9]{64}$/); assert.equal(ready.clientPairing.bridgeId, ready.bridgeId);
    assert.match(ready.clientPairing.code, new RegExp(`^ARGO-CLIENT-${ready.bridgeId}-[a-f0-9]{32}$`));
    const configText = readFileSync(join(box.home, "client.json"), "utf8"), config = JSON.parse(configText);
    const credential = JSON.parse(readFileSync(ready.credential, "utf8"));
    assert.equal(credential.url, ready.url); assert.equal(credential.adapter, "codex"); assert.notEqual(credential.token, config.token);
    assert.equal(statSync(ready.credential).mode & 0o777, 0o600); assert.equal(statSync(join(box.home, "agents")).mode & 0o777, 0o700);
    assert.equal((await request(ready.url, "/v1/sessions", credential.token)).status, 401);
    const before = await (await request(ready.url, "/v1/sessions", config.token)).json();
    assert.equal(before.sessions.length, 1); assert.equal(before.sessions[0].name, "Existing Codex"); assert.equal(before.sessions[0].online, false); assert.equal(before.sessions[0].nativeSessionId, null);
    const claimed = await request(ready.url, "/v1/client-pairings/claim", undefined, "POST", { code: ready.clientPairing.code }); assert.equal(claimed.status, 201);
    const ui = await claimed.json(); assert.equal(ui.bridgeId, ready.bridgeId); assert.notEqual(ui.token, config.token); assert.notEqual(ui.token, credential.token);
    assert.equal((await request(ready.url, "/v1/sessions", ui.token)).status, 200);
    assert.equal((await request(ready.url, "/v1/client-pairings", ui.token, "POST", {})).status, 403);
    assert.equal((await request(ready.url, "/v1/clients", ui.token, "DELETE")).status, 403);
    const reused = box.cli("server-bootstrap", "--agent", "claude", "--name", "Existing Claude"); const again = await reused.ready();
    assert.equal((await finished(reused)).code, 0); assert.equal(again.reused, true); assert.equal(again.bridgeId, ready.bridgeId); assert.equal(again.port, ready.port); assert.notEqual(again.credential, ready.credential);
    assert.notEqual(JSON.parse(readFileSync(again.credential, "utf8")).token, credential.token);
    assert.equal(readFileSync(join(box.home, "client.json"), "utf8"), configText); assert.equal(readFileSync(join(box.home, "bridge.lock"), "utf8"), String(run.child.pid));
    const invite = await finished(box.cli("client-invite")); assert.equal(invite.code, 0, invite.stderr);
    assert.equal(JSON.parse(invite.stdout).bridgeId, ready.bridgeId); assert.notEqual(JSON.parse(invite.stdout).code, again.clientPairing.code);
    assert.equal((await (await request(ready.url, "/v1/sessions", config.token)).json()).sessions.length, 2, "client-invite must not mint an agent grant");
    privateWrite(join(box.home, "client.json"), { url: ready.url, token: ui.token }, true);
    for (const command of ["client-invite", "revoke-clients"]) { const forbidden = await finished(box.cli(command)); assert.notEqual(forbidden.code, 0); noSecrets(forbidden, ui.token, config.token); }
    privateWrite(join(box.home, "client.json"), config, true);
    const revoke = await finished(box.cli("revoke-clients")); assert.equal(revoke.code, 0, revoke.stderr);
    assert.equal((await request(ready.url, "/v1/sessions", ui.token)).status, 401); assert.equal((await request(ready.url, "/v1/sessions", config.token)).status, 200);
    const againToken = JSON.parse(readFileSync(again.credential, "utf8")).token;
    for (const output of [run, reused, invite, revoke]) noSecrets(output, config.token, credential.token, againToken, ui.token);
    assert.equal(hits, 0, "cold start probed/touched an unrelated listener");
    assert.equal((await (await fetch(unrelated.url)).json()).unrelated, true);
    box.checkUntouched();
  } finally { await run.stop(); await unrelated.close(); assert.equal(existsSync(join(box.home, "bridge.lock")), false); box.clean(); }
});

test("offline configured bridge preserves admin token, port, database sessions and identity", async () => {
  const box = isolated(), token = secret(), database = join(box.home, "bridge.sqlite");
  const seed = await startBridge({ database, token, port: 0 });
  const url = seed.url, bridgeId = seed.store.bridgeId, grant = seed.store.createGrant("Preserved", "claude");
  await seed.close(); privateWrite(join(box.home, "client.json"), { url, token });
  const config = readFileSync(join(box.home, "client.json"), "utf8");
  const run = box.cli("server-bootstrap", "--agent", "claude", "--name", "New invocation");
  try {
    const ready = await run.ready(); assert.equal(ready.reused, false); assert.equal(ready.url, url); assert.equal(ready.bridgeId, bridgeId);
    assert.equal(readFileSync(join(box.home, "client.json"), "utf8"), config);
    const sessions = (await (await request(url, "/v1/sessions", token)).json()).sessions;
    assert.equal(sessions.length, 2); assert.ok(sessions.some((session: { id: string }) => session.id === grant.bindingId));
    noSecrets(run, token, grant.token); box.checkUntouched();
  } finally { await run.stop(); box.clean(); }
});

test("explicit occupied port never falls back or writes admin config", async () => {
  const box = isolated(); let hits = 0;
  const unrelated = await endpoint((_req, res) => { hits++; json(res, { unrelated: true }); });
  try {
    const result = await finished(box.cli("server-bootstrap", "--agent", "claude", "--name", "Test", "--port", String(unrelated.port)));
    assert.notEqual(result.code, 0); assert.match(result.stderr, /EADDRINUSE|address already in use/); assert.equal(result.stdout, "");
    assert.equal(existsSync(join(box.home, "client.json")), false); assert.equal(existsSync(join(box.home, "bridge.sqlite")), false); assert.equal(existsSync(join(box.home, "bridge.lock")), false); assert.equal(hits, 0);
    assert.equal((await (await fetch(unrelated.url)).json()).unrelated, true); box.checkUntouched();
  } finally { await unrelated.close(); box.clean(); }
});

test("existing incompatible or mismatched listeners receive no admin token and are never replaced", async () => {
  const box = isolated(), token = secret(), store = new Store(join(box.home, "bridge.sqlite")); store.close();
  let authenticated = 0, mode = "legacy";
  const keys = generateKeyPairSync("ed25519"), der = createPublicKey(keys.privateKey).export({ type: "spki", format: "der" }), bridgeId = createHash("sha256").update(der).digest("hex");
  const listener = await endpoint((req, res) => {
    if (req.headers.authorization) authenticated++;
    const challenge = new URL(req.url!, "http://127.0.0.1").searchParams.get("challenge")!;
    if (mode === "legacy") { json(res, { error: "Not found" }, 404); return; }
    json(res, { service: "argo", protocol: 1, bridgeId, publicKey: der.toString("base64"), challenge, signature: sign(null, Buffer.from(`argo-discovery-v1\n${challenge}\n${bridgeId}`), keys.privateKey).toString("base64") });
  });
  privateWrite(join(box.home, "client.json"), { url: listener.url, token });
  const config = readFileSync(join(box.home, "client.json"), "utf8");
  try {
    const legacy = await finished(box.cli("server-bootstrap", "--agent", "claude", "--name", "Test"));
    assert.notEqual(legacy.code, 0); assert.match(legacy.stderr, /Upgrade Argo.*restart/); assert.equal(legacy.stdout, "");
    mode = "imposter";
    const mismatch = await finished(box.cli("server-bootstrap", "--agent", "claude", "--name", "Test"));
    assert.notEqual(mismatch.code, 0); assert.match(mismatch.stderr, /identity does not match/); assert.equal(mismatch.stdout, "");
    assert.equal(authenticated, 0); assert.equal(readFileSync(join(box.home, "client.json"), "utf8"), config); assert.equal(existsSync(join(box.home, "bridge.lock")), false);
    noSecrets(legacy, token); noSecrets(mismatch, token); box.checkUntouched();
  } finally { await listener.close(); box.clean(); }
});

test("existing config and stale lock are preserved; invalid bootstrap input has no side effects", async () => {
  const box = isolated();
  try {
    for (const extra of [["--agent", "other", "--name", "Test"], ["--agent", "claude", "--name", " "], ["--agent", "claude", "--name", "Test", "--port", "1e4"]]) {
      const result = await finished(box.cli("server-bootstrap", ...extra)); assert.notEqual(result.code, 0); assert.equal(existsSync(box.home), false);
    }
    privateWrite(join(box.home, "client.json"), { unrelated: true, token: secret() });
    const original = readFileSync(join(box.home, "client.json"), "utf8");
    const refused = await finished(box.cli("server-bootstrap", "--agent", "claude", "--name", "Test"));
    assert.notEqual(refused.code, 0); assert.equal(readFileSync(join(box.home, "client.json"), "utf8"), original); assert.equal(existsSync(join(box.home, "bridge.sqlite")), false);
    rmSync(join(box.home, "client.json")); writeFileSync(join(box.home, "bridge.lock"), "99999999", { mode: 0o600 });
    const locked = await finished(box.cli("server-bootstrap", "--agent", "claude", "--name", "Test"));
    assert.notEqual(locked.code, 0); assert.match(locked.stderr, /stale bridge.lock/); assert.equal(readFileSync(join(box.home, "bridge.lock"), "utf8"), "99999999"); assert.equal(existsSync(join(box.home, "client.json")), false);
    box.checkUntouched();
  } finally { box.clean(); }
});

test("preferred range exhaustion is bounded and leaves a clean home for retry", async () => {
  const box = isolated(), listeners: Awaited<ReturnType<typeof endpoint>>[] = []; let hits = 0;
  try {
    for (let port = 49120; port <= 49139; port++) { try { listeners.push(await endpoint((_req, res) => { hits++; json(res, { unrelated: true }); }, port)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; } }
    const result = await finished(box.cli("server-bootstrap", "--agent", "claude", "--name", "Test"));
    assert.notEqual(result.code, 0); assert.match(result.stderr, /No free Argo port in 49120–49139/); assert.equal(result.stdout, "");
    for (const path of ["client.json", "bridge.sqlite", "bridge.lock"]) assert.equal(existsSync(join(box.home, path)), false);
    assert.equal(hits, 0); box.checkUntouched();
  } finally { for (const listener of listeners) await listener.close(); box.clean(); }
});

test("explicit free port is respected and configured port mismatch never changes bridge", async () => {
  const box = isolated(), probe = await endpoint((_req, res) => res.end());
  await probe.close();
  const run = box.cli("server-bootstrap", "--agent", "claude", "--name", "Explicit", "--port", String(probe.port));
  try {
    const ready = await run.ready(); assert.equal(ready.port, probe.port); assert.equal(ready.reused, false);
    const config = readFileSync(join(box.home, "client.json"), "utf8");
    const mismatch = await finished(box.cli("server-bootstrap", "--agent", "claude", "--name", "No mutation", "--port", String(probe.port === 65535 ? 65534 : probe.port + 1)));
    assert.notEqual(mismatch.code, 0); assert.match(mismatch.stderr, /Existing bridge port differs/); assert.equal(mismatch.stdout, "");
    assert.equal(readFileSync(join(box.home, "client.json"), "utf8"), config); assert.equal(readFileSync(join(box.home, "bridge.lock"), "utf8"), String(run.child.pid));
    noSecrets(mismatch, JSON.parse(config).token); box.checkUntouched();
  } finally { await run.stop(); box.clean(); }
});
