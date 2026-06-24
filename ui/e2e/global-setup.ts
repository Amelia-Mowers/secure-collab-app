import { startSynapse } from './synapse'

/**
 * Boot one Synapse homeserver for the whole run and publish its URL via
 * `E2E_HOMESERVER` (inherited by worker processes). Synapse is what prod runs,
 * so the two-browser suite exercises real behaviour — notably MSC4268 pre-join
 * history-on-invite, which Conduit (the old harness) did not support. The
 * returned function tears it down after all tests.
 */
export default async function globalSetup() {
  const synapse = await startSynapse()
  process.env.E2E_HOMESERVER = synapse.url
  // eslint-disable-next-line no-console
  console.log(`[e2e] Synapse ready at ${synapse.url}`)
  return async () => {
    synapse.stop()
  }
}
