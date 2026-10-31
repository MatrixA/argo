import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { startBridge } from "../../bridge/src/server.js";
import { readBridgeId } from "../../bridge/src/store.js";
import { credentialSchema, localUrl, type Session } from "../../shared/src/protocol.js";
import { api, clientPath, home, privateWrite, readClient } from "./config.js";

const upgrade = "The configured bridge does not support signed discovery. Upgrade Argo and restart that bridge explicitly; it was not stopped or changed.";
const discoverySchema = z.object({
  service: z.literal("argo"), protocol: z.literal(1), bridgeId: z.string().regex(/^[a-f0-9]{64}$/),
  publicKey: z.string().max(200), challenge: z.string(), signature: z.string().max(200),
}).strict();
const clientPairingSchema = z.object({
  code: z.string().regex(/^ARGO-CLIENT-[a-f0-9]{64}-[a-f0-9]{32}$/),
  expiresAt: z.number().int().positive(), bridgeId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Admin = ReturnType<typeof readClient>;
export interface ServerReady {
  url: string; port: number; bridgeId: string; credential: string;
  clientPairing: z.infer<typeof clientPairingSchema>; reused: boolean;
}

// Discovery carries no credentials. Only a refused TCP connection means offline;
// an occupied, unresponsive or incompatible listener must never be replaced.
async function discover(url: string, expectedId?: string): Promise<string | undefined> {
  const challenge = randomBytes(16).toString("hex");
  let response: Response;
  try {
    response = await fetch(new URL(`/v1/discovery?challenge=${challenge}`, url), { redirect: "error", signal: AbortSignal.timeout(3000) });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return;
    throw new Error("The configured address did not answer discovery. Its listener was not stopped or changed.");
  }
  try {
    if (!response.ok) throw new Error();
    if (!response.body) throw new Error();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const discovery = discoverySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const der = Buffer.from(discovery.publicKey, "base64");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || discovery.challenge !== challenge
      || createHash("sha256").update(der).digest("hex") !== discovery.bridgeId
      || !verify(null, Buffer.from(`argo-discovery-v1\n${challenge}\n${discovery.bridgeId}`), key, Buffer.from(discovery.signature, "base64"))) throw new Error();
    if (!expectedId || discovery.bridgeId !== expectedId) throw new Error("identity");
    return discovery.bridgeId;
  } catch (error) {
    if (error instanceof Error && error.message === "identity") throw new Error("Bridge identity does not match this ARGO_HOME. No administrator credential was sent; the existing listener was not changed.");
    throw new Error(upgrade);
  } finally { await response.body?.cancel().catch(() => {}); }
}

async function adminRequest<T>(config: Admin, path: string, method = "GET", body?: unknown): Promise<T> {
  try { return await api<T>(config, path, method, body); }
  catch { throw new Error("Bridge administrator request failed. Check this ARGO_HOME's private admin configuration and bridge version; no existing server was changed."); }
}
async function authenticatedBridge(config: Admin) {
  const bridgeId = await discover(config.url, readBridgeId(join(home(), "bridge.sqlite")));
  if (!bridgeId) return;
  const result = await adminRequest<{ sessions: Session[] }>(config, "/v1/sessions");
  if (!Array.isArray(result.sessions)) throw new Error("Invalid bridge sessions response");
  return bridgeId;
}
async function clientPairing(config: Admin, bridgeId: string) {
  const pairing = clientPairingSchema.safeParse(await adminRequest(config, "/v1/client-pairings", "POST", {}));
  if (!pairing.success || pairing.data.bridgeId !== bridgeId || !pairing.data.code.startsWith(`ARGO-CLIENT-${bridgeId}-`) || pairing.data.expiresAt <= Date.now()) throw new Error("Invalid client pairing response; upgrade the configured bridge");
  return pairing.data;
}
export async function clientInvite() {
  const config = readClient(), bridgeId = await authenticatedBridge(config);
  if (!bridgeId) throw new Error("Configured bridge is offline. Start it before inviting a client.");
  return clientPairing(config, bridgeId);
}
export async function revokeClients() {
  const config = readClient(), bridgeId = await authenticatedBridge(config);
  if (!bridgeId) throw new Error("Configured bridge is offline. Start it before revoking clients.");
  await adminRequest(config, "/v1/clients", "DELETE");
}

export async function serverBootstrap(options: { agent: string; name: string; port?: string }, onStarted: (close: () => Promise<void>) => void): Promise<ServerReady> {
  const adapter = z.enum(["claude", "codex"]).safeParse(options.agent);
  if (!adapter.success) throw new Error("Agent must be claude or codex");
  const name = options.name.trim();
  if (!name || name.length > 100) throw new Error("Name must contain 1–100 characters");
  const explicit = options.port === undefined ? undefined : Number(options.port);
  if (explicit !== undefined && (!/^\d{1,5}$/.test(options.port!) || !Number.isInteger(explicit) || explicit < 1 || explicit > 65535)) throw new Error("Invalid port");
  let config = existsSync(clientPath()) ? readClient() : undefined;
  const configuredPort = config ? Number(localUrl(config.url).port || 80) : undefined;
  if (config && explicit !== undefined && explicit !== configuredPort) throw new Error("Existing bridge port differs; use a separate ARGO_HOME instead of changing it");
  let bridgeId = config ? await authenticatedBridge(config) : undefined;
  const reused = Boolean(bridgeId);
  let close: (() => Promise<void>) | undefined;
  if (!bridgeId) {
    if (!config && existsSync(join(home(), "bridge.sqlite"))) throw new Error("Existing bridge database has no admin configuration; restore client.json or use a separate ARGO_HOME");
    if (config && localUrl(config.url).hostname === "[::1]") throw new Error("Configured IPv6 bridge is offline; start that bridge explicitly. Its configuration was not changed.");
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const lock = join(home(), "bridge.lock");
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch { throw new Error("Bridge already running, or stale bridge.lock exists. Check its PID before removing it."); }
    const database = join(home(), "bridge.sqlite"), freshDatabase = !existsSync(database);
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined, closed = false;
    close = async () => { if (closed) return; closed = true; try { await bridge?.close(); } finally { closeSync(fd); unlinkSync(lock); } };
    onStarted(close);
    try {
      writeFileSync(fd, String(process.pid));
      if (!config && existsSync(clientPath())) throw new Error("Admin configuration appeared during setup; rerun bootstrap to reuse it");
      const token = config?.token ?? randomBytes(32).toString("hex");
      const ports = configuredPort !== undefined ? [configuredPort] : explicit !== undefined ? [explicit] : Array.from({ length: 20 }, (_, i) => 49120 + i);
      for (const port of ports) {
        try { bridge = await startBridge({ database, token, port }); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || ports.length === 1) throw error; }
      }
      if (!bridge) throw new Error("No free Argo port in 49120–49139. Free one or select --port explicitly; no existing listener was changed.");
      if (!config) { config = { url: bridge.url, token }; privateWrite(clientPath(), config); }
      bridgeId = await authenticatedBridge(config);
      if (!bridgeId) throw new Error("New bridge did not answer discovery");
    } catch (error) {
      await close();
      if (freshDatabase && !existsSync(clientPath())) for (const path of [database, `${database}-wal`, `${database}-shm`]) { try { unlinkSync(path); } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup; } }
      throw error;
    }
  }
  try {
    const admin = config!;
    const pairing = await clientPairing(admin, bridgeId);
    const credential = credentialSchema.safeParse({ ...await adminRequest<object>(admin, "/v1/grants", "POST", { name, adapter: adapter.data }), url: admin.url });
    if (!credential.success || credential.data.adapter !== adapter.data) throw new Error("Invalid scoped credential response");
    const path = join(resolve(home()), "agents", `${randomUUID()}.json`);
    try { privateWrite(path, credential.data); }
    catch { await adminRequest(admin, `/v1/sessions/${encodeURIComponent(credential.data.bindingId)}`, "DELETE"); throw new Error("Could not save the private scoped credential; its binding was revoked"); }
    return { url: admin.url, port: Number(localUrl(admin.url).port || 80), bridgeId, credential: path, clientPairing: pairing, reused };
  } catch (error) { await close?.(); throw error; }
}
