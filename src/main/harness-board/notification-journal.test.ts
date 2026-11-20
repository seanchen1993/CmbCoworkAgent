import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppNotification } from "../../shared/app-notifications"

const dependencies = vi.hoisted(() => ({
  subscribe: vi.fn(),
  getRun: vi.fn(),
  listEvents: vi.fn(),
  appendEvent: vi.fn()
}))
vi.mock("../services/notification-service", () => ({
  onNotificationChanged: dependencies.subscribe
}))
vi.mock("./managed-run-store", () => ({ managedRunStore: dependencies }))
let listener: (value: AppNotification, change: string) => void
function message(id = "message", runId: string | undefined = "run"): AppNotification {
  return {
    notificationId: id,
    type: "human_gate",
    kind: "decision",
    status: "resolved",
    targets: ["app_view"],
    title: "Gate",
    message: "original",
    result: "approved",
    action: "approve",
    createdAt: "2026-09-01 08:00:00",
    updatedAt: "2026-09-02 09:00:00",
    completedAt: "2026-09-02 09:00:00",
    payload: {
      projectId: "project",
      featureId: "feature",
      sourceThreadId: "thread",
      runId,
      nodeId: "original-stage",
      humanGate: { hookId: "hook" }
    }
  }
}
beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  dependencies.getRun.mockReturnValue({
    snapshot: { decisionBaseline: { nodeId: "current-stage" } }
  })
  dependencies.listEvents.mockReturnValue({ events: [], hasMore: false })
  const module = await import("./notification-journal")
  expect(dependencies.subscribe).not.toHaveBeenCalled()
  module.initializeNotificationJournal()
  module.initializeNotificationJournal()
  expect(dependencies.subscribe).toHaveBeenCalledTimes(1)
  listener = dependencies.subscribe.mock.calls[0][0]
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("domain notification journal", () => {
  it("backfills the original stage, times and text, then deduplicates repeated recovery", () => {
    listener(message(), "recovered")
    listener(message(), "recovered")
    expect(dependencies.appendEvent).toHaveBeenCalledTimes(2)
    expect(dependencies.getRun).toHaveBeenCalledTimes(1)
    expect(dependencies.appendEvent.mock.calls[0][1]).toMatchObject({
      type: "decision_notification_created",
      notificationStatus: "pending",
      gateId: "message",
      nodeId: "original-stage",
      summary: "original",
      notificationAction: undefined
    })
    expect(dependencies.appendEvent.mock.calls[0][2]).toBe("2026-09-01 08:00:00")
    expect(dependencies.appendEvent.mock.calls[1][1]).toMatchObject({
      type: "decision_notification_ended",
      notificationAction: "approve",
      summary: "approved"
    })
    expect(dependencies.appendEvent.mock.calls[1][2]).toBe("2026-09-02 09:00:00")
  })

  it("uses all persisted journal pages to avoid duplicating existing history", () => {
    dependencies.listEvents
      .mockReturnValueOnce({
        events: [{ type: "decision_notification_ended", notificationId: "message" }],
        hasMore: true,
        nextCursor: "next"
      })
      .mockReturnValueOnce({
        events: [{ type: "decision_notification_created", notificationId: "message" }],
        hasMore: false
      })
    listener(message(), "recovered")
    expect(dependencies.getRun).not.toHaveBeenCalled()
    expect(dependencies.listEvents).toHaveBeenCalledTimes(2)
    expect(dependencies.listEvents.mock.calls[1][1]).toBe("next")
    expect(dependencies.appendEvent).not.toHaveBeenCalled()
  })

  it("replays 10,000 complete notifications with one scan and no snapshot reads or writes", () => {
    const events = Array.from({ length: 10_000 }, (_, i) => [
      { type: "decision_notification_created", notificationId: String(i) },
      { type: "decision_notification_ended", notificationId: String(i) }
    ]).flat()
    for (let offset = 0; offset < events.length; offset += 200) {
      dependencies.listEvents.mockReturnValueOnce({
        events: events.slice(offset, offset + 200),
        hasMore: offset + 200 < events.length,
        nextCursor: String(offset + 200)
      })
    }
    for (let i = 0; i < 10_000; i++) listener(message(String(i)), "recovered")
    expect(dependencies.listEvents).toHaveBeenCalledTimes(100)
    expect(dependencies.getRun).not.toHaveBeenCalled()
    expect(dependencies.appendEvent).not.toHaveBeenCalled()
  })

  it("ignores channel updates, unrelated sources and messages without a managed run", () => {
    listener(message(), "channel_disabled")
    listener({ ...message(), type: "other" }, "created")
    listener(message("standalone", ""), "created")
    expect(dependencies.getRun).not.toHaveBeenCalled()
  })

  it("retries failed writes without marking them as successfully indexed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    dependencies.appendEvent.mockImplementationOnce(() => {
      throw new Error("disk failure")
    })
    const pending = { ...message(), status: "pending" as const }
    listener(pending, "created")
    listener(pending, "recovered")
    expect(dependencies.appendEvent).toHaveBeenCalledTimes(2)
  })

  it("keeps a recently accessed run when evicting a cold index", () => {
    for (let i = 0; i < 128; i++) listener(message("message", `run-${i}`), "recovered")
    listener(message("message", "run-0"), "recovered")
    listener(message("message", "run-128"), "recovered")
    listener(message("message", "run-0"), "recovered")
    expect(dependencies.listEvents).toHaveBeenCalledTimes(129)
    listener(message("message", "run-1"), "recovered")
    expect(dependencies.listEvents).toHaveBeenCalledTimes(130)
  })

  it("rebuilds an evicted run index from disk, preserving deduplication", () => {
    dependencies.listEvents.mockReturnValue({
      events: [
        { type: "decision_notification_created", notificationId: "message" },
        { type: "decision_notification_ended", notificationId: "message" }
      ],
      hasMore: false
    })
    for (let i = 0; i < 129; i++) listener(message("message", `run-${i}`), "recovered")
    expect(dependencies.listEvents).toHaveBeenCalledTimes(129)
    listener(message("message", "run-0"), "recovered")
    expect(dependencies.listEvents).toHaveBeenCalledTimes(130)
    expect(dependencies.appendEvent).not.toHaveBeenCalled()
  })
})
