import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A self-hosted build must not advertise our homeserver.
 *
 * The sign-in page used to list "TideWork — the official hosted server"
 * unconditionally, which meant an operator hosting the app for their own team
 * was serving a page that offered a stranger's service above their own — and
 * some of their users would have taken it.
 *
 * `branding.ts` reads `import.meta.env` at module load, so each case needs the
 * env stubbed and the module re-imported.
 */
async function loadBranding(env: Record<string, string | undefined>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '')
    else vi.stubEnv(k, v)
  }
  return await import('./branding')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('build identity', () => {
  it('the build we host knows it is the official one', async () => {
    const b = await loadBranding({ VITE_DEFAULT_HOMESERVER: 'https://matrix.tidework.io' })
    expect(b.IS_OFFICIAL_BUILD).toBe(true)
    expect(b.DEFAULT_HOMESERVER_LABEL).toBe('TideWork')
  })

  it('a self-hosted build is not the official one, and is labelled by its host', async () => {
    const b = await loadBranding({ VITE_DEFAULT_HOMESERVER: 'https://matrix.acme.example' })
    expect(b.IS_OFFICIAL_BUILD).toBe(false)
    expect(b.DEFAULT_HOMESERVER_LABEL).toBe('matrix.acme.example')
    // The whole point: their build must not point at us.
    expect(b.DEFAULT_HOMESERVER_URL).not.toBe(b.OFFICIAL_HOMESERVER_URL)
  })

  it('honours an explicit label', async () => {
    const b = await loadBranding({
      VITE_DEFAULT_HOMESERVER: 'https://matrix.acme.example',
      VITE_HOMESERVER_LABEL: 'Acme Internal',
    })
    expect(b.DEFAULT_HOMESERVER_LABEL).toBe('Acme Internal')
  })

  it('treats a blank setting as unset rather than as an empty server', async () => {
    // `VITE_DEFAULT_HOMESERVER=` with nothing after it is easy to leave in a
    // .env, and an empty string is not nullish — a naive `??` would offer a
    // server with no address.
    const b = await loadBranding({ VITE_DEFAULT_HOMESERVER: undefined })
    expect(b.DEFAULT_HOMESERVER_URL).toBe('http://localhost:8008')
    expect(b.IS_OFFICIAL_BUILD).toBe(false)
  })
})
