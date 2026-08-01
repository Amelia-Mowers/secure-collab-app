# Security Policy

## Reporting a vulnerability

Email **tideworksupport@proton.me** with `SECURITY` in the subject. Please report
privately first rather than opening a public issue.

Include what you need to make it reproducible: the affected surface, steps, and what
an attacker gains. If it helps, say which build — the app shows one under
**Account settings → Help & legal**.

**What to expect:** an acknowledgement within 3 working days, an assessment within 10,
and credit in the fix commit if you want it. This is a small project — that is a
commitment about honesty and speed of reply, not a 24/7 rota.

We have no bug bounty. We will not threaten you for reporting in good faith.

## Scope

**In scope**

- The web app (`app.tidework.io`) and the Rust core it compiles from — `crates/app-core`,
  `crates/tables-over-matrix`, `ui/`
- The hosted homeserver stack (`matrix.tidework.io`, `auth.tidework.io`) as configured in
  `infra/` — our configuration of Synapse and MAS, not upstream bugs in them
- The billing Worker (`billing.tidework.io`)
- The `tidework` CLI (`crates/cli`)
- The marketing site (`tidework.io`)

**Out of scope**

- Upstream vulnerabilities in Synapse, MAS, the Matrix Rust SDK, or the Matrix protocol —
  report those to their maintainers. Tell us too if our configuration makes one worse.
- Anything requiring a compromised device or a malicious browser extension. If script can
  run on the origin, it can reach decrypted data — that limit is stated in
  `crates/app-core/src/…` module docs and in the privacy policy, and is a property of a
  browser E2EE app rather than a bug in this one.
- Rate-limiting and volumetric denial of service against the hosted service.
- Missing hardening headers with no demonstrated impact.

## What our threat model already concedes

Reports in these areas are welcome but are known and documented, so say what you think we
got wrong rather than that the property exists:

- **The homeserver sees metadata.** Room membership, event timing, and event sizes are
  visible to the operator. Content is not.
- **Losing your keys loses your data.** There is no recovery path, by design. See the
  Terms, section 5.
- **Local storage is encrypted at rest but the browser is trusted while unlocked.**
- **Federated servers receive metadata** for rooms they participate in.

## Handling reports about user content

We cannot inspect user content to triage a report about it — the homeserver holds
ciphertext and we do not have the keys. If a report depends on the contents of a specific
workspace, we will need you to reproduce it in a workspace you control and share what you
observed. This is the architecture working as intended, and it does constrain how we can
help.

## Disclosure

Please give us 90 days before public disclosure, or less if the issue is actively
exploited and users are better served by knowing. We will tell you when a fix ships. If we
go quiet for two weeks, treat that as a failure on our side and disclose as you see fit.
