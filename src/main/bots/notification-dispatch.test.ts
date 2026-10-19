import { describe, expect, it, vi } from "vitest"
import { createBotNotificationDispatcher } from "./notification-dispatch"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../../shared/internal-notification-turn"

describe("Bot notification routing", () => {
  it("leaves ordinary threads alone and queues local Bot work with trusted group identity", async () => {
    const enqueueNotification = vi.fn()
    let metadata: Record<string, unknown> = { agentMode: "workflow" }
    const dispatch = createBotNotificationDispatcher(
      () => ({ metadata: JSON.stringify(metadata) }),
      () => ({ enqueueNotification })
    )
    const notice = {
      threadId: "group-g-a",
      kind: "workflow" as const,
      key: "wf-1",
      runStartedAt: "2026-10-18T13:00:00.000Z"
    }
    expect(await dispatch(notice)).toBe(false)
    expect(enqueueNotification).not.toHaveBeenCalled()
    metadata = { botId: "a", botHostId: "local", botGroupId: "g" }
    expect(await dispatch(notice)).toBe(true)
    expect(enqueueNotification).toHaveBeenCalledWith(
      "a",
      "group-g-a",
      "workflow",
      "wf-1",
      WORKFLOW_NOTIFICATION_TURN_PROMPT,
      "g",
      notice.runStartedAt
    )
  })
  it("does not run a foreign host locally or silently bypass an unavailable Bot queue", async () => {
    const getHost = vi.fn(() => {
      throw new Error("unavailable")
    })
    let host = "remote"
    const dispatch = createBotNotificationDispatcher(
      () => ({ metadata: JSON.stringify({ botId: "a", botHostId: host }) }),
      getHost
    )
    const notice = { threadId: "t", kind: "coordinator" as const, key: "receipt" }
    expect(await dispatch(notice)).toBe(true)
    expect(getHost).not.toHaveBeenCalled()
    host = "local"
    await expect(dispatch(notice)).rejects.toThrow("unavailable")
  })
})
