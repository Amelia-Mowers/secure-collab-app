import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AddColumnModal } from './AddColumnModal'

function renderModal(onAdd = vi.fn(), onClose = vi.fn()) {
  return render(<AddColumnModal onAdd={onAdd} onClose={onClose} />)
}

describe('AddColumnModal', () => {
  describe('rendering', () => {
    it('shows an "Add column" heading', () => {
      renderModal()
      // Both the h2 title and submit button contain "Add column" text
      const nodes = screen.getAllByText('Add column')
      expect(nodes.length).toBeGreaterThanOrEqual(1)
    })

    it('shows a column name input with placeholder "e.g. Priority"', () => {
      renderModal()
      expect(screen.getByPlaceholderText('e.g. Priority')).toBeInTheDocument()
    })

    it('shows all column type options', () => {
      renderModal()
      expect(screen.getByText('Text')).toBeInTheDocument()
      expect(screen.getByText('Number')).toBeInTheDocument()
      expect(screen.getByText('Select')).toBeInTheDocument()
      expect(screen.getByText('Multi-select')).toBeInTheDocument()
      expect(screen.getByText('Date')).toBeInTheDocument()
      expect(screen.getByText('Checkbox')).toBeInTheDocument()
      expect(screen.getByText('Document')).toBeInTheDocument()
    })

    it('"Add column" submit button is initially disabled', () => {
      renderModal()
      const buttons = screen.getAllByRole('button')
      const submitButton = buttons.find(b => b.getAttribute('type') === 'submit')!
      expect(submitButton).toBeDisabled()
    })

    it('does not show the options input for "text" type by default', () => {
      renderModal()
      expect(screen.queryByPlaceholderText('Todo, In Progress, Done')).not.toBeInTheDocument()
    })
  })

  describe('form interaction', () => {
    it('enables the submit button once a name is entered', () => {
      renderModal()
      fireEvent.change(screen.getByPlaceholderText('e.g. Priority'), {
        target: { value: 'Status' },
      })
      const submitButton = screen.getAllByRole('button').find(
        b => b.getAttribute('type') === 'submit',
      )!
      expect(submitButton).not.toBeDisabled()
    })

    it('shows the options input when "Select" type is chosen', () => {
      renderModal()
      const selectRadio = screen.getByDisplayValue('select')
      fireEvent.click(selectRadio)
      expect(screen.getByPlaceholderText('Todo, In Progress, Done')).toBeInTheDocument()
    })

    it('shows the options input when "Multi-select" type is chosen', () => {
      renderModal()
      const multiRadio = screen.getByDisplayValue('multiselect')
      fireEvent.click(multiRadio)
      expect(screen.getByPlaceholderText('Todo, In Progress, Done')).toBeInTheDocument()
    })

    it('hides options input when switching from Select back to Text', () => {
      renderModal()
      fireEvent.click(screen.getByDisplayValue('select'))
      expect(screen.getByPlaceholderText('Todo, In Progress, Done')).toBeInTheDocument()
      fireEvent.click(screen.getByDisplayValue('text'))
      expect(screen.queryByPlaceholderText('Todo, In Progress, Done')).not.toBeInTheDocument()
    })

    it('renders option preview chips from the options input', () => {
      renderModal()
      fireEvent.click(screen.getByDisplayValue('select'))
      // Default "Option 1, Option 2, Option 3" should render 3 chips. Scope to the
      // preview container — the option text also appears in the default-value
      // <select> below it.
      const preview = document.querySelector('.acm__option-preview')!
      expect(preview).toHaveTextContent('Option 1')
      expect(preview).toHaveTextContent('Option 2')
      expect(preview).toHaveTextContent('Option 3')
    })

    it('calls onClose when the close button is clicked', () => {
      const onClose = vi.fn()
      renderModal(vi.fn(), onClose)
      fireEvent.click(screen.getByLabelText('Close'))
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('calls onClose when Cancel is clicked', () => {
      const onClose = vi.fn()
      renderModal(vi.fn(), onClose)
      fireEvent.click(screen.getByText('Cancel'))
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('calls onClose when the overlay is clicked', () => {
      const onClose = vi.fn()
      render(<AddColumnModal onAdd={vi.fn()} onClose={onClose} />)
      const overlay = document.querySelector('.modal-overlay')!
      fireEvent.click(overlay)
      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  describe('submission', () => {
    it('calls onAdd with text type when submitted with just a name', () => {
      const onAdd = vi.fn()
      renderModal(onAdd)
      fireEvent.change(screen.getByPlaceholderText('e.g. Priority'), {
        target: { value: 'Tags' },
      })
      const form = screen.getByPlaceholderText('e.g. Priority').closest('form')!
      fireEvent.submit(form)
      expect(onAdd).toHaveBeenCalledWith({
        name: 'Tags',
        columnType: 'text',
        options: [],
        defaultValue: undefined,
      })
    })

    it('calls onAdd with number type when Number is selected', () => {
      const onAdd = vi.fn()
      renderModal(onAdd)
      fireEvent.change(screen.getByPlaceholderText('e.g. Priority'), {
        target: { value: 'Score' },
      })
      fireEvent.click(screen.getByDisplayValue('number'))
      const form = screen.getByPlaceholderText('e.g. Priority').closest('form')!
      fireEvent.submit(form)
      expect(onAdd).toHaveBeenCalledWith({
        name: 'Score',
        columnType: 'number',
        options: [],
        defaultValue: undefined,
      })
    })

    it('calls onAdd with select type and parsed options', () => {
      const onAdd = vi.fn()
      renderModal(onAdd)
      fireEvent.change(screen.getByPlaceholderText('e.g. Priority'), {
        target: { value: 'Priority' },
      })
      fireEvent.click(screen.getByDisplayValue('select'))
      fireEvent.change(screen.getByPlaceholderText('Todo, In Progress, Done'), {
        target: { value: 'Low, Medium, High' },
      })
      const form = screen.getByPlaceholderText('e.g. Priority').closest('form')!
      fireEvent.submit(form)
      expect(onAdd).toHaveBeenCalledWith({
        name: 'Priority',
        columnType: 'select',
        options: ['Low', 'Medium', 'High'],
        // Single-select defaults to its first option.
        defaultValue: 'Low',
      })
    })

    it('trims whitespace from option values', () => {
      const onAdd = vi.fn()
      renderModal(onAdd)
      fireEvent.change(screen.getByPlaceholderText('e.g. Priority'), {
        target: { value: 'Status' },
      })
      fireEvent.click(screen.getByDisplayValue('select'))
      fireEvent.change(screen.getByPlaceholderText('Todo, In Progress, Done'), {
        target: { value: '  Todo  ,  In Progress  , Done  ' },
      })
      const form = screen.getByPlaceholderText('e.g. Priority').closest('form')!
      fireEvent.submit(form)
      expect(onAdd).toHaveBeenCalledWith({
        name: 'Status',
        columnType: 'select',
        options: ['Todo', 'In Progress', 'Done'],
        defaultValue: 'Todo',
      })
    })

    it('trims whitespace from the column name', () => {
      const onAdd = vi.fn()
      renderModal(onAdd)
      fireEvent.change(screen.getByPlaceholderText('e.g. Priority'), {
        target: { value: '  My Column  ' },
      })
      const form = screen.getByPlaceholderText('e.g. Priority').closest('form')!
      fireEvent.submit(form)
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My Column' }),
      )
    })

    it('does not call onAdd when name is blank', () => {
      const onAdd = vi.fn()
      renderModal(onAdd)
      const form = screen.getByPlaceholderText('e.g. Priority').closest('form')!
      fireEvent.submit(form)
      expect(onAdd).not.toHaveBeenCalled()
    })
  })
})
