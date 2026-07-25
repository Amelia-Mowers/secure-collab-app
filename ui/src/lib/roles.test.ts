import { describe, it, expect } from 'vitest'
import { canEdit, canAdminister, ROLE_LABELS, type Role } from './roles'

describe('roles', () => {
  it('lets admins and editors write, and viewers not', () => {
    expect(canEdit('admin')).toBe(true)
    expect(canEdit('editor')).toBe(true)
    expect(canEdit('viewer')).toBe(false)
  })

  it('reserves administration for admins', () => {
    expect(canAdminister('admin')).toBe(true)
    expect(canAdminister('editor')).toBe(false)
    expect(canAdminister('viewer')).toBe(false)
  })

  it('labels every role', () => {
    for (const r of ['admin', 'editor', 'viewer'] as Role[]) {
      expect(ROLE_LABELS[r]).toBeTruthy()
    }
  })
})
