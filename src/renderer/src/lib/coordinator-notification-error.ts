/** A new notification turn can replace its own prior error, never an unrelated user error. */
export function shouldClearCoordinatorNotificationError(
  detail: { coordinatorNotificationRunId?: string } | null,
  nextRunId: unknown
): boolean {
  return (
    typeof nextRunId === "string" &&
    nextRunId.length > 0 &&
    typeof detail?.coordinatorNotificationRunId === "string" &&
    detail.coordinatorNotificationRunId.length > 0 &&
    detail.coordinatorNotificationRunId !== nextRunId
  )
}
