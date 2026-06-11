/**
 * Singleton WASM module loader.
 *
 * Ensures the WASM binary is initialized exactly once, even when
 * multiple hooks (useAuth, useWorkspace) request it concurrently.
 * Calling wasm-bindgen's init function (`default()`) more than once
 * corrupts internal state and causes "index out of bounds" crashes.
 */

let wasmModulePromise: Promise<any> | null = null

export async function getWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      const mod = await import('./generated/app_core.js')
      await mod.default()
      mod.init_panic_hook()
      return mod
    })()
  }
  return wasmModulePromise
}

/** Reset the cached module (used on sign-out to allow clean re-init). */
export function resetWasmModule() {
  wasmModulePromise = null
}
