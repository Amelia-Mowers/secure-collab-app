import { describe, it, expect } from 'vitest'
import { makeReferenceLookup, referenceLabel } from './referenceLookup'

const CONTACTS = [
  { _row_id: 'c1', name: 'Dana Whitfield', email: 'dana@acme.test' },
  { _row_id: 'c2', name: '', email: 'marcus@brightloop.test' },
]

const SCHEMA = {
  columns: {
    name: { id: 'name', name: 'Name', column_type: 'text' },
    email: { id: 'email', name: 'Email', column_type: 'text' },
  },
}

function workspace(overrides: Partial<Record<'rows' | 'schema', unknown>> = {}) {
  return {
    getTableRows: () => JSON.stringify(overrides.rows ?? CONTACTS),
    getTableSchema: () => JSON.stringify(overrides.schema ?? SCHEMA),
  }
}

describe('makeReferenceLookup', () => {
  it('labels rows with the configured display column', () => {
    const lookup = makeReferenceLookup(workspace())
    expect(lookup('contacts', 'email')).toEqual([
      { id: 'c1', label: 'dana@acme.test' },
      { id: 'c2', label: 'marcus@brightloop.test' },
    ])
  })

  it('falls back to the first text column only when none is configured', () => {
    const lookup = makeReferenceLookup(workspace())
    // `name` is the first text column; c2's name is empty so it shows its id.
    expect(lookup('contacts')).toEqual([
      { id: 'c1', label: 'Dana Whitfield' },
      { id: 'c2', label: 'c2' },
    ])
  })

  it('degrades to raw ids when the referenced schema is unreadable', () => {
    const lookup = makeReferenceLookup({
      getTableRows: () => JSON.stringify(CONTACTS),
      getTableSchema: () => 'not json',
    })
    expect(lookup('contacts').map(r => r.label)).toEqual(['c1', 'c2'])
  })

  it('returns nothing for an unreadable table or a null workspace', () => {
    expect(makeReferenceLookup(null)('contacts')).toEqual([])
    expect(
      makeReferenceLookup({
        getTableRows: () => { throw new Error('no such table') },
        getTableSchema: () => '{}',
      })('ghost'),
    ).toEqual([])
  })
})

describe('referenceLabel', () => {
  it('resolves a known id', () => {
    expect(referenceLabel([{ id: 'c1', label: 'Dana' }], 'c1')).toEqual({
      label: 'Dana',
      dangling: false,
    })
  })

  it('flags an id whose row is gone, keeping the id visible', () => {
    expect(referenceLabel([{ id: 'c1', label: 'Dana' }], 'c9')).toEqual({
      label: 'c9',
      dangling: true,
    })
    expect(referenceLabel(null, 'c9')).toEqual({ label: 'c9', dangling: true })
  })
})
