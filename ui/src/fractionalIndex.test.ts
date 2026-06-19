import { describe, it, expect } from 'vitest'
import { generateKeyBetween, generateNKeysBetween, computeReorderWrites } from './fractionalIndex'

describe('generateKeyBetween', () => {
  it('generates a non-empty key between null bounds', () => {
    const k = generateKeyBetween(null, null)
    expect(k.length).toBeGreaterThan(0)
  })

  it('prepends and appends in order', () => {
    const a = generateKeyBetween(null, null)
    const after = generateKeyBetween(a, null)
    const before = generateKeyBetween(null, a)
    expect(before < a).toBe(true)
    expect(a < after).toBe(true)
  })

  it('generates a key strictly between two keys', () => {
    const a = generateKeyBetween(null, null)
    const b = generateKeyBetween(a, null)
    const mid = generateKeyBetween(a, b)
    expect(a < mid && mid < b).toBe(true)
  })

  it('throws when a >= b', () => {
    const a = generateKeyBetween(null, null)
    const b = generateKeyBetween(a, null)
    expect(() => generateKeyBetween(b, a)).toThrow()
  })

  it('stays strictly ordered across many random insertions (property)', () => {
    // Deterministic LCG so the test is reproducible.
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const keys: string[] = generateNKeysBetween(null, null, 3)
    for (let i = 0; i < 3000; i++) {
      const pos = Math.floor(rand() * (keys.length + 1))
      const a = pos > 0 ? keys[pos - 1] : null
      const b = pos < keys.length ? keys[pos] : null
      keys.splice(pos, 0, generateKeyBetween(a, b))
    }
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true)
    }
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('generateNKeysBetween', () => {
  it('returns n ascending keys', () => {
    const keys = generateNKeysBetween(null, null, 10)
    expect(keys).toHaveLength(10)
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true)
  })

  it('returns ascending keys between two bounds', () => {
    const a = generateKeyBetween(null, null)
    const b = generateKeyBetween(a, null)
    const all = [a, ...generateNKeysBetween(a, b, 5), b]
    expect(all).toHaveLength(7)
    for (let i = 1; i < all.length; i++) expect(all[i - 1] < all[i]).toBe(true)
  })
})

describe('computeReorderWrites', () => {
  it('backfills all rows on the first reorder (no keys yet)', () => {
    const rows = [
      { id: 'r1', key: null },
      { id: 'r2', key: null },
      { id: 'r3', key: null },
    ]
    const writes = computeReorderWrites(rows, 'r3', 'r1') // move r3 to front
    expect(writes.map(w => w.id)).toEqual(['r3', 'r1', 'r2'])
    expect(writes[0].key < writes[1].key).toBe(true)
    expect(writes[1].key < writes[2].key).toBe(true)
  })

  it('writes a single key when all rows are already keyed', () => {
    const keys = generateNKeysBetween(null, null, 3)
    const rows = [
      { id: 'r1', key: keys[0] },
      { id: 'r2', key: keys[1] },
      { id: 'r3', key: keys[2] },
    ]
    const writes = computeReorderWrites(rows, 'r1', 'r3') // move r1 to the end
    expect(writes).toHaveLength(1)
    expect(writes[0].id).toBe('r1')
    expect(writes[0].key > keys[2]).toBe(true)
  })

  it('returns no writes for a no-op move', () => {
    const rows = [
      { id: 'r1', key: 'V' },
      { id: 'r2', key: 'l' },
    ]
    expect(computeReorderWrites(rows, 'r1', 'r1')).toEqual([])
  })
})
