#!/usr/bin/env python3
"""Assert the live pages load no script we did not put there.

WHY THIS IS A POST-DEPLOY CHECK AND NOT A TEST. Cloudflare can inject a script
into an HTML response at the edge -- Web Analytics / RUM does exactly that, and
it can be switched on by a dashboard click or by a product default changing
under us. The injected tag is in NOBODY'S repository. It is not in the built
`dist/`, so no unit test, no Playwright run against a dev server, and no review
of a diff can ever see it. The only place it exists is the bytes a browser
actually receives, so that is the only place worth looking.

It matters more here than on a normal product. TideWork's entire claim is that
the server cannot read your data, and the client is the trust boundary that
makes the claim true. A third-party script on the app origin has the same reach
as our own code: it can read decrypted cells out of the DOM and the recovery key
off the screen. "We do not send your data anywhere" and "the CDN injects a
beacon we did not audit" cannot both be true.

Expectations, deliberately strict:
  * the marketing site and the community page load NO script at all
  * the app loads exactly ONE, its own module bundle, from its own origin

Both are the current truth, so any drift is a real change worth a human looking
at it. If a page legitimately gains a script, edit EXPECTED here in the same
commit -- that edit is the audit trail.

Usage: check-live-scripts.py [--verbose]
"""

import argparse
import sys
import time
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

# url -> how many <script> tags it may have. Same-origin is enforced for all of
# them; see `check`.
EXPECTED = {
    "https://tidework.io/": 0,
    "https://tidework.io/privacy.html": 0,
    "https://tidework.io/terms.html": 0,
    "https://tidework.io/status.html": 0,
    "https://tidework.io/reactivate.html": 0,
    "https://community.tidework.io/": 0,
    # The Vite module bundle, hashed, from our own origin.
    "https://app.tidework.io/": 1,
}

ATTEMPTS = 3
RETRY_SECONDS = 10


class ScriptFinder(HTMLParser):
    """Collect every <script>: `src` for external, None for inline."""

    def __init__(self):
        super().__init__()
        self.scripts = []
        self._inline = False

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        src = dict(attrs).get("src")
        self.scripts.append(src)
        self._inline = src is None

    def handle_data(self, data):
        if self._inline and data.strip():
            self.scripts[-1] = f"<inline: {data.strip()[:60]}...>"

    def handle_endtag(self, tag):
        if tag == "script":
            self._inline = False


def fetch(url):
    """Fetch a URL as a browser would — no cache-buster.

    Deliberately NOT cache-busted. A `?cb=` query string is a different cache
    key, so it reaches the origin and proves only that the origin is clean —
    which is not the question. The question is what an edge PoP hands a visitor
    typing the plain URL, and only the plain URL asks it.
    """
    request = Request(url, headers={"User-Agent": "tidework-ci-script-audit"})
    with urlopen(request, timeout=20) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def check(url, allowed, verbose=False):
    """Return a list of problems with this URL (empty means it passed)."""
    body = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            body = fetch(url)
            break
        except (HTTPError, URLError, TimeoutError) as err:
            if attempt == ATTEMPTS:
                return [f"{url}: could not fetch after {ATTEMPTS} attempts ({err})"]
            time.sleep(RETRY_SECONDS)

    finder = ScriptFinder()
    finder.feed(body)
    scripts = finder.scripts
    host = urlparse(url).netloc

    problems = []
    if len(scripts) != allowed:
        problems.append(
            f"{url}: {len(scripts)} script(s), expected {allowed} — {scripts or '[]'}"
        )

    for src in scripts:
        if src is None or src.startswith("<inline:"):
            problems.append(f"{url}: inline script — {src}")
            continue
        src_host = urlparse(src).netloc
        if src_host and src_host != host:
            problems.append(f"{url}: THIRD-PARTY script from {src_host} — {src}")

    if verbose and not problems:
        print(f"  ok  {url}  ({len(scripts)} script(s): {scripts or '[]'})")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verbose", action="store_true", help="print every page checked")
    args = parser.parse_args()

    # Retry the whole audit, not just the fetch: straight after a deploy an edge
    # PoP can still be handing out the previous HTML, and that is a warm-up, not
    # an injected beacon. A real injection is served consistently and survives
    # every round, so retrying costs 30 seconds and removes the only way this
    # check could cry wolf.
    for round_number in range(1, ATTEMPTS + 1):
        problems = []
        for url, allowed in EXPECTED.items():
            problems.extend(check(url, allowed, verbose=args.verbose))
        if not problems or round_number == ATTEMPTS:
            break
        print(f"  {len(problems)} problem(s) on round {round_number}; re-checking")
        time.sleep(RETRY_SECONDS)

    if problems:
        print("Live pages are serving scripts we did not ship:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print(
            "\nIf this is an injected analytics/RUM beacon, turn it off in the\n"
            "Cloudflare dashboard (Speed -> Optimization -> Web Analytics, and\n"
            "Analytics -> Web Analytics for the zone), then purge the cache. If a\n"
            "page legitimately gained a script, update EXPECTED in this file.",
            file=sys.stderr,
        )
        return 1

    print(f"live script audit: {len(EXPECTED)} pages clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
