# Security assessment for the Raycast Store submission

Reviewed on 2026-10-31. This is a scoped defensive review, not an independent audit or a guarantee that Argo has no vulnerabilities.

## Results and remediation

- **Credential revocation race fixed in repository source:** an authenticated client could begin a JSON upload, have its credential revoked, then finish the upload and still create a grant or submit another mutation. All authenticated body-consuming routes now recheck client authorization after the asynchronous upload and before the synchronous mutation. A disposable HTTP regression failed with status 201 before the fix and passes with status 401 afterward. No user bridge, credential, or Agent was used.
- **Runtime update:** v0.1.4 includes the revocation fix, and current installation prompts pin that version. Immutable v0.1.3 remains unpatched. Installing new code does not replace an already-running bridge: explicitly stop the old Argo bridge and restart with the new launcher while preserving its private home. In an emergency, stop the bridge first to terminate incomplete uploads, verify the transport, then revoke clients through the local administrator before restoring access. Already accepted work is not recalled by revocation.
- **Transport trust clarified in the UI and documentation:** discovery validates a fresh Ed25519 signature and a code-pinned identity, not ownership or confidentiality of the local listener. A disposable public-discovery-only forward confirmed that genuine signatures pass through a proxy. That behavior is necessary for ordinary forwarding, but it also means a malicious proxy can observe HTTP pairing codes and bearer tokens. Use only trusted local processes, hosts and authenticated SSH/VS Code forwarding. Argo does not claim resistance to a hostile local user, compromised tunnel endpoint or malicious forwarding service. Supporting those threats needs authenticated encrypted application transport, not another discovery check.
- **Dependency advisory remediation:** the standalone extension and repository use a minimatch override. Both npm audit reports contained no known vulnerabilities at review time. Dependency advisories can change after this review.

## Scope and evidence

- Reviewed bridge HTTP/connector authorization, client invitations, revocation, private credential storage, installer download/archive restrictions, extension discovery/pairing, approval submission and the Store export boundary.
- Gitleaks 8.30.1 scanned public Git history, the pending standalone source and the anonymously downloaded v0.1.3 runtime payload. No secrets were reported. Reports were fully redacted. User homes, private credential files and conversation logs were not scanned or uploaded.
- The exporter uses an explicit public-file allowlist and refuses an existing destination. Store source has no imports outside its own extension directory. Screenshot metadata uses disposable bridge data and synthetic approval text, not user conversations or credentials.
- Backend tests cover Host/Origin rejection, credential separation, atomic single-use expiring pairing, client subscription closure, scoped connectors, stale session generations and explicit expiring approvals. The new upload/revocation test uses a deterministic server-authentication barrier.
- Extension tests cover inert remote Markdown, credential-free bounded discovery, bad signatures, private configuration, exact routing and duplicate approval submission. The real app's discovery screen and actions were exercised without sending messages or decisions to a user Agent.

The automated review agents terminated before completing their reviews. Their partial hypotheses were not counted as completed audits. Findings above were checked directly against repository code and isolated fixtures.

## Deployment boundaries and remaining limitations

- A Mac client credential authorizes all bridge sessions and session administration. It is not read-only. Agent connector credentials authorize one binding. Pairing is an authority grant, not mere discovery.
- Keep loopback endpoints private. Browser Origin/Host checks and bearer authentication do not isolate one local OS user from another or make a hostile host safe.
- Private files use filesystem permissions, not application-level encryption. Conversation history and drafts persist without automatic retention. Revocation does not erase history, previously delivered data or already accepted Agent work.
- Original Agent permissions remain authoritative. No automatic approval, sandbox weakening or model replacement is introduced by the Store extension.
- A dedicated real local Claude session passed direct-loopback messages and pre-attachment context recall with unchanged native identity. Real populated Codex rejoin and native multi-client approval completion remain unverified. Synthetic fixtures, installation, discovery and build success do not establish those capabilities.
- Runtime release publication is separate from Store source review. The Store PR now pins v0.1.4 and documents explicit old-server restart; the v0.1.3 tag remains unchanged. No immutable tag or release asset was replaced by this work.

For a suspected credential compromise, stop the bridge first, remove the untrusted forwarding endpoint, revoke access through the local administrator and issue fresh credentials only over a verified transport. Do not put secrets or private transcripts in public issues. Use GitHub's private vulnerability reporting if enabled; otherwise arrange a private contact before sharing sensitive details.
