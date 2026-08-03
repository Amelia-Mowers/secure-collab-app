/**
 * Screenshot the real app at phone width, so "is it usable at 390px" is
 * answered by looking rather than by reading CSS.
 *
 * Reading stylesheets tells you which files have media queries. It does not
 * tell you whether the first screen past the marketing CTA fits, whether a
 * grid scrolls its own container or pushes the page sideways, or whether a
 * control ends up under the fold with no way to reach it. Those are the things
 * that decide whether a phone visitor bounces.
 *
 * 390x844 is an iPhone 14/15 — the modal width for mobile traffic.
 *
 *   node e2e/mobile-shots.mjs [baseURL]      (default: the live app)
 */
import { chromium, devices } from '@playwright/test'
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'https://app.tidework.io'
const OUT = process.env.SHOT_DIR ?? 'mobile-shots'

function nixChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!base || !base.startsWith('/nix/')) return undefined
  try {
    return (
      execSync(`find -L "${base}" -type f -name chrome -path '*chrome-linux*' 2>/dev/null | head -1`, {
        encoding: 'utf8',
      }).trim() || undefined
    )
  } catch {
    return undefined
  }
}

/** Does the page scroll sideways? The single clearest "this does not fit". */
async function overflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement
    const worst = [...document.querySelectorAll('*')]
      .map(el => ({
        sel:
          el.tagName.toLowerCase() +
          (el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : ''),
        right: el.getBoundingClientRect().right,
      }))
      .filter(x => x.right > d.clientWidth + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 5)
    return { viewport: d.clientWidth, scrollWidth: d.scrollWidth, worst }
  })
}

/** Controls too small to hit reliably. Apple's guidance is 44px. */
async function smallTargets(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, a, select, input[type=checkbox]')]
      .map(el => {
        const r = el.getBoundingClientRect()
        return {
          label: (el.getAttribute('aria-label') || el.textContent || el.tagName)
            .trim()
            .slice(0, 30),
          w: Math.round(r.width),
          h: Math.round(r.height),
        }
      })
      .filter(t => t.w > 0 && t.h > 0 && (t.w < 32 || t.h < 32))
      .slice(0, 8),
  )
}

const results = []

async function shot(page, name, url, prepare) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (prepare) {
    try {
      await prepare(page)
    } catch (e) {
      results.push({ name, error: `setup: ${String(e).slice(0, 120)}` })
      return
    }
  }
  await page.waitForTimeout(2500)
  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  results.push({ name, ...(await overflow(page)), small: await smallTargets(page) })
}

const browser = await chromium.launch({
  executablePath: nixChromium(),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
const ctx = await browser.newContext({ ...devices['iPhone 14'] })
const page = await ctx.newPage()

// The funnel, in the order a phone visitor meets it.
await shot(page, '1-signin', `${BASE}/`)
await shot(page, '2-demo-grid', `${BASE}/demo`)
await shot(page, '3-demo-board', `${BASE}/demo`, async p => {
  await p.getByText('Board', { exact: false }).first().click({ timeout: 15_000 })
})
await shot(page, '4-demo-row', `${BASE}/demo`, async p => {
  await p.locator('tbody tr').first().click({ timeout: 15_000 })
})

await browser.close()

let worstOverflow = 0
for (const r of results) {
  if (r.error) {
    console.log(`\n${r.name}: SETUP FAILED — ${r.error}`)
    continue
  }
  const over = r.scrollWidth - r.viewport
  worstOverflow = Math.max(worstOverflow, over)
  console.log(`\n${r.name}: viewport ${r.viewport}px, scrollWidth ${r.scrollWidth}px` +
    (over > 1 ? `  ← OVERFLOWS BY ${over}px` : '  ✓ fits'))
  for (const w of r.worst) console.log(`    overflowing: ${w.sel} right=${Math.round(w.right)}`)
  for (const t of r.small) console.log(`    small tap target: "${t.label}" ${t.w}x${t.h}`)
}
console.log(`\nworst horizontal overflow: ${worstOverflow}px`)
console.log(`screenshots in ${OUT}/`)
