import type { TaskCardItem } from "../../../shared/task-card-types"

const TASK_CARD_UPDATE_TIME =
  /^(\d{4}-\d{2}-\d{2})(?:[T ]((?:[01]\d|2[0-3]):\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i

function getTaskCardUpdateTimestamp(value?: string): number {
  const match = TASK_CARD_UPDATE_TIME.exec(value ?? "")
  if (!match) return Number.NEGATIVE_INFINITY

  const [, date, time = "00:00:00", offset = "+08:00"] = match
  // 先校验日历日期，再应用时区偏移，避免无效日期被自动进位。
  const calendarDate = new Date(`${date}T00:00:00Z`)
  if (
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== date
  ) {
    return Number.NEGATIVE_INFINITY
  }

  const timestamp = Date.parse(`${date}T${time}${offset}`)
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

export function orderTaskCardsByUpdateTime(cards: readonly TaskCardItem[]): TaskCardItem[] {
  return cards
    .map((card) => ({ card, timestamp: getTaskCardUpdateTimestamp(card.updatedTime) }))
    .sort((left, right) =>
      left.timestamp === right.timestamp ? 0 : right.timestamp - left.timestamp
    )
    .map(({ card }) => card)
}
