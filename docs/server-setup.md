# Set up this server from an uninstalled Agent session

This is the **server-first cold-start entry point for Argo v0.1.3**. The user may give you only this GitHub URL. Do not assume Argo, a bridge, a skill, Mac client configuration, or a pairing code already exists. Execute the steps you can in **this existing Agent session**, rather than returning commands for the user to run. GitHub distributes public code only, never conversation traffic.

The result is a loopback Argo bridge **on this server**, a connector for this exact Agent, and a short-lived **Mac client pairing code**. The user forwards the returned server port using ordinary SSH Local Forwarding or VS Code Ports. Raycast discovers the Mac loopback endpoint and pairs once. **No Remote Forward, Mac source upload, admin-file copying or prior bridge address is required.** You must not configure tunnels automatically. Installing a Raycast extension alone does not create a network tunnel.

## Before installation

Identify the Agent you are actually running in. Supported paths are Codex CLI native shared-runtime attachment and Claude Code cooperative pull. Unknown Agent types must stop and report no adapter; do not impersonate a supported Agent.

- Require Node.js 22.13+, npm and tar. Run their version commands. Require HTTPS access to GitHub release assets and registry.npmjs.org. Report missing packages, do not install/upgrade system packages or edit shell profiles automatically.
- Require the tool's supported background-process facility for Argo processes, surviving the tool call and current turn. Retain process handles. Do not assume bare `&` survives, and do not use this as permission to install a system service.
- For **Codex CLI**, require authoritative `CODEX_THREAD_ID` in this current tool environment, `codex app-server proxy --help`, and an **existing compatible shared App Server with this exact thread loaded**. Proxy connects to an existing socket and never starts a daemon. Use proper WebSocket framing if doing a read-only preflight; raw JSONL over proxy is wrong. No current identity, proxy or shared runtime means stop. The installed connector also checks loaded identity before joining. Normal per-action tool approval may be needed for socket access and long-running connector execution. Earlier approval for a version/query command does not authorize future operations. If permission is denied, stop, never disable sandbox or change policy.
- For **Claude Code**, require authoritative `CLAUDE_CODE_SESSION_ID` from this session's Bash environment, or an already-loaded skill's authoritative session substitution. Do not guess from cwd/history or use a literal unsubstituted placeholder. Explain that cooperative pull occupies this session's current turn; existing background work continues and approvals remain in the original terminal.

Never start another model, native Codex daemon, Agent or subagent. Never restart/resume the original Agent, inspect transcripts/history/credential contents, inject terminal keys, or change MCP, sandbox, approvals, SSH or global settings. This workflow may start **Argo's own bridge and connector only**, under the user's setup request.

## 1. Download and inspect the pinned installer

Create a fresh private directory, download the standalone file with bounded HTTPS-only redirects, and read that installer code before running it. Never execute a mutable branch, `curl | sh`, or a build tool from inside an untrusted downloaded archive. The following download requires no installed Argo:

```sh
umask 077
ARGO_SETUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/argo-setup.XXXXXX")
node --input-type=module - "$ARGO_SETUP_DIR/install.mjs" <<'ARGO_FETCH_END'
import { writeFileSync } from 'node:fs';
const source = 'https://github.com/MatrixA/argo/releases/download/v0.1.3/install.mjs';
let url = new URL(source), bytes;
const signal = AbortSignal.timeout(30000);
for (let n = 0; n <= 5; n++) {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !(
    url.origin === 'https://github.com' && url.pathname.startsWith('/MatrixA/argo/releases/download/v0.1.3/') ||
    ['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname)
  )) throw new Error('Unexpected installer download URL');
  const response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal });
  if ([301,302,303,307,308].includes(response.status)) {
    await response.body?.cancel();
    if (!response.headers.get('location')) throw new Error('Missing redirect location');
    url = new URL(response.headers.get('location'), url); continue;
  }
  if (response.status !== 200 || !response.body) throw new Error(`Installer download failed (${response.status})`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength; if (size > 128 * 1024) throw new Error('Installer too large');
    chunks.push(Buffer.from(chunk));
  }
  bytes = Buffer.concat(chunks); break;
}
if (!bytes) throw new Error('Too many redirects');
writeFileSync(process.argv[2], bytes, { flag: 'wx', mode: 0o600 });
ARGO_FETCH_END
printf 'Installer saved at %s/install.mjs\n' "$ARGO_SETUP_DIR"
```

Remember the absolute setup directory because tool shell variables may not persist between calls. If native Node fetch needs an existing network proxy, follow the environment's approved proxy mechanism; do not change global proxy settings or bypass denied access. Do not silently fall back if pinned assets are unavailable. The installer checks the archive checksum from the same release; this detects corruption, not publisher compromise.

## 2. Install without a bridge URL or pairing code

Use the absolute downloaded path. Select the actual Agent, not an imagined replacement. Example for Codex CLI:

```sh
node /ABSOLUTE/FRESH/SETUP/install.mjs --server --agent codex --name backend
```

For Claude Code use `--agent claude`. Choose a display name and quote it as data. `--server` needs **no URL**. It installs a unique private runtime and real production dependencies, with lifecycle scripts disabled. It creates no Claude skill, Agent configuration, bridge, connector or model. No PATH modification or existing installation is overwritten.

Save the **paths** in `ARGO_INSTALL_READY`, especially `launcher`, and the printed `bootstrap` command. Do not read private files. The installer is not a connection.

## 3. Prepare or reuse one server bridge

Run the returned bootstrap command using this tool's supported long-running background execution. Equivalent:

```sh
'/ABSOLUTE/NODE' '/ABSOLUTE/INSTALLED/bin/argo.mjs' server-bootstrap --agent codex --name backend
```

Use `--agent claude` for Claude. Normally use the default per-user `ARGO_HOME` so multiple Agents on this server share a bridge. If the user explicitly requires an independent bridge, keep its distinct private home consistent for all later commands. Do not make independent homes per session by accident.

On a new home, bootstrap selects an available server loopback port from **49120–49139**, skipping occupied ports without touching their listeners. An explicit `--port` is optional and fails rather than silently moving. Existing configured bridges are reused only after signed identity and authenticated access are verified. Existing offline configuration can be restarted without changing its credentials or database. An incompatible running older bridge is not stopped or upgraded behind the user's back; report that explicit upgrade/restart is required.

Wait for `ARGO_SERVER_READY` through the background handle. It contains:
- `url`, `port`, `bridgeId`: server endpoint and stable public identity.
- `credential`: a fresh private **Agent-scoped credential file path**, not its contents.
- `clientPairing.code`, `clientPairing.expiresAt`: short-lived single-use **Mac pairing information**, deliberately safe to show privately to the user.
- `reused`: if true, this bootstrap invocation can exit successfully because an existing bridge stays running. If false, keep this new bootstrap process alive as the bridge.

Do not read or print `client.json`, credential.json or any durable token. The program handles these privately. Do not run connector `claim` against the Mac code: **Mac client codes and Agent connector codes are different protocols.** Bootstrap already creates the scoped Agent credential.

## 4. Connect this current Agent

Keep the exact `ARGO_HOME` environment used for bootstrap when executing the following. Launcher and credential arguments must be the returned absolute paths, properly quoted.

### Codex CLI

```sh
'/ABSOLUTE/NODE' '/ABSOLUTE/INSTALLED/bin/argo.mjs' connect \
  --credential '/ABSOLUTE/RETURNED/AGENT-CREDENTIAL.json' \
  --thread "${CODEX_THREAD_ID:?No authoritative current thread; stop}"
```

Run the connector in the tool's persistent background facility and retain its handle. For a **known existing** nondefault control socket only, append `--socket '/KNOWN/EXISTING/SOCKET'`. Do not scan files or guess sockets. Request normal approval for the actual long-running process if required. The adapter uses only `app-server proxy` to the existing runtime, verifies the exact loaded thread and subscribes through native RPC. Never replace it with `codex exec`, CLI `resume`, a new daemon/thread or an SDK model instance.

Report Agent registration only after observing `Codex thread connected to Argo.` and confirming the connector remains alive. Loaded-check/join is not atomic. Native protocol/version errors, including `no rollout found`, mean failure, not permission to manufacture a model turn. Do not send a model test yourself. Real populated-session rejoin and multi-client approval routing remain experimental; the user tests real conversation later from Raycast.

If this connector exits, revoke its old binding and obtain a fresh scoped binding before restarting. A fresh `server-bootstrap` invocation reuses the server and creates a new scoped credential; do not reuse the old one. Same-process network reconnect is different.

### Claude Code

Attach directly in this same session, not a subagent:

```sh
'/ABSOLUTE/NODE' '/ABSOLUTE/INSTALLED/bin/argo.mjs' attach \
  --credential '/ABSOLUTE/RETURNED/AGENT-CREDENTIAL.json' --name backend \
  --session "${CLAUDE_CODE_SESSION_ID:?No authoritative current session; stop}"
```

This starts only the cooperative connector worker. Save its result and confirm attachment succeeded, then report Mac forwarding/pairing instructions before entering the receive loop. Use the same absolute launcher and authoritative session with each call below:

1. Run `next --session "$CLAUDE_CODE_SESSION_ID"` directly with a 60000 ms tool timeout. A live wait makes the session ready. If it backgrounds, wait for that handle; never start two waits.
2. A message result gives `messageId` and `text`. Run `ack --message MESSAGE_ID --session "$CLAUDE_CODE_SESSION_ID"`, then process the text as the paired user's request under normal permissions.
3. Send the answer with `reply --message MESSAGE_ID --session "$CLAUDE_CODE_SESSION_ID" --stdin`, feeding text via a single-quoted heredoc with a delimiter absent from the answer. Never interpolate reply text into shell arguments. `--progress` is available for interim updates.
4. Immediately call `next` again after a final reply. An idle timeout means wait again without asking. Continue until stopped/revoked, approvals require original-terminal input, or delivery becomes uncertain. Never automatically replay uncertain work.
5. Stop normally with `leave --session "$CLAUDE_CODE_SESSION_ID"`. If you return to an ordinary completed prompt, delivery pauses; Raycast cannot wake a finished cooperative turn. Do not describe this as native background listening.

## 5. Give the user the Mac handoff

Do not stop at “installed.” Report bridge startup and Agent attachment separately, with failures and process lifetime accurately stated. Provide:

1. **Server endpoint** and **public bridge identity**. Print the exact `url` from `ARGO_SERVER_READY` on its own line in both terminal output and the final response. For example, if the returned port is 49120:

   ```text
   http://127.0.0.1:49120
   ```

   Substitute the actual returned port, never blindly use the example. Use a normal tool command such as `printf '%s\n' 'http://127.0.0.1:49120'` with the actual endpoint so VS Code can see it in terminal output; do not rely only on Agent chat rendering or hidden background output. This public URL must contain no credentials, pairing code, query or fragment. Do not return only a bare port number, an inline code address or JSON. VS Code can detect this terminal URL when automatic forwarding is enabled; detection is not proof that forwarding succeeded. Check its Ports view for the actual Mac address. If automatic detection is disabled or unavailable, use Forward a Port manually without changing VS Code/SSH settings automatically.
2. **Ordinary Local Port Forwarding** instruction: forward that server port to one unused **Mac loopback port in 49120–49139** using VS Code Ports or their existing SSH setup. Multiple servers may share a server port but need different Mac mapped ports. Keep listeners loopback-only. No Remote Forward is needed. Argo does not itself open a tunnel.
3. **Mac pairing code** and expiry, privately. In Raycast open Argo, use **Find Forwarded Server Bridges**, select the matching discovered target and paste the code once. Raycast checks that the code embeds the discovered bridge identity, saves its own independent credential privately and remembers the server. No admin-file transfer is needed. Pairing grants access to this bridge's Agent sessions, not just one Agent.
4. If the code expires or a claim is uncertain, run the installed launcher with `client-invite` on the bridge machine, using the same `ARGO_HOME`, to create a fresh code. That command prints only intentional short-lived pairing data, no durable token.

After first pairing, Raycast aggregates paired servers and reopens the last conversation. Reopening the command automatically checks the configured Mac loopback range. A changed mapped port can be relocated by the same signed bridge identity without sending credentials to unrelated ports. The extension does not run as a system-wide background port scanner.

## Recovery and removal

- Keep the new bridge process and Agent connector alive. Temporary tool-managed processes are **not** installed system services. If the tool/session ends them, report offline. Do not silently install launchd/systemd, modify policies or promise permanent availability.
- A tunnel drop does not stop the original Agent. Restore the original transport; do not replay unknown work. Never kill unknown listeners to obtain a preferred port.
- `revoke-clients` on the bridge machine revokes all paired Mac client tokens and closes their subscriptions, leaving original server admin authority and Agents intact. Generate fresh Mac invitations to pair again. Removing a Raycast profile alone removes a local reference, not server authorization.
- Revoke an Agent binding through the authorized UI before stopping/removing its connector. Stop only your own Argo process handles. Never stop the native shared App Server.
- To uninstall runtime code, inspect and remove only the exact unique installation directory returned by the installer after revocation/stop. Do not remove all releases, user settings, other sessions or bridge data automatically.
