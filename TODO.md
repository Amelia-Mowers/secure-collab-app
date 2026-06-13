# Project TODO / Backlog

Single source of truth for outstanding work. Supersedes the (stale) roadmap in `README.md`.
Most items trace to **[ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md)** — section refs in brackets.

Priority bands:
- **P0 — Must-fix before real data** (correctness & trust)
- **P1 — Should-fix** (make the architecture deliver its promises)
- **P2 — Housekeeping** (cheap, high signal-to-noise)
- **FE — Frontend / Table UX**

---

## P0 — Must-fix before any real data

- [x] **Fix the LWW clock** — `[§4.1]` — _implemented & verified locally 2026-06-07 (stable 1.96 + nightly 1.98): pure-logic tests green (21 + 57), stable `clippy -D warnings` clean, `wasm32 + matrix-wasm` build compiles, `fmt` clean._
  The timestamp was a local counter starting at 0, never advanced on receive, never persisted. Caused cross-client divergence and **silent data loss after reload**.
  - [x] Hybrid logical clock: write ts = `max(last_seen + 1, wall_clock_ms)` (`workspace.rs` `next_timestamp` + `now_millis`).
  - [x] Advance the clock on **every** applied update — `observe_timestamp` in `Workspace::apply_update`, which both sync loops call (`bridge_matrix.rs`).
  - [x] Seed the counter from cold-start history (falls out of `observe_timestamp`; cold-start replays through `apply_update`).
  - [x] Plumb Matrix `origin_server_ts` into `Cell::server_timestamp` (wire-skipped `CellUpdate::server_timestamp` + `with_server_timestamp` + `ReceivedCellUpdate::into_update`; both bridge receive paths now call `into_update()`).
  - [x] Unit tests: post-replay write wins (`test_write_after_replay_wins_over_loaded_history`), monotonic-within-ms, order-independent tie-break by server ts (`test_lww_tiebreak_by_server_timestamp_is_order_independent`), wire omits server ts.
  - [x] **Follow-up:** two-client convergence via the real sync loop — done in `[§4.5]` (`test_two_client_sync_via_real_timeline`): Bob materializes from his own synced Conduit timeline and `origin_server_ts` is confirmed attached as the tiebreaker against real server-stamped events.

- [x] **Make E2E encryption real — or stop claiming it** — `[§4.2]` — _enablement + guard + honest badge + encrypted round-trip (`test_two_client_encrypted_round_trip`), **plus the full key-management programme** (ADR 0001): auto cross-signing + key backup, recovery-key flow, device (SAS) verification, and the new-device verify gate — all verified against Conduit and (verification + recovery) end-to-end in two browsers (`ui/e2e/`). Phase C (UIA) deferred (Conduit doesn't need it); the warn-on-unverified banner + require-verified send mode were dropped — verification is for **own-device** history access, not policing other users' devices (login is the access gate; see ADR)._
  - [x] Enable encryption at room creation — `room.enable_encryption()` in `ConnectedWorkspace`'s `createRoom`; creation fails loudly if it can't be turned on.
  - [x] **Fail-closed send guard** — `send_updates` refuses to emit cell updates unless `room.encryption_state().is_encrypted()` (don't trust the server default). Placed at the bridge boundary only, so the native integration harness (unencrypted test rooms) is unaffected.
  - [x] **Honest badge** — new `ConnectedWorkspace::isEncrypted()` bridge method; `Sidebar` now shows "E2E Encrypted" only when the room really is, and a red "Not encrypted" warning otherwise (instead of a hard-coded claim).
  - [x] **Verify an encrypted round-trip** against Conduit — `test_two_client_encrypted_round_trip`: Alice sends into an `m.room.encryption` room, the SDK Megolm-encrypts + shares the key, and Bob decrypts on sync and materializes the value. Confirms the SDK auto-decrypt of `raw().json()` works for our custom events (the read path survives encryption).
  - [x] **Device verification + cross-signing + key backup** — implemented per **`docs/adr/0001-e2e-key-management.md`** (test-first): `EncryptionSettings` auto cross-signing + backup, the recovery-key flow + sign-in verify gate, SAS device verification (mechanism + interactive UI, e2e-validated), `backup_exists()`, and undecryptable-history detection + banner. Phase C (UIA) deferred; warn-on-unverified + require-verified dropped (see ADR). _Remaining (carried to the **E2E** section): broader two-browser coverage of collaboration / multi-tab._
  - [ ] Decide policy for **legacy unencrypted rooms** (created before this change): the guard makes them read-only. Offer a migrate/recreate path or a clear UI state.

- [x] **OAuth token refresh** — _fixed 2026-06-12._ MAS access tokens are
  short-lived (~5 min) but no `Client::builder()` path enabled
  `.handle_refresh_tokens()`, and nothing re-persisted refreshed tokens. So any
  return to the app after the token expired 401'd (`M_UNKNOWN_TOKEN`) on the
  first request: booted to sign-in, and — because `initialSync()` failed — the
  recovery probe reported `needs_recovery` and the **verify gate re-appeared
  every time** (the "asks for the master key again" symptom). Fix: enable
  `.handle_refresh_tokens()` on all builders + a new `startTokenPersistence`
  bridge method that subscribes to `SessionChange::TokensRefreshed` and re-saves
  the session blob (`useAuth` wires it on restore/sign-in). **Coverage gap that
  hid it:** `oauth.spec.ts` reloaded within the token lifetime, so refresh never
  ran — the e2e MAS now issues 8s tokens (`--e2e`) and the spec waits past expiry
  before asserting an uneventful restore.

- [ ] **Persist row deletion** — `deleteRow` only mutates local state; the bridge
  never emits anything to Matrix (`bridge_matrix.rs` `delete_row`), so a deleted
  row resurrects from the timeline on the next cold start and other devices
  never learn of the deletion. The architecture's deletion-as-decay story covers
  cells of schema-deleted rows/columns, but nothing records a *user row*
  deletion — it needs a design decision (row tombstone cell? membership in a
  system table?). Red test ready: un-`fixme` `'a deleted row stays deleted after
  reload'` in `ui/e2e/core.spec.ts`.

---

## P1 — Should-fix (deliver the architecture's promises)

- [x] **Wire order-based bumping into the write path** — `[§4.3]` — _done 2026-06-07; unit + rotation tests, stable clippy, wasm build verified._
  - [x] Emit a bump alongside each user write — `Workspace::update_cell_with_bump` (used by `ConnectedWorkspace::update_cell`) sends the user write **plus** a bump of the stalest cell; the local-only path stays no-bump.
  - [x] System-table decision: `_schema`/`_views` are intentionally **not** bumped (low churn; lookback bounded by their small cell count) — documented on `update_cell_with_bump`.
  - [x] Removed dead `last_bump`; `CompactionManager` is now stateless (`&self` methods).

- [x] **Unify cold-start to one implementation** — `[§4.4]` — _done 2026-06-07; tables-over-matrix tests + clippy + fmt verified._
  - [x] One engine: `TimelinePaginator` (LWW apply → order-independent values); `materialize_from_timeline` now delegates to it, so they can't drift.
  - [x] Newest-first assumption made explicit (documented on `process_batch`: it governs only the dedup counters + early-stop); old order-dependent accounting removed; added an order-independence test.
  - [x] Bridge cold-start documented as the deliberately-separate **workspace** layer (routes schema/views via `apply_update`) — not a duplicate of the raw-table engine.

- [x] **Recovery bootstrap must not fail open on first sign-up** — _fixed
  2026-06-11._ `ensureHistoryAccess` used to swallow `enableRecovery()`
  failures with a `console.warn` and let sign-in proceed — observed three
  times in practice (the auto-backup race, the OAuth duplicate-bridge miss,
  the "unknown"-state skip): a first device landed on /workspaces having
  **never been shown its recovery key**. `bootstrapRecovery` (`useAuth.ts`)
  now retries with backoff (3 attempts) and, if every attempt fails, raises a
  **blocking** `kind: 'error'` recovery prompt ("Couldn't set up recovery" in
  `VerifyDeviceScreen` — retry or sign out, no dismiss). Only the status
  *probe* still fails open (a returning device is covered by the verify gate
  + undecryptable banner; documented inline). Unit-tested: retry-then-succeed,
  all-fail → blocking prompt, `retryRecoverySetup` from the error state.

- [ ] **Encrypt the persisted session + stores at rest** — today the session
  blob in `localStorage` (containing the **access token**) and the per-device
  IndexedDB state/crypto stores (`indexeddb_store(name, None)` — the SDK
  supports a passphrase, we pass `None`) are plaintext under same-origin
  protection only. architecture.md already promises "optional passphrase
  encryption" for the crypto store. Threat addressed: filesystem-level access
  (other OS users, backups, stolen machine without FDE) — *not* runtime XSS,
  which can read whatever the running app can.
  Design tension to resolve first: a key derived from the login password
  conflicts with silent `restore()` — the password isn't available on reload.
  Offer **password and WebAuthn as parallel unlock options** (not either/or):
  1. Password unlock: re-prompt once per browser session to derive the store
     key (defensible UX for a security product; sessions still outlive tabs).
     Local-only use of the password is fine here — unlike SSSS (below), the
     derived key never leaves the device, so a malicious server gains nothing.
  2. **WebAuthn PRF/`largeBlob`** — wrap a random store key with a passkey;
     unlock is a biometric/security-key gesture, key material never stored.
  3. Fallback (no credential configured): Element-style random "pickle key" in
     `localStorage` — mostly obfuscation (same-origin attacker reads both),
     but cheap, standard, and better than `None`.
  Whatever is chosen: also send `/logout` on sign-out so the access token is
  invalidated server-side, not just forgotten client-side.

- [ ] **Memorable new-device verification: SSSS security phrase (+ passkey
  PRF)** — the recovery flow already fetches the encrypted master/backup keys
  from **server-side secret storage** and decrypts them locally with the
  recovery key; SSSS also supports a **PBKDF2 passphrase** as the secret-storage
  key (Element's "Security Phrase"), so a new device could verify with a
  memorized phrase — no backend needed, it's standard account data.
  Constraints:
  - The phrase **must not be the login password**: with `m.login.password` the
    homeserver sees the password at login and could brute it against the SSSS
    blob, collapsing zero-knowledge against the exact adversary E2EE targets.
    Enforce/warn in UX; this also keeps the design OIDC-ready (no password
    exists client-side under SSO).
  - Stretch: wrap the SSSS key with a **synced passkey (WebAuthn PRF)** so a
    new device in the same passkey ecosystem verifies with a biometric gesture;
    keep phrase + recovery key as the portable fallbacks.

- [~] **Add a true end-to-end sync test** — `[§4.5]` — _harness runnable via Nix/WSL (`scripts/run-integration-tests.sh`) and green: tables-over-matrix integration tests + app-core `workspace_matrix` 17/17._
  - [x] Drive a real send → server → sync → fetch-timeline → extract → materialize round-trip (`test_two_client_sync_via_real_timeline`): Bob converges on Alice's value from his OWN synced timeline, not a re-applied in-memory update.
  - [x] **Encrypted** round-trip (overlaps `[§4.2]`): `test_two_client_encrypted_round_trip` — Megolm send/decrypt across two clients via the `create_encrypted_room` harness helper.
  - [x] Add at least one UI test against compiled WASM (not just `MockWorkspace`) — _done: the two-browser Playwright harness (`ui/e2e/`) drives the real compiled WASM against a live Conduit. See the **E2E** section below._

---

## E2E — End-to-end browser coverage

The **two-browser Playwright harness** (`ui/e2e/`) is in place: a throwaway
Conduit + two isolated browser contexts (two devices of one user) exercising the
**real compiled WASM**. Covered so far — `smoke` (register + recovery bootstrap),
`recovery` (a second device restores with the **master key**), and `verification`
(**SAS emoji** between two devices). Run with
`nix develop --command bash -c "cd ui && npm run e2e"`; also a CI `e2e` job.
Expand to the rest of core product behaviour:

- [x] **Core behaviour** (single device) — _done 2026-06-11 (`ui/e2e/core.spec.ts`):
  workspace → table → a column of each type → entries (all editors) → inline
  grid edit → header sort → global filter → kanban/card views → view switching
  → **persists across reload** (cold-start materialization, `[§4.4]`)._
  The spec immediately earned its keep — it caught three real defects the
  MockWorkspace-based unit tests could not:
  1. **Sessions had no persistent store at all** (fixed): `login`/`register`/
     `restore` built the SDK client with in-memory stores, so every page reload
     was an unverified "new device" that couldn't decrypt its own history.
     Now all three configure a per-device IndexedDB store (named in the
     session blob's `storeName`; Olm state is born in the persistent store
     since device keys are immutable after first upload).
  2. **`ViewType` had no `Card` variant** (fixed): the UI offered card views
     but the bridge rejected them ("Invalid view config") — and the New-view
     modal swallowed the string-JsValue error (also fixed). `MockWorkspace`
     now validates view types like the real bridge to prevent re-drift.
  3. **Row deletion is local-only** (open — see the new P0 item below).
- [ ] **Collaboration** (two *different* users) — A invites B, B accepts; both
  edit and assert real-time propagation **A→B and B→A**, the member list, and
  that **concurrent edits to the same cell converge** (LWW, `[§4.1]`) with no
  flash-then-revert.
- [ ] **Workflows** — common multi-step journeys end to end: onboarding (sign up
  → save master key → first workspace), invite/accept, kanban drag between
  columns persisting, view creation/switching, and a **sign-out → sign-in**
  round-trip that restores state from the session/account pool.
- [ ] **Multi-tab editing** (same account, two tabs — shared crypto store) —
  edits in tab 1 appear in tab 2 via sync; interleaved edits converge with no
  loss (exercises the HLC `[§4.1]` + the per-tab active-account / shared-
  workspace state in `useAuth`); one tab holding the sync stream must not stall
  the other (the `initialSync` timeout race).

---

## Hosted offering — ADR 0002 (proposed)

Hosted Synapse + **MAS** homeserver, OAuth-first client auth (password stays
as the permanent fallback for custom servers + the Conduit harness), and
subscription enforcement via lock/unlock — see
**[docs/adr/0002-hosted-homeserver-mas-auth-and-subscriptions.md](./docs/adr/0002-hosted-homeserver-mas-auth-and-subscriptions.md)**
for the full rationale (authentication ≠ entitlement; lock, never deactivate).
Ordered phases; **A gates everything**:

- [x] **A. Spike: OAuth login from the WASM client** — _done 2026-06-11,
  verdict **proceed** (see ADR 0002 phase A result)._ Full flow green from the
  real WASM against throwaway Synapse+MAS (`ui/e2e/oauth.spec.ts` via
  `scripts/spike-synapse-mas.sh --e2e`): dynamic registration → MAS hosted
  login → code exchange → `kind:"oauth"` session blob → restore. Bridge:
  `startOauthLogin`/`finishOauthLogin` (popup architecture is load-bearing —
  PKCE verifier is in-memory); `sessionData()`/`restore()` handle both
  session kinds. The C-phase remainder: wire this into `SignInPage`/`useAuth`
  with `.well-known` auth-metadata detection + the popup/callback page.
- [~] **B. Hosted stack** — _live 2026-06-12:_ Synapse 1.148 + MAS 1.12 in a
  small in-repo compose stack (`infra/` — conscious deviation from the ansible
  playbook, recorded in ADR 0002) on the DO droplet against managed Postgres;
  repo-owned nginx TLS (certbot certonly, renew hook); registration closed;
  two-tier secrets live (sops/age, droplet decrypts locally). Public smoke
  green: matrix.tidework.io + auth.tidework.io + MSC3861 delegation. MAS
  policy correctly rejects non-https client registration (verified).
  _2026-06-12 (later):_ apex `.well-known` live on tidework.io, app moved to
  Cloudflare Pages at **app.tidework.io** with real CSP headers, landing page
  on the apex (`site/`), domains/DNS wired idempotently by the
  `deploy-cloudflare` CI job. **Validated end to end twice**: the deployed
  app completed the full SSO journey (probe → MAS popup → recovery key →
  workspaces → reload-restore) against production
  (`ui/e2e/validate-production.mjs`) — which also flushed out and fixed the
  sub-path OAuth bugs (redirect URI BASE_URL + router basename + SPA 404).
  _Remaining:_ droplet backups/monitoring, Postgres `verify-full` TLS,
  retire the GitHub Pages deploy job after a soak period.
- [~] **C. Client: default homeserver + auth branching** — _auth branching
  done 2026-06-11:_ the sign-in page probes the selected homeserver
  (`checkOauthSupport` → bridge `homeserverSupportsOauth`) and swaps the
  password form for the secure-sign-in popup flow when it delegates auth
  (`signInWithOauth` → shared `completeSignIn`, so OAuth gets multi-account,
  the verify gate, and recovery bootstrap for free; `/oauth/callback` posts
  the redirect back to the opener). Validated end-to-end through the real UI
  (`ui/e2e/oauth.spec.ts`: detect → popup → MAS → recovery key → workspaces →
  reload-restore). _Branding landed 2026-06-11:_ the picker lists **TideWork**
  (`matrix.tidework.io`, "coming soon") first; the default flips to it via
  `VITE_DEFAULT_HOMESERVER` in the hosted build (`ui/src/branding.ts`).
  _Env flip landed 2026-06-12:_ the GitHub Pages deploy builds with
  `VITE_DEFAULT_HOMESERVER=https://matrix.tidework.io`. _Remaining:_ apex
  `.well-known` on tidework.io (with **B**'s Cloudflare work).
  _Fixed along the way:_ `ensureHistoryAccess` treated the SDK's "unknown"
  recovery state as "nothing to do" — a fresh device could silently skip the
  recovery prompt when the state settled slowly (observed on the OAuth path);
  it now polls until the state settles.
- [x] **D. Billing service + enforcement** — _done & fully validated
  2026-06-13 (test mode), in its amended trial-first shape:_ open
  registration → 14-day trial (`/status` feeds the app's TrialBadge +
  full-page TrialGate) → cron sweep locks unpaid accounts past the trial →
  Stripe checkout keyed programmatically to the username → `/success` +
  webhook unlock; cancel/lapse re-locks. **Complete state machine verified
  live**: register(no token)→trial/14 → sweep→locked → pay→active →
  cancel→locked; exempt operator accounts spared. _Refinements tracked
  below._ **Switched to live mode 2026-06-13:** `STRIPE_API_KEY` is the
  `sk_live_…` key and a live-mode webhook endpoint
  (`https://billing.tidework.io/webhook`; subscription created/updated/deleted)
  with its own live signing secret is wired; the old test-mode endpoint is
  disabled.

- [x] **Email provider** — _resolved 2026-06-12:_ Resend, SMTP transport in
  MAS (`smtp.resend.com:2465` TLS — port 2465 because DigitalOcean blocks
  standard SMTP ports 25/465/587 on droplets), sender `noreply@tidework.io`,
  domain verified (SPF/DKIM via Cloudflare DNS), API key as tier-2 sops
  secret (`infra/secrets/email.sops.env`). Verified end to end: live
  registration completed with a real emailed code (delivery confirmed in the
  Resend dashboard).
- [ ] **Billing refinements** — (a) Stripe *search* is eventually consistent
  (~1 min): a just-paid user can briefly read `trial`, and an unluckily-timed
  sweep could lock someone whose subscription isn't indexed yet (self-heals
  via webhook/success-unlock, but add a pre-lock re-check or store the
  customer id); (b) never-paid accounts locked >60 days → deletion sweep;
  (c) grace-period policy before the sweep locks (currently none).
- [~] **E. Auth-flow e2e** — _CI job landed 2026-06-11:_ `e2e-oauth` runs the
  throwaway Synapse+MAS stack (`nix shell .#oauth-stack-tools` →
  `scripts/spike-synapse-mas.sh --e2e`) and drives the SSO sign-in flow
  through the real UI on every PR. _Remaining (needs **D**):_ extend to the
  full lifecycle — subscribe → register → onboard → lapse → lock → renew →
  unlock.
- [ ] **F. By config later** — consumer social login (Google/Apple upstream of
  MAS); enterprise corporate IdPs (the SSO story from `architecture.md`).

Independent of A–F (client-only — can ship before any infra exists):

- [ ] **Demo mode** — a `/demo` route that instantiates the existing
  **local-only bridge** (`WasmWorkspace`, `bridge.rs`) with seeded example
  data: no auth, no crypto onboarding, no homeserver — pure static-CDN assets,
  so a launch-day spike never touches infrastructure. Sub-decisions:
  - [ ] Seed dataset + which views to showcase (table / kanban / entry / card).
  - [ ] **Demo→paid conversion**: on subscribe, create the real encrypted room
    and **replay the demo workspace's `CellUpdate` stream** through
    `ConnectedWorkspace` so users keep what they built ("everything is
    tables" makes this nearly free — see ADR 0002).
  - [ ] Decide: product-surface-only demo, or add a client-side *simulated*
    collaborator for real-time flavor (the differentiators — collab, sync,
    E2EE — can't be shown locally).
  - [ ] Make sure demo state is visibly ephemeral (banner + "subscribe to
    keep this") so nobody mistakes it for a real encrypted workspace.

---

## FE — Frontend / Table UX

- [~] **Migrate the table view to TanStack Table v8 + TanStack Virtual** — _grid done & verified 2026-06-07 (type-check + lint + 215 vitest + production build); branch `fe/tanstack-table`._
  - [x] Add deps: `@tanstack/react-table`, `@tanstack/react-virtual` (both MIT).
  - [x] **Typed cell registry** `ui/src/cells/cellRegistry.tsx` — `CellDisplay` + commit-on-blur `CellEditor` for all 9 column types, used by **both** the grid and the entry view (`FieldRenderer` delegates to it).
  - [x] Map `schema.columns → ColumnDef[]` (TanStack column model, carries options).
  - [x] Replace the raw `<table>` with TanStack + row virtualization (`@tanstack/react-virtual`, with a render-all fallback when there's no viewport, e.g. jsdom/SSR).
  - [x] **Commit on blur/Enter** → exactly one `CellUpdate` per logical edit (kills the per-keystroke `room.send`/429s).
  - [x] Header-click **column sorting** (`getSortedRowModel`). _(Toolbar Sort/Filter buttons are still stubs — real filter UI is a follow-up.)_
  - [x] Tests: rewritten to assert display + one-update-on-blur; per-type editors covered.
  - [x] **Shared the registry with EntryView** — `FieldRenderer` now delegates to `cellRegistry.CellEditor`; the `TableView` ⇄ `FieldRenderer` duplication is gone (−220 lines).
  - [ ] **Follow-up — optimistic ↔ LWW reconciliation** so a rejected write can't flash-then-revert (relates to `[§4.1]`/`[§5]`).
  - [ ] Follow-up — real filter UI; column resize/reorder/visibility (free with TanStack).

  *Alternative considered:* AG Grid (key features paid Enterprise — awkward for an auditable open-core). Glide Data Grid (canvas) for a future high-volume view.

- [x] **Flesh out placeholder field editors** (`cellRegistry.tsx`) — done 2026-06-07.
  - [x] `multiselect` **chip/tag editor** (add on Enter w/ `options` autocomplete, removable tags, dedupe) with tests.
  - [x] `reference` **record picker** — dropdown of the target table's rows via a `lookup` prop supplied by TableView/EntryView from the workspace; `CellDisplay` resolves ids to labels. With tests.

---

## P2 — Housekeeping

- [x] **Separate generated WASM output from hand-written code** — `[§5]` —
  _done 2026-06-11._ `wasm-pack` now outputs to `ui/src/wasm/generated/`
  (gitignored); `loader.ts` lives outside the blast radius, and the
  `git checkout -- loader.ts` hacks are gone from CI, the Makefile, and the
  docs (`make clean` also no longer deletes the loader).
- [x] **Remove dead/duplicated logic** — `[§5]` — _done 2026-06-11._
  `CompactionManager::last_bump` was already removed with §4.3;
  `estimate_lookback_window` (zero callers) deleted in favour of the tested
  `CompactionManager::calculate_lookback_window`. `next_timestamp_pub` did
  **not** disappear with the §4.1 fix as predicted — the integration tests
  legitimately need workspace-consistent timestamps to hand-construct
  `CellUpdate`s — so it is now `#[doc(hidden)]` and documented as test
  support (the bridges don't use it).
- [ ] **Delete the per-device IndexedDB store on sign-out** — login/register now
  create one store per device identity (`tw-{user}-{ts}`); signing out leaves it
  orphaned. Expose the name (it's in the session blob) and
  `indexedDB.deleteDatabase` it when the account is removed.
- [ ] **ADR: open up the view-type taxonomy** — the closed `ViewType` enum makes
  the local write path stricter than the federated read path (which already
  skips unknown view configs) and turns every new view into a four-layer change
  (Rust enum / bridge / UI registry / mock) — that drift hid the missing `card`
  variant. Consider `view_type` as an open string validated structurally, with
  renderability decided by the UI registry (`ViewRouter` already has a fallback).
- [x] **Re-baseline the docs** — `[§6]` — _done 2026-06-11._
  `BUILD_STATUS.md` + `docs/SESSION_SUMMARY.md` collapsed into a dated
  `STATUS.md` (snapshot-style: replace wholesale, don't append); `README.md`
  fixed (stale roadmap → pointers to STATUS/TODO/ADRs, "scaffolded" footer,
  mocked-integration claims, broken `wasm-pack` out-dir, license now matches
  the Apache-2.0 `LICENSE`); `architecture.md` test-layout diagram corrected
  (per-crate `tests/` + `ui/e2e/`, no top-level `tests/`) and the "no E2E
  browser tests" stance updated to reflect the Playwright harness.

---

## Notes

- Ordering rationale: close **P0** (clock + encryption) before anything ships — they're correctness/trust blockers. The **FE/TanStack** work and **P1** can proceed in parallel; the table migration's commit-on-blur also reduces the §4.1 blast radius.
- Nothing here has been started — this is planning only.
