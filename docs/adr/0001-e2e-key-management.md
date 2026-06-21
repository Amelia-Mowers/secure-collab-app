# ADR 0001 — End-to-end key management (verification, cross-signing, key backup)

- **Status:** Accepted — Phases A, B, D-2/3, E implemented (verification +
  recovery are covered by a two-browser E2E harness). Phase C (UIA) is deferred
  (not needed on Conduit); the **warn-on-unverified banner (D-1) and the
  require-verified send mode (D-4) were dropped** — verification's role here is
  *own-device* history access (the verify gate), not policing other users'
  devices (see Phase D).
- **Date:** 2026-06-07 (status updated 2026-06-09)
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

*(Refined during implementation — see the Decision and Phase D below: in this
app verification is applied to **your own** devices, as a gate to history so a
new device renders a coherent workspace. We do **not** surface or block other
users' unverified devices: login is the data-access gate, so an already-invited
member's device is legitimate, and the non-interrupting "withhold keys from
unverified devices" mode isn't exposed by matrix-sdk 0.14 anyway.)*

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
- **Build device-verification UX** (SAS emoji to start; QR later). Its role here
  is **own-device history access**: a new device of yours must verify (or use its
  master key) before it can read history and render a coherent workspace — the
  *verify gate*. (We initially planned a *warn-on-unverified* banner for other
  users' devices and an opt-in *require-verified* send mode, but **dropped both**
  — see Phase D: login is the data-access gate, so an already-invited member's
  unverified device is neither a threat to surface nor one to block; the genuine
  concern is *coherence*, handled by the gate.)
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
- **Backup exists after setup** (Phase A): **green.** A key backup is enabled
  after `enable_recovery()`, asserted directly via `MatrixClient::backup_exists()`
  (`test_backup_exists_after_enabling_recovery`).
- **Verification** (Phase D): two devices complete SAS and become mutually
  trusted (`test_two_devices_self_verify_via_sas` — **green**), and the full
  two-device SAS UI is exercised end-to-end by the Playwright harness
  (`ui/e2e/verification.spec.ts`). *(The warn-on-unverified banner and the
  require-verified send mode — and their tests — were dropped; see Phase D.)*

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
  restore). The backup-state accessor `MatrixClient::backup_exists()` now lets
  the "backup exists after setup" assertion be made directly
  (`test_backup_exists_after_enabling_recovery`). **A is complete.**
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
  bootstrap. **Deferred (not needed on Conduit):** `auto_enable_cross_signing`
  bootstraps at login without a UIA challenge on Conduit, so this is untestable
  on our harness and is only required before targeting a server that enforces
  UIA (e.g. Synapse). Left as documented future work rather than shipping
  untested re-auth code.
- **D. Verification UX + trust policy** — SAS device verification, framed as
  **own-device history access** (the verify gate), not device-policing.
  **D-1 (warn-on-unverified banner) — built, then removed.** It surfaced another
  user's unverified devices, but that isn't a threat the app should flag: login
  is the data-access gate (a device exists only because someone authenticated),
  and verification here is about *your own* devices reaching history. The banner
  was unactionable (we can't withhold keys from a device — see D-4) and
  confusing, so it and its backing (`count_unverified_devices`,
  `ConnectedWorkspace::unverifiedDeviceCount`, `UnverifiedDevicesBanner`) were
  removed. **D-2 landed (SAS mechanism):**
  the full interactive SAS handshake (request → accept → start_sas → emoji →
  confirm → done) is proven to converge headless on Conduit with our
  `EncryptionSettings` — two devices end mutually verified
  (`test_two_devices_self_verify_via_sas`, green and fast after bounding the
  sync long-poll) — plus `MatrixClient::is_device_verified()`. **D-3 landed
  (verify screen + warning re-gating):** a new device now hits a standard
  `VerifyDeviceScreen` (not a warning) offering SAS verify-with-another-device
  **or** the master key, with **no bypass**; the bridge exposes
  `DeviceVerification` (`advance`/`emoji`/`confirm`/`cancel`) driven sync-free by
  the UI, plus `requestSelfVerification` (new device), `startVerificationListener`
  / `pendingVerificationFlow` / `verificationForFlow` (existing device's incoming
  prompt), and `pumpSync`. Per "warnings only for catastrophe,"
  `count_unverified_devices` now counts only a **verified** identity's unverified
  device (a possible injection); routine unverified peers and our own devices are
  not flagged (`test_routine_unverified_collaborator_is_not_surfaced`).
  **D-4 (require-verified send policy) — dropped, not built.** The concern a new
  device actually raises is *coherence*: its current-state view is replayed from
  history, so a device missing history would render a partial/incoherent
  workspace — which the verify gate already prevents by blocking the device's UI
  until it has history. An already-invited member's unverified device getting
  *future* updates is harmless; blocking sends would interrupt legitimate
  members, and the non-interrupting alternative (share room keys only with
  verified devices, withholding from the rest) is **not exposed by matrix-sdk
  0.14** — `Encryption` has no `set_room_key_recipient_strategy` (compile-checked).
  Injection is still *surfaced* by the warn banner. **The interactive two-device
  SAS UI is now validated end-to-end** by the Playwright harness
  (`ui/e2e/verification.spec.ts`), superseding the earlier "no two-browser
  harness" caveat.
- **E. Cold-start decryption UX** — **landed.** Detection
  (`MatrixClient::is_undecryptable_event` + cold-start/sync counting exposed via
  `ConnectedWorkspace::undecryptableCount()`), the `EncryptionWarningBanner`, and
  the restore affordance (the master-key path in `VerifyDeviceScreen`, plus
  verifying a device, both unlock history). With the up-front verify gate, the
  undecryptable banner only appears post-setup — i.e. for genuinely stuck items —
  matching "warnings only for catastrophe."

Phase A is independently shippable and de-risks the rest; B is the one that
actually makes multi-device + history-recovery work and should be gated behind
a real harness test before the encryption badge claims full E2E.

---

## Addendum (2026-06-21) — sharper threat model: trusted-device-only key sharing + key-custody direction

A re-examination of the threat model in light of the **bump/compaction**
mechanism revises one decision above and adds two.

### The hole the original decision missed: bump amplifies future-read into full-DB-read

E2EE protects data *at rest on the server* (it only ever holds ciphertext + an
**encrypted** SSSS blob + the encrypted key backup), and the recovery/master key
only decrypts that blob **client-side**. So a server breach yields garbage — that
property is real and unchanged.

But the original decision left **key sharing permissive**: `EncryptionSettings`
enables cross-signing + backup yet sets **no sharing restriction**, so the SDK
default applies and every new Megolm session is shared with **every** device in
the room, verified or not. Combined with the bump mechanism — which re-emits each
cell's *current* value as fresh events over time — this means:

> A device that can read only **future** traffic eventually reconstructs the
> **entire live database**, without ever needing historical keys or the master
> key. Bump turns "future-read" into "full-current-state read."

That makes a rogue device a complete compromise. A device can become rogue via:
- an **already-trusted endpoint** being compromised (an E2EE axiom — unfixable by
  any key scheme; bump just makes the loss total), **or**
- **device injection by a malicious/compromised homeserver or token-minter
  (MAS)** — Matrix's homeserver is irreducibly inside the trust boundary for
  *device-list integrity*; it can add a device to a member's device list (or lie
  about a collaborator's devices) **regardless of how the user authenticated**.

The first is out of scope for any crypto design. The **second is in scope and is
exactly what cross-signing exists to stop** — but only if clients refuse to share
room keys with devices not cross-signed by a trusted identity. We don't currently
do that.

### Decision 1 (revises the "dropped require-verified send mode" above): enforce trusted-device-only key sharing

Re-open what Phase D dropped, but reframed. Set the SDK's collect/sharing
strategy to **share room keys only with devices cross-signed by a trusted
identity** (matrix-sdk `only_allow_trusted_devices` / identity-based strategy).
An injected device that isn't cross-signed by the user's master key — which lives
client-side — then receives **no** future keys, so the bump path leaks nothing.
*This is where the master key earns genuine compromise protection*, not just
history access.

- Cost (the reason it was dropped): users must verify/cross-sign their own
  devices or they lock themselves out of their *own* new devices. This is why it
  pairs with Decision 2 — passkey/PRF custody makes verification low-friction.
- Note: the earlier "verification is only for own-device coherence, not policing
  others' devices" framing was correct for *that* threat (an honest member's
  unverified device) but missed the *injection* threat. Trusted-only sharing
  addresses injection without policing legitimate collaborators (their devices
  cross-sign normally).

### Decision 2: key custody → passkey / WebAuthn-PRF; deprecate user-handled master key by default (hosted prod)

Authentication and key custody are **separate layers** (cf. ADR 0002): the IdP
authenticates and must **never** be able to decrypt — letting it hold the
unlocking key hands plaintext to the exact adversary E2EE defends against. So we
don't escrow the key in MAS or an OIDC provider. Instead:

- **Default:** a **passkey / WebAuthn-PRF** wraps the SSSS key. The platform
  keychain (Apple/Google) holds only an *opaque* wrapping secret it can't decrypt
  with; it rides the user's existing ecosystem (composes with social login),
  unlock is a biometric gesture, and no server gains read capability.
- **Fallback:** an SSSS **security phrase** (PBKDF2) — must **not** be the login
  password (a server that sees the password could brute the blob; under OAuth
  there is no client-side password, which keeps this clean).
- **Break-glass:** the raw **recovery key**, demoted to opt-in last resort (not
  removed — it's the only recovery if the passkey ecosystem is lost).
- **Enterprise** may opt into admin **key escrow** (non-zero-knowledge by design,
  for ex-employee recovery) — a deliberate, opt-in exception, not the default.

**Hard invariant:** whatever the custodian, wrap/unwrap happens client-side with
a secret that **never transits our servers**, even briefly — an architectural
guarantee, not a policy. (Compliance corollary: a custodian that can *decrypt*
regulated data, e.g. PHI, becomes a business associate / BAA surface; the
opaque-secret passkey route keeps that surface small, escrow widens it.)

### Decision 3 (supporting): minimize the token-minter's blast radius

MAS-or-equivalent is structurally required to mint Matrix tokens (Google/Apple
don't speak Matrix's device scopes), so it can't be removed — but run it
**federate-only (no local passwords)** so a compromise of our MAS can't harvest
credentials, only mint tokens (which Decision 1 already neutralises for key
access). This is an auth-side item; see ADR 0002.

### Revised threat model (what this buys)

| Adversary | Protected? |
| --- | --- |
| Server breach / data at rest | ✅ (ciphertext + encrypted SSSS only) |
| Network eavesdropper | ✅ |
| Malicious homeserver / MAS **injecting a device** | ✅ **after Decision 1** (was ❌) |
| Credential capture by the homeserver | ✅ via OAuth (ADR 0002) + Decision 3 |
| An **already-trusted compromised endpoint** | ❌ — unfixable by crypto; bump makes it total |

### Implementation order

1. **Decision 1** — trusted-device-only sharing (highest leverage; the security
   fix). Tracked: "Enforce trusted-device-only key sharing" in the TideWork PM
   backlog.
2. **Decision 2** — passkey/PRF custody (makes Decision 1's verification
   friction acceptable; deprecates default master-key handling). Tracked:
   "Memorable new-device verification (SSSS phrase + passkey)" and
   "Reduce/remove the master-key requirement."
3. **Decision 3** — MAS federate-only (auth-side; ADR 0002).

Caveats to verify before building: whether matrix-rust-sdk's recovery API ingests
an SSSS *passphrase* directly (vs only the recovery key), and that
`only_allow_trusted_devices` behaves as expected for own-account device injection
(it should: an injected device isn't cross-signed by the client-held master key).
WebAuthn-PRF wrapping is app-layer work the SDK won't do for you.
