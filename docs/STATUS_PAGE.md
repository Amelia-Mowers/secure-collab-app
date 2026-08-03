# Editing the status page during an incident

`site/status.html` is hand-edited and deploys with the site. It used to carry
these instructions as an HTML comment, which meant every visitor could read our
incident runbook in view-source; the site has no build step, so nothing strips
comments before they are served.

## During an incident

1. Swap the dot and text classes in the banner: `dot--ok` / `dot--degraded` /
   `dot--down`.
2. Change the banner text.
3. Update the "Last checked" date.
4. Change any affected row in the components table: `state--ok` /
   `state--degraded` / `state--down`.
5. Add an entry under **Recent incidents**.

Commit and push. Cloudflare Pages deploys on merge to `main`.

## Recent incidents

Newest first. Keep roughly the last six months — a page that has never recorded
an incident reads as unmaintained rather than as reliable, so an empty list
should be an honest statement rather than a default nobody has revisited.
