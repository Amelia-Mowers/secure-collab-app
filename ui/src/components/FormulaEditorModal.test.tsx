import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FormulaEditorModal, type FormulaPreviewRow } from './FormulaEditorModal'

const COLUMNS = [
  { id: 'item', name: 'Item', column_type: 'text' },
  { id: 'qty', name: 'Qty', column_type: 'number' },
  { id: 'unit_price', name: 'Unit Price', column_type: 'number' },
  { id: '2024_total', name: '2024 Total', column_type: 'number' },
  { id: 'total', name: 'Total', column_type: 'formula', formula: 'Qty * 2' },
]

/** Stands in for the core's evaluator: real enough that a wrong formula
 *  produces a per-row error rather than a value. */
function makePreview(rows: FormulaPreviewRow[] = [], totalRows = rows.length) {
  return vi.fn(async () => ({ rows, totalRows }))
}

function setup(overrides: Partial<Parameters<typeof FormulaEditorModal>[0]> = {}) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  const preview = makePreview([
    { label: 'Widget', value: '4', error: null },
    { label: 'Gadget', value: '6', error: null },
  ])
  render(
    <FormulaEditorModal
      column={COLUMNS.find(c => c.id === 'total')!}
      columns={COLUMNS}
      preview={preview}
      onSave={onSave}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onSave, onClose, preview }
}

describe('FormulaEditorModal', () => {
  it('opens on the column’s current formula and previews it against real rows', async () => {
    setup()
    expect(screen.getByLabelText('Formula')).toHaveValue('Qty * 2')
    // The preview is what makes this better than the column-settings field:
    // the answer is visible before saving.
    await waitFor(() => expect(screen.getByText('Widget')).toBeInTheDocument())
    expect(screen.getByText('4')).toBeInTheDocument()
  })

  it('saves the edited formula', async () => {
    const { onSave } = setup()
    const input = screen.getByLabelText('Formula')
    fireEvent.change(input, { target: { value: 'Qty * 3' } })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith('Qty * 3')
  })

  it('will not save an unchanged formula', async () => {
    setup()
    await waitFor(() => expect(screen.getByText('Widget')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('blocks saving a formula that fails on every row, and says why', async () => {
    const preview = makePreview([
      { label: 'Widget', value: '', error: 'unclosed delimiter' },
      { label: 'Gadget', value: '', error: 'unclosed delimiter' },
    ])
    const { onSave } = setup({ preview })

    const input = screen.getByLabelText('Formula')
    fireEvent.change(input, { target: { value: 'Qty * (' } })

    // Broken on every row is a broken formula, not bad data.
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('unclosed delimiter'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('shows a per-row failure without blocking the save', async () => {
    const preview = makePreview([
      { label: 'Widget', value: '4', error: null },
      { label: 'Gadget', value: '', error: 'expected number, found text' },
    ])
    setup({ preview })

    const input = screen.getByLabelText('Formula')
    fireEvent.change(input, { target: { value: 'Qty * 3' } })

    // One bad row is data, not syntax — the user may well intend to save and
    // then fix the row.
    await waitFor(() =>
      expect(screen.getByText('expected number, found text')).toBeInTheDocument(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
  })

  it('inserts an identifier-shaped column name as written', async () => {
    setup()
    const input = screen.getByLabelText('Formula') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: 'Qty' }))
    await waitFor(() => expect(input).toHaveValue('Qty'))
  })

  it('inserts the id for a column whose name is not a valid identifier', async () => {
    setup()
    const input = screen.getByLabelText('Formula') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '' } })

    fireEvent.click(screen.getByRole('button', { name: 'Unit Price' }))
    // NOT `"Unit Price"`. The evaluator resolves references as identifiers, so
    // a quoted name is a string literal — the formula would compute the words
    // "Unit Price" for every row instead of failing, which is the worst
    // possible outcome: wrong, and silent.
    await waitFor(() => expect(input).toHaveValue('unit_price'))
  })

  it('offers no chip for a column that cannot be referred to at all', () => {
    setup()
    // Slugifying "2024 Total" gives "2024_total", which no identifier may start
    // with — so there is no way to write this reference. A chip inserting it
    // would produce a formula the evaluator rejects, with no hint as to why.
    expect(screen.queryByRole('button', { name: '2024 Total' })).not.toBeInTheDocument()
  })

  it('does not offer the column being computed as a reference', () => {
    setup()
    // A formula referring to itself would read its own last value — offering it
    // as an insert would be an invitation to a confusing result.
    expect(screen.queryByRole('button', { name: 'Total' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Qty' })).toBeInTheDocument()
  })

  it('gives a viewer no way to save', () => {
    setup({ readOnly: true })
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Formula')).toHaveAttribute('readonly')
    // And no insert chips, which only exist to help you write one.
    expect(screen.queryByRole('button', { name: 'Qty' })).not.toBeInTheDocument()
  })

  it('closes on Escape without saving', async () => {
    const { onSave, onClose } = setup()
    fireEvent.keyDown(screen.getByLabelText('Formula'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('reports how much of the table the preview covers', async () => {
    const preview = makePreview([{ label: 'Widget', value: '4', error: null }], 250)
    setup({ preview })
    // A preview of 1 of 250 rows must not read as "this table has one row".
    await waitFor(() => expect(screen.getByText(/first 1 of 250 rows/)).toBeInTheDocument())
  })
})
