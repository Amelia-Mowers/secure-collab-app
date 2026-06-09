import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

/** A running throwaway Conduit homeserver. */
export interface ConduitHandle {
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
 * Start a local Conduit homeserver on a free port with a temp RocksDB store and
 * open registration — mirroring `crates/tables-over-matrix/tests/harness.rs`.
 * Requires the `conduit` binary on PATH (provided by the Nix dev shell).
 */
export async function startConduit(): Promise<ConduitHandle> {
  const port = await freePort()
  const dataDir = mkdtempSync(join(tmpdir(), 'conduit-e2e-'))
  const configPath = join(dataDir, 'conduit.toml')
  const dbPath = join(dataDir, 'db')

  writeFileSync(
    configPath,
    `[global]
server_name = "localhost"
database_backend = "rocksdb"
database_path = "${dbPath}"
port = ${port}
address = "127.0.0.1"
max_request_size = 20_000_000
allow_registration = true
allow_federation = false
trusted_servers = ["matrix.org"]
log = "warn"
`,
  )

  let proc: ChildProcess
  try {
    proc = spawn('conduit', [], {
      env: { ...process.env, CONDUIT_CONFIG: configPath },
      stdio: 'ignore',
    })
  } catch (err) {
    rmSync(dataDir, { recursive: true, force: true })
    throw new Error(`Failed to start Conduit (is it on PATH? run inside the Nix shell): ${err}`)
  }

  const url = `http://localhost:${port}`
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

  // Wait for the homeserver to answer (up to ~30s).
  for (let i = 0; i < 300; i++) {
    try {
      const res = await fetch(`${url}/_matrix/client/versions`)
      if (res.ok) return { url, stop }
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100))
  }

  stop()
  throw new Error(`Conduit did not become ready on ${url} within 30s`)
}
