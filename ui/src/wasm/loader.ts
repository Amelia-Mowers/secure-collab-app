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
 * The module's linear-memory ceiling, in MiB — the `--max-memory` link argument
 * in `.cargo/config.toml`. Duplicated here because a wasm memory does not
 * expose its declared maximum to JS, and the number is worth nothing to a bug
 * report unless the reading can be compared to it.
 *
 * KEEP IN STEP with that link argument. Being wrong here is not dangerous — it
 * only mislabels a diagnostic — but a stale value would misdirect exactly the
 * kind of investigation this exists to shorten.
 */
const WASM_MAX_HEAP_MIB = 2048

/**
 * How much linear memory the module holds, and how close that is to the cap —
 * or null before it has loaded.
 *
 * This exists because a Rust panic and a failed ALLOCATION both surface in JS
 * as the same opaque `RuntimeError: unreachable executed`, and only the panic
 * prints a message and a source location. When `memory.grow` refuses, the
 * allocator gets null and `handle_alloc_error` aborts — an abort is not a
 * panic, so `console_error_panic_hook` never runs and there is nothing at all
 * to read.
 *
 * That is not hypothetical: it was the production crash. The heap came back as
 * exactly 128 MiB, exactly the `--max-memory` of the day, which is what finally
 * identified it after a week of theories that a small test workspace could
 * never have distinguished. The cap is 2 GiB now, but the failure mode survives
 * the fix — so the reading says how near the ceiling it is, and a report that
 * says "at the ceiling" needs no further diagnosis.
 */
export function wasmHeapMiB(): string | null {
  if (!linearMemory) return null
  const mib = Math.round(linearMemory.buffer.byteLength / (1024 * 1024))
  const pct = Math.round((mib / WASM_MAX_HEAP_MIB) * 100)
  const verdict = pct >= 99 ? ' — AT THE CEILING, this is out of memory' : ''
  return `${mib} of ${WASM_MAX_HEAP_MIB} MiB (${pct}%)${verdict}`
}

/** Reset the cached module (used on sign-out to allow clean re-init). */
export function resetWasmModule() {
  wasmModulePromise = null
  linearMemory = null
}
