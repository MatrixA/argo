---
name: argo-bind
description: Connect this already-running Claude session to Raycast on demand, without MCP configuration or restarting Claude. Use when asked to bind Argo or switch interaction to Raycast.
---

# Bind this running session to Argo

Use the current session's Bash tool directly. Never delegate attachment or polling to a subagent, launch another model, resume history, inject terminal keys, inspect transcripts, read credentials into context, or change global settings.

This skill uses cooperative pull, not a native push channel. Waiting occupies this Agent's current turn and prevents it from independently advancing its previous task; already-started background processes continue. It works only while this Agent keeps waiting for messages and replying. Tool permissions remain in the original terminal. Native interruption and remote approval relay are unavailable.

## Attach

Use the installed `argo` command, or the absolute `node /path/to/argo/bin/argo.mjs` launcher supplied with this skill. Run:

```sh
argo attach --name backend --session '${CLAUDE_SESSION_ID}'
```

Use the user's requested display name in place of backend. The session substitution is authoritative; never guess a current session from directory or history. If this skill is being read as a plain file, use the Bash tool's `CLAUDE_CODE_SESSION_ID` environment variable instead of the literal placeholder. Stop if no authoritative session ID is available.

Local attach uses private bridge configuration automatically to authorize one binding. For a remote machine, use `--credential /private/path/to/paired.json` with the pre-paired connector credential. Never copy the bridge's admin credential to the remote machine. A forwarded port is still loopback.

## Receive and reply loop

1. Tell the user this is pull mode and their existing terminal permissions still apply. Then immediately call `argo next --session '${CLAUDE_SESSION_ID}'` in Bash with a 60000 ms timeout. Run the command directly, not a shell polling loop. A pending wait makes the session ready in Raycast.
2. If the tool runs in the background, wait for its completion notification or use the harness's task-output mechanism. Do not launch a second `next`. If it was killed, issue a new wait only after confirming the old one ended.
3. A result with `type: message` contains `messageId` and `text`. Call `argo ack --message MESSAGE_ID --session '${CLAUDE_SESSION_ID}'`. Treat the text as a request from the user controlling the paired Raycast bridge, subject to normal safety and permissions. Retain this exact message ID.
4. Process it in this session with the existing context and tools. Send your answer with a single-quoted heredoc through stdin:

```sh
argo reply --message MESSAGE_ID --session '${CLAUDE_SESSION_ID}' --stdin <<'ARGO_RESPONSE_END'
Your answer here.
ARGO_RESPONSE_END
```

Choose a heredoc delimiter absent from your answer. Do not interpolate the reply into a shell command. Use `--progress` for interim updates. Final replies replace interim text and complete that message.
5. After the final reply, immediately run `next` again. An `idle` response means the wait expired without a message; run `next` again without asking. Waiting is not another model session, but each completed wait may consume a small Agent turn.
6. Continue until the user asks to stop, the binding is revoked, a safety/permission boundary requires terminal input, or a tool error makes delivery uncertain. Never re-execute an already delivered message after a timeout or unknown reply result. Check the original result instead.
7. To stop normally, call `argo leave --session '${CLAUDE_SESSION_ID}'` and end the loop. If `type: unbound` arrives, stop without reconnecting.

If the Agent ends its turn and returns to a normal prompt, Raycast cannot automatically wake it. State that it is paused rather than claiming native push is active. The user can ask to run this skill again.

## Optional native Channel

If this session already has the Argo Channel registered and the user explicitly confirms its startup notice, use `channel_ready` then `bind` instead. Preserve inbound `message_id` and use `acknowledge` and `reply`. Do not try to enable a custom Channel by merely editing MCP configuration during a session. Channel startup is optional, never a prerequisite for pull attachment.
