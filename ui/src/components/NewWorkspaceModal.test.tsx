import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewWorkspaceModal, ARCHIVE_OPTION } from './NewWorkspaceModal'
import type { WorkspaceTemplate } from '@/lib/workspaceTemplates'

const TEMPLATES: WorkspaceTemplate[] = [
  {
    slug: 'demo',
    name: 'Demo Workspace',
    description: 'A project tracker, a CRM, and two kanban boards.',
    tables: [
      { id: 'tasks', name: 'Projects', rows: 8 },
      { id: 'contacts', name: 'Contacts', rows: 4 },
    ],
    files: {},
  },
  {
    slug: 'project-tracker',
    name: 'Project tracker',
    description: 'Tasks with status, assignee, due date, and priority.',
    tables: [{ id: 'tasks', name: 'Tasks', rows: 0 }],
    files: {},
  },
]

function open(onCreate = vi.fn()) {
  render(
    <NewWorkspaceModal templates={TEMPLATES} onCreate={onCreate} onClose={vi.fn()} />,
  )
  return onCreate
}

describe('NewWorkspaceModal', () => {
  it('lists every starting point with its description, defaulting to empty', () => {
    open()
    // The demo is just another template here — not a separate button elsewhere.
    expect(screen.getByText('Demo Workspace')).toBeInTheDocument()
    expect(screen.getByText(/two kanban boards/)).toBeInTheDocument()
    expect(screen.getByText('Project tracker')).toBeInTheDocument()
    expect(screen.getByText('From an archive')).toBeInTheDocument()

    const empty = screen.getByRole('radio', { name: /Empty/ }) as HTMLInputElement
    expect(empty.checked).toBe(true)
  })

  it('creates an empty workspace by default', () => {
    const onCreate = open()
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'Mine' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(onCreate).toHaveBeenCalledWith('Mine', '', null)
  })

  it('passes the chosen template through', () => {
    const onCreate = open()
    fireEvent.click(screen.getByRole('radio', { name: /Demo Workspace/ }))
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'Playground' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(onCreate).toHaveBeenCalledWith('Playground', 'demo', null)
  })

  it('will not create from an archive until a file is chosen', () => {
    open()
    fireEvent.click(screen.getByRole('radio', { name: /From an archive/ }))
    fireEvent.change(screen.getByPlaceholderText('Workspace name'), {
      target: { value: 'Restored' },
    })
    // A name alone isn't enough — creating now would silently make an empty
    // workspace, which is not what was asked for.
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeDisabled()
  })

  it('names the workspace after the archive when nothing was typed', () => {
    const onCreate = open()
    fireEvent.click(screen.getByRole('radio', { name: /From an archive/ }))
    const file = new File(['zip'], 'Team Wiki.zip', { type: 'application/zip' })
    fireEvent.change(screen.getByLabelText('Workspace archive'), { target: { files: [file] } })

    expect((screen.getByPlaceholderText('Workspace name') as HTMLInputElement).value).toBe(
      'Team Wiki',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(onCreate).toHaveBeenCalledWith('Team Wiki', ARCHIVE_OPTION, file)
  })
})
