import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CsvImportModal, type CsvPreviewColumn } from './CsvImportModal'

/**
 * The value of this dialogue is entirely in what it shows you before it
 * commits: the inferred types (overridable), and the count of values that
 * won't import. An import that silently dropped a column would be
 * indistinguishable from a clean one — so those are what these tests pin.
 */

const CSV = 'Title,Count\nAlpha,3\nBeta,x\n'

function columnsFor(overrides: CsvPreviewColumn[]): CsvPreviewColumn[] {
  const base: CsvPreviewColumn[] = [
    { id: 'title', name: 'Title', type: 'text', existing: false },
    { id: 'count', name: 'Count', type: 'number', existing: false },
  ]
  return base.map(c => overrides.find(o => o.name === c.name) ?? c)
}

/** A stand-in for the Rust dry run: "x" isn't a number, so it fails while the
 *  column is typed as one and passes once it's text. */
function fakePreview(_tableId: string, _csv: string, overrides: CsvPreviewColumn[]) {
  const columns = columnsFor(overrides)
  const count = columns.find(c => c.name === 'Count')!
  return {
    columns,
    rows: [
      ['Alpha', '3'],
      ['Beta', 'x'],
    ],
    totalRows: 2,
    issues:
      count.type === 'number'
        ? [{ row: 1, column: 'Count', message: '"x" is not a number' }]
        : [],
  }
}

/** Drive the file input, which is how the dialogue actually gets its text. */
async function selectFile(text = CSV) {
  const input = screen.getByLabelText('CSV file') as HTMLInputElement
  const file = new File([text], 'tasks.csv', { type: 'text/csv' })
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByText('Title')
}

describe('CsvImportModal', () => {
  it('previews inferred types and counts what will not import', async () => {
    render(
      <CsvImportModal tables={[]} preview={fakePreview} onImport={vi.fn()} onClose={vi.fn()} />,
    )
    await selectFile()

    expect((screen.getByLabelText('Type for Count') as HTMLSelectElement).value).toBe('number')
    expect(screen.getByRole('alert')).toHaveTextContent('1 value won’t import')
    expect(screen.getByRole('alert')).toHaveTextContent('not a number')
  })

  it('re-validates when the user overrides a type — inference is only a start', async () => {
    render(
      <CsvImportModal tables={[]} preview={fakePreview} onImport={vi.fn()} onClose={vi.fn()} />,
    )
    await selectFile()
    expect(screen.getByRole('alert')).toHaveTextContent('won’t import')

    fireEvent.change(screen.getByLabelText('Type for Count'), { target: { value: 'text' } })

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('locks columns matched to an existing table rather than offering a dead control', async () => {
    const preview = () => ({
      columns: [
        { id: 'title', name: 'Title', type: 'text', existing: true },
        { id: 'count', name: 'Count', type: 'number', existing: false },
      ],
      rows: [['Alpha', '3']],
      totalRows: 1,
      issues: [],
    })
    render(
      <CsvImportModal
        tables={[{ id: 'tasks', name: 'Tasks' }]}
        defaultTableId="tasks"
        preview={preview}
        onImport={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await selectFile()

    // The live column's type is shown but not editable; the new one is.
    expect(screen.queryByLabelText('Type for Title')).toBeNull()
    expect(screen.getByLabelText('Type for Count')).toBeInTheDocument()
  })

  it('reports what actually landed, including values left empty', async () => {
    const onImport = vi.fn().mockResolvedValue({
      rowsWritten: 2,
      issues: [{ row: 1, column: 'Count', message: '"x" is not a number' }],
    })
    render(
      <CsvImportModal tables={[]} preview={fakePreview} onImport={onImport} onClose={vi.fn()} />,
    )
    await selectFile()

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText(/Imported/)).toHaveTextContent('2')
    expect(screen.getByText(/could not be applied/)).toBeInTheDocument()
  })

  it('opens straight into a table when launched from that table', () => {
    // The per-table entry point (a table's own import button) preselects the
    // destination; the workspace-level button leaves it to the user.
    render(
      <CsvImportModal
        tables={[
          { id: 'tasks', name: 'Tasks' },
          { id: 'notes', name: 'Notes' },
        ]}
        defaultTableId="notes"
        preview={fakePreview}
        onImport={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect((screen.getByLabelText('Destination table') as HTMLSelectElement).value).toBe('notes')
    expect(screen.getByLabelText('New table name')).toBeDisabled()
  })

  it('cannot import before a file is chosen', () => {
    render(
      <CsvImportModal tables={[]} preview={fakePreview} onImport={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })
})
