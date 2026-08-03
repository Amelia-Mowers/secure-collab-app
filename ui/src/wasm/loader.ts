/**
 * Singleton WASM module loader.
 *
 * Ensures the WASM binary is initialized exactly once, even when
 * multiple hooks (useAuth, useWorkspace) request it concurrently.
 * Calling wasm-bindgen's init function (`default()`) more than once
 * corrupts internal state and causes "index out of bounds" crashes.
 */

let wasmModulePromise: Promise<any> | null = null
let linearMemory: WebAssembly.Memory | null = null

export async function getWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const mod = await import('./generated/app_core.js')
      const out = await mod.default()
      linearMemory = out?.memory ?? null
      mod.init_panic_hook()
      return mod
    })()
  }
  return wasmModulePromise
}

/**
 * How much linear memory the module currently holds, in MiB — or null before it
 * has loaded.
 *
 * This exists to tell two very different failures apart. A Rust panic and a
 * failed ALLOCATION both surface in JS as the same opaque
 * `RuntimeError: unreachable executed`, but only the panic prints a message and
 * a source location: the wasm allocation-error handler traps directly, so
 * `console_error_panic_hook` never runs and there is nothing to read. A
 * production report of exactly that shape — no message, unchanged by switching
 * the release profile to `panic = "unwind"`, and only ever on real workspaces
 * rather than the small ones every test builds — fits the second far better
 * than the first. Reporting the heap size at the moment of the trap decides it,
 * from the machine it happens on, without needing a reproduction.
 */
export function wasmHeapMiB(): number | null {
  if (!linearMemory) return null
  return Math.round(linearMemory.buffer.byteLength / (1024 * 1024))
}

/** Reset the cached module (used on sign-out to allow clean re-init). */
export function resetWasmModule() {
  wasmModulePromise = null
  linearMemory = null
}
