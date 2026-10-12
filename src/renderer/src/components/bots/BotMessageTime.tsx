import { memo } from "react"
import { botTranscriptTimeLabel } from "@/lib/bot-transcript-time"

export const BotMessageTime = memo(function BotMessageTime({
  createdAt,
  previous
}: {
  createdAt: number
  previous?: number
}) {
  const label = botTranscriptTimeLabel(createdAt, previous)
  if (!label) return null
  return (
    <div className="bot-time-divider">
      <time dateTime={new Date(createdAt).toISOString()}>{label}</time>
    </div>
  )
})
