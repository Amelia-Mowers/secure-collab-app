import { test, expect, type Page } from '@playwright/test'
import {
  homeserverUrl,
  registerDevice,
  signInDevice,
  captureMasterKey,
  uniqueUser,
  createWorkspace,
  createTable,
  addColumn,
} from './helpers'

/**
 * Multi-step journeys the other specs don't reach (issue 8d854a6e).
 *
 * `core.spec.ts` already covers onboarding, columns of each type, sort/filter,
 * view creation and switching; `collaboration.spec.ts` covers invite/accept and
 * propagation; `resource-crud.spec.ts` covers rename/delete of each resource.
 * What was left uncovered — and is covered here — is the pair where the UI can
 * look correct while nothing was actually written:
 *
 *  1. Dragging a kanban card, which is a CELL WRITE disguised as a layout
 *     change. Local state moves the card whether or not the write landed.
 *  2. Signing out and back in on the SAME device, which is not the same as
 *     `recovery.spec.ts`'s second device: here the local store is one a
 *     previous session left behind (cf. issue f6901da6).
 *
 * Both assertions are therefore after a round trip, not after the interaction.
 */

/** Drag a kanban card onto another column.
 *
 *  dnd-kit's PointerSensor needs a real gesture: press, a small nudge to pass
 *  activation, then a stepped move so the collision detector sees intermediate
 *  positions. Playwright's one-shot `dragTo` doesn't produce those and the drop
 *  silently no-ops — the same reason core.spec.ts hand-rolls its row drag. */
async function dragCardToColumn(page: Page, cardText: string, columnTitle: string) {
  const card = page.locator('.kcard', { hasText: cardText }).first()
  const column = page.locator('.kcol', { has: page.locator('.kcol__title', { hasText: columnTitle }) })
  const drop = column.locator('.kcol__drop-area')

  const from = await card.boundingBox()
  const to = await drop.boundingBox()
  if (!from || !to) throw new Error(`missing bounding box for drag: ${cardText} → ${columnTitle}`)

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(40, to.height / 2), { steps: 12 })
  await page.mouse.up()
}

/** The cards currently rendered under a column heading. */
function columnCards(page: Page, columnTitle: string) {
  return page
    .locator('.kcol', { has: page.locator('.kcol__title', { hasText: columnTitle }) })
    .locator('.kcard')
}

test('kanban: dragging a card writes the group-by cell, and it survives a reload', async ({
  page,
}) => {
  test.setTimeout(420_000)

  await registerDevice(page, homeserverUrl(), uniqueUser('kdrag'))
  await captureMasterKey(page)
  await createWorkspace(page, 'Kanban Drag')
  await createTable(page, 'Work')
  await addColumn(page, 'Status', 'Select', 'Todo, Doing, Done')

  // Both entries start in Todo — set explicitly rather than relying on the
  // select's read-time default, so the starting board is unambiguous.
  await test.step('seed two entries in Todo', async () => {
    for (const title of ['Write the spec', 'Ship the thing']) {
      await page.getByRole('button', { name: 'New entry' }).click()
      await expect(page.getByRole('heading', { name: 'New Entry' })).toBeVisible({ timeout: 30_000 })
      await page.getByPlaceholder('Enter name').fill(title)
      await page.getByPlaceholder('Enter name').press('Enter')
      await page.locator('select.cell-input--select').selectOption('Todo')
      await page.getByRole('button', { name: 'Return' }).click()
      await expect(page.locator('tbody tr', { hasText: title })).toBeVisible({ timeout: 30_000 })
    }
  })

  await test.step('create a board grouped by Status', async () => {
    await page.getByRole('button', { name: 'New view' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('My View').fill('Board')
    // Kanban is the default view type; pick the group/title axes, which are
    // explicit view settings and never inferred.
    await dialog
      .locator('.nvm__form-group', { hasText: 'Group by column' })
      .locator('select')
      .selectOption({ label: 'Status' })
    await dialog
      .locator('.nvm__form-group', { hasText: 'Card title column' })
      .locator('select')
      .selectOption({ label: 'Name' })
    await dialog.getByRole('button', { name: 'Create view' }).click()
    await expect(dialog).toBeHidden({ timeout: 60_000 })
    await expect(page).toHaveURL(/\/view\//, { timeout: 60_000 })
  })

  await expect(columnCards(page, 'Todo')).toHaveCount(2, { timeout: 60_000 })

  await test.step('drag one card from Todo to Doing', async () => {
    await dragCardToColumn(page, 'Ship the thing', 'Doing')
    // Optimistic: the card moves immediately whether or not the write landed.
    await expect(columnCards(page, 'Doing')).toHaveCount(1, { timeout: 30_000 })
    await expect(columnCards(page, 'Todo')).toHaveCount(1)
  })

  // The load-bearing assertion. A drag that only re-rendered locally is
  // indistinguishable from a real one until the state is rebuilt from the
  // room timeline.
  await test.step('the move survives a reload', async () => {
    await page.reload()
    await expect(columnCards(page, 'Doing')).toHaveCount(1, { timeout: 120_000 })
    await expect(columnCards(page, 'Doing').first()).toContainText('Ship the thing')
    await expect(columnCards(page, 'Todo')).toHaveCount(1)
    await expect(columnCards(page, 'Todo').first()).toContainText('Write the spec')
  })
})

test('sign out and back in on the same device: the workspace and its data return', async ({
  page,
}) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  const user = uniqueUser('signout')
  await registerDevice(page, url, user)
  const masterKey = await captureMasterKey(page)

  await createWorkspace(page, 'Round Trip')
  await createTable(page, 'Notes')
  await test.step('write one row', async () => {
    await page.getByRole('button', { name: 'New entry' }).click()
    await expect(page.getByRole('heading', { name: 'New Entry' })).toBeVisible({ timeout: 30_000 })
    await page.getByPlaceholder('Enter name').fill('Survives sign-out')
    await page.getByPlaceholder('Enter name').press('Enter')
    await page.getByRole('button', { name: 'Return' }).click()
    await expect(page.locator('tbody tr', { hasText: 'Survives sign-out' })).toBeVisible({
      timeout: 30_000,
    })
  })

  await test.step('sign out', async () => {
    await page.locator('.account-switcher__trigger').click()
    await page.locator('.account-switcher__item-remove').first().click()
    await expect(page).toHaveURL(/signin/, { timeout: 60_000 })
  })

  // Signing back in is a NEW device to the homeserver — same browser, but the
  // session and device id are gone — so the verify gate applies exactly as it
  // would on another machine.
  await test.step('sign back in and restore', async () => {
    await signInDevice(page, url, user)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: /verify this device/i })).toBeVisible({
      timeout: 90_000,
    })
    await dialog.locator('.verify__input').fill(masterKey)
    await dialog.getByRole('button', { name: /^restore$/i }).click()
    await expect(dialog).toBeHidden({ timeout: 120_000 })
  })

  await test.step('the workspace and its row are back', async () => {
    await expect(page.getByText('Round Trip')).toBeVisible({ timeout: 120_000 })
    await page.getByText('Round Trip').click()
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 90_000 })
    await page.locator('.sidebar__item-label', { hasText: /^Notes$/ }).click()
    await expect(page.locator('tbody tr', { hasText: 'Survives sign-out' })).toBeVisible({
      timeout: 120_000,
    })
  })
})
