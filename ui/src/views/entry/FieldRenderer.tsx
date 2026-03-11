import { useState, useEffect } from 'react'
import { MarkdownEditor } from './MarkdownEditor'
import './FieldRenderer.css'

interface Column {
  id: string
  name: string
  column_type: string
  required: boolean
  options?: string[]
  reference_table?: string
}

interface FieldRendererProps {
  column: Column
  value: any
  onChange: (value: any) => void
}

export function FieldRenderer({ column, value, onChange }: FieldRendererProps) {
  const [localValue, setLocalValue] = useState(value ?? '')
  const [isFocused, setIsFocused] = useState(false)

  useEffect(() => {
    setLocalValue(value ?? '')
  }, [value])

  const handleChange = (newValue: any) => {
    setLocalValue(newValue)
  }

  const handleBlur = () => {
    setIsFocused(false)
    // Only trigger onChange if value actually changed
    if (localValue !== value) {
      onChange(localValue)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Tab moves to next field
    if (e.key === 'Tab' && column.column_type !== 'document') {
      handleBlur()
    }
    // Enter moves to next field for non-text fields
    if (e.key === 'Enter' && column.column_type !== 'text' && column.column_type !== 'document') {
      e.preventDefault()
      handleBlur()
    }
  }

  const renderField = () => {
    switch (column.column_type) {
      case 'text':
        return (
          <input
            type="text"
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={handleBlur}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleKeyDown}
            className="field-input field-text"
            placeholder={`Enter ${column.name.toLowerCase()}...`}
          />
        )

      case 'number':
        return (
          <input
            type="number"
            value={localValue}
            onChange={(e) => handleChange(parseFloat(e.target.value) || 0)}
            onBlur={handleBlur}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleKeyDown}
            className="field-input field-number"
            placeholder="0"
          />
        )

      case 'boolean':
        return (
          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={!!localValue}
              onChange={(e) => {
                handleChange(e.target.checked)
                onChange(e.target.checked)
              }}
              onFocus={() => setIsFocused(true)}
              onBlur={handleBlur}
            />
            <span>{column.name}</span>
          </label>
        )

      case 'date':
        return (
          <input
            type="date"
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={handleBlur}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleKeyDown}
            className="field-input field-date"
          />
        )

      case 'select':
        return (
          <select
            value={localValue}
            onChange={(e) => {
              handleChange(e.target.value)
              onChange(e.target.value)
            }}
            onFocus={() => setIsFocused(true)}
            onBlur={handleBlur}
            className="field-input field-select"
          >
            <option value="">Select {column.name}...</option>
            {column.options?.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )

      case 'multiselect':
        // Simple text input for now, later can be tag-style input
        return (
          <input
            type="text"
            value={Array.isArray(localValue) ? localValue.join(', ') : localValue}
            onChange={(e) => handleChange(e.target.value.split(',').map(s => s.trim()))}
            onBlur={handleBlur}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleKeyDown}
            className="field-input field-multiselect"
            placeholder="Comma-separated values..."
          />
        )

      case 'reference':
        return (
          <input
            type="text"
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={handleBlur}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleKeyDown}
            className="field-input field-reference"
            placeholder={`Reference to ${column.reference_table || 'another table'}...`}
          />
        )

      case 'document':
        return (
          <MarkdownEditor
            value={localValue}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={() => setIsFocused(true)}
          />
        )

      case 'json':
        return (
          <textarea
            value={typeof localValue === 'string' ? localValue : JSON.stringify(localValue, null, 2)}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={handleBlur}
            onFocus={() => setIsFocused(true)}
            className="field-input field-json"
            rows={10}
            placeholder="{}"
          />
        )

      default:
        return (
          <input
            type="text"
            value={localValue}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={handleBlur}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleKeyDown}
            className="field-input"
            placeholder={`Enter ${column.name.toLowerCase()}...`}
          />
        )
    }
  }

  return (
    <div className={`field-renderer ${isFocused ? 'focused' : ''}`}>
      {column.column_type !== 'boolean' && (
        <label className="field-label">
          {column.name}
          {column.required && <span className="required-indicator">*</span>}
        </label>
      )}
      {renderField()}
    </div>
  )
}
