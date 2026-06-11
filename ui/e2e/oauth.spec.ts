import { test, expect } from '@playwright/test'

/**
 * ADR 0002 phase A spike: OAuth 2.0 (next-gen auth) login from the real WASM
 * client against a throwaway Synapse+MAS stack.
 *
 * Only runs when scripts/spike-synapse-mas.sh --e2e provides the stack via
 * E2E_SYNAPSE_URL (+ a pre-registered MAS user via E2E_MAS_USER/PASSWORD) —
 * the normal Conduit-based suite is unaffected.
 *
 * Flow under test (the popup architecture the product will use):
 *  1. main page: startOauthLogin() → dynamic client registration with MAS →
 *     authorization URL (PKCE verifier stays in the WASM client's memory)
 *  2. "popup" (second page): MAS hosted login → consent → redirect to the
 *     app's callback URL carrying code+state
 *  3. main page: finishOauthLogin(redirectedUrl) → token exchange → session
 *  4. sessionData() → restore() round-trip (OAuth session persistence)
 */

const SYNAPSE_URL = process.env.E2E_SYNAPSE_URL
const MAS_USER = process.env.E2E_MAS_USER ?? 'spikeuser'
const MAS_PASSWORD = process.env.E2E_MAS_PASSWORD ?? 'spike-password-123!'

test.skip(!SYNAPSE_URL, 'requires the Synapse+MAS spike stack (E2E_SYNAPSE_URL)')

test('OAuth login via MAS: authorize in popup, finish in app, restore session', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const context = await browser.newContext()
  const app = await context.newPage()

  // Load the app origin so the WASM module can be imported.
  await app.goto('/signin')

  // 1. Start the OAuth flow in the app page; keep the module handle alive.
  const authUrl = await app.evaluate(async (synapseUrl) => {
    const { getWasmModule } = await import('/src/wasm/loader.ts')
    const mod = await getWasmModule()
    ;(window as any).__mod = mod
    return await mod.MatrixSession.startOauthLogin(
      synapseUrl,
      `${window.location.origin}/oauth/callback`,
    )
  }, SYNAPSE_URL)
  expect(authUrl).toContain('/authorize')

  // 2. Drive MAS's hosted pages in a second page (stand-in for the popup).
  const popup = await context.newPage()
  const redirectPromise = popup.waitForRequest(
    (req) => req.url().includes('/oauth/callback'),
    { timeout: 120_000 },
  )
  await popup.goto(authUrl)

  // MAS login form (hosted UI).
  await popup.getByLabel(/username/i).fill(MAS_USER)
  await popup.getByLabel(/password/i).fill(MAS_PASSWORD)
  await popup.getByRole('button', { name: /continue|sign in|log in/i }).click()

  // Consent screen for the dynamically-registered client, if MAS shows one.
  const consent = popup.getByRole('button', { name: /continue|allow|approve/i })
  try {
    await consent.click({ timeout: 15_000 })
  } catch {
    /* no consent step configured — fine */
  }

  const redirectedUrl = (await redirectPromise).url()
  expect(redirectedUrl).toContain('code=')

  // 3. Finish the login on the SAME WASM client instance in the app page.
  const sessionBlob = await app.evaluate(async (url) => {
    const mod = (window as any).__mod
    const session = await mod.MatrixSession.finishOauthLogin(url)
    return session.sessionData() as string
  }, redirectedUrl)

  const session = JSON.parse(sessionBlob)
  expect(session.kind).toBe('oauth')
  expect(session.userId).toBe(`@${MAS_USER}:localhost`)
  expect(session.accessToken).toBeTruthy()
  expect(session.clientId).toBeTruthy()
  expect(session.storeName).toBeTruthy()

  // 4. The persisted blob restores into a working session (fresh client,
  //    same store) — the OAuth equivalent of the password restore path.
  const restoredUserId = await app.evaluate(
    async ({ synapseUrl, blob }) => {
      const mod = (window as any).__mod
      const restored = await mod.MatrixSession.restore(synapseUrl, blob)
      return restored.userId() as string
    },
    { synapseUrl: SYNAPSE_URL, blob: sessionBlob },
  )
  expect(restoredUserId).toBe(`@${MAS_USER}:localhost`)

  await context.close()
})
