# Legal documents

`terms-of-service.md` and `privacy-policy.md` are the **source of truth**.
`site/terms.html` and `site/privacy.html` are generated from them and committed,
because the site deploy publishes `site/` as static files with no build step.

Edit the Markdown, re-render, commit both:

```sh
node scripts/render-legal.mjs
```

Two copies of a legal document that can disagree is exactly the failure to avoid, so
never hand-edit the HTML.

## Where they appear

| Surface | How |
| --- | --- |
| tidework.io footer | `/terms`, `/privacy`, and a `mailto:` support link |
| Registration | MAS `branding.tos_uri` adds a **mandatory checkbox** and records the accepted document in its `user_terms` table |
| OIDC metadata | advertised as `op_tos_uri` / `op_policy_uri` |
| MAS emails | linked in the footer |

Because MAS keys consent to the **URL**, changing `tos_uri` re-prompts every existing
user. That is right for a material change and wrong for fixing a typo — so fix typos in
place at the same URL, and only move the URL when the terms genuinely change.

## Still outstanding

**Neither document has been reviewed by a lawyer.** They were published deliberately —
accurate terms live beat none while review is arranged — but the review is still owed,
and the liability, warranty, and jurisdiction clauses are where generic wording most
often fails.

Two specifics worth raising with whoever reviews them:

- **The provider is an individual**, not a company. That puts personal liability behind
  the cap in §7 and an individual's name in a public document. Forming an entity is the
  usual fix, and changes the opening line of both documents.
- **No postal address is published.** Consumer-protection and e-commerce rules in
  several jurisdictions — including the EU, whose GDPR rights the privacy policy already
  undertakes to honour — expect a contactable address for the controller, not only an
  email address.
