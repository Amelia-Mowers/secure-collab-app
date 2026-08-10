import { describe, it, expect, beforeEach } from 'vitest'
import { parseInviteFragment, readPendingInvite, clearPendingInvite } from './JoinPage'

/**
 * The fragment is the whole link. Getting it wrong sends someone to a dead end
 * holding a valid invitation, so these pin the parsing rather than the page.
 *
 * The Rust side has the matching tests for the URL it produces
 * (`invite::a_link_round_trips_through_its_url`); this is the other half of
 * that round trip, and the two must agree on the format.
 */
describe('parseInviteFragment', () => {
  it('reads a room id and token, decoding the room id', () => {
    // `!` and `:` are percent-encoded by `invite_url`, because a raw room id
    // does not survive a fragment intact.
    const parsed = parseInviteFragment('#%21AbCdEf%3Aexample.org&sometoken')
    expect(parsed).toEqual({ roomId: '!AbCdEf:example.org', token: 'sometoken' })
  })

  it('works with or without the leading hash', () => {
    expect(parseInviteFragment('%21r%3As&tok')).toEqual({ roomId: '!r:s', token: 'tok' })
  })

  it('keeps a token containing the URL-safe base64 characters', () => {
    // `-` and `_` are exactly what distinguishes base64url from base64, and a
    // parser that split on the wrong character would truncate only sometimes.
    const parsed = parseInviteFragment('#%21r%3As&ab-cd_ef')
    expect(parsed?.token).toBe('ab-cd_ef')
  })

  it('rejects a half link rather than half-parsing it', () => {
    expect(parseInviteFragment('')).toBeNull()
    expect(parseInviteFragment('#')).toBeNull()
    expect(parseInviteFragment('#justaroom')).toBeNull()
    expect(parseInviteFragment('#&tokenonly')).toBeNull()
    expect(parseInviteFragment('#%21r%3As&')).toBeNull()
  })
})

describe('the pending invite stash', () => {
  beforeEach(() => {
    clearPendingInvite()
  })

  it('is empty until something is stored', () => {
    expect(readPendingInvite()).toBeNull()
  })

  it('ignores a malformed stash instead of throwing into the page', () => {
    sessionStorage.setItem('tw.pendingInvite', 'not json')
    expect(readPendingInvite()).toBeNull()
    sessionStorage.setItem('tw.pendingInvite', JSON.stringify({ roomId: '!r:s' }))
    expect(readPendingInvite()).toBeNull()
  })

  it('returns a complete stash', () => {
    sessionStorage.setItem('tw.pendingInvite', JSON.stringify({ roomId: '!r:s', token: 't' }))
    expect(readPendingInvite()).toEqual({ roomId: '!r:s', token: 't' })
  })
})
