# Local Claude acceptance and public demonstration material

Verified on 2026-10-31 with Claude Code 2.1.314 and Argo v0.1.4 source. The test used a dedicated real Claude session, a private temporary Argo home and a direct Mac loopback bridge. No Docker, SSH, replacement of a user session or user conversation was involved.

## What ran

A separate test session was deliberately started for acceptance only. Before it attached, its initial instruction established an arbitrary fixture phrase. Its Bash tool then ran Argo attach using its own authoritative native session identity and a private scoped credential file. The test allowed only the isolated wrapper's Argo actions, with a bounded model budget and normal noninteractive tool allowlisting. It did not disable permission enforcement, read user credentials into context, enable external MCP servers or edit user settings.

The Mac-side client used the extension's actual discovery, pairing and Hub functions against the real bridge. It submitted messages through authenticated HTTP while the original test session waited in `next`.

| Check | Observed result |
| --- | --- |
| Initial native identity | Supplied by the dedicated Claude Bash environment |
| Identity after attachment and both replies | Unchanged |
| First real message | Asked the session to confirm readiness |
| First real reply | `Local Agent ready. Context retained.` |
| Second real message | Asked for the phrase established before attachment, without repeating it |
| Second real reply | `amber otter satellite cedar` |
| Message states | Both completed |
| Transport | Direct Mac loopback HTTP and connector WebSocket |
| Additional infrastructure | None |

These were actual model-produced replies through the live cooperative pull session, not generated synthetic connector responses. Argo itself still makes no model API calls. The test harness launched the dedicated Agent solely as a test fixture; normal attachment does not launch or replace an Agent.

## Public-material boundary

Only this dedicated fixture conversation may be shown in screenshots or PR evidence. Private configuration files, temporary pairing codes, durable credentials, user bridge names, native private transcripts and unrelated desktop content are excluded. Store images are cropped to the application window and visually inspected before publication.

The screenshot preview uses the actual production conversation component against this fixture bridge. The bridge was then stopped and its private temporary home removed. The captured completed conversation correctly shows “Bridge Unavailable” after cleanup; it is not presented as a currently connected Agent. A separate development extension identity isolates its preferences and LocalStorage from the user's installed Argo extension. Compilation alone is not counted as a screenshot or interaction test.

## What this does not establish

- Claude cooperative pull does not relay native permissions. Approvals remain in the original terminal, and waiting occupies that session's current turn.
- A context-recall fixture does not prove all prompts, providers or tools will work. The original Agent still must cooperate with the receive/ack/reply loop.
- This is not native Codex acceptance, external SSH acceptance or a native multi-client approval-completion test. Codex remains experimental and may refuse an incompatible or unloaded shared-runtime thread.
- Signed discovery does not make an untrusted local forwarding service safe. Use trusted local listeners or authenticated SSH forwarding.

The ordinary reproducible non-model gates remain `npm test`, the extension test suite, typecheck, official standalone distribution build and `npm run smoke`. A real model acceptance additionally requires explicit authorization, a dedicated session and a bounded budget; it must never target an existing user task.

## Public release installation

After v0.1.4 was published, an anonymous download of its installer completed a clean-home installation with real production dependencies. The published launcher started a fresh bridge; a separate byte-forward loopback endpoint passed signed discovery, Mac pairing, exact synthetic attach/next/ack/reply and client revocation. This post-publication check is a protocol/install fixture, separate from the actual local Claude model acceptance above. Both temporary homes were removed.

## Approval lifecycle regression, 2026-11-01

The Mac extension now keeps approval review subscribed to its exact bridge, binding and session generation. It checks a fresh authoritative snapshot before every decision and shows distinct reasons for expiration, prior submission/resolution, disconnection, changed session and changed parameters. Time comparison uses the existing bridge HTTP Date header with monotonic elapsed time instead of the Mac wall clock. Missing bridge time blocks decisions. This is compatible with the published v0.1.4 bridge; no runtime assets or immutable tags are changed.

An isolated, separately named Raycast extension displayed the production approval component against a disposable synthetic connector. Enter delivered exactly one `allow` decision and no command ran. A separate real HTTP/connector check verified successful delivery, rejection after resolution and rejection after expiry. The open Raycast detail also removed Allow after a synthetic terminal-resolution event and automatically changed from pending to expired at the deadline without another action. Automated view tests cover live invalidation, expiry without another event, explicit feedback on Enter, suppressing retries after unknown delivery and preventing late submissions from popping a view after the review closes. These checks do not establish native Codex or Claude permission completion. No real user approval, credential or conversation was used.


## Codex approval identifier transport regression, 2026-11-01

A follow-up reproduced the exact “This session or request is no longer available” failure while the session was online and the request remained pending. The Mac encoded the colons in Codex request IDs as `%3A`, but the published bridge route accepts literal colons. Earlier GUI/HTTP approval fixtures used simple IDs and missed this boundary.

The extension now validates the request ID with the shared protocol schema and preserves its route-safe colons. Separators, percent-encoded input and oversized IDs are rejected before any decision POST. This client-side correction works with the unchanged v0.1.4 bridge and needs no bridge restart. A preflight GET failure is now distinguished from an uncertain POST result: no decision was sent, and a later explicit activation can retry after reconnecting. Unknown POST delivery still blocks replay.

The new regression sends production Codex adapter IDs through the actual Raycast Hub, loopback HTTP bridge, connector WebSocket and Codex JSON-RPC adapter into a fake native process. It checks approvals, denial, question answers, exact native ID types and no repeated response. This is protocol integration acceptance, not a real Codex runtime/model or native multi-client approval-completion test.

A separately named temporary Raycast extension also used the production approval component with a Codex-format colon-bearing ID. Enter delivered exactly one `allow` with the unchanged ID, and the fixture resolution appeared in the conversation. No command ran. The fixture never connected to a real user Agent.


## Approval history layout, 2026-11-01

Completed and expired interactions no longer render above conversation messages. The conversation retains pending and submitted requests and has a single history entry below its messages. A separate read-only view displays 20 history records initially, expands only on explicit action and searches across all records in the fetched snapshot. Records are not deleted and no decisions are available in history. The bridge still returns the full interaction snapshot; the UI batch size is not backend pagination.

Automated view regressions cover a hundred completed requests alongside active requests and the latest reply, selection fallback when an approval resolves, explicit history expansion, full-history search and preserving submitted or unknown-clock pending requests outside completed history.

An isolated actual Raycast fixture containing 65 resolved approvals, one pending request and one reply showed only the active request, reply and single history entry in the main view. The latest reply stayed selected. The history view opened read-only, explicit Show More expanded it from 20 to 40 records, and its search found a record outside the first visible batch. No real Agent request or user conversation was used.


## Approval readability, 2026-11-01

Codex command, directory, reason, operation, file changes and permission rules now use labeled sections instead of a single compact JSON blob. Main previews, approval review and history share the renderer. Opaque thread/turn/item IDs remain in a separate complete original-parameters view. Unknown fields remain visible. The original details are not mutated, and original-parameter inspection is read-only. A code fence longer than embedded backtick runs keeps untrusted Agent content literal. Malformed or unfamiliar input falls back to literal display, not a missing summary.

Regressions cover command formatting, permission nulls and deny rules, file grant warnings, unknown fields, malformed and deeply nested JSON, embedded fences/images/HTML, unchanged original content and the existing Enter action. This is a UI-only update compatible with the unchanged v0.1.4 bridge.

An isolated actual Raycast fixture displayed command, file-change, network and filesystem permission previews and the production approval review. Command, working directory and reason appeared in separate labeled sections. The complete original-parameters page opened read-only with its original correlation IDs and no Allow or Deny action. No decision was submitted, command executed or real Agent connected. Independent review found a deeply nested JSON serialization crash; a failing regression reproduced it before the original-text fallback fix, and independent re-verification passed.
