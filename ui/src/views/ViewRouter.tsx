import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { KanbanView } from './kanban/KanbanView'
import { TableView } from './table/TableView'
import { CardView } from './card/CardView'

interface ViewRouterProps {
  workspace: any
}

/**
 * Resolves a named view's type from the workspace and renders the appropriate
 * view component. This is the single entry-point for /table/:tableId/view/:viewId.
 *
 * Supported view_type values:
 *   - 'kanban'   → KanbanView
 *   - 'card'     → CardView (card grid)
 *   - 'table'    → TableView (spreadsheet, rare but valid)
 *   - everything else → KanbanView fallback
 */
export function ViewRouter({ workspace }: ViewRouterProps) {
  const { viewId } = useParams<{ viewId: string }>()
  const [viewType, setViewType] = useState<string | null>(null)

  useEffect(() => {
    if (!workspace || !viewId) return
    try {
      const config = JSON.parse(workspace.getView(viewId))
      setViewType(config.view_type ?? 'kanban')
    } catch {
      setViewType('kanban')
    }
  }, [workspace, viewId])

  if (viewType === null) {
    // Still resolving — don't flash the wrong component
    return null
  }

  if (viewType === 'card') {
    return <CardView workspace={workspace} />
  }

  if (viewType === 'table') {
    return <TableView workspace={workspace} />
  }

  // Default: kanban (covers 'kanban', 'calendar', 'tasklist', unknown)
  return <KanbanView workspace={workspace} />
}
