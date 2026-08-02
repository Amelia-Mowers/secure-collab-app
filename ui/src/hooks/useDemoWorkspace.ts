import { useEffect, useRef, useState } from 'react'
import { getWasmModule } from '@/wasm/loader'
import { loadWorkspaceTemplates, templateFiles } from '@/lib/workspaceTemplates'

/** The workspace id the demo mounts under. It is a real path segment, so the
 *  views' hardcoded `/workspace/${id}/...` links all resolve without a single
 *  one of them learning that the demo exists. */
export const DEMO_WORKSPACE_ID = 'demo'

/** Which shipped template the demo shows. The demo archive is the only one
 *  carrying actual row data, which is the entire point of a demo. */
const DEMO_TEMPLATE_SLUG = 'demo'

/**
 * A local-only workspace, seeded from a template, with no account and no
 * Matrix session.
 *
 * `WasmWorkspace` already satisfies every REQUIRED member of the handle the
 * views consume — the session-dependent extras (members, roles, sync,
 * integrity, export) are optional and feature-detected at each call site, so
 * the same TableView / Sidebar / Kanban render against it unchanged. That is
 * what makes a demo cheap: it is the real product with one dependency removed,
 * not a second implementation to keep in step.
 *
 * Memory-only, deliberately. Nothing is written anywhere, so a reload re-seeds
 * from the template rather than restoring — which is also the honest behaviour
 * for something that is explicitly not an account.
 */
export function useDemoWorkspace() {
  const [workspace, setWorkspace] = useState<any>(null)
  const [error, setError] = useState<Error | null>(null)
  // Local mutations have no sync loop to bump `syncCount`, but the Sidebar
  // re-reads on it — so the demo supplies its own counter and bumps it when
  // the schema changes underneath.
  const [changeCount, setChangeCount] = useState(0)
  const startedRef = useRef(false)

  useEffect(() => {
    // StrictMode double-invokes effects in development; seeding twice would
    // duplicate every row, so this runs exactly once per mount.
    //
    // Deliberately NO `cancelled` flag alongside it. The obvious pairing —
    // guard on a ref, cancel in the cleanup — is broken under StrictMode: the
    // first pass sets the flag, its cleanup cancels, and the second pass
    // returns early on the ref, so nothing ever sets state and the demo hangs
    // on its spinner forever. (It did.) There is nothing to leak here anyway:
    // no subscription, no request, just a local object.
    if (startedRef.current) return
    startedRef.current = true

    void (async () => {
      try {
        const wasm = await getWasmModule()
        const ws = new wasm.WasmWorkspace(DEMO_WORKSPACE_ID)
        const templates = await loadWorkspaceTemplates()
        const template = templates.find(t => t.slug === DEMO_TEMPLATE_SLUG) ?? templates[0]
        if (!template) throw new Error('No demo template is bundled in this build.')

        // Pass the local identity so `@@self` substitutes to a real-looking
        // user. Without it the seeded tasks arrive unassigned and the
        // "My Board" view — filtered to `@me` — renders empty, losing the two
        // things the demo most needs to show.
        const files = templateFiles(template, ws.currentUserId())
        ws.importWorkspaceArchive(JSON.stringify(files))

        setWorkspace(ws)
        setChangeCount(c => c + 1)
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  }, [])

  return {
    workspace,
    error,
    changeCount,
    /** Call after a schema-shaped change so the sidebar re-reads. */
    noteChanged: () => setChangeCount(c => c + 1),
  }
}
