/**
 * Starter table templates offered when creating a table (#3). "Blank" preserves
 * the original single-column behaviour; the rest seed a few common schemas.
 * Columns are listed in display order and carry an explicit `order` so the grid
 * shows them as authored (the core otherwise orders columns by id).
 */
export interface TemplateColumn {
  id: string
  name: string
  column_type: string
  required?: boolean
  options?: string[]
  default_value?: unknown
}

export interface TableTemplate {
  id: string
  label: string
  description: string
  columns: TemplateColumn[]
}

export const TABLE_TEMPLATES: TableTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    description: 'Just a Name column to start from scratch.',
    columns: [{ id: 'name', name: 'Name', column_type: 'text' }],
  },
  {
    id: 'project',
    label: 'Project tracker',
    description: 'Tasks with status, assignee, due date, and priority.',
    columns: [
      { id: 'title', name: 'Title', column_type: 'text' },
      { id: 'status', name: 'Status', column_type: 'select', options: ['Todo', 'In Progress', 'Done'], default_value: 'Todo' },
      { id: 'assignee', name: 'Assignee', column_type: 'member' },
      { id: 'due_date', name: 'Due date', column_type: 'date' },
      { id: 'priority', name: 'Priority', column_type: 'select', options: ['Low', 'Medium', 'High'] },
    ],
  },
  {
    id: 'contacts',
    label: 'Contacts / CRM',
    description: 'People or leads with company, status, and notes.',
    columns: [
      { id: 'name', name: 'Name', column_type: 'text' },
      { id: 'email', name: 'Email', column_type: 'text' },
      { id: 'company', name: 'Company', column_type: 'text' },
      { id: 'status', name: 'Status', column_type: 'select', options: ['Lead', 'Active', 'Closed'], default_value: 'Lead' },
      { id: 'notes', name: 'Notes', column_type: 'document' },
    ],
  },
  {
    id: 'content',
    label: 'Content calendar',
    description: 'Plan content by status, channel, and publish date.',
    columns: [
      { id: 'title', name: 'Title', column_type: 'text' },
      { id: 'status', name: 'Status', column_type: 'select', options: ['Idea', 'Draft', 'Scheduled', 'Published'], default_value: 'Idea' },
      { id: 'channel', name: 'Channel', column_type: 'select', options: ['Blog', 'Social', 'Email', 'Video'] },
      { id: 'publish_date', name: 'Publish date', column_type: 'date' },
      { id: 'owner', name: 'Owner', column_type: 'text' },
    ],
  },
]

/** Build a createTable JSON definition from a template + name. */
export function buildTableDefinition(tableId: string, name: string, template: TableTemplate) {
  const columns: Record<string, unknown> = {}
  template.columns.forEach((col, idx) => {
    columns[col.id] = {
      id: col.id,
      name: col.name,
      column_type: col.column_type,
      required: col.required ?? false,
      order: idx,
      ...(col.options ? { options: col.options } : {}),
      ...(col.default_value !== undefined ? { default_value: col.default_value } : {}),
    }
  })
  return { id: tableId, name, columns }
}
