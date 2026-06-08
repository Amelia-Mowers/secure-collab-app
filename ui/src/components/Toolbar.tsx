import './Toolbar.css'

interface ToolbarProps {
  title?: string
  subtitle?: string
  breadcrumb?: React.ReactNode
  actions?: React.ReactNode
}

const FilterIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <line x1="1" y1="3" x2="12" y2="3" />
    <line x1="2.5" y1="6.5" x2="10.5" y2="6.5" />
    <line x1="4.5" y1="10" x2="8.5" y2="10" />
  </svg>
)

const SortIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
    <line x1="2.5" y1="2" x2="2.5" y2="11" />
    <polyline points="1,8.5 2.5,11 4,8.5" />
    <line x1="7" y1="3.5" x2="12" y2="3.5" />
    <line x1="7" y1="6.5" x2="10.5" y2="6.5" />
    <line x1="7" y1="9.5" x2="9" y2="9.5" />
  </svg>
)

const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
    <line x1="6.5" y1="1.5" x2="6.5" y2="11.5" />
    <line x1="1.5" y1="6.5" x2="11.5" y2="6.5" />
  </svg>
)

export function Toolbar({ title, subtitle, breadcrumb, actions }: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar__left">
        {breadcrumb ? (
          <div className="toolbar__breadcrumb">{breadcrumb}</div>
        ) : (
          <div className="toolbar__title-wrap">
            {title && <span className="toolbar__title">{title}</span>}
            {subtitle && <span className="toolbar__subtitle">{subtitle}</span>}
          </div>
        )}
      </div>

      <div className="toolbar__right">
        {actions}
      </div>
    </div>
  )
}

export function ToolbarButton({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick?: () => void; active?: boolean }) {
  return (
    <button className={`toolbar__btn${active ? ' toolbar__btn--active' : ''}`} onClick={onClick}>
      {icon}
      {label}
    </button>
  )
}

export function ToolbarPrimaryButton({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  return (
    <button className="toolbar__btn toolbar__btn--primary" onClick={onClick}>
      <PlusIcon />
      {children}
    </button>
  )
}

export { FilterIcon, SortIcon, PlusIcon }
