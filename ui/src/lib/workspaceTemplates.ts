import { getWasmModule } from '../wasm/loader'

/**
 * Shipped workspace templates (issue row_1785004738121).
 *
 * A template is just a CSV archive (ADR 0004) checked into `src/templates/`.
 * That is the whole point of the format: adding a template means adding a
 * directory of CSVs that anyone can read in a spreadsheet and review in a pull
 * request, not editing a TypeScript literal in the app bundle.
 *
 * The files are inlined at build time, so a template can't fail to load at
 * runtime the way a fetched manifest can.
 */

const RAW = import.meta.glob('../templates/**/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Replaced with the creating user's MXID: a template can seed a member column
 *  without knowing who will use it. Deliberately not `@me` — that is the
 *  filter sentinel, which resolves per *viewer*; this resolves once, at
 *  creation, to an actual MXID stored in the cell. */
export const SELF_TOKEN = '@@self'

export interface WorkspaceTemplate {
  slug: string
  /** Display name, read from the archive's own `workspace.csv`. */
  name: string
  description: string
  tables: Array<{ id: string; name: string; rows: number }>
  files: Record<string, string>
}

/** Group the globbed files by their template directory. */
function collect(): Map<string, Record<string, string>> {
  const bySlug = new Map<string, Record<string, string>>()
  for (const [path, contents] of Object.entries(RAW)) {
    const m = /\/templates\/([^/]+)\/(.+)$/.exec(path)
    if (!m) continue
    const [, slug, rel] = m
    const files = bySlug.get(slug) ?? {}
    files[rel] = contents
    bySlug.set(slug, files)
  }
  return bySlug
}

/** The template whose slug is `demo` backs the "Demo workspace" card. */
export const DEMO_SLUG = 'demo'

let cache: Promise<WorkspaceTemplate[]> | null = null

/**
 * Load every shipped template with its name and description.
 *
 * The metadata is read by the same Rust parser that reads the archive on
 * import, rather than by a second small reader here — a format with two
 * readers eventually has two behaviours.
 */
export function loadWorkspaceTemplates(): Promise<WorkspaceTemplate[]> {
  cache ??= (async () => {
    const wasm: any = await getWasmModule()
    const out: WorkspaceTemplate[] = []
    for (const [slug, files] of collect()) {
      try {
        const info = JSON.parse(wasm.ConnectedWorkspace.describeArchive(JSON.stringify(files)))
        out.push({
          slug,
          name: info.name || slug,
          description: info.description ?? '',
          tables: info.tables ?? [],
          files,
        })
      } catch (err) {
        // A broken template must not take the dialogue down with it; the
        // Rust-side test over these same directories is what keeps it from
        // shipping broken in the first place.
        console.error(`Skipping malformed template "${slug}":`, err)
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  })()
  return cache
}

/** Substitute per-user tokens, then hand the archive to the bridge. */
export function templateFiles(
  template: WorkspaceTemplate,
  selfUserId?: string,
): Record<string, string> {
  if (!selfUserId) {
    // No MXID to seed with: drop the token rather than writing "@@self" into a
    // member column as if it were a user.
    return mapValues(template.files, text => text.split(SELF_TOKEN).join(''))
  }
  return mapValues(template.files, text => text.split(SELF_TOKEN).join(selfUserId))
}

function mapValues(obj: Record<string, string>, fn: (v: string) => string) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]))
}
