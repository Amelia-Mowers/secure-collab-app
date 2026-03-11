import { useState, useEffect } from 'react'
import './LoadingSpinner.css'

interface LoadingSpinnerProps {
  message?: string
  /** If provided, a "Reset app" link appears after a delay. */
  onReset?: () => void
  /** Seconds before showing the reset link (default 8). */
  resetDelay?: number
}

export function LoadingSpinner({
  message = 'Loading...',
  onReset,
  resetDelay = 8,
}: LoadingSpinnerProps) {
  const [showReset, setShowReset] = useState(false)

  useEffect(() => {
    if (!onReset) return
    const timer = setTimeout(() => setShowReset(true), resetDelay * 1000)
    return () => clearTimeout(timer)
  }, [onReset, resetDelay])

  return (
    <div className="loading-spinner-container">
      <div className="loading-spinner">
        <div className="spinner"></div>
      </div>
      <p className="loading-message">{message}</p>
      {showReset && onReset && (
        <button className="loading-reset" onClick={onReset} type="button">
          Taking too long? Reset app data
        </button>
      )}
    </div>
  )
}
