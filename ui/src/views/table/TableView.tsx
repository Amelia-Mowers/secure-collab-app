import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTable } from '@/hooks/useTable'
import { Toolbar, ToolbarButton, ToolbarPrimaryButton, FilterIcon, SortIcon } from '@/components/Toolbar'
import { AddColumnModal, type NewColumnDef } from '@/components/AddColumnModal'
import './TableView.css'

interface TableViewProps {
  workspace: any
}

interface ColumnMeta {
  id: string
  name: string
  column_type: string
  options?: string[]
}

export function TableView({ workspace }: TableViewProps) {
  const { tableId } = useParams<{ tableId: string }>()
  const navigate = useNavigate()
  const { rows, loading, error, updateCell, deleteRow, refresh } = useTable(workspace, tableId!)
  const [schema, setSchema] = useState<any>(null)
  const [isAddingColumn, setIsAddingColumn] = useState(false)
  /** Which cell is currently being edited: "rowId:colId" or null */
  const [editingCell, setEditingCell] = useState<string | null>(null)

  const columns: ColumnMeta[] = React.useMemo(() => {
    const columnSet = new Set<string>()
    rows.forEach(row => {
      Object.keys(row).forEach(key => { if (key !== '_row_id') columnSet.add(key) })
    })
    if (schema?.columns) {
      Object.keys(schema.columns).forEach(colId => columnSet.add(colId))
    }
    return Array.from(columnSet).sort().map(colId => ({
      id: colId,
      name: schema?.columns?.[colId]?.name || colId.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
      column_type: schema?.columns?.[colId]?.column_type || 'text',
      options: schema?.columns?.[colId]?.options,
    }))
  }, [rows, schema])

  useEffect(() => {
    if (workspace && tableId) {
      try {
        const schemaJson = workspace.getTableSchema(tableId)
        setSchema(JSON.parse(schemaJson))
      } catch (err) {
        console.error('Failed to load schema:', err)
      }
    }
  }, [workspace, tableId, rows])

  const handleAddColumn = (def: NewColumnDef) => {
    if (!workspace || !tableId) return
    const columnId = def.name.toLowerCase().replace(/\s+/g, '_')
    const columnDef = {
      id: columnId,
      name: def.name,
      column_type: def.columnType,
      required: false,
      ...(def.options.length > 0 ? { options: def.options } : {}),
    }
    try {
      workspace.addColumn(tableId, JSON.stringify(columnDef))
      setIsAddingColumn(false)
      refresh()
    } catch (err) {
      console.error('Failed to add column:', err)
    }
  }

  if (!tableId) {
    return <div className="table-view"><div className="state-empty"><p>No table selected</p></div></div>
  }

  if (loading) {
    return (
      <div className="table-view">
        <Toolbar title={tableId} />
        <div className="state-empty">Loading...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="table-view">
        <Toolbar title={tableId} />
        <div className="state-error"><h3>Error loading table</h3><p>{error.message}</p></div>
      </div>
    )
  }

  const tableTitle = schema?.name || tableId

  return (
    <div className="table-view">
      <Toolbar
        title={tableTitle}
        actions={
          <>
            <ToolbarButton icon={<FilterIcon />} label="Filter" />
            <ToolbarButton icon={<SortIcon />} label="Sort" />
            <ToolbarPrimaryButton onClick={() => navigate(`/table/${tableId}/entry/new`)}>New entry</ToolbarPrimaryButton>
          </>
        }
      />

      <div className="table-view__content">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map(col => (
                  <th key={col.id}>
                    <span className="col-name">{col.name}</span>
                    {col.column_type !== 'text' && (
                      <span className="col-type-badge">{col.column_type}</span>
                    )}
                  </th>
                ))}
                <th className="col-add-header">
                  <button
                    className="col-add-btn ghost"
                    onClick={() => setIsAddingColumn(true)}
                    title="Add column"
                  >+ Add Column</button>
                </th>
                <th className="col-actions-header" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr className="row-empty-cta">
                  <td colSpan={columns.length + 2}>
                    <button
                      className="empty-cta-btn"
                      onClick={() => navigate(`/table/${tableId}/entry/new`)}
                    >
                      + Add your first entry
                    </button>
                  </td>
                </tr>
              )}
              {rows.map(row => (
                  <tr
                    key={row._row_id}
                    onClick={() => navigate(`/table/${tableId}/entry/${row._row_id}`)}
                  >
                    {columns.map((col, i) => {
                      const cellKey = `${row._row_id}:${col.id}`
                      const isEditing = editingCell === cellKey
                      const rawValue = row[col.id]
                      const displayValue = rawValue != null ? String(rawValue) : ''
                      const isSelect = col.column_type === 'select' || col.column_type === 'multiselect'

                      return (
                        <td
                          key={col.id}
                          onClick={e => {
                            e.stopPropagation()
                            setEditingCell(cellKey)
                          }}
                        >
                          {isSelect ? (
                            // Select columns always show a <select> dropdown
                            <select
                              className="cell-select"
                              value={displayValue}
                              onChange={e => {
                                updateCell(row._row_id, col.id, e.target.value)
                                  .catch(err => console.error('Failed to update cell:', err))
                              }}
                              onClick={e => e.stopPropagation()}
                            >
                              <option value="">—</option>
                              {(col.options ?? []).map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          ) : (
                            // Text/number/etc columns — always an input, focused when editing
                            <input
                              type="text"
                              className={`cell-input ${i === 0 ? 'cell-input--title' : ''}`}
                              value={displayValue}
                              autoFocus={isEditing}
                              onBlur={() => setEditingCell(null)}
                              onChange={e => {
                                updateCell(row._row_id, col.id, e.target.value)
                                  .catch(err => console.error('Failed to update cell:', err))
                              }}
                            />
                          )}
                        </td>
                      )
                    })}
                    <td onClick={e => e.stopPropagation()} />
                    <td className="cell-actions" onClick={e => e.stopPropagation()}>
                      <button
                        className="ghost cell-delete-btn"
                        onClick={() => deleteRow(row._row_id).catch(console.error)}
                        title="Delete row"
                      >
                        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
                          <polyline points="1,3 12,3" />
                          <path d="M4.5 3V2a.5.5 0 01.5-.5h3a.5.5 0 01.5.5v1" />
                          <rect x="2.5" y="3" width="8" height="8.5" rx="1" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      </div>

      {/* Add column modal */}
      {isAddingColumn && (
        <AddColumnModal
          onAdd={handleAddColumn}
          onClose={() => setIsAddingColumn(false)}
        />
      )}
    </div>
  )
}
