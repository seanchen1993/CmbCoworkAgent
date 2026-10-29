import type { FunctionTurnNotice } from "../../../../shared/mods/v2/turn"

export function FunctionTurnNotices({
  notices,
  anchorMessageId
}: {
  notices?: readonly FunctionTurnNotice[]
  anchorMessageId: string
}): React.JSX.Element | null {
  if (!notices?.length) return null
  return (
    <div
      className="mx-auto my-2 max-w-3xl space-y-2"
      data-function-turn-notices
      data-anchor-message-id={anchorMessageId}
    >
      {notices.map((notice) => (
        <p
          key={notice.id}
          data-turn-id={notice.turnId}
          className="whitespace-pre-wrap break-words text-sm text-muted-foreground"
        >
          {notice.text}
        </p>
      ))}
    </div>
  )
}
