import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MarkdownEditor } from './MarkdownEditor'

describe('MarkdownEditor', () => {
  describe('edit mode (default)', () => {
    it('renders a textarea in edit mode by default', () => {
      render(<MarkdownEditor value="" onChange={vi.fn()} />)
      expect(screen.getByRole('textbox')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()
    })

    it('displays the current value in the textarea', () => {
      render(<MarkdownEditor value="Hello world" onChange={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      expect(textarea.value).toBe('Hello world')
    })

    it('calls onChange when the user types', () => {
      const onChange = vi.fn()
      render(<MarkdownEditor value="" onChange={onChange} />)
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New text' } })
      expect(onChange).toHaveBeenCalledWith('New text')
    })

    it('calls onBlur when the textarea loses focus', () => {
      const onBlur = vi.fn()
      render(<MarkdownEditor value="" onChange={vi.fn()} onBlur={onBlur} />)
      fireEvent.blur(screen.getByRole('textbox'))
      expect(onBlur).toHaveBeenCalledTimes(1)
    })

    it('calls onFocus when the textarea gains focus', () => {
      const onFocus = vi.fn()
      render(<MarkdownEditor value="" onChange={vi.fn()} onFocus={onFocus} />)
      fireEvent.focus(screen.getByRole('textbox'))
      expect(onFocus).toHaveBeenCalledTimes(1)
    })

    it('shows the markdown hint text', () => {
      render(<MarkdownEditor value="" onChange={vi.fn()} />)
      expect(screen.getByText(/Use markdown shortcuts/i)).toBeInTheDocument()
    })
  })

  describe('preview toggle', () => {
    it('switches to preview mode when the Preview button is clicked', () => {
      render(<MarkdownEditor value="# Hello" onChange={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    })

    it('switches back to edit mode from preview', () => {
      render(<MarkdownEditor value="# Hello" onChange={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })
  })

  describe('markdown rendering in preview', () => {
    function renderPreview(markdown: string) {
      render(<MarkdownEditor value={markdown} onChange={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    }

    it('renders h1 headings from # syntax', () => {
      renderPreview('# Project Brief')
      const preview = document.querySelector('.markdown-preview')!
      expect(preview.innerHTML).toContain('<h1>Project Brief</h1>')
    })

    it('renders h2 headings from ## syntax', () => {
      renderPreview('## Background')
      const preview = document.querySelector('.markdown-preview')!
      expect(preview.innerHTML).toContain('<h2>Background</h2>')
    })

    it('renders h3 headings from ### syntax', () => {
      renderPreview('### Details')
      const preview = document.querySelector('.markdown-preview')!
      expect(preview.innerHTML).toContain('<h3>Details</h3>')
    })

    it('renders bold text from **syntax**', () => {
      renderPreview('This is **important** text')
      const preview = document.querySelector('.markdown-preview')!
      expect(preview.innerHTML).toContain('<strong>important</strong>')
    })

    it('renders italic text from *syntax*', () => {
      renderPreview('This is *emphasised* text')
      const preview = document.querySelector('.markdown-preview')!
      expect(preview.innerHTML).toContain('<em>emphasised</em>')
    })

    it('renders inline code from `backtick` syntax', () => {
      renderPreview('Use `npm install` to install')
      const preview = document.querySelector('.markdown-preview')!
      expect(preview.innerHTML).toContain('<code>npm install</code>')
    })

    it('renders hyperlinks from [text](url) syntax', () => {
      renderPreview('[Open](https://example.com)')
      const preview = document.querySelector('.markdown-preview')!
      expect(preview.innerHTML).toContain('<a href="https://example.com"')
      expect(preview.innerHTML).toContain('>Open</a>')
    })

    it('renders an empty preview for empty input', () => {
      renderPreview('')
      const preview = document.querySelector('.markdown-preview')!
      // renderMarkdown returns '' for empty string – wrapped in <p></p>
      expect(preview.innerHTML).toBe('')
    })

    it('renders a realistic document with multiple elements', () => {
      const markdown = [
        '# Bug Report',
        '## Steps to reproduce',
        '1. Open the app',
        'Expected: **no error**',
        'Actual: *crash*',
        'See `console.log` output',
      ].join('\n')
      renderPreview(markdown)
      const preview = document.querySelector('.markdown-preview')!
      expect(preview.innerHTML).toContain('<h1>Bug Report</h1>')
      expect(preview.innerHTML).toContain('<h2>Steps to reproduce</h2>')
      expect(preview.innerHTML).toContain('<strong>no error</strong>')
      expect(preview.innerHTML).toContain('<em>crash</em>')
      expect(preview.innerHTML).toContain('<code>console.log</code>')
    })
  })
})
