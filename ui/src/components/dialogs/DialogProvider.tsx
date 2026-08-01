import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import './dialogs.css'

/**
 * Themed replacements for `window.alert`, `confirm` and `prompt`.
 *
 * Why bother: the native ones cannot be styled, they render under
 * "app.tidework.io says" — the least trustworthy chrome in the browser, on a
 * product whose entire pitch is trust — and after a few in one session Chrome
 * offers "prevent this page from creating additional dialogs", which SILENTLY
 * disables them. A user who clicks that gets an app where deleting a table
 * appears to do nothing.
 *
 * They also block. Check Integrity reported its result through `alert()` and
 * froze the tab for the 30+ seconds the check takes.
 *
 * The API is promise-based so call sites read the same as the natives they
 * replace:
 *
 *     if (!(await confirm({ title: 'Delete view?', … }))) return
 *     const name = await prompt({ title: 'Rename table', initial: table.name })
 *
 * FALLBACK: outside a provider these delegate to the native dialogs rather
 * than throwing, so a component rendered standalone (tests, Storybook) still
 * works. `App` mounts the provider once at the root, so users never see that
 * path.
 */

export interface ConfirmOptions {
  title: string
  /** Optional detail under the title. */
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Styles the confirm button as destructive. */
  danger?: boolean
}

export interface PromptOptions {
  title: string
  label?: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
}

export type NoticeKind = 'info' | 'error' | 'success'

interface DialogApi {
  confirm(options: ConfirmOptions): Promise<boolean>
  /** Resolves to the trimmed value, or null if cancelled. */
  prompt(options: PromptOptions): Promise<string | null>
  /** Transient, non-blocking. Errors persist until dismissed. */
  notify(message: ReactNode, kind?: NoticeKind): void
}

const nativeFallback: DialogApi = {
  confirm: async ({ title, message }) =>
    window.confirm(typeof message === 'string' ? `${title}\n\n${message}` : title),
  prompt: async ({ title, initial }) => window.prompt(title, initial ?? '')?.trim() ?? null,
  notify: message => {
    if (typeof message === 'string') window.alert(message)
  },
}

const DialogContext = createContext<DialogApi>(nativeFallback)

export const useDialogs = () => useContext(DialogContext)

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void
}
interface PromptState extends PromptOptions {
  resolve: (value: string | null) => void
}
interface Notice {
  id: number
  message: ReactNode
  kind: NoticeKind
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [promptState, setPromptState] = useState<PromptState | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [notices, setNotices] = useState<Notice[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setNotices(list => list.filter(n => n.id !== id))
  }, [])

  const api = useMemo<DialogApi>(
    () => ({
      confirm: options => new Promise<boolean>(resolve => setConfirmState({ ...options, resolve })),
      prompt: options =>
        new Promise<string | null>(resolve => {
          setPromptValue(options.initial ?? '')
          setPromptState({ ...options, resolve })
        }),
      notify: (message, kind = 'info') => {
        const id = nextId.current++
        setNotices(list => [...list, { id, message, kind }])
        // An error stays until dismissed — it is usually the only record of
        // what went wrong. Anything else clears itself.
        if (kind !== 'error') setTimeout(() => dismiss(id), 4000)
      },
    }),
    [dismiss],
  )

  const closeConfirm = (ok: boolean) => {
    confirmState?.resolve(ok)
    setConfirmState(null)
  }
  const closePrompt = (value: string | null) => {
    promptState?.resolve(value)
    setPromptState(null)
  }

  return (
    <DialogContext.Provider value={api}>
      {children}

      {confirmState && (
        <div className="modal-overlay" onClick={() => closeConfirm(false)}>
          <div
            className="modal dlg"
            role="alertdialog"
            aria-modal="true"
            aria-label={confirmState.title}
            onClick={e => e.stopPropagation()}
          >
            <h2 className="dlg__title">{confirmState.title}</h2>
            {confirmState.message && <div className="dlg__message">{confirmState.message}</div>}
            <div className="dlg__actions">
              <button className="ghost" onClick={() => closeConfirm(false)}>
                {confirmState.cancelLabel ?? 'Cancel'}
              </button>
              <button
                className={confirmState.danger ? 'dlg__danger' : 'primary'}
                onClick={() => closeConfirm(true)}
                autoFocus
              >
                {confirmState.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {promptState && (
        <div className="modal-overlay" onClick={() => closePrompt(null)}>
          <form
            className="modal dlg"
            role="dialog"
            aria-modal="true"
            aria-label={promptState.title}
            onClick={e => e.stopPropagation()}
            onSubmit={e => {
              e.preventDefault()
              closePrompt(promptValue.trim() || null)
            }}
          >
            <h2 className="dlg__title">{promptState.title}</h2>
            {promptState.label && (
              <label className="dlg__label" htmlFor="dlg-prompt">
                {promptState.label}
              </label>
            )}
            <input
              id="dlg-prompt"
              className="dlg__input"
              value={promptValue}
              placeholder={promptState.placeholder}
              onChange={e => setPromptValue(e.target.value)}
              autoFocus
              autoComplete="off"
            />
            <div className="dlg__actions">
              <button type="button" className="ghost" onClick={() => closePrompt(null)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!promptValue.trim()}>
                {promptState.confirmLabel ?? 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {notices.length > 0 && (
        <div className="dlg-notices" role="status" aria-live="polite">
          {notices.map(n => (
            <div key={n.id} className={`dlg-notice dlg-notice--${n.kind}`}>
              <span className="dlg-notice__text">{n.message}</span>
              <button
                className="dlg-notice__dismiss"
                onClick={() => dismiss(n.id)}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </DialogContext.Provider>
  )
}
