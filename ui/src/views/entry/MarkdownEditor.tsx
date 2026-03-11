import { useState } from 'react'
import './MarkdownEditor.css'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onFocus?: () => void
}

export function MarkdownEditor({ value, onChange, onBlur, onFocus }: MarkdownEditorProps) {
  const [showPreview, setShowPreview] = useState(false)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
  }

  // Basic markdown rendering for preview (simplified)
  const renderMarkdown = (text: string): string => {
    if (!text) return ''

    const html = text
      // Headers
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      // Bold
      .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.*?)\*/gim, '<em>$1</em>')
      // Inline code
      .replace(/`(.*?)`/gim, '<code>$1</code>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Line breaks
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')

    return `<p>${html}</p>`
  }

  return (
    <div className="markdown-editor">
      <div className="markdown-toolbar">
        <button
          type="button"
          onClick={() => setShowPreview(!showPreview)}
          className="toolbar-button"
        >
          {showPreview ? 'Edit' : 'Preview'}
        </button>
        <span className="toolbar-label">Markdown Document</span>
      </div>

      {!showPreview ? (
        <textarea
          value={value}
          onChange={handleChange}
          onBlur={onBlur}
          onFocus={onFocus}
          className="markdown-textarea"
          placeholder="Start writing... Use markdown syntax:
# Heading
## Subheading
**bold** *italic* `code`
- Bullet list
1. Numbered list"
          rows={20}
        />
      ) : (
        <div
          className="markdown-preview"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
        />
      )}

      <div className="markdown-hint">
        Tip: Use markdown shortcuts like # for headings, ** for bold, * for italic
      </div>
    </div>
  )
}
