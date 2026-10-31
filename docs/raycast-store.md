# Raycast Store submission preparation

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
- `extensions/raycast/metadata/`: PNG screenshots at 2000 × 1250, showing a disposable bridge and synthetic approval. No real conversation, pairing secret or user credential is included.
- Public macOS manifest, explicit dependencies, standalone npm lockfile, ESLint/Prettier configuration, distribution build and publication scripts.

## Preparation verification

Verified on 2026-10-31:

- A fresh standalone export installed with `npm ci --ignore-scripts`, passed `ray lint`, passed all 33 extension tests and completed the official distribution build with TypeScript checking.
- Repository backend regression: 54 passed and one optional native Codex test skipped, including protocol snapshot and safe-export regressions. The bridge CLI smoke test passed. No paid model request was made.
- Both the repository and standalone dependency audits reported zero vulnerabilities after applying the minimatch override.
- The screenshot metadata passed Raycast's dimensions/format validation and was visually inspected. Screenshots come from earlier real Raycast runs with disposable data, not user sessions.
- The standalone distribution build loaded in the actual Raycast app. Its discovery screen, rescan action and action menu were exercised. This is UI-only acceptance, not an Agent model or approval round-trip. No real Agent was used as an interactive test fixture.

## Remaining publication gates

- The public `fernando_jacob` Raycast profile was verified. No account was created or changed.
- The upstream directory and open PR titles had no Argo submission at review time. Store reviewers still decide name and branding acceptance.
- Exercise a dedicated real supported Agent session through sending, reply and native approval completion. Synthetic UI tests, bridge discovery, authenticated registration and installation tests are not model round-trips. Codex populated-thread rejoin and multi-client approval routing remain unverified and are described as experimental.
- Confirm the separately pinned runtime and instructions remain publicly reachable and usable. Do not overwrite existing release artifacts or move immutable tags.
- Review the actual distribution build in Raycast. Keep the self-configuration requirement prominent in the listing.
- Final source, screenshots and public runtime payload were reviewed and scanned before submission. Scans are not a guarantee of safety.
- **Blocking security gate:** the source revocation fix is not in immutable v0.1.3. Publish a separately authorized patched runtime and update the pinned setup before requesting Store merge. See [security assessment](security-review.md). This submission is a draft, not a release-ready listing.

Publishing is a separate, outward-facing action. After explicit approval, follow the official `ray publish` flow from a standalone Git checkout or prepare the extension directory in a fork of `raycast/extensions`. It authenticates and opens a public pull request for review; it does not guarantee Store acceptance. Do not run `publish` as part of these checks. Use the attribution required by the working session on commits and the pull-request description.

Official references:

- https://developers.raycast.com/basics/prepare-an-extension-for-store
- https://developers.raycast.com/basics/publish-an-extension
- https://manual.raycast.com/extensions-guidelines
