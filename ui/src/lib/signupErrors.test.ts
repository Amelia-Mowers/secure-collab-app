import { describe, expect, it } from 'vitest'
import { describeSignupError } from './signupErrors'

const HS = 'https://matrix.example.org'

describe('describeSignupError', () => {
  it('explains a closed server as a setting, not a rejection', () => {
    // What a self-hoster's first user actually hits: infra/selfhost ships with
    // registration closed, so this is the default experience of pressing
    // "Create account" against a correctly configured server.
    const msg = describeSignupError(
      new Error('M_FORBIDDEN: Registration has been disabled'),
      HS,
    )
    expect(msg).toContain('matrix.example.org')
    expect(msg).toMatch(/ask whoever runs the server/i)
    // The point of the message: it must not read as "you are not allowed".
    expect(msg).toMatch(/deliberate setting, not a fault/i)
  })

  it('names the host rather than the whole URL', () => {
    const msg = describeSignupError(new Error('Registration is disabled'), HS)
    expect(msg).toContain('matrix.example.org')
    expect(msg).not.toContain('https://')
  })

  it('tolerates a homeserver that is not a valid URL', () => {
    const msg = describeSignupError(new Error('Registration has been disabled'), 'not a url')
    expect(msg).toContain('not a url')
  })

  it('handles a server that wants a registration token', () => {
    const msg = describeSignupError(new Error('M_MISSING_PARAM registration token'), HS)
    expect(msg).toMatch(/invitation token/i)
  })

  it('says plainly when a username is taken', () => {
    const msg = describeSignupError(new Error('M_USER_IN_USE'), HS)
    expect(msg).toMatch(/already taken/i)
  })

  it('passes an unrecognised error through unchanged', () => {
    // A wrong guess is worse than the raw text: the raw text can be searched
    // for, an invented explanation sends someone the wrong way.
    const msg = describeSignupError(new Error('Some novel server failure'), HS)
    expect(msg).toBe('Some novel server failure')
  })

  it('never returns an empty string', () => {
    expect(describeSignupError(null, HS)).toBe('Registration failed')
    expect(describeSignupError(new Error(''), HS)).toBe('Registration failed')
  })
})
