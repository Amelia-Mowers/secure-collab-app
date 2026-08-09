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
 * Drag with intermediate mouse positions — a one-shot `dragTo` silently no-ops
 * against dnd-kit (same reason kanban-two-tabs.spec.ts hand-rolls this).
 *
 * Aimed at the column's CARD AREA, not its header. The droppable is the
 * cards container; dropping on the title lands outside it, and dnd-kit simply
 * returns the card to where it came from — a no-op that looks like a drag.
 */
async function dragCardToColumn(page: Page, cardText: string, columnTitle: string) {
  const card = page.locator('.kcard__title', { hasText: cardText }).first()
  const target = columnBody(page, columnTitle)
  const from = await card.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error(`missing bounding box for drag: ${cardText} → ${columnTitle}`)

  const fx = from.x + from.width / 2
  const fy = from.y + from.height / 2
  const tx = to.x + to.width / 2
  const ty = to.y + 40

  await page.mouse.move(fx, fy)
  await page.mouse.down()
  // A small first movement to cross dnd-kit's activation distance, then the
  // real path in steps so its collision detection sees the target on the way.
  await page.mouse.move(fx + 8, fy + 8, { steps: 2 })
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(fx + ((tx - fx) * i) / 10, fy + ((ty - fy) * i) / 10, { steps: 3 })
  }
  await page.mouse.move(tx, ty, { steps: 3 })
  // Settle before releasing. Without this the drop fires in the same frame as
  // the last move, dnd-kit has not yet registered the column as `over`, and it
  // returns the card to where it started — a no-op that looks exactly like a
  // drag. That silence is what made the first version of this guard pass while
  // moving nothing.
  await page.waitForTimeout(150)
  await page.mouse.up()
  // And settle after the drop. A move writes the group-by cell plus an `_order`
  // per neighbour and then refreshes; starting the next drag mid-refresh has
  // the board re-render under the pointer and the drag is lost. This guard is
  // about memory, not about how fast the board can be hammered — drag
  // robustness is kanban-two-tabs.spec.ts's job.
  await page.waitForTimeout(400)
}

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
  // Logged, not just asserted: a number in the CI output is how a slow drift
  // gets noticed before it reaches the threshold.
  console.log(`[heap] ${SWITCHES} table reads: ${before} -> ${after} (${grew} bytes)`)

  expect(
    grew,
    `wasm heap grew ${(grew / 1024 / 1024).toFixed(2)} MiB over ${SWITCHES} table switches ` +
      `(${before} -> ${after} bytes). Suspect a global allocator that does not reuse freed ` +
      `memory, or a retention cycle. Do NOT raise --max-memory to hide it.`,
  ).toBeLessThanOrEqual(SLACK_BYTES)
})

/**
 * The same guard, for the operation that actually crashed production.
 *
 * The reported bug (issue f7f0d967) was a kanban card move, and the measurement
 * that explained it (issue c666312c) put the cost at ~0.85 MiB of permanent
 * heap PER DRAG on a five-row board — about a hundred moves to exhaust the old
 * 128 MiB ceiling, which is one session of board work.
 *
 * The test above covers reads. A drag is a different path and a heavier one:
 * `getRowOrderKeys` over every row, a group-by cell write, N `_order` writes
 * from `computeReorderWrites`, then a refresh that re-reads the whole table.
 * Reads being flat says nothing about it, so closing those issues on the read
 * guard alone would have been closing them on an assumption.
 */
const DRAGS = 24

/** A column, located by its header title. */
function kanbanColumn(page: Page, columnTitle: string) {
  return page
    .locator('.kcol')
    .filter({ has: page.locator('.kcol__title', { hasText: new RegExp(`^${columnTitle}$`) }) })
}

/** The droppable area of a column — `.kcol__drop-area` is the element dnd-kit
 *  registers via `useDroppable`, so it is the only place a drop counts. The
 *  inner `.kcol__cards` collapses to nothing when a column is empty, which is
 *  precisely when a drop needs to land. */
function columnBody(page: Page, columnTitle: string) {
  return kanbanColumn(page, columnTitle).locator('.kcol__drop-area')
}

/** The named card, scoped to the column it should be sitting in. */
function cardInColumn(page: Page, columnTitle: string, cardText: string) {
  return kanbanColumn(page, columnTitle).locator('.kcard__title', { hasText: cardText })
}

test('the wasm heap does not grow across repeated kanban card moves', async ({ page }) => {
  test.setTimeout(600_000)

  const pageErrors: string[] = []
  page.on('pageerror', e => pageErrors.push(String(e)))

  await page.goto('/demo')
  const board = page.locator('.sidebar__item-label', { hasText: /^Board$/ })
  await expect(board).toBeVisible({ timeout: 60_000 })
  await board.click()

  // A card to move, and the two columns to move it between.
  await expect(
    page.getByText('Sketch landing page hero', { exact: true }).first(),
  ).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('In Progress', { exact: true }).first()).toBeVisible()

  // Settle: building and first-rendering the board legitimately allocates.
  await dragCardToColumn(page, 'Sketch landing page hero', 'In Progress')
  await page.waitForTimeout(1500)

  const before = await heapBytes(page)

  for (let i = 0; i < DRAGS; i++) {
    const target = i % 2 === 0 ? 'Done' : 'In Progress'
    await dragCardToColumn(page, 'Sketch landing page hero', target)
    // Assert the card is now IN the target column, not merely still on screen.
    // "Visible" is true whether or not the drop landed, and a drag that
    // silently no-ops allocates nothing — which would make this guard pass by
    // doing nothing, exactly the failure it exists to catch.
    await expect(
      cardInColumn(page, target, 'Sketch landing page hero'),
      `drag ${i + 1} did not land in ${target}`,
    ).toBeVisible({ timeout: 30_000 })
  }

  const after = await heapBytes(page)
  const grew = after - before
  console.log(`[heap] ${DRAGS} card moves: ${before} -> ${after} (${grew} bytes)`)

  // At the rate that crashed production this would be ~20 MiB.
  expect(
    grew,
    `wasm heap grew ${(grew / 1024 / 1024).toFixed(2)} MiB over ${DRAGS} card moves ` +
      `(${before} -> ${after} bytes). This is the shape of the crash in issue f7f0d967. ` +
      `Do NOT raise --max-memory to hide it.`,
  ).toBeLessThanOrEqual(SLACK_BYTES)

  // The crash presented as a trap with no message, so a page error here is the
  // original bug reappearing rather than an incidental warning.
  expect(pageErrors, `page errors during card moves:\n${pageErrors.join('\n')}`).toEqual([])
})
