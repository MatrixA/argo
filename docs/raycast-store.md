# Raycast Store submission

[Store PR #32995](https://github.com/raycast/extensions/pull/32995) was submitted on 2026-10-31. The updated submission is ready for reviewer assessment, not approved or listed. The current candidate pins the patched v0.1.4 runtime and has dedicated real local Claude acceptance. Codex populated-thread and native multi-client approval acceptance remain unverified.

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
npm --prefix /ABSOLUTE/FRESH/argo test
npm --prefix /ABSOLUTE/FRESH/argo run build
```

The exporter copies only extension source, assets, Store metadata, standalone manifest/lockfile, configuration and documentation. It does not copy credentials, `.context`, runtime databases, installed dependencies or the enclosing repository. The destination is created exclusively, never overwritten. Exporting and building do not publish anything.

## Submission materials

- `extensions/raycast/README.md`: prerequisites, self-configuration, first pairing, limitations, privacy and removal.
- `extensions/raycast/CHANGELOG.md`: initial public submission with the required merge-date placeholder.
- `extensions/raycast/metadata/`: PNG screenshots at 2000 × 1250, showing a disposable bridge, synthetic approval, and a dedicated real local Claude context-recall conversation after cleanup. No existing user conversation, pairing secret or credential is included.
- Public macOS manifest, explicit dependencies, standalone npm lockfile, ESLint/Prettier configuration, distribution build and publication scripts.

## Preparation verification

Latest extension verification on 2026-11-02. Dedicated native Claude message/context acceptance remains dated 2026-10-31:

- A fresh standalone export installed with `npm ci --ignore-scripts`, passed `ray lint`, passed all 58 extension tests and completed the official distribution build with TypeScript checking.
- Repository backend regression: 55 passed and one optional native Codex test skipped, including protocol snapshot and safe-export regressions. The bridge CLI smoke test passed. That regression run made no paid model request. Separately, the user-authorized dedicated local Claude acceptance made real model calls and verified same-session context recall.
- Review feedback is covered by regressions for reconnect snapshots, durable retry IDs, custom discovery ports, generated preference types, and confirmed-rejection recovery. Rejected sends keep their draft; uncertain or previously queued attempts retain their original ID.
- Approval review now owns a live request subscription, uses bridge-relative time, refreshes after rejection and distinguishes expiry, prior submission/resolution, changed parameters, changed session and disconnection. Regressions cover time skew, submit-time races, unknown delivery and live invalidation. Actual Raycast Enter delivered exactly one synthetic allow; real loopback HTTP rejected resolved and expired requests. Native multi-client approval completion is still not claimed.
- Codex colon-bearing approval IDs now travel unchanged after strict protocol validation, compatible with the existing v0.1.4 bridge. A cross-package HTTP/WebSocket/adapter regression covers actual generated IDs, native response types, questions and duplicate rejection. Preflight failures allow explicit retry without claiming an uncertain POST. Earlier simple-ID acceptance missed this routing defect.
- Completed/expired approvals and questions now live in a separate read-only history, 20 at a time with explicit expansion and full-history search. Pending/submitted requests remain in the conversation; messages keep their latest-reply selection. No runtime storage or protocol change is needed.
- Codex request previews, approval review and completed history share structured command/directory/reason/permissions formatting. Complete unchanged details remain available in a separate read-only original-parameters view. Code fences keep embedded Agent markup inert; unknown fields remain visible. The original-parameters action is hidden while an approval decision is sending, preventing its successful completion from popping a newly opened page.
- Both the repository and standalone dependency audits reported zero vulnerabilities after applying the minimatch override.
- The screenshot metadata passed Raycast's dimensions/format validation and was visually inspected. Screenshots use disposable data and a dedicated local Claude acceptance session, never an existing user task. The local-context screenshot shows offline state after its bridge was cleaned up.
- The standalone distribution build loaded in the actual Raycast app. Its discovery screen, rescan action and action menu were exercised. Earlier screenshots covered UI-only acceptance. A separate dedicated real local Claude fixture now verifies model replies and context recall; it never targets an existing user task. See [local acceptance](local-acceptance.md).

## Submission status and boundaries

- The public `fernando_jacob` Raycast profile was verified. No account was created or changed.
- The upstream directory and open PR titles had no Argo submission at review time. Store reviewers still decide name and branding acceptance.
- Dedicated real local Claude sending, replies and context recall passed. Cooperative pull keeps tool approvals in the terminal, not Raycast. Codex populated-thread rejoin and native multi-client approval routing remain unverified and are described as experimental.
- Published v0.1.4 assets were anonymously downloaded and installed in a clean temporary home after publication. Discovery, pairing, synthetic messaging and revocation passed. Existing release assets and immutable tags were not overwritten.
- The distribution build was reviewed in the actual Raycast app. The listing prominently requires self-configuration.
- Final source, screenshots and public runtime payload were reviewed and scanned before submission. Scans are not a guarantee of safety.
- Runtime v0.1.4 contains the upload/revocation fix. All active installation prompts pin the new immutable release. Previously running bridges require explicit stop/restart using the new launcher. See [security assessment](security-review.md).

The existing PR was updated under the user's explicit publication authorization. For a future first submission, follow the official `ray publish` flow from a standalone Git checkout or prepare the extension directory in a fork of `raycast/extensions`. It authenticates and opens a public pull request for review; it does not guarantee Store acceptance. Do not run `publish` as part of these checks. Use the attribution required by the working session on commits and the pull-request description.

Official references:

- https://developers.raycast.com/basics/prepare-an-extension-for-store
- https://developers.raycast.com/basics/publish-an-extension
- https://manual.raycast.com/extensions-guidelines
