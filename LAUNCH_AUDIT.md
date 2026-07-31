# Launch readiness audit

**Date:** 2026-07-31
**Scope:** the hosted product at [tidework.io](https://tidework.io) — app, marketing
site, docs, and the open backlog — assessed against what a paid, public launch of a
Notion/Airtable-class workspace requires.

**Method:** every claim below was checked against the code, the live services, or a
run of the tests. Where something is stated as missing, the search that failed to
find it is cited. This is a point-in-time snapshot in the manner of
[ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md); it is not a changelog.

---

## Verdict

The **engineering** is in better shape than the **launch surface**. The hard part —
end-to-end encryption with real key management, convergent offline-tolerant sync, a
federated protocol, a Rust core shared by browser and CLI — is built, deployed, and
covered by 215 Rust tests, 626 UI tests, and 26 browser tests against a real
homeserver.

What is missing is mostly not hard; it is the surrounding material a stranger needs
before they will trust a paid service with their data. Three items are genuine
blockers, and none of them are engineering problems.

The one product gap that is likely to cost real conversions is that **the app does
not work on a phone**.

---

## Blockers — do not launch without these

### 1. No Terms of Service and no Privacy Policy

Neither exists anywhere in the repo or on the live site:

```
grep -rniE "privacy|terms of|/terms|/privacy" site/index.html ui/src   → no matches
```

This is not a formality. The service takes recurring payments through Stripe, whose
terms require a published refund/cancellation policy and contact information; and it
serves EU users, where a privacy notice is a legal requirement rather than a nicety.

There is also a story here worth telling properly rather than boilerplating: a
privacy policy for a service that *cannot read user content* is a genuinely strong
document. The current absence wastes that.

### 2. No support or contact channel

`site/index.html` has no `mailto:`, no contact route, no support address. A paying
customer with a billing problem, or a locked-out user, has nowhere to go. Stripe also
expects a contact method for dispute handling.

Related: `infra/healthcheck.sh` alerts to `mia.mowe@gmail.com` only. There is no
status page and no way for a user to distinguish "the service is down" from "my
account is broken".

### 3. No account deletion

There is no user-facing deletion or erasure path anywhere in the UI. The capability
exists — `POST /api/admin/v1/users/{id}/deactivate` is already used by the billing
sweep — but it is reachable only by an operator.

For a GDPR-facing service this is a right-of-erasure gap, and for a product whose
pitch is data sovereignty it is an awkward one: users can leave a workspace
(`LeaveWorkspaceModal`) but cannot close an account.

---

## Should fix before launch

### 4. The app is not usable on a phone

Two of twenty-one app stylesheets contain any media query at all:

```
grep -rl "@media" ui/src --include=*.css
  → ui/src/components/ConnectionStatus.css
  → ui/src/components/VerifyDeviceScreen.css
```

The sidebar, the table grid, the entry view, kanban, cards, and the workspaces page
have **no responsive rules**. The marketing site is responsive (4 media queries), so
the funnel reads well on a phone and then delivers an app that does not fit it.

This is the largest single product gap for a launch, and it is the one most likely to
be discovered by a prospect rather than reported by a user.

### 5. Search is a dead placeholder

`ui/src/components/Sidebar.tsx:870-877` renders a search box with a `⌘K` hint. It is a
static `<div>` — no input, no handler, and nothing anywhere binds the shortcut:

```
grep -rn "key === 'k'" ui/src   → no matches
```

A visible control that does nothing when clicked reads as broken software. Either
implement it or remove it before strangers see it; leaving it is the worst option.

Search over encrypted data is a real design problem (the server cannot index
ciphertext, so it has to be client-side over materialized state) — which is exactly
why it should not be implied by a decorative box.

### 6. No demo route

ADR 0002 specifies demo mode as the top of the funnel: "a `/demo` route instantiates
[the local-only workspace] with seeded example data — no registration, no crypto
onboarding". The route does not exist (`ui/src/App.tsx` route table).

The local-only bridge (`WasmWorkspace`) and the template archives both exist, so this
is closer to wiring than to building. Without it, the first thing the site asks a
stranger to do is create an account.

### 7. No device/session management

Users cannot list their own sessions or revoke one. `VerifyDeviceScreen` is the
new-device verification gate, not a device manager.

For most products this is a nice-to-have. For one that sells encryption, "which
devices can decrypt my data, and how do I remove one" is a question the product
should be able to answer.

---

## Gaps against the product class

Not blockers — the honest list of what a Notion/Airtable-shaped product has that this
does not. Useful for deciding what "early" means in public.

| Missing | Notes |
| --- | --- |
| **Comments / discussion** | No comment surface at all. The most-expected collaboration feature after real-time editing. |
| **File attachments** | Matrix supports encrypted media; nothing in the app uses it. |
| **Notifications** | No in-app or email notification of mentions, assignments, or changes. |
| **Undo (⌘Z)** | History exists at *table* granularity via the History drawer; there is no per-action undo, which a grid strongly implies. |
| **Trash / restore** | Deletes are tombstones under the decay model, but nothing surfaces them for restore. |
| **Grouping in table views** | Kanban groups by a select column; the table view cannot group. |
| **Rollups / lookups across references** | The new formula column computes within one row only. Cross-relation aggregation is the Airtable expectation. |
| **Presence** | No indication of who else is viewing or editing. |
| **Public share links** | Genuinely hard under E2EE — a link recipient has no keys. Worth stating as a deliberate design boundary rather than a missing feature. |
| **HTTP API / webhooks** | The CLI covers scripting. A server-side API is largely precluded by the threat model (the server has no plaintext), which is a *position*, not an omission — say so. |
| **Accessibility** | Unaudited. Grid keyboard navigation exists; ARIA/contrast/screen-reader behaviour has never been checked. |
| **Internationalisation** | English only, no framework in place. |

Two of these — public sharing and the HTTP API — are consequences of the encryption
model rather than backlog items. Publishing that reasoning is more persuasive than
quietly lacking the features.

---

## Website verification

Checked against the live site and the code. **The site is honest** — every factual
claim I could test holds.

| Claim | Verdict |
| --- | --- |
| "this page loads no JavaScript" | ✅ zero `<script>` tags |
| "sets no cookies, zero third-party requests — fonts included" | ✅ only same-origin `/fonts/`; the sole external URLs are anchor targets |
| "no telemetry" | ✅ no analytics SDK anywhere in `ui/src` |
| `io.tidework.cell.update` | ✅ real event type (`crates/tables-over-matrix/src/matrix.rs:210`) |
| "$12 / month · 14-day free trial" | ✅ matches `PRICE_CENTS=1200`, `TRIAL_DAYS=14` |
| "Try free for 14 days — no card required" | ✅ registration is open; trial-first |
| "Cancel anytime" | ✅ Stripe billing portal is wired (`/portal`) |
| "Apache-2.0 licensed" | ✅ `LICENSE` present |
| "encryption, key backup, and device verification are tested end-to-end in CI on every change" | ✅ accurate |
| "Deploy configs included in the repo" | ✅ `infra/` |
| Live services | ✅ tidework.io, app.tidework.io, billing.tidework.io all 200 |

Three things to correct:

1. **"one event type, `io.tidework.cell.update`"** — there are now two: multi-cell
   writes go out as `io.tidework.cell.batch` (`matrix.rs:218`). The architectural
   claim survives (one *merge rule*, one code path); the sentence does not.
2. **Self-hosting is oversold relative to the README.** The site's Self-hosted tier
   says "Free — forever… Deploy configs included in the repo"; the README says
   self-hosting "is not yet documented as a supported path". Both cannot be right.
   The configs are real, so the fix is to document the path or soften the tier copy.
3. **No legal/contact footer** — see blockers 1 and 2. The footer currently carries
   only `App · GitHub · Built on Matrix`.

---

## Documentation verification

- **README.md** — accurate but unfit for a public repo: 563 lines mixing marketing,
  install, Rust API examples, product manuals, and troubleshooting, much of it
  duplicating `QUICKSTART.md` and `CONTRIBUTING.md`. Rewritten in this change.
- **STATUS.md** — **stale and misleading**, dated 2026-06-11. It describes Conduit as
  the test homeserver (migrated to Synapse), claims 242 UI tests (626), and lists
  at-rest encryption and collaboration/multi-tab e2e as *gaps* when all three have
  shipped. The README points at it as the source of truth for current state, so it
  was refreshed here too.
- **CONTRIBUTING.md** — titled "Contributing to Secure Collaborative Workspace";
  pre-rename branding. Content is sound.
- **docs/UX_AND_FEATURES.md** — referenced by the README as "complete product vision";
  worth confirming it still matches the product before a public repo invites reading
  it.
- **TODO.md**, **docs/adr/**, **ARCHITECTURE_REVIEW.md**, **QUICKSTART.md** — accurate.

---

## Open backlog, triaged for launch

13 open issues. Mapped to launch relevance rather than their existing priority:

**Launch-relevant**

- `75869aa5` — `healthcheck.sh` reprints the Resend key under `bash -x`. The
  mechanism that caused the 2026-07-21 leak is unchanged; the key was rotated.
- `8fe63084` — one Resend key serves both transactional email and alerting, so one
  leak takes out the channel that would tell you about the outage.
- `d7a56ef5` — unattended security upgrades, and an **untested DB restore path**. A
  backup nobody has restored is not yet a backup.
- `f6901da6` — orphaned per-device IndexedDB stores on sign-out (privacy on shared
  machines).
- `363e0051` — confirm before leaving the master-key dialog: a user who skips it
  loses history access, which is unrecoverable.

**Not launch-blocking**

- `f4d0c594` (flaky e2e under load), `c7d42d81` (injectable retry delays),
  `ab0a28d8` (CLI bench), `78529070` (view-type ADR), `762593a6` (CLI under passkey
  custody), `692581cf` (Apple/Microsoft SSO), `6544ee2e` (billing e2e, punted),
  `e094eb64` (HIPAA — a market-entry project, not a launch task).

Nothing in the backlog is a hard blocker. The blockers are the three items above that
nobody had filed, which is itself the finding: the backlog tracks engineering well
and launch readiness not at all.

---

## What is genuinely strong

Worth stating plainly, because the list above is all deficits:

- **The encryption is real and continuously proven.** Key backup, cross-signing,
  device verification, and recovery are exercised end-to-end in CI against a real
  homeserver and real browsers on every change — not asserted in a README.
- **At-rest encryption on the client** with a device-key wrap, so a reload does not
  prompt. That combination is unusual and was hard-won.
- **One engine, two clients.** The CLI links `app-core` directly; a saved view
  selects the same rows in a terminal as in the browser.
- **Data portability is already better than most incumbents** — CSV archive
  export/import (ADR 0004), readable by the CLI, with no lock-in.
- **The marketing site tells the truth**, which is rarer than it should be, and the
  zero-JavaScript proof section is a real demonstration rather than a claim.
