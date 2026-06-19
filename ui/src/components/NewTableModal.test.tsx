import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewTableModal } from './NewTableModal'
import { buildTableDefinition, TABLE_TEMPLATES } from '@/tableTemplates'

describe('buildTableDefinition', () => {
  it('builds ordered, typed columns from a template', () => {
    const project = TABLE_TEMPLATES.find(t => t.id === 'project')!
    const def = buildTableDefinition('proj', 'Proj', project)
    expect(def.id).toBe('proj')
    expect(def.name).toBe('Proj')
    const cols = def.columns as Record<string, any>
    expect(cols.status.column_type).toBe('select')
    expect(cols.status.options).toContain('In Progress')
    expect(cols.status.default_value).toBe('Todo')
    // Authored order is preserved (title first … priority last).
    expect(cols.title.order).toBe(0)
    expect(cols.priority.order).toBe(4)
  })
})

describe('NewTableModal', () => {
  it('creates with the chosen template', () => {
    const onCreate = vi.fn()
    render(<NewTableModal onCreate={onCreate} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Table name...'), { target: { value: 'Sprint' } })
    fireEvent.click(screen.getByText('Project tracker'))
    fireEvent.click(screen.getByText('Create table'))
    expect(onCreate).toHaveBeenCalledWith('Sprint', expect.objectContaining({ id: 'project' }))
  })

  it('defaults to the Blank template (preserving the original flow)', () => {
    const onCreate = vi.fn()
    render(<NewTableModal onCreate={onCreate} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Table name...'), { target: { value: 'Notes' } })
    fireEvent.click(screen.getByText('Create table'))
    expect(onCreate).toHaveBeenCalledWith('Notes', expect.objectContaining({ id: 'blank' }))
  })
})
