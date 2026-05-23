import type { GoalEvent } from "@/types"

const goalEventTimeMs = (event: GoalEvent): number => {
  const date = event.created_at instanceof Date ? event.created_at : new Date(event.created_at)
  const time = date.getTime()
  return Number.isFinite(time) ? time : 0
}

export function mergeGoalUiEvents(
  restoredEvents: readonly GoalEvent[],
  currentEvents: readonly GoalEvent[]
): GoalEvent[] {
  const byId = new Map<number, GoalEvent>()
  for (const event of restoredEvents) byId.set(event.event_id, event)
  for (const event of currentEvents) byId.set(event.event_id, event)
  return Array.from(byId.values()).sort((left, right) => {
    const timeDelta = goalEventTimeMs(left) - goalEventTimeMs(right)
    return timeDelta || left.event_id - right.event_id
  })
}
