# TideWork — Privacy Policy

**DRAFT — not published. See [README.md](./README.md) for the blanks that must be
filled and the legal review required before this goes live.**

**Effective:** [EFFECTIVE DATE]
**Controller:** [LEGAL ENTITY], operator of TideWork at tidework.io.
**Contact:** [SUPPORT EMAIL]

---

## The short version

**We cannot read your workspaces.** Everything you write is encrypted on your device
before it reaches our servers, and the keys never leave your devices. What we hold is
ciphertext.

We collect the minimum needed to run an account and take payment. There is **no
analytics, no tracking, and no advertising** anywhere in the product or on the
website — the marketing site loads no JavaScript, sets no cookies, and makes no
third-party requests at all.

The rest of this document is the specifics.

## What we cannot see

Your **content** — the rows, tables, boards, documents, and files in your workspaces,
including their names and structure — is end-to-end encrypted with the Matrix Megolm
protocol. We hold the encrypted blobs. We do not hold the keys, and we cannot decrypt
them, produce them on request, or reset them for you.

This is architectural, not a policy we could quietly change: a change would be visible
in the open-source client and would require your devices to hand over keys.

## What we do collect

**Account data**
- Your username and Matrix user ID.
- An email address, where you provide one — used for sign-in verification codes and
  password resets. If you sign in with Google, we receive the email address and basic
  profile information Google supplies.
- Authentication data: password hashes (never plaintext), OAuth session records, and
  the list of devices/sessions on your account.

**Encrypted content and its metadata**
- The encrypted events themselves.
- Unavoidable protocol metadata: which room an event belongs to, who sent it, and
  when. This tells us *that* you were active and roughly how much, never *what* you
  wrote.
- Room membership — who shares a workspace with whom.

**Operational data**
- Server logs from the homeserver and our reverse proxy, including IP addresses,
  timestamps, and request paths. These exist for security, abuse handling, and
  debugging.
- Cloudflare, which serves the site and app, processes connection data including IP
  addresses as part of delivery and DDoS protection.

**Billing data**
- Subscription status, and the association between your username and a Stripe
  customer.
- **Card details are handled entirely by Stripe. We never see or store them.**

## What we do not do

- No analytics or telemetry SDK, in the app or on the site.
- No advertising, and no sale or sharing of personal data with advertisers. Ever.
- No profiling or automated decision-making with legal effects.
- No cookies on the marketing site. The app stores data locally in your browser to
  keep you signed in and to hold your encrypted keys and cached workspace state —
  local storage, not tracking.

## Why we process it, and on what basis

| Purpose | Data | Basis (GDPR Art. 6) |
| --- | --- | --- |
| Providing the service | account, encrypted content, membership | Contract |
| Taking payment | billing, subscription status | Contract |
| Sending verification and password-reset email | email address | Contract |
| Security, abuse prevention, debugging | logs, IP addresses | Legitimate interests |
| Meeting legal obligations (e.g. tax records) | billing | Legal obligation |

## Who we share it with

Only the providers needed to run the service:

| Processor | Role | Data |
| --- | --- | --- |
| **DigitalOcean** | Hosting the homeserver and its managed database | Encrypted content, account data, logs |
| **Cloudflare** | Serving the site/app, and the billing worker | Connection data, IP addresses |
| **Stripe** | Payments and the billing portal | Billing details, card data (directly) |
| **Resend** | Transactional email (verification, password reset, alerts) | Email address, message contents |
| **Google** | Optional sign-in, only if you choose it | Your Google account identifier and email |

We do not sell personal data. We disclose data to authorities only where legally
compelled — and note that a compelled disclosure of your workspaces would produce
ciphertext we cannot decrypt.

Some of these providers operate outside your country, including in the United States.
Transfers rely on the providers' standard contractual clauses and equivalent
safeguards.

## Federation

TideWork is built on Matrix. If you collaborate with someone on **another** homeserver,
the protocol shares the encrypted events and the necessary metadata with that server,
which is operated by someone else under their own policy. Your content stays encrypted
in transit and at rest there; the metadata described above is visible to them.

This only happens if you invite, or accept an invitation from, a user on another
server.

## How long we keep it

- **Account and encrypted content:** while your account exists.
- **A lapsed account:** locked, not deleted — your data is preserved so that paying
  again restores it. An account that never paid and has been locked for more than 60
  days past its trial may be deleted with its data.
- **After you delete your account:** account records and encrypted content are removed
  from live systems, with encrypted backups ageing out on their normal schedule
  (currently 7 days).
- **Logs:** kept only as long as useful for security and debugging.
- **Billing records:** kept as long as tax and accounting law requires, typically
  several years, independent of account deletion.

## Your rights

Where the GDPR, UK GDPR, or a similar law applies, you can ask us to give you a copy
of your data, correct it, delete it, restrict or object to processing, or provide it
in a portable form. You may also complain to your local supervisory authority.

Two of these you can exercise yourself, immediately:

- **Portability** — export any workspace as a CSV archive from the app or the CLI.
  It is a plain, documented format, not a lock-in.
- **Erasure** — delete your account from *Account settings*.

For anything else, write to [SUPPORT EMAIL].

The honest limit on erasure: we can delete your account and the encrypted content we
hold. We cannot reach copies already synced to a collaborator's device or to another
homeserver you federated with — the same property that stops *us* reading your data
stops us reaching into someone else's client.

## Children

TideWork is not directed at children under 16, and we do not knowingly collect their
data. If you believe a child has created an account, contact us and we will remove it.

## Security

Content is end-to-end encrypted in transit and at rest. Local browser storage —
including the encryption keys and cached workspace state — is itself encrypted at rest
with a key held by your device and, optionally, your passkey. Connections use TLS.
Server access is restricted and key-based.

No system is perfectly secure. If you find a vulnerability, please report it to
[SUPPORT EMAIL] rather than disclosing it publicly, and we will work with you.

## Changes

We will update this policy as the service changes, and give notice of material changes
before they take effect. The current version is always published at tidework.io.
