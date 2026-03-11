/**
 * Pure utility functions for Kanban board logic.
 * Kept separate so they can be unit-tested without a DOM or React.
 */

export interface KanbanCard {
  id: string
  title: string
  [key: string]: any
}

export interface KanbanColumn {
  id: string
  title: string
  cards: KanbanCard[]
}

/**
 * Resolve the target column ID from a dnd-kit drag-end event.
 *
 * dnd-kit's `over.id` can be either:
 *   - A **column** ID (the status/group value, e.g. "In Progress")
 *   - A **card** ID (the row's `_row_id`, e.g. "row_1234_abc") when the
 *     pointer lands on top of another card rather than the column background.
 *
 * In the second case we look up which column owns that card and return the
 * column's ID, preventing the card's group-by cell from being overwritten
 * with a raw row ID.
 *
 * @param overId   The `String(over.id)` value from the drag-end event.
 * @param columns  The current list of Kanban columns.
 * @returns The resolved column ID, or `null` if it cannot be determined.
 */
export function resolveTargetColumn(
  overId: string,
  columns: KanbanColumn[]
): string | null {
  // 1. Direct match: over.id is a column id
  const isColumn = columns.some(col => col.id === overId)
  if (isColumn) return overId

  // 2. over.id is a card id – find the column that contains it
  for (const col of columns) {
    if (col.cards.some(card => card.id === overId)) {
      return col.id
    }
  }

  // 3. Could not resolve
  return null
}
