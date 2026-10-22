import type { BotDefinition } from "../../../../shared/bots/contracts"
import { CircleUserRound } from "lucide-react"
import { BotAvatar } from "./BotAvatar"

/** The same member identity cluster is used in the list, header and detail panel. */
export function BotGroupAvatar({
  memberIds,
  bots,
  userInitials,
  size
}: {
  memberIds: readonly string[]
  bots: readonly BotDefinition[]
  userInitials: string
  size?: number
}) {
  const count = Math.min(memberIds.length + 1, 4)
  return (
    <div
      className="bot-group-avatar"
      data-count={count}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      <span
        className="bot-account-button bot-group-avatar-person"
        style={{
          fontSize: ((size ?? 42) * (count === 1 ? 1 : count === 2 ? 2 / 3 : 5 / 9) * 14) / 36
        }}
      >
        {userInitials || <CircleUserRound aria-hidden="true" />}
      </span>
      {memberIds.slice(0, 3).map((id) => {
        const member = bots.find((bot) => bot.id === id)
        return (
          <BotAvatar key={id} color={member?.color ?? "#168bea"} shape={member?.shape} size={28} />
        )
      })}
    </div>
  )
}
