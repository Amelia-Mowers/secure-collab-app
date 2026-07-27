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
import { createDispatcher } from './dispatch'
import type { Event, Message, Request } from './protocol'

/** The bit of `SharedWorkerGlobalScope` this file uses. Declared locally rather
 *  than by switching the project to the `webworker` lib, which would pull DOM
 *  types out from under the rest of `src`. */
interface SharedWorkerScope {
  onconnect: ((event: MessageEvent) => void) | null
}
declare const self: SharedWorkerScope

/** Every connected tab. There is no reliable "port closed" signal, so ports are
 *  pruned when a tab says goodbye or when posting to it throws. */
const ports = new Set<MessagePort>()

function broadcast(event: Event) {
  for (const port of [...ports]) {
    try {
      port.postMessage(event satisfies Message)
    } catch {
      ports.delete(port) // the tab is gone
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
  ports.add(port)

  port.onmessage = async (messageEvent: MessageEvent<Request>) => {
    const req = messageEvent.data
    if (req?.kind === 'bye') {
      ports.delete(port)
      return
    }
    const response = await dispatcher.handle(req)
    if (!response) return
    try {
      port.postMessage(response satisfies Message)
    } catch {
      // The tab vanished mid-request. Nothing to report to, and the worker's
      // state is unaffected — the session and workspace it built stay open for
      // whichever tab asks next.
      ports.delete(port)
    }
  }

  port.start()
}
