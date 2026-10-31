# Choose where Argo runs

Choose the machine for the **bridge**, then supply the address visible from **each client machine**. Raycast runs on your Mac; the Agent can run there or on a server. You do not have to move a working bridge, replace an existing tunnel, or use a particular forwarding direction.

Argo stays loopback-only. SSH carries the existing authenticated HTTP/WebSocket protocol; there is no public web relay, new TLS proxy, public listener, or extra reply port. GitHub distributes runtime code, never conversations.

## Start with the current Claude session

In Raycast, open **Argo → Agent Sessions → Connection Setup**. First select or add a working bridge, then choose where your Agent runs. **Use an Existing Bridge** asks for a private configuration **file path**, not a pasted token, and **Address From This Mac**. **Test and Use Connection** verifies authenticated access before switching. Saved bridge profiles contain names, file paths and per-Mac loopback address overrides only; credentials stay in private files. Removing a saved connection removes that reference, not the bridge or its data.

For an Agent, set **Address From Agent** to the endpoint visible on its machine. Choose **Create Private Pairing Prompt**, then **Copy Private Agent Prompt** to the **already-running Claude Code session**. The prompt contains a ten-minute, single-use code for one binding. The Agent installs the public connector if needed, claims its scoped credential privately and starts cooperative pull in that exact session. [Full Agent instructions](connect.md).

Claude pull is the default: no restart, MCP configuration, model replacement or tmux. Waiting occupies the original Claude's current turn; it must keep its receive/reply loop running. Background processes keep running. Approvals stay in its original terminal. A reachable port is not a ready Agent, and a diagnostic pass is not a model round-trip.

Codex is **experimental**, not a Claude pull target. It needs an existing shared App Server and the exact loaded thread; real populated-session rejoin remains unverified. Choose Codex in the wizard to generate a dedicated experimental pairing prompt. See [Codex connection instructions](connect-codex.md) and [current limitations](../README.md#connect-codex). Other Agents are not automatically supported.

## Topology matrix

The example bridge port is `48123`; forwarded listener ports deliberately differ. All URLs below refer to the same bridge within each row, not to independent services.

| Where bridge runs | Where Agent runs | Tunnel, if needed | Raycast / Mac Agent address | Server Agent address | Admin file transfer |
| --- | --- | --- | --- | --- | --- |
| Mac | Mac | None | `http://127.0.0.1:48123` | — | None |
| Mac | Server | Run `ssh -R` on Mac → server | `http://127.0.0.1:48123` | `http://127.0.0.1:49123` | None; remote Agent receives only scoped pairing |
| Mac | Server | Run `ssh -L` on server → Mac | `http://127.0.0.1:48123` | `http://127.0.0.1:49123` | None; requires SSH access into Mac |
| Server | Server, and optionally Mac | Run `ssh -L` on Mac → server | `http://127.0.0.1:49124` | `http://127.0.0.1:48123` | Export/import admin access privately to Mac |
| Either | Either | Keep existing functioning SSH forward / trusted loopback transport | Existing Mac loopback endpoint | Existing Agent loopback endpoint | Only if Mac does not already have that bridge's admin file |

A remote bridge can serve a local Mac Agent and several server Agents simultaneously. Pair each Agent separately; the bridge's location does not restrict the Agent's location. Do not copy the admin file to Agents to make their attachment easier.

## Bootstrap a bridge on the chosen host

Requirements on the bridge/Agent host: Node.js **22.13+** and npm. Raycast is needed only on the Mac. Keep the bridge process alive for use.

From a checkout on the chosen bridge host:

```sh
npm ci
npm run build
node bin/argo.mjs serve --port 48123
```

Or use the [pinned public installer](connect.md#1-download-the-standalone-pinned-installer): perform only the download/inspection and installation steps, then run `node /ABSOLUTE/INSTALLED/LAUNCHER serve --port 48123` using the returned `launcher` path. Installation alone starts no bridge or Agent. Do **not** claim a pairing code just to start a bridge. The distributed runtime includes the bridge. GitHub/npm access and the installer proxy prerequisites still apply.

`serve` creates a private admin configuration at `$ARGO_HOME/client.json` (default `~/.argo/client.json`) and a local database. Keep that original file on the bridge machine. Do not replace it to change what a tunnel looks like from another machine. For a second independent bridge, use a different `ARGO_HOME` and port.

**Release scope:** the public runtime installer is pinned to `v0.1.2`, including `doctor`, `export-client` and `--agent codex`. Load the Raycast connection wizard from this checkout. Native Codex populated-session rejoin remains experimental.

## 1. Everything on your Mac

Run the bridge on the Mac. Use the existing `~/.argo/client.json` in Raycast and `http://127.0.0.1:48123` for both Raycast and **Address From Agent**. Choose **Agent on this Mac**, then give the private pairing prompt to your current Claude. If Argo is already installed and on PATH, the [local `argo-bind` skill](../skills/argo-bind/SKILL.md) can also attach directly using the existing local private config.

No tunnel and no admin export are necessary.

## 2. Mac bridge, remote Agent: Mac opens a reverse forward

Run this **on the Mac**. Replace `user@server.example` with your SSH configuration alias or real SSH destination:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:49123:127.0.0.1:48123 -- user@server.example
```

`-R` creates the listener `127.0.0.1:49123` **on the server**, and reaches `127.0.0.1:48123` **from the Mac**. Keep the command running. The SSH server must allow remote forwarding and must not be configured to expose the listener publicly (for example by forcing `GatewayPorts yes`). Do not use `-g` or a wildcard bind.

Raycast remains at `http://127.0.0.1:48123`. In the wizard choose **Mac bridge · Mac connects to server** and use **Address From Agent** `http://127.0.0.1:49123`. Only the private single-use pairing prompt goes to the Agent; the Mac admin file stays on the Mac.

The optional [`argo remote --host SSH_ALIAS`](../README.md#optional-mac-driven-ssh-deployment) command installs the connector and holds this direction of tunnel for you. It is not required when your tunnel already works.

## 3. Mac bridge, remote Agent: server opens a local forward

Use this when the server can SSH into your Mac, rather than replacing it with a reverse-forward design. **Mac SSH access/Remote Login must already be available and authorized**; Argo does not enable it or alter SSH configuration.

Run this **on the Agent server**:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:49123:127.0.0.1:48123 -- user@mac.example
```

`-L` creates the listener `127.0.0.1:49123` **on the server**, and reaches the bridge's `127.0.0.1:48123` **from the Mac** through the SSH connection. This has the same endpoint mapping as section 2, despite the opposite SSH initiation direction.

Raycast uses `http://127.0.0.1:48123`; the server Agent uses `http://127.0.0.1:49123`. Choose **Mac bridge · Server connects to Mac**. Pair via the existing Mac bridge; do not give its admin file to the server Agent.

## 4. Server bridge: Mac opens a local forward

Start the bridge **on the server**. Run this **on the Mac**:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:49124:127.0.0.1:48123 -- user@server.example
```

The listener `127.0.0.1:49124` is **on the Mac**, forwarding to the server bridge at `127.0.0.1:48123`. Raycast needs the server bridge's admin authority, not a new independent Mac bridge's token.

### Export and import admin access privately

On the **server**, using this built checkout and the same `ARGO_HOME` as `serve`:

```sh
node bin/argo.mjs export-client \
  --out "$HOME/.argo/mac-client-NEW.json" \
  --url http://127.0.0.1:49124
```

Choose a **new** filename. Export uses exclusive creation and mode `600`; an existing file or symlink is never overwritten. It reads the existing valid private config, writes the same admin token with the **Mac-side URL**, and leaves the server's original `client.json` unchanged. It makes no network request. The file contains admin authority over **all bindings**, not a single Agent credential. The CLI warns but never prints its contents.

Transfer the file over a private channel such as SCP. For example, run **on the Mac**, using the actual absolute server path, into a new private directory:

```sh
umask 077
ARGO_CLIENT_DIR=$(mktemp -d "$HOME/.argo-client.XXXXXX")
scp -p user@server.example:/home/user/.argo/mac-client-NEW.json "$ARGO_CLIENT_DIR/client.json"
chmod 600 "$ARGO_CLIENT_DIR/client.json"
printf 'Private config path: %s/client.json\n' "$ARGO_CLIENT_DIR"
```

Never `cat` the file into chat, paste it into a model/context, include it in a pairing prompt, or store its contents in Raycast preferences/logs/Git. Remove the extra server transfer copy after import if no longer needed. Keep the imported Mac file private; deleting it later disconnects its saved profile. The original bridge config remains on the server. This command deliberately grants the Mac admin control; use scoped pairing instead for Agents.

In Raycast choose **Use an Existing Bridge**, enter that Mac file path and **Address From This Mac** `http://127.0.0.1:49124`, then **Test and Use Connection**. The wizard stores a file reference and address override, not the token. Switching back to another bridge tests it first and does not change running Agents.

Now choose **Server bridge · Mac connects to server**. A Claude Agent **on the bridge server** uses **Address From Agent** `http://127.0.0.1:48123`, not the Mac's forwarded port. Pairing must be generated by the selected server bridge; a code from a separate Mac bridge is not interchangeable.

## Shared remote bridge, local and remote Agents

Keep the section 4 Mac forward and imported admin config. Each Agent gets its own code and scoped file:

- **Mac Agent:** choose **Agent on this Mac** and use `http://127.0.0.1:49124`, the same forwarded address Raycast uses.
- **Agent on the bridge server:** use `http://127.0.0.1:48123`, directly on that server's loopback interface.
- **Agent on another server:** establish an existing authorized tunnel from that machine to the bridge server, then enter that machine's forwarded loopback URL. For example, run `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49125:127.0.0.1:48123 -- user@server.example` **on the other Agent server** and use `http://127.0.0.1:49125` there.

Choose **I already have a working connection** for an endpoint that is already forwarded. Agent endpoint selection and Mac admin-file import are separate operations. Importing admin access does not attach an Agent, and attaching an Agent does not give Raycast admin access.

## Keep an existing tunnel

If the bridge already works over your SSH `LocalForward` or `RemoteForward`, keep it. The wizard's optional tunnel helper only generates a command to copy; it never opens connections or changes SSH settings. Enter the actual per-machine endpoints; different ports are normal. Use your normal SSH aliases for ports, keys, jump hosts and host-key verification. Never disable host-key checks.

A tunnel only carries the protocol: bridge admin authentication and per-binding connector authentication remain required. An existing trusted transport must still present loopback HTTP endpoints. Argo does not add or configure a web relay or TLS proxy.

## Safe diagnosis and next steps

With this built checkout:

```sh
# On the bridge host (or a Mac CLI home with its imported client.json).
node bin/argo.mjs doctor
# On any connector machine, without any admin config.
node bin/argo.mjs doctor --url http://127.0.0.1:49123
```

`doctor` prints structured JSON and makes only a read-only `GET /v1/sessions`. It reports Node runtime support, private client config `found` / `missing` / `invalid`, bridge access status and an actionable `nextStep`. Authenticated success includes total/online counts and fixed status counts only: no names, paths, IDs, text, tokens, prompts or response/error bodies. It creates or changes no files, sessions, pairing codes or permissions. Diagnostic findings are returned as JSON with exit code zero; check `bridge.status` and `nextStep`, not just shell success.

Without `--url`, doctor reads `$ARGO_HOME/client.json` and verifies authenticated access using that file's address. It does not read Raycast's saved profiles or preference override. To diagnose an imported Mac config with the CLI, keep it as `client.json` in a dedicated private directory and run `ARGO_HOME=/absolute/private/directory node bin/argo.mjs doctor`. Do not overwrite another installation's client file.

**With `--url`, no admin token is sent**, even if a local config exists. HTTP 401 is `reachable-not-authenticated` with `identity: "unverified"`: an HTTP service answered, but an arbitrary 401 is not proof that it is Argo. It is a safe tunnel/endpoint check, not proof of connector WebSocket access, valid pairing, Agent readiness or successful model execution. Redirects are never followed; unsafe/public URLs are rejected before a request. No mutation endpoint or pairing claim is probed.

| Finding | Next step |
| --- | --- |
| Unsupported Node runtime | Use Node.js 22.13+ on that machine. |
| Missing config on an Agent-only machine | Expected; use `doctor --url` for transport and claim a scoped pairing. Do not transfer admin to the Agent. |
| Missing config on bridge host / Mac | Start `serve` on the intended bridge host, or privately import that bridge's exported client file on the Mac. |
| Invalid private config | Check valid JSON, ownership and mode `600` locally; never paste its contents for diagnosis. |
| HTTP 401 | Check the intended tunnel destination; authenticated doctor/Raycast requires that bridge's matching admin file. |
| Connection failure | Keep bridge and tunnel alive, check listener ports and SSH forwarding policy. Do not expose the bridge publicly. |
| Other HTTP or invalid response | Check for a wrong service/port or unwanted proxy. Responses are deliberately suppressed. |
| Authenticated but no sessions / offline sessions | Pair the current Agent, keep its connector and tunnel running, and resume Claude's receive/reply loop. |

If environment proxying is enabled, keep loopback endpoints in `NO_PROXY=127.0.0.1,localhost,::1`, preserving other required entries. See the [installer proxy note](../README.md#github-self-service-setup-recommended).

## Verification boundary

Compiled CLI tests exercise real loopback bridge traffic, isolated homes, sanitized failures, unauthenticated transport checks, redirect refusal, private export, unchanged originals and no-overwrite behavior. SSH example syntax was checked with `ssh -G` (configuration expansion only, no connection). Independent real loopback byte forwards also verify different Mac/Agent addresses reaching the same bridge for pairing, synthetic messaging and event subscription. This is not an SSH server or model acceptance test. No actual SSH connection or external-server end-to-end test was performed for these topology examples. Bridge authentication alone does not prove a native Agent or model round-trip.
