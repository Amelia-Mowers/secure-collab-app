import { operatorsForType, operatorNeedsValue, type FilterCondition, type FilterOp } from '@/lib/filters'
import './FilterBar.css'

export interface FilterColumnMeta {
  id: string
  name: string
  column_type: string
  options?: string[]
}

const MULTI_VALUE_OPS: FilterOp[] = ['is_any_of', 'has_any_of', 'has_all_of', 'has_none_of']

/**
 * The per-column "where" filter bar (issue: Real filter UI). Stacked conditions
 * (column · operator · value), each type-aware: number/date get </≤/>/≥, select
 * gets is/is-any-of, multiselect gets has any/all/none. ANDed together. The
 * conditions are owned by TableView (applied client-side + saved into a view).
 */
export function FilterBar({
  columns,
  conditions,
  onChange,
}: {
  columns: FilterColumnMeta[]
  conditions: FilterCondition[]
  onChange: (conditions: FilterCondition[]) => void
}) {
  const update = (i: number, patch: Partial<FilterCondition>) =>
    onChange(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const remove = (i: number) => onChange(conditions.filter((_, j) => j !== i))
  const add = () => {
    const col = columns[0]
    if (!col) return
    const ops = operatorsForType(col.column_type)
    onChange([...conditions, { columnId: col.id, operator: ops[0].op, value: undefined }])
  }

  return (
    <div className="filter-conditions">
      {conditions.map((c, i) => {
        const col = columns.find(x => x.id === c.columnId) ?? columns[0]
        const ops = operatorsForType(col?.column_type ?? 'text')
        return (
          <div className="filter-condition" key={i}>
            <span className="filter-condition__lead">{i === 0 ? 'Where' : 'And'}</span>
            <select
              className="filter-condition__col"
              value={c.columnId}
              onChange={e => {
                const next = columns.find(x => x.id === e.target.value)
                if (!next) return
                update(i, {
                  columnId: next.id,
                  operator: operatorsForType(next.column_type)[0].op,
                  value: undefined,
                })
              }}
            >
              {columns.map(x => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <select
              className="filter-condition__op"
              value={c.operator}
              onChange={e => update(i, { operator: e.target.value as FilterOp, value: undefined })}
            >
              {ops.map(o => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {operatorNeedsValue(c.operator) && (
              <ValueEditor
                column={col}
                operator={c.operator}
                value={c.value}
                onChange={v => update(i, { value: v })}
              />
            )}
            <button
              type="button"
              className="filter-condition__remove"
              aria-label="Remove filter"
              onClick={() => remove(i)}
            >
              ✕
            </button>
          </div>
        )
      })}
      <button type="button" className="filter-condition__add" onClick={add}>
        + Add condition
      </button>
    </div>
  )
}

/** The value input for a condition — type- and operator-aware. */
function ValueEditor({
  column,
  operator,
  value,
  onChange,
}: {
  column: FilterColumnMeta | undefined
  operator: FilterOp
  value: unknown
  onChange: (v: unknown) => void
}) {
  const type = column?.column_type ?? 'text'
  const options = column?.options ?? []

  // is_any_of / has any/all/none → pick one or more option values.
  if (MULTI_VALUE_OPS.includes(operator)) {
    const selected = Array.isArray(value) ? (value as string[]) : []
    if (options.length) {
      const toggle = (opt: string) =>
        onChange(selected.includes(opt) ? selected.filter(o => o !== opt) : [...selected, opt])
      return (
        <div className="filter-value-multi">
          {options.map(opt => (
            <label key={opt} className="filter-value-multi__opt">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
              />
              {opt}
            </label>
          ))}
        </div>
      )
    }
    return (
      <input
        className="filter-condition__value"
        placeholder="a, b, c"
        value={selected.join(', ')}
        onChange={e => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
      />
    )
  }

  if (type === 'select' && options.length) {
    return (
      <select
        className="filter-condition__value"
        value={String(value ?? '')}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">—</option>
        {options.map(opt => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }

  if (type === 'boolean') {
    return (
      <select
        className="filter-condition__value"
        value={value === false ? 'false' : 'true'}
        onChange={e => onChange(e.target.value === 'true')}
      >
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </select>
    )
  }

  if (type === 'date') {
    return (
      <input
        type="date"
        className="filter-condition__value"
        value={String(value ?? '')}
        onChange={e => onChange(e.target.value)}
      />
    )
  }

  if (type === 'number') {
    return (
      <input
        type="number"
        className="filter-condition__value"
        value={value == null ? '' : String(value)}
        onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    )
  }

  return (
    <input
      type="text"
      className="filter-condition__value"
      value={String(value ?? '')}
      onChange={e => onChange(e.target.value)}
    />
  )
}
