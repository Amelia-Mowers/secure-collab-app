import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FieldRenderer } from './FieldRenderer'

// Helper to build a column definition quickly
const col = (overrides: Partial<{
  id: string; name: string; column_type: string;
  required: boolean; options: string[]; reference_table: string
}> = {}) => ({
  id: 'field',
  name: 'My Field',
  column_type: 'text',
  required: false,
  ...overrides,
})

describe('FieldRenderer', () => {
  describe('text field', () => {
    it('renders a text input', () => {
      render(<FieldRenderer column={col()} value="hello" onChange={vi.fn()} />)
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('displays the current value', () => {
      render(<FieldRenderer column={col()} value="initial text" onChange={vi.fn()} />)
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('initial text')
    })

    it('calls onChange with the new value on blur after change', () => {
      const onChange = vi.fn()
      render(<FieldRenderer column={col()} value="old" onChange={onChange} />)
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'new value' } })
      fireEvent.blur(input)
      expect(onChange).toHaveBeenCalledWith('new value')
    })

    it('does not call onChange on blur when value did not change', () => {
      const onChange = vi.fn()
      render(<FieldRenderer column={col()} value="same" onChange={onChange} />)
      fireEvent.blur(screen.getByRole('textbox'))
      expect(onChange).not.toHaveBeenCalled()
    })

    it('handles empty string values', () => {
      render(<FieldRenderer column={col()} value="" onChange={vi.fn()} />)
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
    })

    it('handles very long strings', () => {
      const longString = 'a'.repeat(5000)
      render(<FieldRenderer column={col()} value={longString} onChange={vi.fn()} />)
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(longString)
    })

    it('handles unicode and emoji values', () => {
      render(<FieldRenderer column={col()} value="Hello 世界 🌍" onChange={vi.fn()} />)
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Hello 世界 🌍')
    })
  })

  describe('number field', () => {
    it('renders a number input', () => {
      render(<FieldRenderer column={col({ column_type: 'number' })} value={42} onChange={vi.fn()} />)
      expect(screen.getByRole('spinbutton')).toBeInTheDocument()
    })

    it('displays the current number value', () => {
      render(<FieldRenderer column={col({ column_type: 'number' })} value={99} onChange={vi.fn()} />)
      expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('99')
    })

    it('handles zero', () => {
      render(<FieldRenderer column={col({ column_type: 'number' })} value={0} onChange={vi.fn()} />)
      expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('0')
    })

    it('handles negative numbers', () => {
      render(<FieldRenderer column={col({ column_type: 'number' })} value={-100} onChange={vi.fn()} />)
      expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('-100')
    })
  })

  describe('boolean (checkbox) field', () => {
    it('renders a checkbox', () => {
      render(<FieldRenderer column={col({ column_type: 'boolean' })} value={false} onChange={vi.fn()} />)
      expect(screen.getByRole('checkbox')).toBeInTheDocument()
    })

    it('is unchecked when value is false', () => {
      render(<FieldRenderer column={col({ column_type: 'boolean' })} value={false} onChange={vi.fn()} />)
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    })

    it('is checked when value is true', () => {
      render(<FieldRenderer column={col({ column_type: 'boolean' })} value={true} onChange={vi.fn()} />)
      expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    })

    it('calls onChange immediately when toggled', () => {
      const onChange = vi.fn()
      render(<FieldRenderer column={col({ column_type: 'boolean' })} value={false} onChange={onChange} />)
      fireEvent.click(screen.getByRole('checkbox'))
      expect(onChange).toHaveBeenCalledWith(true)
    })

    it('does not show a separate label (the checkbox label IS the field name)', () => {
      render(<FieldRenderer column={col({ name: 'Done', column_type: 'boolean' })} value={false} onChange={vi.fn()} />)
      // The label wraps the checkbox – no extra .field-label element
      expect(screen.queryByText('*')).not.toBeInTheDocument()
    })
  })

  describe('date field', () => {
    it('renders a date input', () => {
      render(<FieldRenderer column={col({ column_type: 'date' })} value="2026-03-10" onChange={vi.fn()} />)
      const input = document.querySelector('input[type="date"]')
      expect(input).toBeInTheDocument()
    })

    it('displays the current date value', () => {
      render(<FieldRenderer column={col({ column_type: 'date' })} value="2026-03-10" onChange={vi.fn()} />)
      const input = document.querySelector('input[type="date"]') as HTMLInputElement
      expect(input.value).toBe('2026-03-10')
    })
  })

  describe('select field', () => {
    it('renders a select element', () => {
      render(
        <FieldRenderer
          column={col({ column_type: 'select', options: ['Todo', 'In Progress', 'Done'] })}
          value="Todo"
          onChange={vi.fn()}
        />
      )
      expect(screen.getByRole('combobox')).toBeInTheDocument()
    })

    it('shows all options including the blank prompt', () => {
      render(
        <FieldRenderer
          column={col({ name: 'Status', column_type: 'select', options: ['Todo', 'In Progress', 'Done'] })}
          value=""
          onChange={vi.fn()}
        />
      )
      expect(screen.getByText('Select Status...')).toBeInTheDocument()
      expect(screen.getByText('Todo')).toBeInTheDocument()
      expect(screen.getByText('In Progress')).toBeInTheDocument()
      expect(screen.getByText('Done')).toBeInTheDocument()
    })

    it('reflects the selected value', () => {
      render(
        <FieldRenderer
          column={col({ column_type: 'select', options: ['Todo', 'In Progress', 'Done'] })}
          value="In Progress"
          onChange={vi.fn()}
        />
      )
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('In Progress')
    })

    it('calls onChange immediately when an option is selected', () => {
      const onChange = vi.fn()
      render(
        <FieldRenderer
          column={col({ column_type: 'select', options: ['Todo', 'In Progress', 'Done'] })}
          value=""
          onChange={onChange}
        />
      )
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Done' } })
      expect(onChange).toHaveBeenCalledWith('Done')
    })

    it('renders an empty select when options list is empty', () => {
      render(
        <FieldRenderer
          column={col({ column_type: 'select', options: [] })}
          value=""
          onChange={vi.fn()}
        />
      )
      const select = screen.getByRole('combobox') as HTMLSelectElement
      // Only the blank prompt option
      expect(select.options).toHaveLength(1)
    })
  })

  describe('required field indicator', () => {
    it('shows a * indicator for required fields', () => {
      render(<FieldRenderer column={col({ required: true })} value="" onChange={vi.fn()} />)
      expect(screen.getByText('*')).toBeInTheDocument()
    })

    it('does not show * for optional fields', () => {
      render(<FieldRenderer column={col({ required: false })} value="" onChange={vi.fn()} />)
      expect(screen.queryByText('*')).not.toBeInTheDocument()
    })
  })

  describe('document field', () => {
    it('renders the MarkdownEditor for document columns', () => {
      render(<FieldRenderer column={col({ column_type: 'document' })} value="# Hello" onChange={vi.fn()} />)
      // MarkdownEditor always shows Preview / Edit button
      expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()
    })
  })

  describe('json field', () => {
    it('renders a textarea for JSON columns', () => {
      render(<FieldRenderer column={col({ column_type: 'json' })} value={{}} onChange={vi.fn()} />)
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('pretty-prints JSON objects in the textarea', () => {
      render(
        <FieldRenderer
          column={col({ column_type: 'json' })}
          value={{ key: 'value', num: 42 }}
          onChange={vi.fn()}
        />
      )
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      expect(textarea.value).toContain('"key"')
      expect(textarea.value).toContain('"value"')
    })
  })

  describe('unknown field type', () => {
    it('falls back to a text input for unrecognised column types', () => {
      render(
        <FieldRenderer
          column={col({ column_type: 'custom_future_type' as any })}
          value="fallback"
          onChange={vi.fn()}
        />
      )
      expect(screen.getByRole('textbox')).toBeInTheDocument()
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('fallback')
    })
  })
})
