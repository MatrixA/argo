# Connect this running Codex session to Argo (experimental)

These instructions are for the **already-open Codex Agent on the Agent machine**, at the user's explicit request. Execute the supported steps in this current session, not in a new Agent. **Preflight first; stop if this session cannot be joined.** Do not start another Codex/model, run `codex exec` or `codex resume`, launch a new App Server/daemon, or fake attachment with a separate session. Do not change tool approvals, sandbox policy, global settings, MCP configuration, shell profiles, or permissions.

**Native populated-session rejoin remains unverified.** This is not the Claude cooperative pull path. A compatible existing shared App Server and the exact loaded thread are required; an ordinary standalone TUI may not expose them. Installation alone does not mean connected. Do not send a model prompt or run a native model test to prove setup.

Public GitHub distributes **code only**, not conversations or credentials. No GitHub login/token, model API key, bridge admin token, or source upload is required. Never read user logs, history, transcripts, or credential files.

## Inputs and preflight — before downloading or consuming a code

The user supplies:

- The selected running bridge's **loopback HTTP URL as seen from this Agent machine**, e.g. `http://127.0.0.1:49123`. Raycast may use a different loopback address for the same bridge.
- A display name such as `backend`, and a short-lived single-use **Codex pairing code** from Raycast (or `argo invite --agent codex` on the bridge host). A Claude code is not interchangeable.
- Only if needed, the **known existing** shared App Server socket path. Do not discover a socket by scanning user files/configuration or invent a path.

Reuse the **existing transport only**. The bridge may be on this machine or reached through an existing SSH local/reverse forward. Do not create/change a tunnel, expose the bridge publicly, or invent a relay; ask the user to fix transport instead. See [topologies](topologies.md).

Run these checks in this current session's tool environment, stopping on any failure:

```sh
node --version
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("Node.js 22.13+ required"); process.exit(1); }'
npm --version
tar --version
codex --version
codex app-server proxy --help
node -e 'const id = process.env.CODEX_THREAD_ID; if (!id || !id.trim()) { console.error("No authoritative CODEX_THREAD_ID in this session; stop"); process.exit(1); } console.log("Current CODEX_THREAD_ID:", id);'
```

Require Node.js **22.13+**, npm, tar, HTTPS access to public GitHub release assets and registry.npmjs.org, and a Codex version with `app-server proxy` support. Missing/unsupported prerequisites: report the exact blocker, do not install/upgrade system packages automatically. The help command is only a capability check, not permission to start a server.

Use the **exact `CODEX_THREAD_ID` from this current session environment**. Never guess from cwd, history, latest/recent sessions, thread listings, filenames, or another Agent. If it is missing, or this session has no compatible existing shared App Server, stop and say this current session cannot be attached by this path. Do not restart/resume/migrate it to make the requirement appear satisfied. The connector, not a guessed ID or successful install, will verify that the exact thread is loaded in the selected existing runtime.

Also confirm this session's tool supports a **long-running background process that survives the tool call and the current turn**. If it does not, report that blocker before consuming a code. Do not substitute a daemon/service or a second model session.

## 1. Download and inspect the pinned public installer

Use the same bounded, HTTPS-only public download pattern as [connect.md](connect.md), pinned to **v0.1.4**. Require a v0.1.4 bridge for the client-revocation upload-race fix; older servers need an explicit runtime upgrade and bridge restart, not just a connector or Raycast update. Use a fresh private directory, save the installer as a file, and inspect it before execution. Never `curl | sh`, use a mutable `main` URL, or run an interpreter/build tool from inside a downloaded archive.

```sh
umask 077
ARGO_SETUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/argo-setup.XXXXXX")
node --input-type=module - "$ARGO_SETUP_DIR/install.mjs" <<'ARGO_FETCH_END'
import { writeFileSync } from 'node:fs';
const source = 'https://github.com/MatrixA/argo/releases/download/v0.1.4/install.mjs';
let url = new URL(source), bytes;
const signal = AbortSignal.timeout(30000);
for (let n = 0; n <= 5; n++) {
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !(
    url.origin === 'https://github.com' && url.pathname.startsWith('/MatrixA/argo/releases/download/v0.1.4/') ||
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

Remember the **absolute path**, since shell variables may not survive separate tool calls. Read only that installer code, not credentials. The installer verifies the archive against `SHA256SUMS` from the same release: this detects corruption, not a compromised publisher. For independent provenance, compare the installer hash against a separately trusted release checksum before execution. If v0.1.4 assets are unavailable, stop; do not fall back to a mutable branch or another version silently.

## 2. Install runtime only

Substitute the downloaded absolute path and the user's Agent-reachable URL/name as properly quoted shell arguments:

```sh
node /absolute/fresh/argo-setup.XXXXXX/install.mjs \
  --agent codex --url 'http://127.0.0.1:49123' --name 'backend'
```

The installer fetches pinned `v0.1.4/argo-connector.tar.gz` and `SHA256SUMS`, verifies SHA-256 and safe archive entries, extracts into unique private staging, and runs production `npm ci --omit=dev --ignore-scripts --workspaces=false`. It installs public runtime code/dependencies only. **It creates no Claude skill, changes no Codex/Claude configuration, and starts no claim, connector, Codex/model, or daemon.** Nothing is added to PATH; existing installations are not overwritten.

`ARGO_INSTALL_READY` includes `adapter: "codex"`, the unique `release`, absolute `launcher`, future `credential` file path, and `claim` command. Save these **paths**, never credential contents. The runtime is under `~/.local/share/argo/releases/<uuid>`. The installer can be removed afterward. This result means **installed only**, not ready to receive messages.

## 3. Claim the one-use code through stdin

Execute the **claim command printed by this installation**. Feed only the user's one-time Codex code through a single-quoted heredoc, or redirect a user-supplied private code file without reading it. Do not put the code in arguments, interpolate it as shell text, echo it, or repeat it in your reply. Never request a durable/admin token.

```sh
'/absolute/node' '/absolute/release/bin/argo.mjs' claim \
  --url 'http://127.0.0.1:49123' --stdin --out '/absolute/release/credential.json' <<'ARGO_PAIR_CODE_END'
USER_SUPPLIED_ONE_TIME_CODE
ARGO_PAIR_CODE_END
```

The placeholder is **not** a code; choose a delimiter absent from the actual code. If no code was supplied, pause for the user's private claim/code. It expires after ten minutes and is consumed once. On failure/expiry or an uncertain claim, request a fresh code from Raycast; do not automatically retry an uncertain claim. Never overwrite an existing credential, create local admin config, run `serve`/`pair`, or copy `~/.argo/client.json`. Claim's adapter comes from the scoped pairing, not a CLI override.

The resulting scoped credential must never enter Agent context, logs, diagnostics, git, or GitHub. Only its **file path** goes to connect. If a credential already exists, use it only when it belongs to this installation, is an unused Codex binding, and the user still authorizes it; otherwise ask for a fresh pairing without reading the file.

## 4. Join this exact loaded thread and keep the connector alive

After successful claim, use the installation's absolute launcher/credential paths. The environment expansion below must come from **this current Codex session**, not a new shell/session's guessed identity:

```sh
'/absolute/node' '/absolute/release/bin/argo.mjs' connect \
  --credential '/absolute/release/credential.json' \
  --thread "${CODEX_THREAD_ID:?No authoritative current Codex thread; stop}"
```

Only for a **known existing** nondefault runtime socket, append `--socket '/absolute/existing/control.sock'`. Otherwise omit it; no socket creation or server startup. Do not use `attach`, the Claude skill, or the Claude polling loop.

Run this as a **long-running process using this session's supported background execution facility**, retaining its process/job handle so you can check status and stop it. Do not run it as a short foreground command that the tool kills on timeout, and do not assume a bare shell `&` survives the tool. The connector must stay alive after your current turn; if the tool cannot do that, stop and report the limitation. Do not install a service/daemon to work around it.

The connector launches only `codex app-server proxy` to the **existing** runtime, uses WebSocket framing over its pipes, and checks `thread/loaded/list` plus exact metadata before a native `thread/resume` RPC rejoins that thread. This RPC is not permission to launch `codex resume` or start a replacement runtime. It refuses unloaded/mismatched threads and passes no model, sandbox, or approval-policy overrides. Loaded-check/rejoin is not atomic; unloading between them remains a native protocol limitation.

Check only this connector's status/output through your tool's process handle, not user logs/history or credentials. If it reports an unsupported proxy, unloaded thread, native rejoin error (including `no rollout found`), or exits: report **not connected** with the blocker; do not guess another thread, restart a server, send a model turn to manufacture a rollout, or claim success. A pairing for the wrong adapter must be replaced by a fresh Codex pairing, not edited.

Report connected only after **`Codex thread connected to Argo.`** is observed and the background connector is confirmed still running. Report that native populated-session rejoin/model responses and multi-client approvals are still unverified; neither installation nor this connection confirmation is an end-to-end model test. Do not send a test model prompt. Tool approvals and safety boundaries remain unchanged in the original environment; never weaken policy to complete setup.

## Stopping and limits

- Revocation in Raycast or lost transport stops delivery. Do not switch credentials/addresses or replay an uncertain message automatically.
- Stop only this connector through its process handle. Its proxy is disposable; do not stop the shared App Server or the user's original Codex session.
- After the connector exits, revoke its old binding and obtain a **fresh pairing** before restarting: a new process is a new runtime authorization boundary. A temporary network reconnection inside the same live process is different.
- To uninstall, revoke first, stop this connector, then remove only the exact unique release directory from `ARGO_INSTALL_READY`. Never remove all releases, user settings, the shared server, or another session's files.
