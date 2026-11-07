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

## Approval submission navigation, 2026-11-02

Store review identified that opening Original Parameters while an approval decision was sending could put a new page above the still-mounted review. A successful response then popped that page and left the review's own Back action inactive. The approval now hides only its original-parameters navigation while busy. Read-only inspection remains available before submission and returns after an unsuccessful response. Decisions, request validation and native Back handling are unchanged.

A production-component regression failed before the fix and passed afterward. It covers pending submission, live request invalidation while still busy, accepted completion, unsuccessful completion and restored original inspection. Existing late-response/unmount and duplicate-activation regressions also pass.

An isolated actual Raycast fixture held a synthetic response open, verified that the sending action menu had no Original Parameters entry, then released the response and returned to its parent conversation. It used the production Approval component but no bridge, real Agent, command or model. This is navigation acceptance, not native approval-completion evidence.

## Herdr direct-source acceptance, 2026-11-03

The extension now has a direct HC source independent of native Argo bridges. Development used Herdr core 0.1.17 and App 0.1.12. Discovery connects to an existing private Unix socket without invoking autostarting CLI commands. A separate named Raycast development extension isolates preferences and LocalStorage from installed Argo. Its advanced socket preference points exclusively to an acceptance core with scratch HC_SESSION, XDG state/config/runtime directories and a private socket. No user Agent, model API, real command authorization or HC remote credentials were involved.

A non-model Python terminal fixture reports OSC 7501 idle, blocked permission, blocked question and working states. Its own input log records exact submitted text, navigation keys, decisions, answers and interruption. Production code discovers the core and terminal, captures Unicode screen text, sends a task, displays its permission prompt inside Raycast, sends one Down key, refreshes, and separately submits Enter. The fixture records exactly one task, one navigation and one denial. This confirms terminal keyboard control, not native Claude/Codex approval completion.

Actual runtime testing caught an omitted-field difference: HC omits terminal.list.machines when the table is empty. The client now accepts omission and fetches machine.list only as a fallback. Explicit malformed machine tables remain rejected. A targeted regression covers omission, embedded tables and invalid values.

Automated checks exercise bounded/fragmented NDJSON, generation/capability negotiation, private socket discovery, pinned local/remote routes, event snapshot/missed/EOF, independent HC feed cleanup, legacy and HC recent targets, HC-only first run, single-key review, explicit forced dialog text, unreported terminal input, storage failure, persistent uncertain-delivery locks, duplicate submission, abandoned composers and program replacement. Native bridge approval, queue, credential and reconnect regressions remain in the same suite. Remote protocol fixtures are not external SSH acceptance. The optional live native Codex test remains skipped unless explicitly configured.

HC exposes no atomic expected-screen or agent-incarnation guard. Fresh capture checks cannot eliminate changes while input waits in HC's quiet queue. A key result does not prove approval or completion. Disconnecting cannot cancel queued input, and unknown attempts are never retried. Screen capture can lose color-only selection highlights. Do not infer Allow/Deny from program names. Screenshots contain only the isolated acceptance window and live under ignored .context/.

The actual Unicode question-response path also delivered exactly one answer through the dedicated reviewed text workflow. During that run, automatic capture on the same plain NDJSON RPC connection competed with HC's post-submit start observation. A read timed out and delivery correctly remained uncertain without replay. HC's plain connection processes requests sequentially, so the view now pauses both timer/event reads and user refresh while a target mutation is running; its cached output remains readable. Regression tests cover this pause before React rerenders as well as resuming afterward. Additional review found and fixed stale-view acknowledgment deleting a newer uncertain marker, unsupported shifted punctuation accepted by custom-key validation, and hidden output polling after All Sessions navigation. Each has production-class/view regression coverage.

A direct production-client check against the same isolated fixture sent a synthetic working task and invoked terminal.interrupt. HC returned outcome stopped with key esc, and the fixture logged interruption and returned to idle. This is real HC protocol acceptance. The final production Raycast view also sent a working task, opened its explicit Interrupt confirmation, submitted once and displayed “Interrupt outcome: stopped · key: esc.” The fixture independently logged interruption and returned to idle. Final root tests, extension tests, typecheck, smoke, Raycast build and generated-protocol check passed. A fresh standalone export also passed npm ci, official Raycast lint, the complete extension suite and distribution build. The optional live native Codex test was skipped. Implementation acceptance did not publish changes or replace the user installation. Publication and local extension update are separate subsequent steps.

After the serial-read guard fix, the final production Raycast view sent another permission task and settled normally as blocked with “Input submitted,” without a read timeout or uncertain marker. Reopening the recent fixture preserved the earlier uncertain-answer marker before explicit inspection/recovery and never replayed its answer. The compact permission view was captured and inspected in both dark and light system appearances; the original appearance was restored. Full identity details remain available separately so metadata does not obscure the prompt.

The real GUI checks cover local discovery, current output, ordinary task input, single-step permission navigation/confirmation, Unicode dialog text, recent reopen, persistent uncertainty without replay, the final post-fix send path and interruption. Long-running stress, real external SSH, real model approval-completion, custom keyboard-chord interaction and every long-name/output layout remain outside this manual acceptance. Their synthetic coverage is not presented as real deployment acceptance. The isolated development watcher and acceptance core were stopped after verification; no user core or Agent was stopped.

## Herdr multi-turn regression, 2026-11-03

A reported real-use failure exposed missing completion-state coverage: after the first answer HC reports `done`, but the UI only allowed `idle`, hid Send Task and classified completed terminals as Unknown. A production-component reproduction failed on the missing second-send action. Ordinary messages now accept freshly reported idle or done, label completed terminals Ready, use Send Message / Compose Message, and preserve Enter / Command-N workflows. Working retains the draft rather than opening permission controls. Agent Sessions opens the source-aware catalogue; Recent Agent Session alone resumes its saved exact target.

Real isolated HC acceptance also caught a protocol distinction that a synthetic view test could not: HC 0.1.17 reports done but its send-condition enum accepts only idle or working. The first experimental done condition was rejected before writing. Production now uses if:idle when freshly idle, and omits the unsupported condition when freshly done, always with force:false. The HC blocked guard remains active. Fresh checks cannot make done input atomic against a concurrent transition to working, so no stronger guarantee is claimed.

An independent private core and non-model terminal fixture report done after each answer. The production client submitted repeated messages including Unicode, read each fixture answer, and verified the fixture log contained one submission per explicit message. No model or existing user Agent was used. Production-component regressions cover repeated completed turns, stale working-to-done refresh, retained working drafts, confirmed pre-write rejections without false uncertainty, and the source-list entry. Unknown delivery, durable markers and no automatic replay remain enforced. Root tests, extension tests, typecheck, public CLI smoke and Raycast build passed. A fresh standalone export passed locked install, official lint, all extension tests and the distribution build. The optional live native Codex test remains skipped.


Actual Raycast multi-turn acceptance also passed in a separately named extension whose socket and configuration defaults point only to the isolated fixture. In the same terminal view, Enter submitted an ordinary message, its answer appeared with Ready restored, and a second Unicode message submitted directly without reopening or dialog controls. The fixture log recorded each exactly once, the second reply appeared, and no uncertain-input lock remained. The screenshot under ignored .context contains only the isolated window. Production installed Sessions and Recent bundles were compared with the final source and matched. Existing preferences, credentials and user Agents were not changed.


## Herdr per-message compatibility, 2026-11-03

HC supplies terminal captures rather than a structured transcript. The compatibility layer records only explicit Raycast messages and compares later snapshots against a fixed fresh pre-send baseline. Whole-line insertions, recognizable new exact message echoes and strong suffix-prefix scrolling overlap isolate new terminal-derived output. Streaming replaces the same row rather than accumulating screenshots. Unclear redraws require View Raw Terminal and are never persisted as guessed replies. Text stays inert and literal, including indentation, Unicode, tables and embedded Markdown.

Local history is scoped to the exact target plus observed program fingerprint and bounded to recent turns and text size. Raw baselines remain in memory. Existing screen history is not imported. Restored submitting attempts become unknown and other unfinished captures pause; no observation resumes attribution and no input replays. HC cannot guarantee attribution when another actor inputs text concurrently, so this is reconstructed local history, not a native Agent transcript or receipt. Approval controls still require a fresh original-screen review.

Production-helper, state and component regressions cover repeated sends, fixed-baseline streaming replacement, screen-only fallbacks, selected-message details/full-width reading, exact target/program isolation, paused restoration, incomplete/unstable captures, concurrent turn jumps, corrupt/duplicate storage, failed history writes and rejected versus unknown delivery. Native bridge tests, public CLI smoke, typecheck, protocol generation, extension build and a clean standalone locked install/lint/test/build passed. The optional live native Codex test remains skipped.


Actual Raycast acceptance used a separately named extension and private HC core with scratch state/config/runtime directories. A cumulative-screen non-model fixture included unrelated pre-existing history. Two explicit messages, including Chinese, produced separate user/output rows and exactly one fixture submission each. The selected second reply excluded both prior reply and pre-existing history. Full-width reading preserved Chinese and aligned columns. Reopening Recent Agent Session restored the saved rows and selected latest derived reply without another submission. Compact role/status labels were inspected after removing redundant list subtitles. No user Agent, model API or production preference was used for acceptance.


## Herdr review corrections, 2026-11-03

Store review found two data-loss paths. Shared-suffix removal after a new exact prompt or scroll boundary could discard a real answer ending such as Done. Exact-echo and scrolling extraction now retain the current capture's trailing content rather than infer a footer. A possible UI footer is preferable to silently truncated output. Regressions failed on both exact-echo and scrolling examples before the correction.

Independent conversation views also held stale copies of a whole persisted array. A later save from an older view could delete messages created by a newer view. History writes now serialize read/merge/write per durable key and update only changed turns, preserving other saved records. Returning from All Sessions reloads history without reattributing old output. Failing-first state regressions cover sequential older/newer views and queued streaming saves; added checks cover navigation refresh, paused attribution and corrupt durable records left untouched. Storage failure still blocks pre-send submission, and uncertain input is never replayed.


The correction passed all extension regressions, native bridge regressions, public CLI smoke, typecheck, generated-protocol consistency and a fresh standalone locked install/lint/test/build. Actual isolated HC acceptance through the production client and conversation class preserved repeated Done endings and all messages after sequential sends from older/newer views. The initial probe inspected while the fixture still reported working; waiting for its actual done status made the completion assertion valid. No model was used. This round's attempted Raycast GUI inspection could not complete because accessibility calls repeatedly timed out while macOS reported the session screen locked. The application and user core were not restarted, and no new visual acceptance is claimed. The isolated core and development watcher were stopped. Its disposable extension registration and source remain pending official UI removal after unlock; production support data remains untouched.


## Conversation Markdown and personal hotkeys, 2026-11-07

HC derived replies previously fenced the entire answer, so Markdown tables appeared as terminal text. Native message escaping also encoded table alignment colons and code contents. A shared message formatter now preserves safe Markdown prose and native pipe tables, including alignment and escaped pipes. Recognized fenced and indented code is enclosed with a safe variable-length literal fence, preserving body contents without entities. Original terminal captures and approval review remain literal. Links, images, HTML and reference syntax remain inert. Copy actions keep the original message source. This is presentation only; attribution, input, approvals and native bridge behavior are unchanged.

The revised personal global launch mapping is Control-Shift-Command J for Recent Agent Session, K for Agent Sessions and L for Connect a Server. It was configured through official Raycast Settings, not by editing Raycast databases. Global command hotkeys are user-owned; the extension cannot ship them as manifest defaults.

All 162 extension tests passed, including production native/HC rendering, full-width equality, exact copying and unchanged raw/control-screen checks. Root tests passed with 55 passing and the optional native Codex test skipped. Typecheck, official lint, build, public CLI smoke and generated-protocol consistency passed. A fresh standalone export passed locked dependency installation, lint, all 162 tests and distribution build.

The root SSE test initially failed under Node 26.5.0 because it assumed the first network chunk contained an event ID. A legal standalone connected-comment chunk disproved that assumption. The test now reads bounded-by-time chunks until an event ID and always aborts its stream on exit. The isolated test passed repeatedly and the full root suite passed. No runtime source was changed for this correction.

Actual Raycast acceptance used a separately named development extension with defaults pointing only to a private HC 0.1.18 core and an absent bridge configuration. A non-model cumulative-screen fixture returned a Chinese heading, emphasis, aligned table and code block after one explicit Unicode request. Split and full-width views both exposed a native table and preserved the code URL and indentation. Screenshots were visually inspected. Selected output excluded unrelated earlier screen history. The fixture independently recorded exactly one request and one answer. No existing user Agent, model API or external SSH target was used.

Raw terminal and Terminal Controls review were also opened in the actual app without sending terminal keys. Both retained the original Markdown syntax as literal terminal text rather than rendering a table. The fixture log remained at one submission. The production extension was overwritten with the official develop command, then all installed command source maps were compared to the worktree. The production support-file hash snapshot was unchanged.

The private Markdown core and development watchers were stopped. The new Markdown registration and the earlier stopped Argo HC Review registration were removed through official Raycast Settings; their stopped private roots were removed afterward. Production Argo and unrelated registrations remain installed. No Raycast database was edited.


## Compact native message status, 2026-11-07

The native conversation's per-message metadata panel duplicated role, state and its explanation while taking space from the reply. It is removed from normal message details. All delivery states now have distinct compact list-row icons; role, exact localized timestamp and state explanation are available in the accessory tooltip. Failed and unknown results also retain visible text, so exceptions do not rely on color. A read-only Message Details action provides keyboard-accessible timestamp, meaning and complete literal diagnostics. Message text, original copying, HC rendering, approval review and delivery/retry semantics are unchanged.

A failing-first production-component regression covered the reported panel before the change. It now checks every message state, an absent metadata panel and subtitle, distinct icons, visible exception labels, exact hover timestamps, keyboard-accessible details and safely fenced diagnostics. All 167 extension tests passed. Root tests passed with 55 passing and the optional live Codex test skipped. Typecheck, official lint, extension build, generated-protocol consistency and public CLI smoke passed. A fresh standalone export passed locked dependency installation, lint, all tests and distribution build.

Actual GUI acceptance was attempted with a separately named development extension, isolated preferences/storage and a private loopback bridge containing only synthetic messages in all delivery states. No model or existing Agent was used. The development extension built successfully, but accessibility returned no usable main window and macOS reported CGSSessionScreenIsLocked=Yes. The captured window could not establish current rendering. No fresh visual acceptance is claimed, and the screen was not unlocked or the application restarted. The isolated development watcher and bridge were stopped. The disposable registration remains pending official UI removal after unlock. Production support data is not cleared.

The local production extension was overwritten through the official Raycast develop command. Installed Sessions, Recent and Connect source maps were compared with the worktree, and production support-file hashes were unchanged. Personal hotkeys were not edited by this change. Their current GUI persistence could not be rechecked while the session was locked.

A new Store review finding identified valid blank-separated nested list items being converted to standalone literal code. A failing-first exact regression reproduced it. Narrow outer-list content-column tracking now preserves bullet/ordered list context across blanks and nested continuations, resets on nonblank dedent, accounts for tabs and excludes thematic breaks. Standalone indented/fenced code and inert syntax handling remain protected. This is not a full Markdown block parser; list-contained code remains renderer-managed through sanitized prose rather than gaining exact-body code support. Focused and full extension regressions pass.


## List-contained Markdown code correction, 2026-11-07

The next Store review reproduced code corruption inside lists: a literal URL colon became an HTML entity. The shared native/HC formatter now uses markdown-it block tokens instead of handwritten list indentation. It emits safe Markdown containers and re-fences parsed code before adding list/quote prefixes. Sanitized prose remains inert. Reference definitions stay visible. Pipe-table rows remain sanitized source text rather than table tokens, because table parsing discards extra cells beyond the header width. No HTML renderer is used for production output.

Display formatting canonicalizes list indentation and line endings. An incomplete code fence gains the final newline required by its generated closer. Code content, internal whitespace, embedded fence runs and punctuation remain literal. Original Copy Selected Message continues copying the untouched source. If block tokens reach the parser's bounded nesting ceiling, the complete original message is shown literally rather than silently truncated.

The exact review example failed before the repair. Semantic regressions now compare parsed block hierarchy and code values instead of requiring identical Markdown indentation. Paired cases distinguish child continuation prose from parent/child code and cover list-marker fences, quote/list combinations, tabs, wide ordered markers, delimiter changes, thematic-break/empty list items, multiline/trailing-hash headings, single-column tables, maximum-width ordered markers, incomplete fences, hostile syntax and deep nesting. Existing exact table-source tests still protect wide, empty, extra, escaped-pipe and malformed rows. All 176 extension tests passed. Root tests passed with 55 passing and the optional native Codex test skipped. Typecheck, official lint, distribution build, generated-protocol consistency and public CLI smoke passed. A fresh standalone locked install passed lint, all 176 tests and distribution build. Its production dependency audit reported no known vulnerabilities.

Actual Raycast inspection used the separate Argo Compact Check extension and private synthetic bridge, not a user Agent. The refreshed preview showed the Chinese table, list-contained code with an unchanged URL and port, and a nested child list. The normal detail pane contained no role/status metadata panel. Ordinary states used compact icons while failed/unknown states retained visible warning labels. The synthetic bridge has no connector, so its connection warning is expected and is not model or approval acceptance. Screenshots were saved privately and visually inspected. The Message Details action was exposed in the real action menu; navigating it could not be confirmed through automation, so the complete details content remains covered by production-component tests rather than a new GUI acceptance claim. No real task, terminal key, model call or production preference was used in this preview.

The final production extension was overwritten with the official develop command. Installed Sessions, Recent and Connect source-map contents matched the worktree. Production support-file hashes remained unchanged, preserving existing credentials, pairing, preferences and drafts. Personal command hotkeys were not edited. The private synthetic bridge and preview development watcher were stopped after inspection.

The disposable Argo Compact Check registration was removed through official Raycast Settings. A later confirmation helper found no dialog because removal had already completed; both registration/support paths and its Settings entry were verified absent. The stopped current and earlier synthetic bridge roots were then removed after checking their contents and absence of open processes. Production Argo remained installed with identical support-file hashes. No Raycast database was edited.
