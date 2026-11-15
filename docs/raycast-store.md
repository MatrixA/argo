# Raycast Store publication and updates

[Argo is published in the Raycast Store](https://www.raycast.com/fernando_jacob/argo). Its [initial Store PR #32995](https://github.com/raycast/extensions/pull/32995) merged on 2026-11-13 as commit `9fe3617a91159f550a60587441745a5a21de435c`. The published extension includes direct Herdr terminal control alongside Argo bridges and pins the patched v0.1.4 bridge runtime. Screenshot comments and input-bar attachment controls are under review in [Store update PR #33548](https://github.com/raycast/extensions/pull/33548). Codex populated-thread and native multi-client approval acceptance remain unverified.

Argo is prepared as a **self-configured companion extension**. The Store installs only the Mac UI. The separately installed bridge, connector, native Agent and loopback transport remain under the user's control. No hosted Argo service, model account, tunnel or background system service is bundled.

## Reproducible checks

Run from the Argo repository root:

```sh
node scripts/sync-raycast-protocol.mjs --check
npm run lint --workspace extensions/raycast
npm run test --workspace extensions/raycast
npm run typecheck
npm run raycast:build
npm test
```

The root `raycast:build` command typechecks and builds the development workspace. The standalone candidate uses the official `ray build -e dist` distribution build. Raycast CLI expects a local `node_modules/.bin/tsc` for distribution checks, which is absent when npm hoists the workspace compiler; use the standalone export for the release gate.

The extension contains its own protocol snapshot so it never imports files outside its submission directory. Edit `packages/shared/src/protocol.ts` in this repository, then regenerate with `node scripts/sync-raycast-protocol.mjs`. The backend regression suite checks that the snapshot is identical. Formatting tools intentionally leave this generated file unchanged.

Export reviewed public source to a **new, nonexistent directory**:

```sh
node scripts/prepare-raycast-store.mjs /ABSOLUTE/FRESH/argo
npm --prefix /ABSOLUTE/FRESH/argo ci --ignore-scripts
npm --prefix /ABSOLUTE/FRESH/argo run lint
npm --prefix /ABSOLUTE/FRESH/argo run build
```

The exporter copies production extension source, assets, Store metadata, configuration and documentation. It excludes `src/*.test.ts`, removes the `test` script and test-only `tsx` dependency from the exported manifest, and regenerates the exported lockfile offline without installing packages or running lifecycle scripts. Tests and their runner remain in the Argo development workspace and run before export. The source lockfile pins retained dependency versions; the exporter needs npm and its existing package cache. It does not copy credentials, `.context`, runtime databases, installed dependencies or the enclosing repository. The destination is created exclusively, never overwritten. Exporting and building do not publish anything.

## Submission materials

- `extensions/raycast/README.md`: prerequisites, self-configuration, first pairing, limitations, privacy and removal.
- `extensions/raycast/CHANGELOG.md`: a new update entry with the required merge-date placeholder, followed by the unchanged published Initial Version history dated 2026-11-13.
- `extensions/raycast/metadata/`: fresh 2000 × 1250 PNGs saved by Raycast Capture Window with Save to Metadata. They show current signed bridge discovery, the actual pending approval-review view, and a connected conversation with compact status icons and message-only Markdown details. The unmodified production components use a disposable local bridge and connector-backed synthetic examples. No existing user conversation, pairing secret or credential is included.
- Public macOS manifest, explicit dependencies, standalone npm lockfile, ESLint/Prettier configuration, distribution build and publication scripts.

## Preparation verification

Latest extension verification on 2026-11-03. Dedicated native Claude message/context acceptance remains dated 2026-10-31:

- A fresh standalone export installed with `npm ci --ignore-scripts`, passed `ray lint`, passed all 108 extension tests and completed the official distribution build with TypeScript checking.
- Herdr follow-up messages now recognize reported done as ready, omit the unsupported done send condition, and preserve ordinary Enter / Command-N input. Working keeps drafts rather than routing to dialog controls. Agent Sessions opens the full catalogue while Recent resumes. Real isolated HC and production-component multi-turn checks cover the completion-state regression.
- Direct Herdr discovery, current output, task input, single-step permission navigation/confirmation, Unicode dialog text, recent reopen, persistent uncertainty without replay, post-fix sending and interruption passed in the actual Raycast app against an isolated real HC core and non-model terminal fixture. HC sends terminal input, not native approval transactions. External SSH and real model approval completion remain unverified. Existing Agent sessions and credentials were not used.
- Repository backend regression: 55 passed and one optional native Codex test skipped, including protocol snapshot and safe-export regressions. The bridge CLI smoke test passed. That regression run made no paid model request. Separately, the user-authorized dedicated local Claude acceptance made real model calls and verified same-session context recall.
- Review feedback is covered by regressions for reconnect snapshots, durable retry IDs, custom discovery ports, generated preference types, and confirmed-rejection recovery. Rejected sends keep their draft; uncertain or previously queued attempts retain their original ID.
- Approval review now owns a live request subscription, uses bridge-relative time, refreshes after rejection and distinguishes expiry, prior submission/resolution, changed parameters, changed session and disconnection. Regressions cover time skew, submit-time races, unknown delivery and live invalidation. Actual Raycast Enter delivered exactly one synthetic allow; real loopback HTTP rejected resolved and expired requests. Native multi-client approval completion is still not claimed.
- Codex colon-bearing approval IDs now travel unchanged after strict protocol validation, compatible with the existing v0.1.4 bridge. A cross-package HTTP/WebSocket/adapter regression covers actual generated IDs, native response types, questions and duplicate rejection. Preflight failures allow explicit retry without claiming an uncertain POST. Earlier simple-ID acceptance missed this routing defect.
- Completed/expired approvals and questions now live in a separate read-only history, 20 at a time with explicit expansion and full-history search. Pending/submitted requests remain in the conversation; messages keep their latest-reply selection. No runtime storage or protocol change is needed.
- Codex request previews, approval review and completed history share structured command/directory/reason/permissions formatting. Complete unchanged details remain available in a separate read-only original-parameters view. Code fences keep embedded Agent markup inert; unknown fields remain visible. The original-parameters action is hidden while an approval decision is sending, preventing its successful completion from popping a newly opened page.
- Both the repository and standalone dependency audits reported zero vulnerabilities after applying the minimatch override.
- The earlier screenshot set passed dimensions/format validation and used disposable data plus a dedicated local Claude acceptance session. Its offline post-cleanup context image has been replaced by the current connected example described below.
- The standalone distribution build loaded in the actual Raycast app. Its discovery screen, rescan action and action menu were exercised. Earlier screenshots covered UI-only acceptance. A separate dedicated real local Claude fixture now verifies model replies and context recall; it never targets an existing user task. See [local acceptance](local-acceptance.md).

## Screenshot refresh, 2026-11-13

All three metadata images were captured again from the current extension through the official Capture Window command with Save to Metadata enabled. The command was invoked through its own copied Raycast deeplink, without adding or changing a global hotkey. The images use one consistent system theme and wallpaper. Original captures are retained privately before byte-for-byte copies to the canonical metadata filenames.

Discovery displays “Signed identity · Use a trusted forward · Pair once”. Approval displays the actual live pending review, including command, working directory and reason. The conversation stays connected and shows compact status icons, readable example message prefixes, a rendered table and message-only details without the previous status metadata panel.

The temporary development registration uses production source unchanged, isolated preferences, an absent HC socket and a single private discovery port. Its real bridge and connector transports supply synthetic example content and a pending request. These screenshots demonstrate the current UI, not model-generated accessibility results or native approval completion. No task or approval decision was submitted. Earlier dedicated real Claude acceptance remains a separate historical check.

## Update candidate verification (2026-11-15)

- Extension regression tests: 209 passed. Repository tests: 62 passed, with the opt-in live Codex test skipped.
- Repository and extension TypeScript checks, generated protocol synchronization, and diff whitespace checks passed.
- A fresh standalone export passed locked installation with lifecycle scripts disabled, official Raycast lint, and distribution build. The export includes Screenshot and Comment and the direct image dropdown controls.
- The published Initial Version changelog was compared with upstream and preserved exactly. The new update uses its own merge-date placeholder.
- Actual Raycast screenshot, send, direct removal and Recent reopening acceptance is recorded in [local acceptance](local-acceptance.md). Complete manual preview/change flows remain unverified.
- Export validation did not publish, create a Store update PR, install a production extension, or update any installed runtime.

## Cache review follow-up

Greptile's review of Store PR #33548 identified valid reattachment-cleanup and abandoned-capture retention defects. The follow-up protects persistent references, retains images before saving drafts, expires unreferenced captures, and coordinates cache mutation across command instances with a lock that releases on process exit. The updated source passed 217 extension regressions, TypeScript, standalone export/protocol regressions, Raycast-managed Node compatibility, and a fresh standalone locked install/lint/distribution build. See [the acceptance record](local-acceptance.md#image-cache-lifecycle-review-follow-up) for exact coverage and remaining desktop limits.

## Submission status and boundaries

- The public `fernando_jacob` Raycast profile was verified. No account was created or changed.
- The initial submission was reviewed and merged. The Store listing offers Install Extension, and `raycast/extensions/main/extensions/argo` contains the published source. The subsequent screenshot and image-control update is open as [PR #33548](https://github.com/raycast/extensions/pull/33548).
- Dedicated real local Claude sending, replies and context recall passed. Cooperative pull keeps tool approvals in the terminal, not Raycast. Codex populated-thread rejoin and native multi-client approval routing remain unverified and are described as experimental.
- Published v0.1.4 assets were anonymously downloaded and installed in a clean temporary home after publication. Discovery, pairing, synthetic messaging and revocation passed. Existing release assets and immutable tags were not overwritten.
- The distribution build was reviewed in the actual Raycast app. The listing prominently requires self-configuration.
- Final source, screenshots and public runtime payload were reviewed and scanned before submission. Scans are not a guarantee of safety.
- Runtime v0.1.4 contains the upload/revocation fix. All active installation prompts pin the new immutable release. Previously running bridges require explicit stop/restart using the new launcher. See [security assessment](security-review.md).

The initial PR was updated under the user's explicit publication authorization and is now merged. Future changes must use a new Store update PR rather than pushing to that merged submission.

## Updating the published extension

1. Review and validate the source changes in this repository. The Argo source PR and the Store update PR are separate reviews; updating one does not publish the other.
2. Add a new `CHANGELOG.md` update heading with `{PR_MERGE_DATE}` as its date and preserve the published Initial Version entry and date.
3. Create a fresh standalone export and run its locked install, official lint and distribution build using the commands above.
4. Prepare a new branch in the author's `MatrixA/raycast-extensions` fork from current upstream `raycast/extensions/main`, and update only `extensions/argo` with the reviewed export. Check for upstream contributions before replacing files.
5. Open an update PR against `raycast/extensions:main`, or use the official `ray publish` flow from a standalone Git checkout. Publishing authenticates with GitHub and opens a public PR. Once reviewers accept and merge it, Raycast automatically publishes the update to the Store.

The earlier `argo-store-submission` branch belongs to the merged initial PR and must not be treated as an open update submission. The verified Store history contains only Initial Version, and the upstream directory has no later contribution as of 2026-11-15. Do not run `publish` as part of validation. Use the attribution required by the working session on commits and the pull-request description.

Store publication updates the Mac extension only. The screenshot feature's native image transport still requires an updated source-built bridge and connector; the fixed v0.1.4 runtime is unchanged. Herdr uses its optional `terminal.put` capability. A Store PR must preserve these prerequisites rather than imply that it upgrades users' runtimes or binds their global shortcuts.

Official references:

- https://developers.raycast.com/basics/prepare-an-extension-for-store
- https://developers.raycast.com/basics/publish-an-extension
- https://manual.raycast.com/extensions-guidelines
