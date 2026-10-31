# Argo

Continue an existing Claude Code or Codex session from Raycast, whether that Agent runs on your Mac or a server.

Argo is a loopback companion bridge (on your Mac or a server), a lightweight Agent connector, and a native Raycast extension. It does not call a model API, replace your Agent, require tmux, or upload conversations to an Argo cloud.

## Requirements

- Node.js 22.13 or later, npm, and Raycast on macOS.
- Claude Code with its Bash tool for on-demand pull attachment. Channels support is optional. Codex needs a shared App Server and `app-server proxy` support.
- For remote connections: Node.js and the connector on the Agent machine, plus a working loopback transport to the chosen bridge. Existing SSH LocalForward or RemoteForward both work; the bridge can run on the Mac or a server.

The GitHub self-service installer is pinned to release `v0.1.3`, including server-first installation, signed discovery and separate Mac-client pairing. Load the Raycast extension from this checkout. Codex remains experimental; release availability is not proof that an arbitrary running Codex session can attach.

The protocols are evolving. Development used Claude Code 2.1.314 and Codex CLI 0.157.1. A successful build or mock test is not proof that your installation enables these experimental features.

## Start with an uninstalled server Agent

Give the existing Agent this public entry point: [server-setup.md](docs/server-setup.md). The instructions begin with no Argo installation, no bridge URL and no pairing code. The Agent downloads and inspects the pinned v0.1.3 installer, runs `--server`, prepares a server-local bridge and joins its exact current session using the supported adapter. Installation does not start another model or alter Agent security policy.

The Agent prints its complete server endpoint, such as `http://127.0.0.1:49120`, on its own line in terminal output and the final response, plus a short-lived **Mac pairing code**. VS Code can detect the terminal URL when automatic forwarding is enabled. Confirm the actual Mac mapping in its Ports view; otherwise use Forward a Port manually. Forward that port with ordinary Local Port Forwarding (for example VS Code Ports) into an unused **Mac loopback port 49120–49139**. Open Argo's **Find Forwarded Server Bridges**, select the discovered identity, and enter the code once. No Remote Forward, bridge-address entry or admin-file transfer is needed. Port forwarding is still necessary and is not automatically created by installing the extension. Discovery range is configurable, with a maximum of 64 loopback ports.

Discovery is credential-free and checks a fresh signed challenge. Pairing pins the public bridge identity from the user-provided code before consuming it. The Mac stores its independent durable client credential in a private file, not preferences or LocalStorage. Discovery alone never authorizes a connection. After pairing, all configured bridges' sessions are aggregated. Opening Argo resumes the last valid conversation; All Sessions switches targets. Pinned bridge identity keeps drafts/recent state stable when local forwarding ports change and rejects an unrelated discovered identity. It does not authenticate the local transport: a malicious proxy can relay a genuine discovery signature and observe bearer credentials. Use only trusted local listeners and SSH forwards, never shared/public forwarding endpoints.

Same-user Agents on one server share one bridge. Multiple servers may use the same server port but require different mapped Mac ports. The new bridge and connectors use supported tool-managed background execution; they are not silently installed as launchd/systemd services. For server-side recovery, `client-invite` refreshes a Mac invitation and `revoke-clients` revokes all paired Mac clients without replacing the server's admin configuration. Removing a local saved profile is not revocation.

Claude uses cooperative pull, which occupies its current turn. Codex requires its current loaded thread on an existing shared App Server and remains experimental. Neither successful discovery nor registration proves a real model round-trip.

## Build and start

```sh
npm ci
npm run build
node bin/argo.mjs serve
```

Run these commands on the chosen bridge machine. The service listens only on `http://127.0.0.1:48123` there. On first start it creates a private `~/.argo/client.json` containing admin authority over all bridge bindings. Do not paste its contents into a conversation.

**Choose your setup:** [Deployment topology guide](docs/topologies.md) covers everything on the Mac, Mac bridge with either direction of SSH forwarding, a server bridge, existing tunnels, and a shared remote bridge with both local and remote Agents. No public relay or TLS proxy is added.

Use `ARGO_HOME=/private/path` to isolate an installation, or `serve --port PORT` for another port. An existing installation cannot silently change its address. The CLI uses a lock to prevent concurrent bridge processes. After an abnormal exit, check the PID in `bridge.lock` before removing a stale lock. Connector `.lock` files require the same check.

### Load the Raycast extension

The extension is being prepared for the public Raycast Store as a self-configured companion UI. See the [Store preparation and standalone build guide](docs/raycast-store.md). It has not been submitted or listed.

```sh
npm run dev --workspace extensions/raycast
```

Open **Argo → Agent Sessions** in Raycast. Use **Connection Setup** to choose where the bridge and Agent run, keep an existing tunnel, or add/switch bridge connections. **Use an Existing Bridge** takes a private configuration file path and **Address From This Mac**; it verifies authenticated access before switching. Saved profiles contain references and per-Mac loopback URL overrides, never token contents. The default remains `~/.argo/client.json`, or the configured preference path. Both Argo entry commands resume the last valid conversation. Set a global shortcut for direct access; use **All Sessions** to switch Agents across paired bridges.

For a server bridge, [export/import its admin file privately](docs/topologies.md#export-and-import-admin-access-privately) on the Mac first. For Agents, create separate scoped pairing prompts and enter **Address From Agent** as seen on their own machine. Admin import is not Agent pairing. The same bridge can serve Mac and server Agents at once.

Type a short prompt into the conversation's search bar and use **Send Message**. Use **Compose Message** or **⌘N** for longer input. Replies are Markdown details, not the private Raycast AI chat surface. Opening a conversation selects its latest Agent reply. Sending a message automatically selects its matching reply when it arrives and follows subsequent reply updates. Selecting another item stops following until you send again. Only explicitly submitted text is sent. No screen, browser page, or selected text is collected automatically.

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

**Experimental native path, not the default Claude pull setup.** In Connection Setup choose the matching topology, select **Codex · Experimental shared runtime**, then **Create Experimental Codex Prompt**. Copy the private prompt into the existing Codex session. It checks the authoritative current thread and existing shared App Server, installs the public runtime with `--agent codex` without creating a Claude skill, claims a scoped code via stdin, then connects that exact loaded thread. [Agent-facing Codex instructions](docs/connect-codex.md).

If `CODEX_THREAD_ID`, `app-server proxy`, the existing control socket or the exact loaded thread is unavailable, stop and report that prerequisite. Do not launch another daemon, use `codex exec`/CLI resume, infer a recent thread or weaken permissions to fake attachment. Real populated-session rejoin remains unverified. The following manual pairing path is optional:

Authorize a binding from the selected bridge's admin client (on the Mac or bridge host):

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

The following convenience flows use a Mac bridge. They are not a requirement: [the topology guide](docs/topologies.md) also supports existing `LocalForward`/`RemoteForward`, SSH initiated from the server, and a bridge running on the server. Do not replace a working tunnel just to match an example.

### GitHub self-service setup, recommended

GitHub is the public distribution point, not a chat relay. The remote Agent downloads a versioned connector and verifies its checksum. Chat and credentials stay on the two machines and the SSH tunnel.

1. Keep the Mac bridge running and prepare your SSH reverse tunnel. For example, forward remote `127.0.0.1:49123` to Mac `127.0.0.1:48123`.
2. Open **Argo → Agent Sessions → Connection Setup** in Raycast. Choose the matching setup (or **I already have a working connection**), enter **Address From Agent** and a display name, then create a private pairing prompt.
3. Choose **Copy Private Agent Prompt** and give it to the already-running remote Claude. It follows [the public connection guide](docs/connect.md), downloads the installer, claims the single-use code through stdin, saves its scoped credential privately, and binds that exact session.
4. The Agent starts its receive/reply loop. Open its conversation in Raycast.

You do not copy program files or credential files, clone/build remotely, configure MCP, or restart Claude. The remote machine still needs Node.js 22.13+, npm, tar, and outbound HTTPS to GitHub and the npm registry. Installation does not create the SSH tunnel or install system packages.

The pairing code grants one binding, expires after ten minutes, is stored only as a hash by the bridge, and can be exchanged once. The pairing prompt intentionally contains this temporary secret. Share it only with the intended Agent, never in a GitHub issue or public chat. Raycast marks its clipboard copy confidential so it is not recorded in Raycast Clipboard History. Long-lived connector credentials are never printed or put in model context. Use **Cancel Unused Pairing Code** to invalidate an unused code; leaving the view does not cancel it. After claiming, revoke the binding with **Unbind Session** if necessary.

**This remains a pull-mode handoff.** Waiting for Raycast occupies the original Agent's current turn. It does not independently continue its previous task while waiting. Previously started background processes keep running. Tool approvals remain in the original terminal. GitHub distribution does not change this limitation.

If your network requires an HTTP proxy, the installer must use that proxy too. On Node versions supporting `NODE_USE_ENV_PROXY` (including the verified Node 22.23 installation), set `NODE_USE_ENV_PROXY=1` when running the installer. Keep the bridge on the proxy bypass list with `NO_PROXY=127.0.0.1,localhost,::1`. Preserve any other bypass entries your environment needs. Older Node versions may not support this option; use a supported Node release or a direct network path. Argo does not change global proxy settings.

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

See [the topology matrix and machine-labelled SSH examples](docs/topologies.md#topology-matrix). Keep a working tunnel, whether it is `LocalForward` or `RemoteForward`. Every machine uses its own loopback endpoint for the same bridge. Pairing a remote Agent transfers only scoped authority; importing a remote bridge into Raycast is the separate, private admin-file operation.

For manual scoped pairing, run this using the bridge's admin config; `--url` is the endpoint **from the Agent machine**, not a change to the bridge listener:

```sh
node bin/argo.mjs pair --agent claude --name server-backend \
  --url http://127.0.0.1:49123 --out ~/.argo/server-backend.json
```

Transfer that single-binding credential privately to the intended Agent, mode `600`, or use the recommended one-time pairing prompt instead. Do not transfer the admin `client.json` to the Agent.

## CLI and background service

```sh
node bin/argo.mjs doctor
# Credential-free endpoint check, including on an Agent-only machine:
node bin/argo.mjs doctor --url http://127.0.0.1:49123
# On the bridge host: new private admin file readdressed for the Mac's tunnel.
node bin/argo.mjs export-client --out /private/NEW-mac-client.json --url http://127.0.0.1:49124
```

`doctor` prints safe structured JSON: Node support, private config found/missing/invalid, authenticated bridge access, session counts/status only, and a next step. It reads only `GET /v1/sessions`, changes nothing, never prints credentials/conversation content or server error bodies, and never follows redirects. Explicit `--url` sends **no admin token**; HTTP 401 means reachable but not authenticated with **unverified identity**, not proof that an arbitrary service is Argo. Findings use exit code zero; inspect `bridge.status` and `nextStep`. It reads `$ARGO_HOME/client.json`, not Raycast profiles. [Diagnostic details](docs/topologies.md#safe-diagnosis-and-next-steps).

`export-client` contains admin authority over all bindings. Transfer it privately to the Mac, import its **path** in Raycast, and never put its contents into model/context, stdout, chat or logs. It creates a new file exclusively with mode `600`, refuses overwrite (including symlinks), and leaves the bridge's original config unchanged. [Full server bridge flow](docs/topologies.md#4-server-bridge-mac-opens-a-local-forward).

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

See the [security assessment and deployment boundaries](docs/security-review.md). Signed discovery is not encrypted transport or relay protection.

- All control endpoints require authentication. Browser-origin requests, non-loopback addresses, redirects, and arbitrary public listeners are rejected.
- Pairing creation and cancellation require bridge admin authentication. The native-only claim endpoint accepts a high-entropy, expiring, single-use code and returns only one scoped connector credential. Claim attempts are rate-limited and never bypass Host/Origin checks.
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

Data is stored on the bridge machine in `~/.argo/bridge.sqlite` and the Agent machine's `~/.argo/outbox/`. History currently remains until the user removes the relevant data while the service is stopped. Revocation is not deletion. Back up anything needed before removing the database. There is no automatic retention or cloud backup.

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

`npm run smoke` drives the public compiled CLI through service startup, pairing, connector registration, multiline send, reply, history, and detach. Its Agent is a test adapter, not a real model. The updated Raycast extension was driven in the actual app against an isolated bridge and synthetic Agent. Private-file import, authenticated connection switching, local pairing-prompt generation with a secret-safe preview, sending a synthetic message, automatic selection of its arriving reply, offline send refusal, and draft persistence after closing/reopening the conversation were verified. The default bridge was preserved. No user conversation was read or sent test input. Regression tests additionally cover matching replies, manual history navigation, stale Recent fallback, per-bridge drafts and cross-connection send guards. Permission views, real Claude model round-trips, and external SSH end-to-end behavior remain unverified.

The published `v0.1.2` release was anonymously downloaded and installed in a clean temporary home, with its checksum verified. The installed Claude connector claimed a single-use code, attached an exact synthetic session, completed a synthetic receive/ack/reply round-trip, and revoked the binding. A separate Codex-mode production install created no Claude skill or Codex configuration, claimed a Codex-scoped code, and revoked that binding without starting native Codex. This used a real local bridge and the public GitHub release, with the configured network proxy explicitly enabled for Node. It did not verify native Codex rejoin, call a model, or connect to an external SSH server.

The published `v0.1.3` server-first assets were anonymously downloaded into a clean temporary home and installed with no URL, configuration or skill. The published launcher started a fresh bridge, a separate Mac-side byte-forward endpoint discovered its signed identity, and Mac pairing saved a private independent credential. An exact synthetic Claude session completed attach/next/ack/reply through that forwarded endpoint, then its binding and Mac client were revoked. This used no model, native Codex or external SSH server. The actual Raycast app independently discovered and paired a disposable fresh bridge. No user conversation was used as test input.

The v0.1.3 server-first regression suite additionally exercises zero-config bootstrap, preferred-port collisions/exhaustion, signed discovery and identity pinning before authenticated reuse, private scoped credentials, single-use Mac pairing, UI-token revocation and subscription closure. Extension regressions cover bounded credential-free discovery, multi-bridge routing with duplicate binding IDs, independent subscriptions, first-run discovery and default recent-conversation restoration. The actual Raycast app discovered an isolated fresh bridge; no user conversation was used. Native Codex model round-trips and external SSH acceptance remain unverified.

The public-installer tests validate checksums, bounded GitHub redirects, strict archive entries, rollback, and real production installation in isolated homes. Pairing tests cover expiry, cancellation, concurrent single-use claims, hashed storage, browser rejection, and CLI secret handling.

The automated remote-deployment test substitutes SSH transport but runs the real archive extraction, production dependency installation, compiled launcher, and skill rendering in a clean temporary home. Diagnostics tests drive the compiled CLI in isolated homes against real loopback services, checking count/status-only output, sanitized invalid configs/responses, unauthenticated endpoint checks, redirect refusal and exclusive private admin export without changing originals. A real bidirectional byte-forwarding test gives Raycast and the connector different loopback endpoints to the same bridge and verifies scoped pairing, exact-session registration, a synthetic request/reply, event subscription and revocation. This is not an SSH or model test. Topology examples were syntax-checked with `ssh -G`, which opens no connection. No actual SSH connection or external-host topology acceptance was performed.

Node may print an experimental `node:sqlite` warning on Node 22. The app uses the built-in SQLite library rather than a native addon.

## Protocol sources

- [Claude Code Channels](https://code.claude.com/docs/en/channels.md) and [Channel contract](https://code.claude.com/docs/en/channels-reference.md)
- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Raycast extension lifecycle](https://developers.raycast.com/information/lifecycle)

MIT license. Argo is an independent companion tool, not an official Raycast, Anthropic, or OpenAI product.
