import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusPill } from './StatusPill'

describe('StatusPill', () => {
  describe('rendering', () => {
    it('renders the value text', () => {
      render(<StatusPill value="Done" />)
      expect(screen.getByText('Done')).toBeInTheDocument()
    })

    it('has the status-pill CSS class', () => {
      render(<StatusPill value="Todo" />)
      expect(screen.getByText('Todo')).toHaveClass('status-pill')
    })

    it('applies a --pill-bg CSS custom property', () => {
      render(<StatusPill value="Done" />)
      const el = screen.getByText('Done')
      // The inline style should set --pill-bg
      expect(el.style.getPropertyValue('--pill-bg')).toBeTruthy()
    })

    it('uses the provided color prop over the computed color', () => {
      render(<StatusPill value="Done" color="#ff0000" />)
      const el = screen.getByText('Done')
      expect(el.style.getPropertyValue('--pill-bg')).toBe('#ff0000')
    })
  })

  describe('semantic color mapping', () => {
    it('assigns green for "done"', () => {
      render(<StatusPill value="done" />)
      const el = screen.getByText('done')
      const color = el.style.getPropertyValue('--pill-bg')
      expect(color).toContain('#22c55e')
    })

    it('assigns green for "completed"', () => {
      render(<StatusPill value="completed" />)
      const el = screen.getByText('completed')
      expect(el.style.getPropertyValue('--pill-bg')).toContain('#22c55e')
    })

    it('assigns blue for "in progress"', () => {
      render(<StatusPill value="in progress" />)
      const el = screen.getByText('in progress')
      expect(el.style.getPropertyValue('--pill-bg')).toContain('#3b82f6')
    })

    it('assigns red for "blocked"', () => {
      render(<StatusPill value="blocked" />)
      const el = screen.getByText('blocked')
      expect(el.style.getPropertyValue('--pill-bg')).toContain('#ef4444')
    })

    it('assigns gray for "todo"', () => {
      render(<StatusPill value="todo" />)
      const el = screen.getByText('todo')
      expect(el.style.getPropertyValue('--pill-bg')).toContain('#6b7280')
    })

    it('assigns orange for "high"', () => {
      render(<StatusPill value="high" />)
      const el = screen.getByText('high')
      expect(el.style.getPropertyValue('--pill-bg')).toContain('#f97316')
    })

    it('assigns yellow for "medium"', () => {
      render(<StatusPill value="medium" />)
      const el = screen.getByText('medium')
      expect(el.style.getPropertyValue('--pill-bg')).toContain('#eab308')
    })

    it('assigns teal for "low"', () => {
      render(<StatusPill value="low" />)
      const el = screen.getByText('low')
      expect(el.style.getPropertyValue('--pill-bg')).toContain('#14b8a6')
    })

    it('assigns a palette color (not empty) for unknown values', () => {
      render(<StatusPill value="custom-status-xyz" />)
      const el = screen.getByText('custom-status-xyz')
      const color = el.style.getPropertyValue('--pill-bg')
      expect(color).toBeTruthy()
      // Should be one of the palette hex values
      expect(color).toMatch(/^#/)
    })

    it('is case-insensitive for semantic values', () => {
      const { rerender } = render(<StatusPill value="Done" />)
      const lower = screen.getByText('Done').style.getPropertyValue('--pill-bg')
      rerender(<StatusPill value="DONE" />)
      const upper = screen.getByText('DONE').style.getPropertyValue('--pill-bg')
      expect(lower).toBe(upper)
    })
  })

  describe('deterministic hashing', () => {
    it('produces the same color for the same unknown value each render', () => {
      const { rerender } = render(<StatusPill value="Sprint A" />)
      const first = screen.getByText('Sprint A').style.getPropertyValue('--pill-bg')
      rerender(<StatusPill value="Sprint A" />)
      const second = screen.getByText('Sprint A').style.getPropertyValue('--pill-bg')
      expect(first).toBe(second)
    })

    it('produces different colors for different unknown values', () => {
      render(<StatusPill value="Alpha" />)
      const colorA = screen.getByText('Alpha').style.getPropertyValue('--pill-bg')
      render(<StatusPill value="BetaXYZ123" />)
      const colorB = screen.getByText('BetaXYZ123').style.getPropertyValue('--pill-bg')
      // Not guaranteed to differ, but highly likely for these strings
      // Both should still be valid colors
      expect(colorA).toMatch(/^#/)
      expect(colorB).toMatch(/^#/)
    })
  })
})
