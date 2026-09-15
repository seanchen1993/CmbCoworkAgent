import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { ensureAppNotificationsSchema } from "../db/app-notifications-schema"
import type { AppNotification } from "../../shared/app-notifications"

const dependencies = vi.hoisted(() => ({
  database: undefined as NativeSqliteAdapter | undefined,
  enqueue: vi.fn(),
  grant: vi.fn(),
  conversation: vi.fn()
}))
vi.mock("../db", () => ({
  getDb: () => dependencies.database,
  getThread: () => ({ title: "Thread" }),
  getThreadMessages: () => []
}))
vi.mock("./im/event-store", () => ({
  imEventStore: { enqueueProactiveReplies: dependencies.enqueue }
}))
vi.mock("./im/remote-access-service", () => ({
  imRemoteAccessService: {
    getThreadGrant: dependencies.grant,
    getFeatureGrant: () => undefined
  }
}))
vi.mock("./im/conversation-state", () => ({
  imConversationStateStore: {
    getConversation: dependencies.conversation
  }
}))

let sqlite: DatabaseSync
let service: (typeof import("./notification-service"))["notificationService"]
let store: (typeof import("./app-notifications"))["appNotificationStore"]
let channels: typeof import("./notification-channels")
let actions: typeof import("./notification-actions")
let observe: (typeof import("./notification-service"))["onNotificationChanged"]

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
  vi.setSystemTime(new Date("2026-09-13T00:00:00Z"))
  sqlite = new DatabaseSync(":memory:")
  dependencies.database = new NativeSqliteAdapter(sqlite)
  ensureAppNotificationsSchema(dependencies.database)
  dependencies.enqueue.mockResolvedValue(undefined)
  dependencies.grant.mockReturnValue({
    state: "active",
    principalId: "user",
    conversationKey: "chat"
  })
  dependencies.conversation.mockReturnValue({ state: "active", principalId: "user" })
  const lifecycle = await import("./notification-service")
  service = lifecycle.notificationService
  observe = lifecycle.onNotificationChanged
  store = (await import("./app-notifications")).appNotificationStore
  channels = await import("./notification-channels")
  actions = await import("./notification-actions")
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  sqlite.close()
})
function create(type = "human_gate", id = "message"): AppNotification {
  return service.create({
    notificationId: id,
    kind: "decision",
    type,
    title: "确认",
    message: "请确认",
    targets: ["app_view", "im"],
    payload: {
      projectId: "project",
      featureId: "feature",
      sourceThreadId: "thread",
      humanGate: { hookId: "hook" },
      bizRetry: {}
    }
  })
}
function seed(
  id: string,
  completedAt: string,
  status: AppNotification["status"] = "resolved"
): void {
  store.insert({
    notificationId: id,
    kind: "decision",
    type: "biz_retry",
    status,
    targets: ["app_view"],
    payload: {},
    title: "历史",
    message: "历史",
    createdAt: completedAt,
    updatedAt: completedAt,
    completedAt: status === "pending" ? undefined : completedAt
  })
}

describe("message persistence and retention", () => {
  it("publishes only after persistence, keeps completion in one column, and rejects a second finish", () => {
    const seen: AppNotification[] = []
    observe((value) => {
      seen.push(service.get(value.notificationId)!)
    })
    create()
    expect(seen[0].createdAt).toBe("2026-09-13 08:00:00")
    expect(
      service.finish("message", {
        status: "resolved",
        reasonCode: "user_decision",
        result: "done",
        action: "approve",
        channel: "desktop"
      })
    ).toBe(true)
    expect(
      service.finish("message", {
        status: "resolved",
        reasonCode: "user_decision",
        result: "done",
        action: "reject",
        channel: "im"
      })
    ).toBe(false)
    expect(seen).toHaveLength(2)
    expect(service.get("message")?.action).toBe("approve")
    const row = sqlite.prepare("SELECT * FROM app_messages").get()!
    expect(row.completed_at).toBe("2026-09-13 08:00:00")
    expect(JSON.parse(String(row.envelope_json))).not.toHaveProperty("completedAt")
  })

  it("does not publish an insertion that failed", () => {
    create()
    const listener = vi.fn()
    observe(listener)
    expect(() => create()).toThrow()
    expect(listener).not.toHaveBeenCalled()
  })

  it("reads domain pending messages directly from storage without initialization", async () => {
    create()
    create("other_source", "unrelated")
    const { harnessNotifications } = await import("../harness-board/notifications")
    expect(harnessNotifications.pending().map((value) => value.notificationId)).toEqual(["message"])
    service.disableChannel("message", "im")
    expect(harnessNotifications.pending()[0].disabledTargets?.im).toBe(true)
    create("biz_retry", "second")
    expect(harnessNotifications.pending()).toHaveLength(2)
    service.finish("message", {
      status: "resolved",
      channel: "desktop",
      reasonCode: "user_decision",
      result: "done"
    })
    expect(harnessNotifications.pending().map((value) => value.notificationId)).toEqual(["second"])
    // Even a storage change without a lifecycle broadcast must be visible on the next read.
    sqlite.exec("UPDATE app_messages SET status='invalidated' WHERE notification_id='second'")
    expect(harnessNotifications.pending()).toEqual([])
  })

  it("recovers pending records without reading them again by id", async () => {
    create()
    const get = vi.spyOn(store, "get")
    await service.recover()
    expect(get).not.toHaveBeenCalled()
    expect(store.get("message")?.status).toBe("invalidated")
  })

  it("paginates tied timestamps without skipping valid records after malformed JSON", () => {
    for (let i = 0; i < 405; i++) seed(String(i).padStart(4, "0"), "2026-09-01 08:00:00")
    sqlite.exec("UPDATE app_messages SET envelope_json='broken' WHERE notification_id='0205'")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const ids: string[] = []
    let cursor: import("./app-notifications").NotificationCursor | undefined
    let rows = 0
    do {
      const page = store.recoveryPage("terminal", "2026-07-15 08:00:00", cursor)
      rows += page.count
      ids.push(...page.values.map((item) => item.notificationId))
      cursor = page.count ? page.cursor : undefined
    } while (cursor)
    expect(rows).toBe(405)
    expect(new Set(ids).size).toBe(404)
    expect(ids).toContain("0000")
  })

  it("deletes terminal messages of any kind in bounded batches, preserving the cutoff and pending messages", () => {
    for (let i = 0; i < 205; i++) seed(`old-${i}`, "2026-07-15 07:59:59")
    seed("boundary", "2026-07-15 08:00:00")
    seed("pending", "2020-01-01 00:00:00", "pending")
    seed("info", "2020-01-01 00:00:00")
    sqlite.exec("UPDATE app_messages SET kind='information' WHERE notification_id='info'")
    expect(store.deleteExpiredBatch("2026-07-15 08:00:00")).toBe(200)
    expect(store.deleteExpiredBatch("2026-07-15 08:00:00")).toBe(6)
    expect(store.deleteExpiredBatch("2026-07-15 08:00:00")).toBe(0)
    for (const id of ["boundary", "pending"]) expect(store.get(id)).toBeDefined()
    expect(store.get("info")).toBeUndefined()
  })

  it("counts all terminal kinds toward overflow without extending pending-decision recovery", () => {
    seed("decision", "2026-09-01 08:00:00")
    seed("info-old", "2026-08-01 08:00:00")
    seed("info-new", "2026-09-02 08:00:00", "invalidated")
    seed("info-pending", "2020-01-01 00:00:00", "pending")
    sqlite.exec("UPDATE app_messages SET kind='information' WHERE notification_id LIKE 'info-%'")
    expect(store.recoveryPage("pending", "2026-07-15 08:00:00").values).toEqual([])
    expect(
      store
        .recoveryPage("terminal", "2026-07-15 08:00:00")
        .values.map((item) => item.notificationId)
    ).toEqual(["info-new", "decision", "info-old"])
    expect(store.deleteOverflowBatch(1)).toBe(2)
    expect(store.get("info-new")).toBeDefined()
    expect(store.get("info-pending")).toBeDefined()
    expect(store.get("decision")).toBeUndefined()
    expect(store.get("info-old")).toBeUndefined()
  })

  it("replaces the decision-only index and supports repeated schema initialization", () => {
    sqlite.exec(`DROP INDEX idx_app_messages_terminal;
      CREATE INDEX idx_app_messages_completed ON app_messages(completed_at DESC, notification_id DESC)
      WHERE kind='decision' AND status IN ('resolved', 'invalidated')`)
    seed("info", "2020-01-01 00:00:00")
    sqlite.exec("UPDATE app_messages SET kind='information' WHERE notification_id='info'")
    ensureAppNotificationsSchema(dependencies.database!)
    ensureAppNotificationsSchema(dependencies.database!)
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name='idx_app_messages_completed'").get()
    ).toBeUndefined()
    expect(store.deleteExpiredBatch("2026-07-15 08:00:00")).toBe(1)
  })

  it("recovers pending decisions, limits historical replay to 10000 and cleans daily", async () => {
    sqlite.exec("BEGIN")
    for (let i = 0; i < 10005; i++)
      seed(`recent-${String(i).padStart(5, "0")}`, "2026-09-01 08:00:00")
    seed("expired", "2026-01-01 00:00:00")
    create("human_gate", "waiting")
    sqlite.exec("COMMIT")
    const replayed: string[] = []
    observe((value, change) => {
      if (change === "recovered") replayed.push(value.notificationId)
    })
    const delivery = vi.fn()
    channels.registerNotificationChannel("im", "im", { created: delivery, ended: vi.fn() })
    await service.recover()
    expect(service.get("waiting")).toMatchObject({
      status: "invalidated",
      reasonCode: "app_restarted"
    })
    expect(replayed).toHaveLength(10000)
    expect(replayed).not.toContain("expired")
    expect(store.get("recent-00000")).toBeUndefined()
    expect(store.get("expired")).toBeUndefined()
    expect(delivery).not.toHaveBeenCalled()
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM app_messages").get()!.n).toBe(10000)
    seed("daily", "2026-01-01 00:00:00")
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
    expect(store.get("daily")).toBeDefined()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(store.get("daily")).toBeUndefined()
  })
})

describe("notification routing", () => {
  it("keeps projection invalidation separate from writes, lifecycle events and delivery", async () => {
    const { invalidateNotificationProjection, onNotificationProjectionChanged } =
      await import("./notification-read-model")
    const changed = vi.fn()
    onNotificationProjectionChanged(changed)
    const delivery = vi.fn()
    channels.registerNotificationChannel("projection-test", "im", {
      created: delivery,
      ended: delivery
    })
    create()
    const before = service.get("message")
    const lifecycle = vi.fn()
    observe(lifecycle)
    delivery.mockClear()
    changed.mockClear()
    invalidateNotificationProjection("message")
    expect(changed).toHaveBeenCalledExactlyOnceWith("message")
    expect(lifecycle).not.toHaveBeenCalled()
    expect(delivery).not.toHaveBeenCalled()
    expect(service.get("message")).toEqual(before)
  })

  it("routes by source, isolates delivery failure and signals disabled targets without re-delivering", async () => {
    const { onNotificationProjectionChanged } = await import("./notification-read-model")
    const changed = vi.fn()
    onNotificationProjectionChanged(changed)
    const imEnded = vi.fn()
    const unrelated = vi.fn()
    const broken = vi.fn(() => Promise.reject(new Error("offline")))
    vi.spyOn(console, "warn").mockImplementation(() => {})
    channels.registerNotificationChannel(
      "broken",
      "im",
      { created: broken, ended: imEnded },
      "human_gate"
    )
    channels.registerNotificationChannel(
      "other",
      "im",
      { created: unrelated, ended: unrelated },
      "biz_retry"
    )
    create()
    expect(changed).toHaveBeenCalledExactlyOnceWith("message")
    changed.mockClear()
    await Promise.resolve()
    service.disableChannel("message", "im")
    expect(broken).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledExactlyOnceWith("message")
    expect(imEnded).toHaveBeenCalledTimes(1)
    expect(unrelated).not.toHaveBeenCalled()
    expect(service.get("message")?.status).toBe("pending")
  })

  it("rejects unsupported or disabled actions and keeps failed domain actions pending", async () => {
    create()
    const handler = vi.fn(async () => ({ applied: false, message: "retry" }))
    actions.registerNotificationActions("human_gate", handler)
    service.disableChannel("message", "im")
    expect(
      (
        await actions.decideNotification(
          { notificationId: "message", action: "approve" },
          { channel: "im" }
        )
      ).applied
    ).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    await actions.decideNotification(
      { notificationId: "message", action: "approve" },
      { channel: "desktop" }
    )
    expect(handler).toHaveBeenCalledTimes(1)
    expect(service.get("message")?.status).toBe("pending")
    create("unknown", "unsupported")
    expect(
      (
        await actions.decideNotification(
          { notificationId: "unsupported", action: "x" },
          { channel: "desktop" }
        )
      ).applied
    ).toBe(false)
  })
})

for (const source of ["human_gate", "biz_retry"] as const) {
  describe(`${source} IM lifecycle with real message persistence`, () => {
    async function setup(drainer?: Pick<import("./im/reply-client").ImReplyClient, "sendPending">) {
      const gate = await import("./im/human-gate-adapter")
      const retry = await import("./im/biz-retry-adapter")
      gate.initializeImHumanGateChannel()
      retry.initializeImBizRetryChannel()
      const handler = vi.fn(
        async (
          notification: AppNotification,
          input: { action: string },
          origin: { channel: "desktop" | "im" }
        ) => ({
          applied: service.finish(notification.notificationId, {
            status: "resolved",
            reasonCode: "user_decision",
            result: "done",
            action: input.action,
            channel: origin.channel
          }),
          message: "done"
        })
      )
      actions.registerNotificationActions(source, handler)
      const resolve = (code: string, principalId = "user", conversationKey = "chat") =>
        source === "human_gate"
          ? gate.imHumanGateAdapter.resolveCode({
              code,
              decision: "approve",
              principalId,
              conversationKey
            })
          : retry.imBizRetryAdapter.resolveCode({
              code,
              choice: "continue",
              principalId,
              conversationKey
            })
      const adapter = source === "human_gate" ? gate.imHumanGateAdapter : retry.imBizRetryAdapter
      if (drainer) adapter.registerReplyDrainer(drainer)
      create(source)
      await Promise.resolve()
      const sent = JSON.stringify(dependencies.enqueue.mock.calls[0])
      const code = sent.match(
        source === "human_gate" ? /门禁批准 ([A-F0-9]{6})/ : /停止托管运行 ([A-F0-9]{6})/
      )?.[1]
      expect(code).toBeDefined()
      return { code: code!, resolve, handler, adapter }
    }
    it("APP completion invalidates the IM code and prevents a second action", async () => {
      const { code, resolve, handler } = await setup()
      await actions.decideNotification(
        { notificationId: "message", action: "approve" },
        { channel: "desktop" }
      )
      await resolve(code)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(service.get("message")?.channel).toBe("desktop")
    })
    it("IM completion removes the APP pending message and rejects repeated IM/APP decisions", async () => {
      const { onNotificationProjectionChanged } = await import("./notification-read-model")
      const changed = vi.fn()
      onNotificationProjectionChanged(changed)
      const { code, resolve, handler } = await setup()
      changed.mockClear()
      await resolve(code)
      expect(service.pending()).toEqual([])
      expect(changed).toHaveBeenCalledExactlyOnceWith("message")
      await resolve(code)
      await actions.decideNotification(
        { notificationId: "message", action: "approve" },
        { channel: "desktop" }
      )
      expect(handler).toHaveBeenCalledTimes(1)
      expect(service.get("message")?.channel).toBe("im")
    })
    it("rejects another principal or conversation without consuming the valid code", async () => {
      const { code, resolve, handler } = await setup()
      await resolve(code, "intruder")
      await resolve(code, "user", "other-chat")
      expect(handler).not.toHaveBeenCalled()
      await resolve(code)
      expect(handler).toHaveBeenCalledTimes(1)
    })
    it("keeps a temporarily rejected code retryable and returns the domain reason", async () => {
      const { code, resolve, handler } = await setup()
      handler.mockResolvedValueOnce({ applied: false, message: "请先处理 Human Gate" })
      expect(await resolve(code)).toBe("请先处理 Human Gate")
      expect(service.get("message")?.status).toBe("pending")
      await resolve(code)
      expect(handler).toHaveBeenCalledTimes(2)
      expect(service.get("message")?.status).toBe("resolved")
    })
    it("cleans a code when its runtime is invalidated without a persistent ended event", async () => {
      const { code, resolve, handler } = await setup()
      const { registerNotificationVisibility } = await import("./notification-read-model")
      registerNotificationVisibility(source, () => false)
      expect(await resolve(code)).toContain("已失效")
      registerNotificationVisibility(source, () => true)
      expect(await resolve(code)).toContain("已失效")
      expect(handler).not.toHaveBeenCalled()
      expect(service.get("message")?.status).toBe("pending")
    })
    it("cleans a code when outbox insertion fails, while retaining APP action", async () => {
      dependencies.enqueue.mockRejectedValue(new Error("disk failure"))
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const { code, resolve, handler } = await setup()
      await Promise.resolve()
      await resolve(code)
      expect(handler).not.toHaveBeenCalled()
      expect(service.pending()).toHaveLength(1)
    })
    it("disabling IM invalidates its code while APP remains actionable", async () => {
      const { code, resolve, handler } = await setup()
      service.disableChannel("message", "im")
      await resolve(code)
      expect(handler).not.toHaveBeenCalled()
      expect(service.pending()).toHaveLength(1)
      await actions.decideNotification(
        { notificationId: "message", action: "approve" },
        { channel: "desktop" }
      )
      expect(handler).toHaveBeenCalledTimes(1)
    })
    it("retains the code when an already queued reply temporarily fails to send", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const sendPending = vi.fn(async () => {
        throw new Error("network offline")
      })
      const { code, resolve, handler } = await setup({ sendPending })
      await Promise.resolve()
      expect(sendPending).toHaveBeenCalledTimes(1)
      await resolve(code)
      expect(handler).toHaveBeenCalledTimes(1)
    })
    it("does not send to an inactive grant or mismatched conversation", async () => {
      const gate = await import("./im/human-gate-adapter")
      const retry = await import("./im/biz-retry-adapter")
      gate.initializeImHumanGateChannel()
      retry.initializeImBizRetryChannel()
      dependencies.grant.mockReturnValueOnce({ state: "revoked" })
      create(source, "inactive")
      dependencies.conversation.mockReturnValue({ state: "active", principalId: "someone-else" })
      create(source, "mismatched")
      await Promise.resolve()
      expect(dependencies.enqueue).not.toHaveBeenCalled()
      expect(service.pending()).toHaveLength(2)
    })
    it("restart invalidates its code without re-sending IM requests", async () => {
      const { code, resolve, handler } = await setup()
      await service.recover()
      await resolve(code)
      expect(handler).not.toHaveBeenCalled()
      expect(dependencies.enqueue).toHaveBeenCalledTimes(1)
    })
  })
}
