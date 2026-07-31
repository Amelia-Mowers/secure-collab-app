# Legal documents — drafts

`terms-of-service.md` and `privacy-policy.md` are **drafts for review**, not published
text. They are deliberately kept out of `site/` so that merging cannot publish them:
the Cloudflare Pages deploy ships everything under `site/`, and half-finished legal
text on a live paid service is worse than none.

## Before publishing

Four blanks need real answers. They appear as `[BRACKETED]` markers in both files:

| Marker | What it needs |
| --- | --- |
| `[LEGAL ENTITY]` | The contracting party — a company if one exists, otherwise the individual trading name. This also decides who is liable. |
| `[JURISDICTION]` | Governing law and venue. Follows from where the entity is established. |
| `[SUPPORT EMAIL]` | The support/contact address, once it exists. Stripe expects one for dispute handling, and both documents need a route for legal notices and privacy requests. |
| `[EFFECTIVE DATE]` | The date you publish. |

## Then

1. Fill the blanks.
2. **Have a lawyer read them.** These are written to be honest and specific about how
   the product actually works — which is the hard half — but they have not been
   reviewed by anyone qualified, and the liability and warranty sections in
   particular are exactly where generic wording fails.
3. Move both into `site/` as `terms.html` and `privacy.html` (or render them), add
   footer links, and deploy.

## Why these are unusual

Most privacy policies are written to permit as much as possible. This one can be
narrow and specific, because the service genuinely cannot read user content — the
homeserver holds ciphertext and the keys never leave the user's devices. That is a
real competitive asset and worth the effort of saying precisely.

The flip side is the data-loss position: because we cannot read the data, we cannot
recover it either. A lost recovery key with no enrolled passkey means the history is
gone permanently, and the terms have to say so plainly rather than bury it.
