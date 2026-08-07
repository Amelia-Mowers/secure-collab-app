/**
 * The wasm heap must not grow when nothing is being retained.
 *
 * This exists because of a bug every other test we own was blind to. The wasm
 * build used `wee_alloc` as its global allocator, and wee_alloc does not reuse
 * freed memory — it grows the heap in proportion to how much a program has EVER
 * allocated rather than how much it holds. Reading one four-row table cost
 * ~12.6 KiB of permanent heap, dead linear, 35 MiB to 160 MiB across ten
 * thousand reads, while the data never changed and every assertion still passed.
 *
 * Nothing surfaced until the heap reached `--max-memory`, at which point the
 * allocator got a null, `handle_alloc_error` aborted, and the module trapped on
 * a bare `unreachable` with no panic message and no recovery short of a reload.
 * That reached production, and reproducing it took days precisely because
 * correctness tests cannot see it: memory is not an output.
 *
 * So this is the guard. It drives the demo — the same wasm engine, in the page,
 * no Matrix client, no worker, no network — so nothing here depends on timing
 * or a server, and asserts the heap is flat once the workspace has settled.
 *
 * If it fails, suspect a global allocator or a retention cycle, and do NOT
 * "fix" it by raising the ceiling: that turns a fast crash into a slow one.
 */
import { test, expect, type Page } from '@playwright/test'

/**
 * Each switch re-materializes a table through the wasm bridge — `getTableRows`,
 * `getTableSchema`, the view config — so it is several real reads. At the
 * wee_alloc rate this many switches leaked several MiB, two orders of magnitude
 * above the tolerance below.
 */
const SWITCHES = 60

/** A correct allocator grows by nothing here. Allow a couple of 64 KiB wasm
 *  pages so a rounded-up growth request cannot flake the suite. */
const SLACK_BYTES = 128 * 1024

declare global {
  interface Window {
    __twWasmHeapBytes?: () => number | null
  }
}

async function heapBytes(page: Page): Promise<number> {
  const bytes = await page.evaluate(() => window.__twWasmHeapBytes?.() ?? null)
  expect(bytes, 'wasm heap probe missing — did ui/src/wasm/loader.ts change?').not.toBeNull()
  return bytes as number
}

test('the wasm heap does not grow across repeated table reads', async ({ page }) => {
  test.setTimeout(600_000)

  await page.goto('/demo')
  await expect(page.getByText('A sample workspace')).toBeVisible({ timeout: 60_000 })

  const projects = page.locator('.sidebar__item-label', { hasText: /^Projects$/ })
  const contacts = page.locator('.sidebar__item-label', { hasText: /^Contacts$/ })
  await expect(projects).toBeVisible({ timeout: 60_000 })
  await expect(contacts).toBeVisible({ timeout: 60_000 })

  // Settle: the heap legitimately grows while the workspace is built and first
  // rendered. Steady-state repetition is what must not grow.
  await projects.click()
  await expect(page.getByText('Sketch landing page hero')).toBeVisible({ timeout: 60_000 })
  await contacts.click()
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1500)

  const before = await heapBytes(page)

  for (let i = 0; i < SWITCHES; i++) {
    await (i % 2 === 0 ? projects : contacts).click()
    // Waiting on a row proves the table actually re-rendered, so the loop
    // cannot pass by doing nothing — the failure this guard exists to catch
    // would otherwise be indistinguishable from a no-op.
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 })
  }

  const after = await heapBytes(page)
  const grew = after - before

  expect(
    grew,
    `wasm heap grew ${(grew / 1024 / 1024).toFixed(2)} MiB over ${SWITCHES} table switches ` +
      `(${before} -> ${after} bytes). Suspect a global allocator that does not reuse freed ` +
      `memory, or a retention cycle. Do NOT raise --max-memory to hide it.`,
  ).toBeLessThanOrEqual(SLACK_BYTES)
})
