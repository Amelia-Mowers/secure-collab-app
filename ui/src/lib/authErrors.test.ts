import { describe, it, expect } from 'vitest'
import { isSessionRejected } from './authErrors'

/**
 * The asymmetry here is the whole point: a wrong "keep" costs one failed
 * retry, a wrong "delete" costs the user their session and cached workspaces.
 * So every uncertain case must resolve to "not rejected".
 */

describe('isSessionRejected', () => {
  it('treats a definitive server rejection as rejected', () => {
    expect(isSessionRejected(new Error('M_UNKNOWN_TOKEN: Invalid access token'))).toBe(true)
    expect(isSessionRejected(new Error('OAuth error: invalid_grant'))).toBe(true)
    expect(isSessionRejected('the server returned 401 Unauthorized')).toBe(true)
  })

  it('does NOT treat an unreachable server as rejected', () => {
    // The 2026-07-26 report: MAS was briefly down, and the app deleted the
    // account because the failure was not literally a "timeout".
    for (const message of [
      'error sending request for url (https://auth.tidework.io/...)',
      'Failed to fetch',
      'NetworkError when attempting to fetch resource',
      'request timed out',
      'ECONNREFUSED',
      '502 Bad Gateway',
      '503 Service Unavailable',
      '504 Gateway Timeout',
    ]) {
      expect(isSessionRejected(new Error(message)), message).toBe(false)
    }
  })

  it('reads an explicit rejection even when the text also mentions the connection', () => {
    expect(
      isSessionRejected(new Error('connection to https://auth/ returned M_UNKNOWN_TOKEN')),
    ).toBe(true)
  })

  it('keeps the account for anything it does not recognise', () => {
    expect(isSessionRejected(new Error('something went sideways'))).toBe(false)
    expect(isSessionRejected(undefined)).toBe(false)
    expect(isSessionRejected(null)).toBe(false)
    expect(isSessionRejected(new Error(''))).toBe(false)
  })
})
