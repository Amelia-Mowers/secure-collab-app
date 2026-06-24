import { test, expect, type Page } from '@playwright/test'
import { homeserverUrl, registerDevice, captureMasterKey, uniqueUser } from './helpers'

/**
 * Two-user collaboration end to end (issue c3db652c) against a real **Synapse**
 * homeserver — the same one prod runs (ui/e2e/synapse.ts). Two DISTINCT accounts
 * in two isolated browser contexts.
 *
 * A creates a workspace + table + rows, THEN invites B. Because Synapse supports
 * MSC4268 history-on-invite and the bridge shares the room-key bundle on invite,
 * B sees A's PRE-JOIN content after joining — the prod behaviour Conduit could
 * not exercise. We then assert the member list, live A→B and B→A propagation,
 * and same-cell LWW convergence.
 */

const SERVER_NAME = 'localhost' // matches ui/e2e/synapse.ts

function gridRow(page: Page, text: string) {
  return page.locator('tbody tr', { hasText: text })
}

async function createWorkspace(page: Page, name: string) {
  await page.locator('.workspace-card--new').click()
  await page.getByPlaceholder('Workspace name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 90_000 })
  await expect(page.getByRole('button', { name: 'New table' })).toBeVisible({ timeout: 90_000 })
}

async function createTable(page: Page, name: string) {
  await page.getByRole('button', { name: 'New table' }).click()
  const input = page.getByPlaceholder('Table name...')
  await input.fill(name)
  await input.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/table/${name.toLowerCase()}`), { timeout: 90_000 })
}

/** Create a row via the entry view, filling only the default "Name" column. */
async function newEntry(page: Page, name: string) {
  await page.getByRole('button', { name: 'New entry' }).click()
  await expect(page.getByRole('heading', { name: 'New Entry' })).toBeVisible({ timeout: 30_000 })
  await page.getByPlaceholder('Enter name').fill(name)
  await page.getByPlaceholder('Enter name').press('Enter')
  await page.getByRole('button', { name: 'Return' }).click()
  await expect(gridRow(page, name)).toBeVisible({ timeout: 30_000 })
}

/** Inline-edit a row's Name cell from `fromText` to `toText` (mirror core.spec). */
async function inlineEditName(page: Page, fromText: string, toText: string) {
  await gridRow(page, fromText).locator('.cell-click', { hasText: fromText }).click()
  const editor = page.locator('input.cell-input[type="text"]')
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await editor.fill(toText)
  await editor.press('Enter')
  await expect(gridRow(page, toText)).toBeVisible({ timeout: 30_000 })
}

test('two users: pre-join history, invite/join, member list, real-time propagation, LWW', async ({
  browser,
}) => {
  // Two registrations + Synapse cold start + invite/join + synced round-trips.
  test.setTimeout(420_000)

  const url = homeserverUrl()
  const userA = uniqueUser('collab-a')
  const userB = uniqueUser('collab-b')
  const userBId = `@${userB}:${SERVER_NAME}`

  // ── A: register (captureMasterKey bootstraps cross-signing, needed so the
  //    MSC4268 room-key bundle is shared on invite) + create a workspace, table,
  //    and rows — ALL BEFORE inviting B. ──
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await registerDevice(pageA, url, userA)
  await captureMasterKey(pageA)
  await expect(pageA).toHaveURL(/workspaces/, { timeout: 60_000 })
  await createWorkspace(pageA, 'Collab E2E')
  const wsId = pageA.url().match(/\/workspace\/([^/?#]+)/)?.[1]
  expect(wsId, 'workspace id present in URL').toBeTruthy()
  await createTable(pageA, 'Shared')
  await newEntry(pageA, 'Alpha')
  await newEntry(pageA, 'Bravo')

  // ── B: register a separate account in its own context. ──
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  await registerDevice(pageB, url, userB)
  await captureMasterKey(pageB)
  await expect(pageB).toHaveURL(/workspaces/, { timeout: 60_000 })

  // ── A invites B by Matrix id (Sidebar → Share workspace). The bridge shares
  //    the room-key bundle so B can decrypt A's pre-join history. ──
  await pageA.locator('.sidebar').getByRole('button', { name: /share workspace/i }).click()
  const shareModal = pageA.getByRole('dialog')
  await shareModal.getByPlaceholder('@user:server').fill(userBId)
  await shareModal.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(shareModal.getByText(`Invited ${userBId}`)).toBeVisible({ timeout: 30_000 })

  // ── B sees the invitation and accepts (no auto-join). Reload to force a fresh
  //    listInvitedRooms in case session-sync hasn't surfaced it yet. ──
  await pageB.reload()
  const acceptBtn = pageB
    .locator('.invitation-card', { hasText: 'Collab E2E' })
    .getByRole('button', { name: /accept|joining/i })
  await expect(acceptBtn).toBeVisible({ timeout: 60_000 })
  await acceptBtn.click()
  await expect(pageB).toHaveURL(/\/workspace\/[^/]+/, { timeout: 90_000 })
  expect(pageB.url().match(/\/workspace\/([^/?#]+)/)?.[1]).toBe(wsId)

  // ── PRE-JOIN HISTORY: B sees the table + rows A created BEFORE the invite.
  //    Generous timeout: room-key bundle import + cold-start history gather. ──
  await pageB.goto(`/workspace/${wsId}/table/shared`)
  await expect(pageB.locator('th', { hasText: 'Name' })).toBeVisible({ timeout: 90_000 })
  await expect(gridRow(pageB, 'Alpha')).toBeVisible({ timeout: 90_000 })
  await expect(gridRow(pageB, 'Bravo')).toBeVisible({ timeout: 90_000 })

  // ── Member list shows both, on each side. Sidebar loads members on mount (not
  //    sync-reactive), so reload A after B has joined. ──
  await pageA.reload()
  await expect(pageA.locator('.sidebar__member-count')).toHaveText('2', { timeout: 60_000 })
  await expect(pageB.locator('.sidebar__member-count')).toHaveText('2', { timeout: 60_000 })

  // A's reload may land on the workspace home — make sure A is on the table.
  await pageA.goto(`/workspace/${wsId}/table/shared`)
  await expect(pageA.locator('th', { hasText: 'Name' })).toBeVisible({ timeout: 30_000 })

  // ── Real-time A → B ──
  await newEntry(pageA, 'Charlie')
  await expect(gridRow(pageB, 'Charlie')).toBeVisible({ timeout: 30_000 })

  // ── Real-time B → A ──
  await newEntry(pageB, 'Delta')
  await expect(gridRow(pageA, 'Delta')).toBeVisible({ timeout: 30_000 })

  // ── Concurrent same-cell LWW: A edits Alpha's name; B (after seeing it) edits
  //    the same cell; the later write wins and BOTH sides converge to it. ──
  await inlineEditName(pageA, 'Alpha', 'Alpha-A')
  await expect(gridRow(pageB, 'Alpha-A')).toBeVisible({ timeout: 30_000 })
  await inlineEditName(pageB, 'Alpha-A', 'Alpha-B')

  // Convergence: both show the winning value; the superseded value is gone on both.
  await expect(gridRow(pageA, 'Alpha-B')).toBeVisible({ timeout: 30_000 })
  await expect(gridRow(pageB, 'Alpha-B')).toBeVisible({ timeout: 30_000 })
  await expect(gridRow(pageA, 'Alpha-A')).toHaveCount(0, { timeout: 30_000 })
  await expect(gridRow(pageB, 'Alpha-A')).toHaveCount(0, { timeout: 30_000 })

  await ctxA.close()
  await ctxB.close()
})
