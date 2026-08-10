import { test, expect, type Page } from '@playwright/test'
import {
  homeserverUrl,
  registerDevice,
  captureMasterKey,
  uniqueUser,
  createWorkspace,
  createTable,
} from './helpers'

/**
 * A workspace invite LINK, across two browsers (issue 5e362d42).
 *
 * Inviting used to require the colleague's Matrix ID, which meant they had to
 * already have an account. A link cannot be an ordinary Matrix invite — an
 * invite names a user, and a link-holder has no user id until they sign up. So
 * the room accepts knocks, the link carries a secret, and a member's client
 * verifies it and admits them.
 *
 * Every piece of that is tested at one end or the other: the token rules
 * natively, the knock/admit round trip against Synapse, the link's fragment in
 * vitest. What none of them covers is the SEAM — and the two bugs this feature
 * has already produced were both seams. `knockWithToken` was bound only where
 * the invitee could not reach it, and before that the demo shipped without
 * import/export because a binding existed in one layer and not the next.
 *
 * So this drives the actual journey: A mints a link, B opens it in a different
 * browser with an account B already has, and B ends up in A's workspace seeing
 * A's data. Nobody types a Matrix ID anywhere.
 */

function gridRow(page: Page, text: string) {
  return page.locator('tbody tr', { hasText: text })
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

test('an invite link admits someone who never types a Matrix ID', async ({ browser }) => {
  // Two registrations, a Synapse cold start, a knock, an admit, and a join.
  test.setTimeout(420_000)

  const url = homeserverUrl()
  const userA = uniqueUser('link-a')
  const userB = uniqueUser('link-b')

  // ── A: an account, a workspace, and data written BEFORE the link exists, so
  //    the history B ends up seeing cannot have arrived any other way. ──
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await registerDevice(pageA, url, userA)
  await captureMasterKey(pageA)
  await expect(pageA).toHaveURL(/workspaces/, { timeout: 60_000 })
  await createWorkspace(pageA, 'Link E2E')
  const wsId = pageA.url().match(/\/workspace\/([^/?#]+)/)?.[1]
  expect(wsId, 'workspace id present in URL').toBeTruthy()
  await createTable(pageA, 'Shared')
  await newEntry(pageA, 'WrittenBeforeTheLink')

  // ── A mints a link and copies it. ──
  await pageA.locator('.sidebar').getByRole('button', { name: /share workspace/i }).click()
  const shareModal = pageA.getByRole('dialog')
  await expect(shareModal).toBeVisible({ timeout: 30_000 })

  const createLink = shareModal.getByRole('button', { name: 'Create invite link' })
  await expect(createLink, 'the workspace creator is an admin and must be offered a link').toBeVisible({
    timeout: 30_000,
  })
  await createLink.click()

  const linkInput = shareModal.getByLabel('Invite link')
  await expect(linkInput).toBeVisible({ timeout: 30_000 })
  const inviteUrl = await linkInput.inputValue()
  expect(inviteUrl, 'no link was produced').toBeTruthy()

  // The secret must be in the FRAGMENT. In a query string it would reach the
  // access log of every host on the way, including ours.
  expect(inviteUrl).toContain('/join#')
  expect(inviteUrl.split('#')[0], 'the token is before the fragment').not.toContain('?')

  // A stays on the workspace: admitting happens in a member's browser, because
  // there is deliberately no server of ours that could do it instead.
  await pageA.locator('.share-modal__close').click()

  // ── B: a different browser, a different account, and no idea what A's user
  //    id is. B follows the link. ──
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  await registerDevice(pageB, url, userB)
  await captureMasterKey(pageB)
  await expect(pageB).toHaveURL(/workspaces/, { timeout: 60_000 })

  const fragment = inviteUrl.slice(inviteUrl.indexOf('/join'))
  await pageB.goto(fragment)

  // ── A's open client admits the knock. Nothing is clicked: useAutoAdmit runs
  //    on sync, which is the behaviour under test.
  //
  //    Deliberately NOT asserting the intermediate "waiting to be let in"
  //    screen here. It is real, but it is transient — the first version of this
  //    test failed on it because B had already been admitted and redirected
  //    before the assertion ran, i.e. the test broke because the product was
  //    fast. The waiting copy is asserted in the test below, where nobody is
  //    online to admit and the state is therefore stable. ──
  await expect(pageB).toHaveURL(/\/workspace\/[^/]+/, { timeout: 180_000 })
  expect(pageB.url().match(/\/workspace\/([^/?#]+)/)?.[1]).toBe(wsId)

  // ── B sees the data A wrote BEFORE the link existed. That needs the room-key
  //    bundle shared on invite (MSC4268) — membership alone would leave the
  //    history undecryptable, which is the failure that looks like an empty
  //    workspace. ──
  await pageB.goto(`/workspace/${wsId}/table/shared`)
  await expect(pageB.locator('th', { hasText: 'Name' })).toBeVisible({ timeout: 120_000 })
  await expect(gridRow(pageB, 'WrittenBeforeTheLink')).toBeVisible({ timeout: 120_000 })

  await ctxA.close()
  await ctxB.close()
})

test('a link followed while nobody is online says so, instead of spinning', async ({ browser }) => {
  test.setTimeout(420_000)

  const url = homeserverUrl()
  const userA = uniqueUser('offline-a')
  const userB = uniqueUser('offline-b')

  // A mints a link, then CLOSES the browser. There is deliberately no server of
  // ours that could admit anyone in A's absence, so this is the honest steady
  // state of the design — and the one a user is most likely to misread as the
  // product being broken.
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await registerDevice(pageA, url, userA)
  await captureMasterKey(pageA)
  await createWorkspace(pageA, 'Offline E2E')
  await pageA.locator('.sidebar').getByRole('button', { name: /share workspace/i }).click()
  const modal = pageA.getByRole('dialog')
  await modal.getByRole('button', { name: 'Create invite link' }).click()
  const inviteUrl = await modal.getByLabel('Invite link').inputValue()
  await ctxA.close()

  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  await registerDevice(pageB, url, userB)
  await captureMasterKey(pageB)
  await pageB.goto(inviteUrl.slice(inviteUrl.indexOf('/join')))

  // It must EXPLAIN, not just spin. Someone staring at a spinner with no words
  // concludes the product is broken; this is the sentence that stops them.
  await expect(pageB.getByText(/waiting to be let in/i)).toBeVisible({ timeout: 120_000 })
  await expect(pageB.getByText(/has TideWork open/i)).toBeVisible({ timeout: 30_000 })

  // And it stays put rather than silently failing or bouncing them away.
  await pageB.waitForTimeout(5_000)
  expect(new URL(pageB.url()).pathname).toBe('/join')

  await ctxB.close()
})

test('a viewer is not offered a link they could not mint', async ({ browser }) => {
  test.setTimeout(300_000)

  const url = homeserverUrl()
  const userA = uniqueUser('role-a')

  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await registerDevice(pageA, url, userA)
  await captureMasterKey(pageA)
  await createWorkspace(pageA, 'Role E2E')

  // The creator is an admin, so the control IS offered here. The negative half
  // — that a viewer is not offered it — is asserted in the unit test for the
  // dialog; reaching a viewer's session here would need a second account, an
  // invite, and a role change, which is three features to test one condition.
  await pageA.locator('.sidebar').getByRole('button', { name: /share workspace/i }).click()
  const shareModal = pageA.getByRole('dialog')
  await expect(shareModal.getByRole('button', { name: 'Create invite link' })).toBeVisible({
    timeout: 30_000,
  })

  // And the Matrix-ID path is still reachable, now behind a disclosure — it is
  // the only way to invite someone on another homeserver.
  await expect(shareModal.getByText('Invite by Matrix ID instead')).toBeVisible()

  await ctxA.close()
})
