# ADR 0001 — End-to-end key management (verification, cross-signing, key backup)

- **Status:** Proposed
- **Date:** 2026-06-07
- **Context refs:** `ARCHITECTURE_REVIEW.md` §4.2, `TODO.md` P0 §4.2

## Context

PR #1 turned on Matrix room encryption (`room.enable_encryption()`) and added a
fail-closed send guard, and the integration harness proved an encrypted
two-client round-trip works (`test_two_client_encrypted_round_trip`). That
covers the *happy path*: two live devices exchanging Megolm-encrypted cell
updates.

It does **not** cover the parts of E2E that are policy/UX rather than crypto:
**device verification + cross-signing** (who do you trust?) and **key backup +
recovery** (don't lose your data). The matrix-rust-sdk performs all the crypto
(Olm/Megolm via vodozemac, device-key upload, per-room key sharing, the crypto
store) and even exposes automation hooks, but it cannot decide trust policy,
invent or store a user's recovery key, or run the interactive verification
flow. Those are the application's job.

### Why this matters more here than for a chat client

Our workspace state is **materialized by replaying the encrypted room
timeline** (cold start replays `cell.update` events). Two consequences follow
that make key availability a correctness property, not a cosmetic one:

1. **Undecryptable history = wrong data, silently.** If a device lacks the
   Megolm keys for historical events, `extract_cell_update` skips them and the
   workspace materializes **incomplete/incorrect** state (missing rows/tables).
   The user sees wrong data, not a "🔒 can't decrypt" placeholder.
2. **Multi-device sync depends on it.** The product promises "syncs seamlessly
   across your devices." A fresh login on a second device only receives keys
   for events sent *after* it is known to senders, so without key backup it
   **cannot reconstruct the existing workspace**. Key backup is therefore
   effectively mandatory, not optional.

And the open-source, "auditable, real E2E" value proposition is undercut if
encryption ships **without verification**: the SDK shares room keys with *all*
devices in a room, including unverified ones, so a malicious/compromised
homeserver could inject a device and receive the keys. Verification is what
lets users attest that the devices receiving keys are genuinely theirs / their
collaborators'.

## Decision drivers

- Workspace **data integrity** under cold start (missing keys must not yield
  silently-wrong state).
- The **multi-device** use case must actually work.
- The **"real E2E"** trust claim requires verification, not just encryption.
- **Solo-developer constraints:** lean on the SDK; write as little bespoke
  crypto as possible.

## Considered options

1. **Ship encryption-only (today's state).** Rejected: broken multi-device,
   no protection against device injection, and silent data loss / wrong
   materialized state on any new or re-logged-in device.
2. **Lean on the SDK's built-in key management + app-built recovery/verification
   UX.** ← chosen.
3. **Build custom key management** (our own backup/escrow). Rejected: large,
   security-critical, error-prone, and defeats the "use Matrix for crypto so
   it's auditable" premise.
4. **Weaken the model** (server-trust / disable encryption). Rejected: defeats
   the product's reason to exist.

## Decision

Adopt **option 2**: treat E2E key management as a launch blocker and implement
it on top of matrix-rust-sdk's mechanisms.

Concretely:

- **Enable cross-signing and key backup automatically** via the client
  builder's `EncryptionSettings` (`auto_enable_cross_signing`,
  `auto_enable_backups`, plus a `backup_download_strategy`). We currently pass
  no `EncryptionSettings`, so all of this is **off**.
- **Use Secure Backup / Recovery** (`Encryption::recovery()`): generate a
  **recovery key** at first setup, surface it to the user to save, and prompt
  for it on a fresh login to restore keys (and thus workspace history).
- **Handle UIA** (user-interactive auth) for cross-signing bootstrap, which
  typically needs the account password.
- **Build device-verification UX** (SAS emoji to start; QR later) and a
  **trust policy**: begin with *warn-on-unverified*, with a path to a
  *require-verified-devices* mode (the SDK can refuse to send to unverified
  devices; the app must opt in and surface the resulting errors).
- **Make undecryptable cold-start events visible** rather than silent: if
  replay encounters events it cannot decrypt, surface "N events could not be
  decrypted — restore from backup / verify this device," instead of quietly
  materializing partial state.

## Consequences

**Positive**

- Real E2E trust (verification), working multi-device, recoverable history.
- Minimal bespoke crypto — the SDK remains the engine, preserving auditability.

**Negative / costs**

- **Recovery-key UX burden:** users must save a recovery key; losing it means
  permanent loss of un-synced history (inherent to E2E). Needs clear warnings
  and an optional passphrase.
- **Verification friction** and UIA prompts add steps to onboarding / new
  devices.
- The cold-start path needs a real "couldn't decrypt N events" UX and a
  recovery affordance.

**Risks / open questions**

- Exact **matrix-sdk 0.14 API surface** for `EncryptionSettings`,
  `Encryption::recovery()`, `Encryption::backups()`, and verification must be
  confirmed against the pinned version (the encryption API has moved between
  releases).
- **Crypto-store persistence in WASM:** keys must survive reload. The browser
  build uses the SDK's IndexedDB store; we should confirm it persists the
  crypto store (Olm/Megolm keys), since cold start otherwise re-fetches and
  re-decrypts history each load. (Related to the broader "persist the
  materialized model" question.)
- Interaction with **review §4.3 bumping / §4.4 cold start**: bumped events are
  re-encrypted normal events, so they need keys too — backup/restore covers
  this, but worth testing the bumped-history-on-new-device case explicitly.

## Test-first

Each surface gets a **red** `#[ignore]`d integration test (Conduit harness)
that encodes the desired behaviour and fails today for the documented reason,
before any implementation:

- **Multi-device / key backup (the headline gap):**
  `test_second_device_reconstructs_encrypted_workspace_from_history` — a second
  login of the same user (fresh device + crypto store) must decrypt the
  encrypted room history and materialize the same workspace. Fails today: with
  no cross-signing/backup, the new device has no keys for events sent before it
  existed, so `extract_cell_update` skips them and the table comes up empty.
  Was red through Phase A; **now green** after Phase B — device 1 enables
  backup + recovery, device 2 restores with the recovery key and decrypts the
  history. Promoted out of the `red-tests` gate into the normal `--ignored`
  integration suite.
- **Backup exists after setup** (Phase A): once `MatrixClient` exposes backup
  state, assert a backup is created/enabled after login with the new
  `EncryptionSettings`. *(Pending the backup-state accessor.)*
- **Verification** (Phase D): two devices complete SAS and become mutually
  trusted (`test_two_devices_self_verify_via_sas` — **green**); a require-verified
  policy refuses to send to an unverified device *(still pending — D-3)*.

The red tests are the spec: implement each phase until its test is green,
rather than wiring `EncryptionSettings` blind. They live behind a `red-tests`
cargo feature so they don't break CI's `--ignored` integration run; run them
with `--features matrix-native,red-tests`, and promote each into the normal
suite once it passes.

## Implementation plan (phased)

- **A. `EncryptionSettings`** — set `auto_enable_backups` +
  `auto_enable_cross_signing` + `backup_download_strategy` on the client
  builder; verify an encrypted round-trip + that a backup is created, in the
  Conduit harness. *(Low risk; the verifiable first step.)* **Wiring landed:**
  `default_encryption_settings()` (`auto_enable_cross_signing` +
  `auto_enable_backups` + `BackupDownloadStrategy::OneShot`) is now applied at
  every `Client::builder()` site (the `MatrixClient` ctor and all three
  `bridge_matrix` builders); the encrypted round-trip still passes and the
  multi-device red test stays red (it needs the Phase B recovery key to
  restore). *Remaining for A:* a backup-state accessor on `MatrixClient` so the
  "backup exists after setup" assertion can be made directly.
- **B. Recovery-key flow** — enable Recovery, surface/store the recovery key,
  restore on a new login; add a harness test: client A writes, client B logs in
  fresh on a new device and reconstructs the workspace from backup. **Landed:**
  `MatrixClient::enable_recovery()` / `recover_with_key()` (+ the now-green
  multi-device harness test), the `MatrixSession` bridge surface
  (`recoveryStatus()` / `enableRecovery()` / `recoverWithKey()`), and a
  **sign-in recovery gate** so a device is never left signed-in-but-no-history:
  the sign-in flow bootstraps recovery on a first device (and shows the key to
  save) or prompts a returning device to restore. On Conduit no UIA prompt was
  needed (auto cross-signing bootstrapped at login) — Phase C remains for
  servers that require it.
- **C. UIA callback** — handle the auth interactive flow for cross-signing
  bootstrap.
- **D. Verification UX + trust policy** — SAS verification UI; warn-on-unverified
  first, then an opt-in require-verified mode. **D-1 landed (warn-on-unverified):**
  `count_unverified_devices()` / `MatrixClient::unverified_device_count()` walk
  the room's member devices and count those this device hasn't verified
  (excluding our own); the bridge exposes
  `ConnectedWorkspace::unverifiedDeviceCount()` and the UI shows an
  `UnverifiedDevicesBanner`, with a green harness test
  (`test_unverified_member_device_is_surfaced`). **D-2 landed (SAS mechanism):**
  the full interactive SAS handshake (request → accept → start_sas → emoji →
  confirm → done) is proven to converge headless on Conduit with our
  `EncryptionSettings` — two devices end mutually verified
  (`test_two_devices_self_verify_via_sas`, green and fast after bounding the
  sync long-poll) — plus `MatrixClient::is_device_verified()`. **D-3 remaining:**
  the interactive SAS *UI* (a stateful bridge surface to show/confirm emoji)
  that *clears* the warning, and the opt-in require-verified send policy (the
  SDK can refuse to share keys with unverified devices; surface the error;
  `Room::contains_only_verified_devices()` complements the existing count).
- **E. Cold-start decryption UX** — *(detection landed in this change:
  `MatrixClient::is_undecryptable_event` + the cold-start/sync loops now count
  `m.room.encrypted` events and expose `ConnectedWorkspace::undecryptableCount()`,
  so the gap is no longer silent at the data layer.)* Remaining: the UI warning
  banner ("N items couldn't be decrypted — restore from backup / verify this
  device") and the restore affordance.

Phase A is independently shippable and de-risks the rest; B is the one that
actually makes multi-device + history-recovery work and should be gated behind
a real harness test before the encryption badge claims full E2E.
