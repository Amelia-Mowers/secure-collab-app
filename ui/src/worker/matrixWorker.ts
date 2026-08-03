/**
 * SharedWorker entry point: the single owner of the Matrix client (issue
 * 87bf86a6). Every tab of every account talks to this one worker; the logic
 * lives in `dispatch.ts` so it stays unit-testable, and this file is only port
 * plumbing.
 *
 * Loaded as an ES-module worker (`new SharedWorker(url, { type: 'module' })`) —
 * wasm-bindgen's `--target web` glue resolves the `.wasm` through
 * `import.meta.url`, which a classic worker cannot do. Vite's
 * `worker.format: 'es'` config matches.
 */

import { getWasmModule } from '../wasm/loader'
import { createDispatcher, type Client } from './dispatch'
import type { Event, Message, Request } from './protocol'

/** The bit of `SharedWorkerGlobalScope` this file uses. Declared locally rather
 *  than by switching the project to the `webworker` lib, which would pull DOM
 *  types out from under the rest of `src`. */
interface SharedWorkerScope {
  onconnect: ((event: MessageEvent) => void) | null
}
declare const self: SharedWorkerScope

/** Every connected tab, port → the dispatcher's view of it. There is no reliable
 *  "port closed" signal, so tabs are pruned when one says goodbye or when posting
 *  to it throws. */
const clients = new Map<MessagePort, Client>()

function post(port: MessagePort, message: Message): boolean {
  try {
    port.postMessage(message)
    return true
  } catch {
    drop(port)
    return false
  }
}

function drop(port: MessagePort) {
  const client = clients.get(port)
  if (client) dispatcher.disconnect(client)
  clients.delete(port)
  // The browser may terminate this worker as soon as its last port is gone,
  // taking the send queue with it. Flush what has to survive.
  if (clients.size === 0) dispatcher.flushPersistence()
}

function broadcast(event: Event) {
  for (const port of [...clients.keys()]) post(port, event)
}

/**
 * Forward this worker's own console to every tab.
 *
 * `dispatch.ts` already reports what it CATCHES (`[worker] snapshot failed:
 * RuntimeError: unreachable executed`) — but a Rust panic's actual message and
 * source location are not in that error. They are printed separately, by
 * `console_error_panic_hook`, straight to this worker's console. Firefox does
 * not surface a SharedWorker's console in the tab, so a production bug report
 * arrives as the trap and nothing else: the one line that says WHERE never
 * leaves the machine it happened on. We spent a session on exactly that.
 *
 * Anything the module prints at warn/error goes over the same channel the
 * dispatcher's diagnostics use, so it lands in the page console — and in a
 * Playwright console listener, which is why the e2e panic assertions can see it
 * at all.
 */
function describe(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    original(...args)
    // Logging must never be the thing that kills the worker.
    try {
      broadcast({
        kind: 'event',
        event: 'log',
        level,
        message: `console.${level}: ${args.map(describe).join(' ')}`,
      })
    } catch {
      /* ignore */
    }
  }
}

// NOTE: nothing here may reference `__BUILD_ID__` or any other Vite `define`.
// Those replacements do not reach a worker module served by the dev server, and
// the resulting ReferenceError kills the worker before it can answer a single
// request — a silent failure, since a SharedWorker's console is not the tab's.
// The worker learns its build id from the first tab that pings it.
const dispatcher = createDispatcher({ loadWasm: getWasmModule, broadcast })

self.onconnect = (connectEvent: MessageEvent) => {
  const port = connectEvent.ports[0]
  const client: Client = { send: event => post(port, event) }
  clients.set(port, client)

  port.onmessage = async (messageEvent: MessageEvent<Request>) => {
    const req = messageEvent.data
    if (req?.kind === 'bye') {
      drop(port)
      return
    }
    const response = await dispatcher.handle(req, client)
    // A tab that vanished mid-request gets dropped by `post`. The worker's state
    // is unaffected: the session and workspace it built stay open for whichever
    // tab asks next.
    if (response) post(port, response)
  }

  port.start()
}
