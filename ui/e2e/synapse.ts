import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

/** A running throwaway Synapse homeserver. */
export interface SynapseHandle {
  url: string
  stop: () => void
}

/** Bind to port 0 to find a free TCP port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Start a local Synapse homeserver on a free port with a temp SQLite store and
 * open (password) registration — the same homeserver prod runs. Unlike Conduit
 * (the old harness), Synapse includes the inviter in the invite's stripped
 * state, so MSC4268 pre-join history-on-invite works: a collaborator can decrypt
 * content created before they were invited. Mirrors the Synapse config in
 * `crates/app-core/tests/harness.rs`. Requires `synapse_homeserver` on PATH
 * (provided by the Nix dev shell).
 *
 * Rate limits are relaxed (1000/1000) for test speed — prod defaults are far
 * stricter (see the rate-limit-divergence note in harness.rs).
 */
export async function startSynapse(): Promise<SynapseHandle> {
  const port = await freePort()
  const url = `http://localhost:${port}`
  const dataDir = mkdtempSync(join(tmpdir(), 'synapse-e2e-'))
  const configPath = join(dataDir, 'homeserver.yaml')
  const logConfigPath = join(dataDir, 'log.config')

  writeFileSync(
    logConfigPath,
    `version: 1
formatters:
  precise:
    format: '%(asctime)s %(levelname)s %(name)s - %(message)s'
handlers:
  file:
    class: logging.handlers.RotatingFileHandler
    formatter: precise
    filename: ${join(dataDir, 'homeserver.log')}
    maxBytes: 10485760
    backupCount: 1
    encoding: utf8
root:
  level: WARNING
  handlers: [file]
disable_existing_loggers: false
`,
  )

  writeFileSync(
    configPath,
    `server_name: "localhost"
pid_file: ${join(dataDir, 'homeserver.pid')}
public_baseurl: "${url}/"
listeners:
  - port: ${port}
    type: http
    tls: false
    bind_addresses: ['127.0.0.1']
    x_forwarded: false
    resources:
      - names: [client]
        compress: false
database:
  name: sqlite3
  args:
    database: ${join(dataDir, 'homeserver.db')}
log_config: "${logConfigPath}"
media_store_path: ${join(dataDir, 'media_store')}
signing_key_path: "${join(dataDir, 'signing.key')}"
trusted_key_servers: []
suppress_key_server_warning: true
report_stats: false
enable_registration: true
enable_registration_without_verification: true
registration_requires_token: false
macaroon_secret_key: "test_macaroon_secret_key_do_not_use_in_prod"
form_secret: "test_form_secret_do_not_use_in_prod"
presence:
  enabled: false
rc_message:
  per_second: 1000
  burst_count: 1000
rc_registration:
  per_second: 1000
  burst_count: 1000
rc_login:
  address:
    per_second: 1000
    burst_count: 1000
  account:
    per_second: 1000
    burst_count: 1000
  failed_attempts:
    per_second: 1000
    burst_count: 1000
rc_joins:
  local:
    per_second: 1000
    burst_count: 1000
  remote:
    per_second: 1000
    burst_count: 1000
rc_invites:
  per_room:
    per_second: 1000
    burst_count: 1000
  per_user:
    per_second: 1000
    burst_count: 1000
`,
  )

  // Generate the signing key (blocking) before starting the server.
  const keygen = spawnSync(
    'synapse_homeserver',
    ['--config-path', configPath, '--generate-keys'],
    { stdio: 'ignore' },
  )
  if (keygen.error || keygen.status !== 0) {
    rmSync(dataDir, { recursive: true, force: true })
    throw new Error(
      `synapse_homeserver --generate-keys failed (is matrix-synapse on PATH? run inside the Nix shell): ${
        keygen.error ?? `exit ${keygen.status}`
      }`,
    )
  }

  let proc: ChildProcess
  try {
    proc = spawn('synapse_homeserver', ['--config-path', configPath], { stdio: 'ignore' })
  } catch (err) {
    rmSync(dataDir, { recursive: true, force: true })
    throw new Error(
      `Failed to start synapse_homeserver (is it on PATH? run inside the Nix shell): ${err}`,
    )
  }

  const stop = () => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  // Synapse runs DB schema migrations on first start — slower than Conduit.
  // 600 * 100ms = 60s.
  for (let i = 0; i < 600; i++) {
    try {
      const res = await fetch(`${url}/_matrix/client/versions`)
      if (res.ok) return { url, stop }
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100))
  }

  stop()
  throw new Error(`Synapse did not become ready on ${url} within 60s (see ${dataDir}/homeserver.log)`)
}
