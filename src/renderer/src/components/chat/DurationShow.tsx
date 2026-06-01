import React from "react"

interface DurationShowProps {
  durationMs?: number
  text?: string
}

export function DurationShow({
  durationMs,
  text
}: DurationShowProps): React.JSX.Element | null {
  function formatResponseDuration(ms?: number): string | null {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null

    const seconds = ms / 1000
    if (seconds < 60) {
      return `${Math.round(seconds)}s`
    }

    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.round(seconds % 60)
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }

  const label = formatResponseDuration(durationMs)
  if (!label) return null

  return <span className="text-xs text-muted-foreground/70">{text} {label}</span>
}
