# Argo

Continue an existing Claude Code or Codex session from Raycast, whether that Agent runs on your Mac or a server.

Argo is a local companion service, a lightweight Agent connector, and a native Raycast extension. It does not call a model API, replace your Agent, require tmux, or upload conversations to an Argo cloud.

## Requirements

- Node.js 22.13 or later, npm, and Raycast on macOS.
- Claude Code with its Bash tool for on-demand pull attachment. Channels support is optional. Codex needs a shared App Server and `app-server proxy` support.
- For remote Agents: Node.js and the connector on the Agent machine, plus an SSH tunnel back to the Mac.

The protocols are evolving. Development used Claude Code 2.1.314 and Codex CLI 0.157.1. A successful build or mock test is not proof that your installation enables these experimental features.

## Build and start

```sh
npm ci
npm run build
node bin/argo.mjs serve
```

The service listens only on `http://127.0.0.1:48123`. On first start it creates a private `~/.argo/client.json` containing the Raycast credential. Do not paste its contents into a conversation.

Use `ARGO_HOME=/private/path` to isolate an installation, or `serve --port PORT` for another port. An existing installation cannot silently change its address. The CLI uses a lock to prevent concurrent bridge processes. After an abnormal exit, check the PID in `bridge.lock` before removing a stale lock. Connector `.lock` files require the same check.

### Load the Raycast extension

```sh
npm run dev --workspace extensions/raycast
```

Open **Argo → Agent Sessions** in Raycast. Set **Recent Agent Session** to a global shortcut for direct access to your last conversation. The extension reads `~/.argo/client.json` by default. Its preference can point to a different private configuration file.

Type a short prompt into the conversation's search bar and use **Send Message**. Use **Compose Multiline Message** for longer input. Replies are Markdown details, not the private Raycast AI chat surface. Opening a conversation selects its latest Agent reply. Sending a message automatically selects its matching reply when it arrives and follows subsequent reply updates. Selecting another item stops following until you send again. Only explicitly submitted text is sent. No screen, browser page, or selected text is collected automatically.

The extension can be unloaded or hidden while the Agent continues. The service retains bridge messages and replays events on reconnect.

## Connect an already-running Claude Code session

**The default flow requires no startup flags, MCP configuration, or restart.** Ask the current Agent to use the [`argo-bind` skill](skills/argo-bind/SKILL.md). Install that skill through the normal Claude skill mechanism, with the absolute Argo launcher path replacing the `argo` command if it is not on PATH. Skills hot-reload into running Claude Code sessions.

Inside the current Claude Bash tool, the core operations are:

```sh
node /absolute/path/to/argo/bin/argo.mjs attach --name backend
node /absolute/path/to/argo/bin/argo.mjs next
node /absolute/path/to/argo/bin/argo.mjs ack --message MESSAGE_ID
node /absolute/path/to/argo/bin/argo.mjs reply --message MESSAGE_ID --stdin <<'ARGO_REPLY_END'
The response from this same Agent session.
ARGO_REPLY_END
node /absolute/path/to/argo/bin/argo.mjs next
```

`attach` uses the Bash tool's authoritative `CLAUDE_CODE_SESSION_ID`. A loaded skill can pass `${CLAUDE_SESSION_ID}` explicitly via `--session`. It never discovers a target from recent history or launches another Claude process. Locally it creates a scoped binding from the existing private bridge configuration. On a remote machine, add `--credential /private/path/to/paired.json` to attach using a pre-paired credential through the SSH tunnel.

The current Agent waits with `next`, processes each returned message in its existing context, sends the answer through stdin, and immediately waits again. The wait is bounded and returns `idle` after inactivity; the skill reissues it. Only a live wait advertises ready. When the wait ends or the Agent stops the loop, the session reports paused/waiting rather than claiming native push. Pending message text is returned only once; a lost tool response is uncertain and is never automatically re-executed.

**Pull-mode limits:** waiting occupies the original Agent's current turn, so it cannot independently advance its previous task while waiting. Existing background processes continue. The Agent must keep cooperating with the receive/reply loop. Returning to an ordinary input prompt cannot be automatically woken. Each expired wait may consume another Agent turn. Tool permissions remain in the original terminal; remote approval relay, native interruption, and automatic token streaming are disabled. This mode is suitable for an on-demand handoff, not an invisible always-on background channel. Use `leave` in that same session to revoke the pull binding without stopping Claude.

## Optional Claude native Channel

Use this mode only when you want native push and are willing to authorize the Channel at session startup. It is not required for on-demand pull attachment.

### One-time pairing and Channel preparation

With the bridge running, authorize a single session:

```sh
node bin/argo.mjs pair --agent claude --name backend --out ~/.argo/backend.json
node bin/argo.mjs setup-claude --credential ~/.argo/backend.json > /private/path/argo.mcp.json
```

The second command prints an MCP configuration containing an executable path and the credential **file path**, not the secret itself. Save it on the machine where Claude runs. It does not edit your existing MCP or Claude settings.

Start Claude interactively with that configuration:

```sh
claude --mcp-config /private/path/argo.mcp.json \
  --dangerously-load-development-channels server:argo
```

Channels are a research preview. Custom channels need the development-channel confirmation or an appropriate organization-approved plugin configuration. This flag opts a channel into receiving events. It does **not** disable tool permissions. Organization policy or authentication restrictions may still prevent registration.

### Bind from inside the Agent

Check that the startup notice actually lists `server:argo` as an enabled Channel. Then tell Claude:

> The startup banner confirms Argo is enabled as a Channel. Call channel_ready, then bind this session to the local bridge as backend.

The connector is the MCP child of this exact session. It does not select a session by directory or by reading the most recent transcript. Its channel connection is the identity boundary. The bind tool can receive the loopback URL if needed, but it must match the previously paired address.

A normal MCP connection does not prove Channels are active. There is no public registration ACK in this interface. Argo therefore requires your explicit startup confirmation before bind, and still distinguishes channel submission from Agent acknowledgement. The first acknowledged message is the real round-trip check.

For inbound messages, Claude uses the `acknowledge` and `reply` tools. A reply marked final completes that bridge turn. A model that ignores these tools can leave a message pending. Argo will not guess a completion from unrelated terminal prose or fabricate token streaming.

The on-demand Agent skill is in [`skills/argo-bind/SKILL.md`](skills/argo-bind/SKILL.md). Install it using your Agent's normal skill mechanism. No global settings are modified by the build or service.

An already-running session without the Channel enabled may need an explicit restart and resume during setup. Argo never silently replaces or restarts it.

## Connect Codex

Authorize a binding on the Mac:

```sh
node bin/argo.mjs pair --agent codex --name backend --out ~/.argo/backend-codex.json
```

On the Agent machine, run a separate connector process:

```sh
node bin/argo.mjs connect --credential ~/.argo/backend-codex.json \
  --thread EXACT_CURRENT_THREAD_ID
```

For a nondefault shared server socket, add `--socket /private/path/to/control.sock`.

Use the actual thread ID supplied by your current Codex session, not a guessed latest-history entry. The connector uses WebSocket framing over `codex app-server proxy` to join the existing server. The proxy relays raw bytes, not JSONL. It checks loaded threads and metadata before rejoining that thread without model, sandbox, or approval-policy overrides. It refuses unloaded threads instead of launching an independent Agent.

The installed protocol documents that resuming a running thread rejoins its runtime. The loaded check and rejoin are not atomic, so a thread unloading between them remains a protocol limitation. App Server interfaces and multi-client approval routing are experimental and require version-specific live verification.

**Current verification limit:** isolated Codex 0.157.1 passed initialization, empty-thread creation, and metadata reads through another connection. Rejoining that empty thread failed with the native `no rollout found` error, even with persistence requested. No model turn was sent to create a rollout. Same-runtime rejoin, model responses, and multi-client approvals remain unverified against a real populated session. The connector fails closed instead of advertising a successful attachment.

A connector restart is deliberately a new runtime authorization boundary. Pair a fresh credential after its process exits. Temporary network reconnection in the same process does not require pairing again. Argo does not reuse an old process's pending approval authority.

## Remote Agents

### GitHub self-service setup, recommended

GitHub is the public distribution point, not a chat relay. The remote Agent downloads a versioned connector and verifies its checksum. Chat and credentials stay on the two machines and the SSH tunnel.

1. Keep the Mac bridge running and prepare your SSH reverse tunnel. For example, forward remote `127.0.0.1:49123` to Mac `127.0.0.1:48123`.
2. Open **Argo → Agent Sessions** in Raycast. Choose **Connect Remote Claude** from Actions, enter the remote loopback URL and a display name, then create a pairing prompt.
3. Choose **Copy Agent Setup Prompt** and give it to the already-running remote Claude. It follows [the public connection guide](docs/connect.md), downloads the installer, claims the single-use code through stdin, saves its scoped credential privately, and binds that exact session.
4. The Agent starts its receive/reply loop. Open its conversation in Raycast.

You do not copy program files or credential files, clone/build remotely, configure MCP, or restart Claude. The remote machine still needs Node.js 22.13+, npm, tar, and outbound HTTPS to GitHub and the npm registry. Installation does not create the SSH tunnel or install system packages.

The pairing code grants one binding, expires after ten minutes, is stored only as a hash by the bridge, and can be exchanged once. The pairing prompt intentionally contains this temporary secret. Share it only with the intended Agent, never in a GitHub issue or public chat. Raycast marks its clipboard copy confidential so it is not recorded in Raycast Clipboard History. Long-lived connector credentials are never printed or put in model context. Use **Cancel Unused Pairing Code** to invalidate an unused code; leaving the view does not cancel it. After claiming, revoke the binding with **Unbind Session** if necessary.

**This remains a pull-mode handoff.** Waiting for Raycast occupies the original Agent's current turn. It does not independently continue its previous task while waiting. Previously started background processes keep running. Tool approvals remain in the original terminal. GitHub distribution does not change this limitation.

The same pairing exchange is available from the CLI:

```sh
# On the Mac. This deliberately prints a temporary, single-use secret.
node bin/argo.mjs invite --name remote-backend
# On the remote machine, the Agent feeds the code to claim through stdin.
# See docs/connect.md for the complete self-service flow.
```

### Optional Mac-driven SSH deployment

You do not need to make this repository public, clone it remotely, copy credentials, or type installation steps on the server. From this built checkout on your Mac, run:

```sh
node bin/argo.mjs remote --host YOUR_SSH_ALIAS --name server-backend
```

The command uses your normal SSH configuration and host-key checks. It creates a scoped binding, uploads an explicit connector-only bundle over SSH, installs locked production dependencies without package lifecycle scripts, stores the binding credential privately, installs a uniquely named Claude skill, and holds the reverse tunnel open. It prints the exact slash command to invoke in the **already-running remote Claude session**. That skill contains the correct remote paths and credential reference. No Agent is launched, no model is called, and the Mac's admin credential is never transferred.

Keep the Mac command running during use. Ctrl+C or tunnel exit revokes this temporary binding. The installed release and its skill remain on the server for inspection, but the revoked credential cannot reconnect. Run the setup command again for a fresh authorization. Each setup uses a unique release and skill, never overwrites an existing one, and does not edit shell profiles, SSH settings, MCP configuration, or permission policies.

The remote host needs Node.js 22.13+, npm, a POSIX shell, tar, outbound access to the npm registry, and SSH forwarding enabled. Versions installed only by an interactive shell profile may not be available to SSH commands; expose them in the SSH environment first. Argo does not install system packages or disable host-key checking. Use `--remote-port 49124` if the default forwarded port is occupied. Put custom SSH ports, keys, jump hosts, and identities in your SSH alias configuration.

This remains cooperative pull mode: the original Claude must keep its receive/reply loop running, and tool approvals remain in its terminal.

### Manual topology and pairing

Keep the bridge on the Mac. From the Mac, forward a remote loopback port back to it:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:48123:127.0.0.1:48123 user@server
```

Install/build Argo on the server. Transfer only that Agent's paired credential file over a private channel, set mode `600`, then run the same Claude or Codex setup there. Do not transfer the Mac's `client.json`, which controls all bindings.

The remote connector now uses `http://127.0.0.1:48123` on the server. Commands and files remain on the server. Replies travel on the existing bidirectional connection. No public listener or reply port is needed.

If the remote forwarded port differs, set it when pairing:

```sh
node bin/argo.mjs pair --agent codex --name server-backend \
  --url http://127.0.0.1:49123 --out ~/.argo/server-backend.json
```

The SSH server must permit forwarding. In this manual flow, you open the tunnel yourself. Argo never changes SSH configuration. SSH protects transport, but the forwarded port still requires the per-binding application credential.

## CLI and background service

```sh
node bin/argo.mjs list
printf '%s' 'Continue the current task' | node bin/argo.mjs send --binding BINDING_ID --stdin
node bin/argo.mjs show --binding BINDING_ID
node bin/argo.mjs detach --binding BINDING_ID
```

Detaching revokes only Argo access. The original Agent keeps running. It also does not erase old history.

Generate a launchd template from the repository after building:

```sh
node bin/argo.mjs launchd > /private/path/local.argo.bridge.plist
```

Inspect and install it using your normal launchd workflow. Template generation does not install, load, or restart a service. The template contains absolute Node and project paths, so regenerate it after moving the project or Node installation. `ARGO_HOME` is inherited at generation time through the template's environment configuration.

## Safety and recovery

- All control endpoints require authentication. Browser-origin requests, non-loopback addresses, redirects, and arbitrary public listeners are rejected.
- Pairing creation and cancellation require Mac admin authentication. The native-only claim endpoint accepts a high-entropy, expiring, single-use code and returns only one scoped connector credential. Claim attempts are rate-limited and never bypass Host/Origin checks.
- A connector credential controls only one binding. The Raycast client credential controls all bindings. Credentials never belong in URLs, model context, logs, or Git.
- Each binding has an independent queue. Switching the displayed conversation does not redirect in-flight work.
- “Received”, “submitted”, “accepted”, “completed”, and “unknown” mean different things. Notifications written to Claude are not claimed to be processed until acknowledged.
- Requests and events have stable IDs. The connector persists its output until the bridge durably acknowledges it. Uncertain dispatched work is **not** automatically re-executed after a crash.
- A disconnected in-flight prompt becomes unknown and blocks further sends until completion or explicit reconciliation. Check the original Agent is idle and inspect the result, then use **Resume Queue After Checking Agent** in Raycast. This never replays the uncertain prompt or labels it completed.
- Replaying events does not guarantee exactly-once Agent execution. When execution is uncertain, inspect the original session before submitting another prompt.
- Tool approvals are explicit, scoped, and expiring. Claude's relay does not expose an applied-decision ACK, so it remains “submitted” rather than falsely “resolved”. Terminal answers are ultimately enforced by the Agent runtime.
- Unknown interactions are not automatically approved. Claude project-trust dialogs, channel consent, and unsupported selectors still require the original terminal.
- First-version history covers bridge interactions from binding onward. It does not import complete terminal history, hidden reasoning, or arbitrary filesystem paths.
- tmux is not required and keyboard injection is not implemented. Additional Agents need a genuine native adapter; ordinary terminal output is not a conversation protocol.

For command-line reconciliation, use the exact uncertain message ID shown by `show`:

```sh
node bin/argo.mjs reconcile --binding BINDING_ID --message MESSAGE_ID --confirm-checked
```

This confirmation can release queued prompts. The original Agent must report ready. It is not an automatic retry.

Data is stored locally in `~/.argo/bridge.sqlite` and the Agent machine's `~/.argo/outbox/`. History currently remains until the user removes the relevant data while the service is stopped. Revocation is not deletion. Back up anything needed before removing the database. There is no automatic retention or cloud backup.

## Verification

```sh
npm test
npm run test --workspace extensions/raycast
npm run typecheck
npm run build
npm run raycast:build
npm run smoke
npm audit
```

The bridge tests exercise real loopback HTTP/WebSocket traffic, queue isolation, deduplication, revocation, stale identity, persistence and restart behavior. The pull tests drive compiled CLI attachment, wait, acknowledgement, reply, identity, duplicate prevention, and revocation against the real bridge without MCP or a model call. The Claude Channel test launches the actual MCP connector subprocess and simulates Claude's client contract, including permission notifications. It does not call a model or prove the Claude CLI has allowed the research-preview Channel.

Codex regression tests use fake JSONL and real WebSocket-over-pipe transports to verify version-matched handling and failure cases. The optional native acceptance test uses an isolated test home and sends no model requests:

```sh
ARGO_CODEX_LIVE=1 npx tsx --test test/codex.test.ts
```

On the development installation, this acceptance test **fails at empty-thread resume** for the native rollout limitation described above. It is intentionally not reported as a successful rejoin.

`npm run smoke` drives the public compiled CLI through service startup, pairing, connector registration, multiline send, reply, history, and detach. Its Agent is a test adapter, not a real model. The Raycast extension was opened in the actual app. Its offline/setup view and automatic latest-reply selection on opening a populated synthetic conversation were visually checked. Selection regression tests cover matching a newly sent message, reply updates, and preserving manual history navigation. The Raycast window became unavailable during the complete GUI send/automatic-selection acceptance run, including a locked-desktop interval, so that interaction remains unit-tested rather than fully GUI-verified. Permission views, real Claude model round-trips, and remote SSH end-to-end behavior have not been live-verified.

The public-installer tests validate checksums, bounded GitHub redirects, strict archive entries, rollback, and real production installation in isolated homes. Pairing tests cover expiry, cancellation, concurrent single-use claims, hashed storage, browser rejection, and CLI secret handling.

The automated remote-deployment test substitutes SSH transport but runs the real archive extraction, production dependency installation, compiled launcher, and skill rendering in a clean temporary home. An actual external SSH host has not yet been exercised.

Node may print an experimental `node:sqlite` warning on Node 22. The app uses the built-in SQLite library rather than a native addon.

## Protocol sources

- [Claude Code Channels](https://code.claude.com/docs/en/channels.md) and [Channel contract](https://code.claude.com/docs/en/channels-reference.md)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Raycast extension lifecycle](https://developers.raycast.com/information/lifecycle)

MIT license. Argo is an independent companion tool, not an official Raycast, Anthropic, or OpenAI product.
