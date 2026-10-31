import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startBridge } from "../packages/bridge/src/server.js";
import { secret } from "../packages/bridge/src/store.js";
import { privateWrite, readClient } from "../packages/connector/src/config.js";
const exec = promisify(execFile);
const entry = resolve("bin/argo.mjs");
async function cli(home: string, ...args: string[]) {
  try { const result = await exec(process.execPath, [entry, ...args], { env: { ...process.env, HOME: home, ARGO_HOME: home }, timeout: 15000 }); return { ...result, code: 0 }; }
  catch (error) { const result = error as { stdout: string; stderr: string; code: number }; return { stdout: result.stdout, stderr: result.stderr, code: result.code }; }
}
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const safe = (result: { stdout: string; stderr: string }, ...secrets: string[]) => { for (const value of secrets) assert.ok(!(result.stdout + result.stderr).includes(value), "diagnostic output leaked private data"); };

test("compiled doctor reports missing/invalid private config without exposing inputs or creating files", async () => {
  const home = mkdtempSync(join(tmpdir(), "argo-doctor-config-")), token = secret();
  try {
    const missing = await cli(home, "doctor"); assert.equal(missing.code, 0);
    const report = JSON.parse(missing.stdout); assert.equal(report.runtime.node, process.versions.node); assert.equal(report.runtime.status, "supported");
    assert.equal(report.clientConfig.status, "missing"); assert.equal(report.bridge.status, "not-checked"); assert.ok(report.nextStep);
    assert.equal(existsSync(join(home, "client.json")), false);
    writeFileSync(join(home, "client.json"), `{ invalid ${token}`, { mode: 0o600 });
    const malformed = await cli(home, "doctor"); assert.equal(JSON.parse(malformed.stdout).clientConfig.status, "invalid"); safe(malformed, token);
    writeFileSync(join(home, "client.json"), JSON.stringify({ url: "http://127.0.0.1:1", token }), { mode: 0o600 }); chmodSync(join(home, "client.json"), 0o644);
    const publicFile = await cli(home, "doctor"); assert.equal(JSON.parse(publicFile.stdout).clientConfig.status, "invalid"); safe(publicFile, token);
    chmodSync(join(home, "client.json"), 0o600);
    writeFileSync(join(home, "client.json"), JSON.stringify({ url: `http://${token}@example.com`, token }), { mode: 0o600 });
    const badUrl = await cli(home, "doctor"); assert.equal(JSON.parse(badUrl.stdout).clientConfig.status, "invalid"); safe(badUrl, token);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("compiled doctor authenticates read-only real bridge and emits counts/status only", async () => {
  const home = mkdtempSync(join(tmpdir(), "argo-doctor-bridge-")), token = secret(), sensitive = "private-session-name-and-detail";
  const bridge = await startBridge({ database: join(home, "bridge.sqlite"), token, port: 0 });
  try {
    privateWrite(join(home, "client.json"), { url: bridge.url, token });
    bridge.store.createGrant(sensitive, "claude");
    const before = JSON.stringify(bridge.store.list());
    const result = await cli(home, "doctor"); assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout); assert.equal(report.clientConfig.status, "found"); assert.equal(report.bridge.authenticated, true);
    assert.equal(report.bridge.status, "authenticated"); assert.equal(report.bridge.sessions.total, 1); assert.equal(report.bridge.sessions.online, 0); assert.equal(report.bridge.sessions.statuses.offline, 1);
    assert.equal(JSON.stringify(bridge.store.list()), before); safe(result, token, sensitive, bridge.store.list()[0]!.id);
    const probe = await cli(home, "doctor", "--url", bridge.url);
    const unauth = JSON.parse(probe.stdout); assert.equal(unauth.bridge.status, "reachable-not-authenticated"); assert.equal(unauth.bridge.identity, "unverified"); assert.equal(unauth.bridge.authenticated, false); safe(probe, token, sensitive);
    const connectorHome = join(home, "connector"); mkdirSync(connectorHome);
    const connectorProbe = await cli(connectorHome, "doctor", "--url", bridge.url); assert.equal(JSON.parse(connectorProbe.stdout).bridge.status, "reachable-not-authenticated");
    assert.equal(existsSync(join(connectorHome, "client.json")), false);
    privateWrite(join(home, "client.json"), { url: bridge.url, token: secret() }, true);
    const denied = await cli(home, "doctor"); assert.equal(JSON.parse(denied.stdout).bridge.status, "reachable-not-authenticated"); safe(denied, token, sensitive);
  } finally { await bridge.close(); rmSync(home, { recursive: true, force: true }); }
});

test("doctor distrusts arbitrary 401, suppresses bodies, does not leak auth on explicit URL or redirects", async () => {
  const home = mkdtempSync(join(tmpdir(), "argo-doctor-http-")), token = secret(), privateBody = "response-body-private-text";
  const requests: { method?: string; path?: string; auth?: string }[] = [];
  let status = 401, body = privateBody, location: string | undefined;
  const server = await endpoint((req, res) => { requests.push({ method: req.method, path: req.url, auth: req.headers.authorization }); res.writeHead(status, location ? { Location: location } : {}); res.end(body); });
  let redirected = 0; const other = await endpoint((_req, res) => { redirected++; res.end(privateBody); });
  try {
    privateWrite(join(home, "client.json"), { url: server.url, token });
    const result = await cli(home, "doctor", "--url", server.url); const report = JSON.parse(result.stdout);
    assert.equal(report.bridge.identity, "unverified"); assert.equal(report.bridge.authenticated, false); assert.match(report.nextStep, /identity is unverified/); safe(result, token, privateBody);
    assert.deepEqual(requests, [{ method: "GET", path: "/v1/sessions", auth: undefined }]);
    status = 302; location = other.url;
    const redirect = await cli(home, "doctor"); assert.equal(JSON.parse(redirect.stdout).bridge.status, "http-response-unverified"); assert.equal(redirected, 0); safe(redirect, token, privateBody);
    status = 200; location = undefined; body = JSON.stringify({ sessions: [{ online: true, status: privateBody, token }], cursor: 1 });
    const invalid = await cli(home, "doctor"); assert.equal(JSON.parse(invalid.stdout).bridge.status, "unreachable-or-invalid-response"); safe(invalid, token, privateBody);
    body = JSON.stringify({ sessions: [{ online: true, status: "busy", name: privateBody, detail: token }], cursor: 1 });
    const valid = await cli(home, "doctor"); assert.equal(JSON.parse(valid.stdout).bridge.sessions.statuses.busy, 1); safe(valid, token, privateBody);
    body = privateBody.repeat(260000);
    const oversized = await cli(home, "doctor"); assert.equal(JSON.parse(oversized.stdout).bridge.status, "unreachable-or-invalid-response"); safe(oversized, token, privateBody);
    const rejected = await cli(home, "doctor", "--url", `http://user:${token}@example.com`); assert.equal(JSON.parse(rejected.stdout).bridge.status, "invalid-url"); safe(rejected, token);
    assert.equal(requests.length, 5, "unsafe URL was never requested");
  } finally { await server.close(); await other.close(); rmSync(home, { recursive: true, force: true }); }
});

test("doctor reports an unreachable loopback endpoint with an actionable sanitized step", async () => {
  const home = mkdtempSync(join(tmpdir(), "argo-doctor-offline-"));
  const server = await endpoint((_req, res) => res.end()); await server.close();
  try { const result = await cli(home, "doctor", "--url", server.url); assert.equal(JSON.parse(result.stdout).bridge.status, "unreachable-or-invalid-response"); assert.match(JSON.parse(result.stdout).nextStep, /SSH tunnel/); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test("compiled export-client creates a private readdressed admin file exclusively and never changes server config", async () => {
  const home = mkdtempSync(join(tmpdir(), "argo-export-")), token = secret(), original = { url: "http://127.0.0.1:48123", token };
  const out = join(home, "transfer", "mac-client.json"), url = "http://127.0.0.1:49123";
  try {
    const absent = await cli(home, "export-client", "--out", out, "--url", url); assert.notEqual(absent.code, 0); assert.equal(existsSync(out), false); safe(absent, token);
    privateWrite(join(home, "client.json"), original); const before = readFileSync(join(home, "client.json"), "utf8");
    const result = await cli(home, "export-client", "--out", out, "--url", url); assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /admin authority/); assert.match(result.stderr, /Transfer privately/); safe(result, token);
    assert.deepEqual(readClient(out), { url, token }); assert.equal(statSync(out).mode & 0o777, 0o600); assert.equal(readFileSync(join(home, "client.json"), "utf8"), before);
    const sameFile = await cli(home, "export-client", "--out", join(home, "client.json"), "--url", url); assert.notEqual(sameFile.code, 0); assert.equal(readFileSync(join(home, "client.json"), "utf8"), before); safe(sameFile, token);
    const exported = readFileSync(out, "utf8");
    const duplicate = await cli(home, "export-client", "--out", out, "--url", original.url); assert.notEqual(duplicate.code, 0); assert.match(duplicate.stderr, /overwrite/); assert.equal(readFileSync(out, "utf8"), exported); safe(duplicate, token);
    const link = join(home, "symlink.json"); symlinkSync(out, link);
    const symlink = await cli(home, "export-client", "--out", link, "--url", original.url); assert.notEqual(symlink.code, 0); assert.equal(readFileSync(out, "utf8"), exported); safe(symlink, token);
    const invalid = await cli(home, "export-client", "--out", join(home, "bad.json"), "--url", `http://user:${token}@example.com`); assert.notEqual(invalid.code, 0); assert.equal(existsSync(join(home, "bad.json")), false); safe(invalid, token);
    writeFileSync(join(home, "client.json"), `{${token}`, { mode: 0o600 });
    const badConfig = await cli(home, "export-client", "--out", join(home, "bad-config.json"), "--url", url); assert.notEqual(badConfig.code, 0); safe(badConfig, token); assert.equal(existsSync(join(home, "bad-config.json")), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
