# TideWork — Terms of Service

**Effective:** 1 August 2026
**Provider:** Amelia Mowers ("we", "us"), operator of TideWork at tidework.io.

By creating an account or using TideWork, you agree to these terms. If you do not
agree, do not use the service.

---

## 1. What TideWork is

TideWork is a collaborative workspace — tables, boards, and documents — built on the
Matrix protocol. Content you create is **end-to-end encrypted on your device before it
reaches our servers**.

This is the single most important thing to understand about the service, because it
determines what we can and cannot do for you. See section 5.

## 2. Your account

You must be able to form a binding contract to use TideWork. You are responsible for
what happens under your account, including keeping your credentials, recovery key, and
devices secure.

**An account is for one person.** Pricing is per person, so each collaborator needs
their own account — you may not share one set of credentials between people. One person
may hold as many accounts as they like.

## 3. Subscriptions, trials, and billing

- New accounts get a **14-day free trial**. No payment method is required to start.
- After the trial, continued use requires an active subscription at the price shown at
  [tidework.io](https://tidework.io) at the time you subscribe.
- Subscriptions renew **monthly** until cancelled. Payment is processed by Stripe; we
  do not store your card details.
- **Cancel any time** through *Manage subscription* in the app, which opens Stripe's
  billing portal. Cancellation takes effect at the end of the paid period; you keep
  access until then.
- We may change prices with at least 30 days' notice before the change applies to your
  renewal. Continuing to use the service after that is acceptance of the new price.
- **Refunds** are not automatic. If something has gone wrong, contact
  tideworksupport@proton.me and we will deal with it in good faith. Statutory rights that apply
  where you live are unaffected by this paragraph.

### What happens if you stop paying

If a trial ends or a subscription lapses without payment, we **lock** the account: you
cannot sign in or write, but your data is preserved and unlocking it restores
everything. We do not delete data on lapse.

An account that has **never** had a paid subscription and has been locked for more
than 60 days past its trial may be deleted, along with its data. Accounts that have
paid at any point are not deleted this way.

## 4. Acceptable use

You may not use TideWork to:

- break the law, or infringe anyone's rights;
- store or distribute material that is unlawful where you or we operate;
- attack, overload, or probe the service or other users (deliberate abuse of the
  homeserver, its federation partners, or other tenants);
- resell the hosted service as your own without a separate agreement.

Because the service is end-to-end encrypted, we cannot proactively inspect content —
enforcement is necessarily reactive, based on reports, billing signals, and abuse
patterns visible without decryption. We may suspend or terminate an account we
reasonably believe is being used in breach of this section.

## 5. Encryption, keys, and data loss — read this

Your content is encrypted on your device. **We do not hold the keys and cannot decrypt
your workspaces.** That is the product's central promise, and it has a direct
consequence:

> **If you lose access to your keys, your data is permanently unrecoverable — by you
> and by us. We cannot reset it, restore it, or recover it, because there is nothing
> we hold that could.**

Concretely:

- Your **recovery key** (and any passkey you enrol to unlock it) is the only route
  back into your encrypted history on a new device. Store it somewhere safe and
  durable.
- If you lose every enrolled device *and* your recovery key, the encrypted history is
  gone. Your account may still exist; its contents will not be readable.
- Resetting your account's encryption starts you from an empty history. Older content
  stays encrypted under keys nobody has.

We keep server-side backups of the encrypted data so that *our* failures — hardware,
corruption, operator error — do not lose it. Those backups are ciphertext and do not
help if you have lost your keys.

**We are not responsible for data loss.** Without limiting section 7, we are not
liable for loss of, or inability to access, content caused by: loss of your recovery
key or devices; your own deletion or overwriting of data; a resetting of your
encryption; conflicts arising from concurrent edits; or third-party services and
networks outside our control. **Keep your own copies of anything you cannot afford to
lose** — the app exports your workspaces as CSV archives, and the CLI can do the same.

## 6. Availability and changes

We aim to keep TideWork available and to give notice of disruptive changes, but the
service is provided **without any uptime guarantee or service-level commitment**. We
may modify, suspend, or discontinue features. If we discontinue the hosted service
entirely, we will give reasonable notice and a window in which to export your data.

TideWork's source is published under Apache-2.0, so a discontinued hosted service does
not have to mean a discontinued workspace: you can run it yourself.

## 7. Disclaimers and limitation of liability

The service is provided **"as is" and "as available"**, without warranties of any
kind, express or implied, including merchantability, fitness for a particular purpose,
and non-infringement. We do not warrant that the service will be uninterrupted,
error-free, or secure against every possible attack.

To the fullest extent permitted by law, our total liability arising out of or relating
to the service — in contract, tort, or otherwise — is limited to **the amounts you
paid us in the 12 months before the event giving rise to the claim**. We are not
liable for indirect, incidental, special, consequential, or punitive damages, or for
lost profits, revenue, goodwill, or data.

Some jurisdictions do not allow certain exclusions; where that is the case, the above
applies to the maximum extent permitted, and nothing here excludes liability for
fraud, death or personal injury caused by negligence, or anything else that cannot
lawfully be excluded.

## 8. Ending the agreement

**You** may stop at any time: cancel the subscription through *Manage subscription*,
and delete the account from *Account settings* when you want the account itself gone.
Deleting an account is irreversible and cancels any active subscription.

**We** may suspend or terminate an account for breach of section 4, for non-payment
(subject to section 3), or if required by law. Where practical we will give notice and
an opportunity to export.

## 9. Your content

You keep all rights in what you create. We claim no ownership.

You grant us only the narrow permission needed to run the service — to store,
transmit, and back up the **encrypted** form of your content, and to process the
account metadata described in the [Privacy Policy](./privacy-policy.md). We cannot
grant ourselves more than that even if we wanted to: the plaintext is not available to
us.

## 10. Changes to these terms

We may update these terms. For material changes we will give notice before they take
effect — in the app, by email, or both. Continuing to use the service after that is
acceptance. The current version is always published at tidework.io.

## 11. Governing law

These terms are governed by the laws of the State of Washington, USA, and the courts of
the State of Washington, USA have exclusive jurisdiction, except where mandatory consumer-protection
law in your country of residence gives you the right to bring proceedings locally.

## 12. Contact

tideworksupport@proton.me
