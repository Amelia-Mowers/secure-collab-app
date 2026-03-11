import './StatusPill.css'

interface StatusPillProps {
  value: string
  /** Optional: predefined colour override */
  color?: string
}

/** Deterministic colour from the option label */
function pillColor(value: string): string {
  const lc = value.toLowerCase()
  if (lc === 'done' || lc === 'complete' || lc === 'completed') return 'var(--pill-green, #22c55e)'
  if (lc.includes('progress') || lc === 'active' || lc === 'in review') return 'var(--pill-blue, #3b82f6)'
  if (lc === 'blocked' || lc === 'cancelled' || lc === 'canceled') return 'var(--pill-red, #ef4444)'
  if (lc === 'todo' || lc === 'backlog' || lc === 'pending') return 'var(--pill-gray, #6b7280)'
  if (lc === 'high' || lc === 'urgent') return 'var(--pill-orange, #f97316)'
  if (lc === 'medium') return 'var(--pill-yellow, #eab308)'
  if (lc === 'low') return 'var(--pill-teal, #14b8a6)'
  // Hash the rest to a consistent palette entry
  const palette = ['#6d9fff', '#a78bfa', '#f472b6', '#34d399', '#fb923c', '#e879f9']
  let h = 0
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) & 0xffff
  return palette[h % palette.length]
}

export function StatusPill({ value, color }: StatusPillProps) {
  const bg = color ?? pillColor(value)
  return (
    <span
      className="status-pill"
      style={{ '--pill-bg': bg } as React.CSSProperties}
    >
      {value}
    </span>
  )
}
