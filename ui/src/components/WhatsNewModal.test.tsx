import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { WhatsNewModal } from './WhatsNewModal'
import { compareVersions, entriesSince, parseChangelog } from '@/lib/changelog'

// vitest.config.ts pins __APP_VERSION__ to 1.2.3 and supplies a three-entry
// changelog (1.2.3, 1.2.2, 1.1.9), so these assert against a fixture rather
// than against whatever the repo's real CHANGELOG.md says today.

const SEEN_KEY = 'tw:whatsNewSeen'

beforeEach(() => {
  localStorage.clear()
})

describe('changelog parsing', () => {
  it('reads every entry, newest first', () => {
    expect(parseChangelog().map(e => e.version)).toEqual(['1.2.3', '1.2.2', '1.1.9'])
  })

  it('keeps the date and body of an entry', () => {
    const [newest] = parseChangelog()
    expect(newest.date).toBe('2026-01-03')
    expect(newest.body).toContain('**Third** thing')
  })

  it('orders versions numerically, not as strings', () => {
    // The bug this prevents: '0.1.10' < '0.1.9' lexically, so a user on 0.1.9
    // would never be shown 0.1.10.
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('returns only entries between what was seen and what is running', () => {
    expect(entriesSince('1.1.9').map(e => e.version)).toEqual(['1.2.3', '1.2.2'])
    expect(entriesSince('1.2.3')).toEqual([])
  })

  it('never announces a release newer than the running bundle', () => {
    // A tab on an old bundle must not advertise what it cannot show.
    expect(entriesSince('1.1.9', '1.2.2').map(e => e.version)).toEqual(['1.2.2'])
  })

  it('shows nothing when nothing has been seen', () => {
    expect(entriesSince(null)).toEqual([])
  })
})

describe('WhatsNewModal', () => {
  it('does not interrupt a first-time user, but records their version', async () => {
    render(<WhatsNewModal />)
    await waitFor(() => expect(localStorage.getItem(SEEN_KEY)).toBe('1.2.3'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the entries a returning user has missed', async () => {
    localStorage.setItem(SEEN_KEY, '1.1.9')
    render(<WhatsNewModal />)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('1.2.3')
    expect(dialog).toHaveTextContent('1.2.2')
    // Already seen — must not reappear.
    expect(dialog).not.toHaveTextContent('1.1.9')
  })

  it('joins a wrapped bullet into one sentence', async () => {
    localStorage.setItem(SEEN_KEY, '1.1.9')
    render(<WhatsNewModal />)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Second thing continued on the next line')
  })

  it('renders **bold** rather than printing the asterisks', async () => {
    localStorage.setItem(SEEN_KEY, '1.2.2')
    render(<WhatsNewModal />)
    await screen.findByRole('dialog')
    expect(screen.getByText('Third')).toBeInTheDocument()
    expect(screen.queryByText(/\*\*/)).toBeNull()
  })

  it('stays dismissed: closing records the running version', async () => {
    localStorage.setItem(SEEN_KEY, '1.1.9')
    render(<WhatsNewModal />)
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(localStorage.getItem(SEEN_KEY)).toBe('1.2.3')
  })

  it('shows nothing when the user is already current', async () => {
    localStorage.setItem(SEEN_KEY, '1.2.3')
    render(<WhatsNewModal />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
