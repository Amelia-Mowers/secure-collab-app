import { startConduit } from './conduit'

/**
 * Boot one Conduit homeserver for the whole run and publish its URL via
 * `E2E_HOMESERVER` (inherited by worker processes). The returned function tears
 * it down after all tests.
 */
export default async function globalSetup() {
  const conduit = await startConduit()
  process.env.E2E_HOMESERVER = conduit.url
  // eslint-disable-next-line no-console
  console.log(`[e2e] Conduit ready at ${conduit.url}`)
  return async () => {
    conduit.stop()
  }
}
