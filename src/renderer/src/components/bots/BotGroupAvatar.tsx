import type { BotDefinition } from "../../../../shared/bots/contracts"
import { BotAvatar } from "./BotAvatar"

/** The same member identity cluster is used in the list, header and detail panel. */
export function BotGroupAvatar({
  memberIds,
  bots,
  size
}: {
  memberIds: readonly string[]
  bots: readonly BotDefinition[]
  size?: number
}) {
  return (
    <div
      className="bot-group-avatar"
      data-count={Math.min(memberIds.length, 3)}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      {memberIds.slice(0, 3).map((id) => {
        const member = bots.find((bot) => bot.id === id)
        return (
          <BotAvatar key={id} color={member?.color ?? "#168bea"} shape={member?.shape} size={28} />
        )
      })}
    </div>
  )
}
