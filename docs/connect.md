# Connect this running Claude session to Argo

These instructions are for the **already-running Claude Code Agent on the Agent machine**, at the user's explicit request. Do the setup in this session's Bash tool, then attach and enter the receive/reply loop here. Do not merely return these commands for the user to run when you can execute them. Never spawn another Agent/model, restart/resume Claude, inspect transcripts, inject terminal input, or edit Claude settings, MCP configuration, permissions, or shell profiles.

Public GitHub is **code distribution only**, not a conversation relay. Conversations travel between the connector and the user's selected bridge, directly on the same machine or through an existing loopback tunnel. No Mac uploads source files. No GitHub login/token, bridge admin credential, or model API key is needed remotely.

## Inputs and prerequisites

The user's connection request supplies:

- The **bridge URL as seen from this Agent machine**, typically `http://127.0.0.1:49123`.
- A display name, such as `backend`.
- A short-lived, single-use **pairing code** generated for the selected bridge in Raycast (or `argo invite`). This authorizes exactly one scoped binding; it is not the durable credential.

The selected bridge must already be running and reachable at the supplied address. The bridge and Agent may share a machine, with no tunnel at all. Otherwise reuse the existing transport. SSH local forwarding and remote forwarding both work; the correct direction depends on bridge placement and which machine initiates SSH. Raycast may use a different loopback address for the same bridge. Do not create or change tunnels, relocate the bridge, expose it publicly, or invent a relay. See [topologies](topologies.md) for setup guidance.

Agent-machine prerequisites: **Node.js 22.13+, npm, and tar**, with HTTPS access to public GitHub release assets and registry.npmjs.org. If missing, report which prerequisite is missing; do not install system packages or change permissions automatically. The existing Claude session must have a Bash tool and authoritative `CLAUDE_CODE_SESSION_ID`, or the loaded skill's `${CLAUDE_SESSION_ID}` substitution. Do not guess a session from cwd, recent sessions, or history.

## 1. Download the standalone pinned installer

Use a fresh private directory. Fetch the public installer as a file; inspect it before running. Never `curl | sh`, use a mutable `main` URL, or run from inside a downloaded archive. The following uses native Node fetch and needs no new dependencies. It accepts only HTTPS release redirects to the documented GitHub asset hosts and bounds the download.

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

Remember the absolute directory printed/created by your Bash environment: shell variables may not survive separate tool calls. Read **only the installer code** at that path, not any credentials. The pinned release and installer are trusted as publisher code; the archive's SHA-256 is checked against `SHA256SUMS` from that same release. This detects corruption, not a compromised GitHub publisher. For independent provenance, compare the installer hash with a separately trusted release checksum before executing.

## 2. Install without starting another session

Run the downloaded absolute installer path, substituting the supplied Agent-reachable URL and display name as properly quoted shell arguments:

```sh
node /absolute/fresh/argo-setup.XXXXXX/install.mjs --url http://127.0.0.1:49123 --name backend
```

The installer downloads pinned `v0.1.3/argo-connector.tar.gz` and `SHA256SUMS`, verifies SHA-256, rejects unsafe/unexpected archive entries, extracts into a new private staging directory, and runs `npm ci --omit=dev --ignore-scripts --workspaces=false`. It installs only public runtime code/dependencies and a uniquely named skill. It never runs claim, attach, polling, a model, or a daemon on your behalf.

The `ARGO_INSTALL_READY` result includes absolute `launcher`, `skillFile`, and future `credential` paths, a unique `skill` name, and the `claim` command. Save these **paths**, not credential contents. Releases live under `~/.local/share/argo/releases/<uuid>`; skills under `~/.claude/skills/argo-remote-<uuid>/SKILL.md`. Existing installations/skills are not overwritten, and nothing is added to PATH. The installer can be removed after installation.

## 3. Claim the code, never read the resulting credential

Execute the **claim command printed by this installation**, directly in this current session's Bash tool. Feed only the user-provided one-time code through a single-quoted heredoc, or redirect a user-supplied private code file without reading it. Do not put the code in command arguments, interpolate it as shell text, echo it, or include it in your reply. Never ask for a durable/admin token in chat.

```sh
'/absolute/node' '/absolute/release/bin/argo.mjs' claim \
  --url 'http://127.0.0.1:49123' --stdin --out '/absolute/release/credential.json' <<'ARGO_PAIR_CODE_END'
USER_SUPPLIED_ONE_TIME_CODE
ARGO_PAIR_CODE_END
```

Use a delimiter not present in the code. The placeholder above is **not** a code. If no code was supplied, pause for the user's code/private claim; do not fabricate one. The code expires after ten minutes and is consumed once. On failure/expiry request a fresh code from the Mac. Never retry by creating local admin config, running `serve`/`pair`, or transferring `~/.argo/client.json`.

`claim` writes the scoped credential privately to the given file. Its contents must never enter Agent context, logs, git, diagnostics, or GitHub. The future attach only receives this **file path**. If a credential already exists, do not overwrite it or claim again; use it only if it belongs to this installation and the user still authorizes that binding.

## 4. Attach this same session and immediately wait

Read the installed unique `skillFile` (safe: it contains paths and instructions, not credentials) and follow it **now**, without delegating or waiting for a new user prompt. Skills may hot-reload; if not listed yet, reading the file and following it is sufficient—no restart is required. Its attach command already contains absolute remote paths and `--credential FILE`:

```sh
'/absolute/node' '/absolute/release/bin/argo.mjs' attach \
  --credential '/absolute/release/credential.json' --name 'backend'
```

Run from this session's Bash environment so attach uses authoritative `CLAUDE_CODE_SESSION_ID`. If a skill is loaded normally it can explicitly pass `--session '${CLAUDE_SESSION_ID}'`; when reading it as a plain file, use the environment ID instead of the literal placeholder. Stop if neither authoritative identity is available.

Tell the user this is cooperative **pull mode** and existing terminal tool permissions still apply. Then immediately run the installed launcher's `next` command in Bash with a 60000 ms tool timeout. Follow the unique skill for ack, processing in this same context, reply via stdin, and the next wait. Do not return a normal final answer after attaching instead of entering the loop. Never run two concurrent `next` calls or replay a message after an uncertain result.

## Limits and stopping

- Waiting occupies this Agent's current turn. It cannot independently advance the previous task while waiting. Already-started background processes keep running.
- This is **not native push**: it works only while this Agent cooperates with the receive/reply loop. A completed wait can consume a small Agent turn. Returning to the ordinary input prompt pauses delivery; Raycast cannot wake it automatically.
- No native interruption, automatic token streaming, or remote approval relay. Tool permissions remain in the original terminal. Stop and ask there when a permission/safety boundary requires it; do not weaken policy.
- Revocation or a closed SSH tunnel stops delivery. Do not silently reconnect with another credential or replay an uncertain prompt.
- Use the unique skill's `leave` in this same session to revoke its binding and stop the loop without stopping Claude. A new connection needs a new pairing code if revoked.
- Uninstall only this installation: revoke first, then remove the exact unique skill directory and release directory from `ARGO_INSTALL_READY`. Never remove all skills, all releases, shared settings, or another session's files.
