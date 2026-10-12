import { formatMessageTimeLabel } from "@/lib/message-bubble-timing"

// Grok Bot 0.66.0 index.eager-app-Cj5f8Gby.js: T$, $p and U$.
// SHA-256 dd5b92add9e5ee9c3d3ed224c68eff2b09f7a4e5204393a1b4076f0258e157cc.
// Preserve the 15-minute / local-calendar boundary without reordering Cmb's
// authoritative sequence or introducing a second transcript state.
const TIMESTAMP_GAP_MS = 900 * 1000

export function botTranscriptTimeLabel(current: number, previous?: number): string | null {
  const label = formatMessageTimeLabel(current)
  if (!label) return null
  const date = new Date(current)
  const before = previous === undefined ? null : new Date(previous)
  if (
    before === null ||
    !Number.isFinite(before.getTime()) ||
    Math.abs(current - before.getTime()) >= TIMESTAMP_GAP_MS ||
    date.getFullYear() !== before.getFullYear() ||
    date.getMonth() !== before.getMonth() ||
    date.getDate() !== before.getDate()
  )
    return label
  return null
}
