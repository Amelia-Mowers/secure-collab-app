import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CellEditor, CellDisplay, type CellColumn } from './cellRegistry'

const col = (overrides: Partial<CellColumn> = {}): CellColumn => ({
  id: 'field',
  name: 'My Field',
  column_type: 'text',
  ...overrides,
})

describe('cellRegistry', () => {
  describe('CellEditor — commit semantics', () => {
    it('text commits once on blur (not per keystroke)', () => {
      const commit = vi.fn()
      render(<CellEditor column={col()} value="old" commit={commit} />)
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'new' } })
      expect(commit).not.toHaveBeenCalled()
      fireEvent.blur(input)
      expect(commit).toHaveBeenCalledTimes(1)
      expect(commit).toHaveBeenCalledWith('new')
    })

    it('text does not commit on blur when unchanged', () => {
      const commit = vi.fn()
      render(<CellEditor column={col()} value="same" commit={commit} />)
      fireEvent.blur(screen.getByRole('textbox'))
      expect(commit).not.toHaveBeenCalled()
    })

    it('boolean commits immediately on toggle', () => {
      const commit = vi.fn()
      render(<CellEditor column={col({ column_type: 'boolean' })} value={false} commit={commit} />)
      fireEvent.click(screen.getByRole('checkbox'))
      expect(commit).toHaveBeenCalledWith(true)
    })

    it('number commits a parsed number on blur', () => {
      const commit = vi.fn()
      render(<CellEditor column={col({ column_type: 'number' })} value={1} commit={commit} />)
      const input = screen.getByRole('spinbutton')
      fireEvent.change(input, { target: { value: '42' } })
      fireEvent.blur(input)
      expect(commit).toHaveBeenCalledWith(42)
    })
  })

  describe('CellEditor — multiselect tag input', () => {
    const tagsCol = col({ id: 'tags', name: 'Tags', column_type: 'multiselect' })

    it('renders existing values as tags', () => {
      render(<CellEditor column={tagsCol} value={['urgent', 'bug']} commit={vi.fn()} />)
      expect(screen.getByText('urgent')).toBeInTheDocument()
      expect(screen.getByText('bug')).toBeInTheDocument()
    })

    it('adds a tag on Enter', () => {
      const commit = vi.fn()
      render(<CellEditor column={tagsCol} value={['urgent']} commit={commit} />)
      const input = screen.getByPlaceholderText('Add…')
      fireEvent.change(input, { target: { value: 'bug' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(commit).toHaveBeenCalledWith(['urgent', 'bug'])
    })

    it('does not add a duplicate tag', () => {
      const commit = vi.fn()
      render(<CellEditor column={tagsCol} value={['urgent']} commit={commit} />)
      const input = screen.getByPlaceholderText('Add…')
      fireEvent.change(input, { target: { value: 'urgent' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(commit).not.toHaveBeenCalled()
    })

    it('removes a tag via its remove button', () => {
      const commit = vi.fn()
      render(<CellEditor column={tagsCol} value={['urgent', 'bug']} commit={commit} />)
      fireEvent.click(screen.getByLabelText('Remove urgent'))
      expect(commit).toHaveBeenCalledWith(['bug'])
    })
  })

  describe('CellEditor — reference', () => {
    const refCol = col({ id: 'project', name: 'Project', column_type: 'reference', reference_table: 'projects' })
    const lookup = () => [
      { id: 'p1', label: 'Apollo' },
      { id: 'p2', label: 'Zephyr' },
    ]

    it('renders a record dropdown from the lookup and commits the chosen id', () => {
      const commit = vi.fn()
      render(<CellEditor column={refCol} value="" commit={commit} lookup={lookup} />)
      expect(screen.getByText('Apollo')).toBeInTheDocument()
      expect(screen.getByText('Zephyr')).toBeInTheDocument()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p2' } })
      expect(commit).toHaveBeenCalledWith('p2')
    })

    it('falls back to a text input when no lookup is provided', () => {
      render(<CellEditor column={refCol} value="p1" commit={vi.fn()} />)
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })
  })

  describe('CellEditor — document', () => {
    const docCol = col({ id: 'notes', name: 'Notes', column_type: 'document' })

    it('renders a floating popover (not inline) when popover is set', () => {
      render(<CellEditor column={docCol} value="" commit={vi.fn()} popover />)
      expect(document.querySelector('.doc-popover')).toBeInTheDocument()
      expect(screen.getByText('Done')).toBeInTheDocument()
    })

    it('binds to a draft so input accumulates, and commits the value on Done', () => {
      // Regression guard for the "only one character sticks" bug: the editor
      // must bind the Markdown textarea to its own draft, not the static
      // upstream value.
      const commit = vi.fn()
      const onDone = vi.fn()
      render(<CellEditor column={docCol} value="" commit={commit} onDone={onDone} popover />)
      const textarea = screen.getByPlaceholderText(/Start writing/i) as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Hello world' } })
      expect(textarea.value).toBe('Hello world')
      fireEvent.click(screen.getByText('Done'))
      expect(commit).toHaveBeenCalledWith('Hello world')
      expect(onDone).toHaveBeenCalled()
    })

    it('edits inline (no popover) for the entry/detail view', () => {
      render(<CellEditor column={docCol} value="x" commit={vi.fn()} />)
      expect(document.querySelector('.doc-popover')).not.toBeInTheDocument()
      expect(screen.getByPlaceholderText(/Start writing/i)).toBeInTheDocument()
    })
  })

  describe('CellDisplay', () => {
    it('renders a boolean check only when true', () => {
      const { rerender, container } = render(<CellDisplay column={col({ column_type: 'boolean' })} value={true} />)
      expect(container.textContent).toContain('✓')
      rerender(<CellDisplay column={col({ column_type: 'boolean' })} value={false} />)
      expect(container.textContent).not.toContain('✓')
    })

    it('renders multiselect values as tags', () => {
      render(<CellDisplay column={col({ column_type: 'multiselect' })} value={['a', 'b']} />)
      expect(screen.getByText('a')).toBeInTheDocument()
      expect(screen.getByText('b')).toBeInTheDocument()
    })

    it('renders a reference label resolved via the lookup', () => {
      const lookup = () => [{ id: 'p1', label: 'Apollo' }]
      render(
        <CellDisplay
          column={col({ column_type: 'reference', reference_table: 'projects' })}
          value="p1"
          lookup={lookup}
        />,
      )
      expect(screen.getByText('Apollo')).toBeInTheDocument()
    })
  })
})
