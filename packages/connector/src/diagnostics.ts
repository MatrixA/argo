import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { localUrl, statusSchema } from "../../shared/src/protocol.js";
import { readClient } from "./config.js";

export async function diagnose(url?: string) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const runtime = { node: process.versions.node, status: major! > 22 || (major === 22 && minor! >= 13) ? "supported" : "unsupported" };
  let config: ReturnType<typeof readClient> | undefined;
  let configStatus: "found" | "missing" | "invalid" = "found";
  try { config = readClient(); }
  catch (error) { configStatus = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid"; }
  const report = (bridge: Record<string, unknown>, nextStep: string) => ({ runtime, clientConfig: { status: configStatus }, bridge, nextStep: runtime.status === "unsupported" ? "Use Node.js 22.13 or later. " + nextStep : nextStep });
  const target = url ?? config?.url;
  if (!target) return report({ status: "not-checked", authenticated: false }, configStatus === "missing"
    ? "On the bridge machine run argo serve; for a remote bridge privately import an exported client file on the Mac. Use argo doctor --url LOOPBACK_URL for a credential-free tunnel check."
    : "Check that the client file is valid private JSON owned by you (chmod 600). Do not paste its contents into chat.");
  try { localUrl(target); }
  catch { return report({ status: "invalid-url", authenticated: false }, "Use only a loopback HTTP base URL, such as http://127.0.0.1:48123. Keep remote transport inside an SSH tunnel."); }
  // An explicit endpoint is a credential-free transport check, never a token override.
  const authenticated = url === undefined && config !== undefined;
  try {
    const response = await fetch(new URL("/v1/sessions", target), {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: authenticated ? { Authorization: `Bearer ${config!.token}` } : {},
    });
    const httpStatus = response.status;
    if (httpStatus !== 200 || !authenticated) {
      await response.body?.cancel();
      if (httpStatus === 401) return report({ status: "reachable-not-authenticated", httpStatus, authenticated: false, identity: "unverified" }, authenticated
        ? "The endpoint rejected this client credential. Check the tunnel destination and privately import the matching bridge's exported client file; do not regenerate a running bridge's credentials. HTTP 401 alone does not identify Argo."
        : "An HTTP service answered but bridge identity is unverified. Check the tunnel destination; run authenticated argo doctor on the bridge host or Mac with its matching private client configuration. An Agent-only machine uses scoped pairing, not admin import. No admin token was sent.");
      return report({ status: "http-response-unverified", httpStatus, authenticated: false, identity: "unverified" }, "An HTTP service answered, but authenticated Argo access was not verified. Check the tunnel destination and use the matching private client configuration. Redirects are never followed.");
    }
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > 4_000_000) throw new Error("Diagnostic response too large");
      chunks.push(Buffer.from(chunk));
    }
    const result = z.object({ sessions: z.array(z.object({ online: z.boolean(), status: statusSchema })), cursor: z.number().int().nonnegative() })
      .safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!result.success) throw new Error("Invalid diagnostic response");
    const statuses = Object.fromEntries(statusSchema.options.map(status => [status, 0]));
    for (const session of result.data.sessions) statuses[session.status]!++;
    const sessions = { total: result.data.sessions.length, online: result.data.sessions.filter(session => session.online).length, statuses };
    return report({ status: "authenticated", httpStatus, authenticated: true, sessions }, sessions.total === 0
      ? "Bridge access works. In Raycast, connect the current Claude session using cooperative pull; use a scoped pairing code on each Agent machine."
      : "Bridge access works. If a session is offline or waiting, check its connector/tunnel and continue the receive/reply loop in the original Claude session. Doctor does not verify a model round-trip.");
  } catch {
    return report({ status: "unreachable-or-invalid-response", authenticated: false }, "Check that the bridge is running and the SSH tunnel targets its loopback port. Confirm the endpoint is Argo and retry; no response body or credential is included in diagnostics.");
  }
}

export function exportClient(out: string, url: string) {
  try { localUrl(url); }
  catch { throw new Error("Use a loopback HTTP base URL for the Mac side of the tunnel; credentials are never accepted in URLs"); }
  let config: ReturnType<typeof readClient>;
  try { config = readClient(); }
  catch { throw new Error("Cannot read a valid private bridge client configuration. Run export-client on the bridge machine; never paste its contents into chat."); }
  let fd: number;
  try { mkdirSync(dirname(out), { recursive: true, mode: 0o700 }); fd = openSync(out, "wx", 0o600); }
  catch (error) { throw new Error((error as NodeJS.ErrnoException).code === "EEXIST" ? "Refusing to overwrite an existing client file" : "Cannot create the new private client file"); }
  try { writeFileSync(fd, JSON.stringify({ url, token: config.token }, null, 2) + "\n"); fsyncSync(fd); }
  catch { try { unlinkSync(out); } catch {} throw new Error("Could not save the private client file; the bridge configuration was not changed"); }
  finally { closeSync(fd); }
}
