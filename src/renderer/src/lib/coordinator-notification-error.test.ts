import { describe, expect, it } from "vitest"
import { shouldClearCoordinatorNotificationError } from "./coordinator-notification-error"

describe("notification error ownership", () => {
  it("clears the previous notification error at the next actual notification turn", () => {
    expect(
      shouldClearCoordinatorNotificationError({ coordinatorNotificationRunId: "failed-A" }, "new-B")
    ).toBe(true)
  })
  it("preserves user errors, same-run errors, and malformed lifecycle events", () => {
    expect(shouldClearCoordinatorNotificationError(null, "new-B")).toBe(false)
    expect(shouldClearCoordinatorNotificationError({}, "new-B")).toBe(false)
    expect(
      shouldClearCoordinatorNotificationError({ coordinatorNotificationRunId: "A" }, "A")
    ).toBe(false)
    expect(
      shouldClearCoordinatorNotificationError({ coordinatorNotificationRunId: "A" }, undefined)
    ).toBe(false)
    expect(shouldClearCoordinatorNotificationError({ coordinatorNotificationRunId: "A" }, "")).toBe(
      false
    )
  })
})
