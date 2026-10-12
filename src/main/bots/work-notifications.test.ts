import { afterEach, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { BotStore } from "./store"
import { BotWorkNotifications } from "./work-notifications"
import { BotNotificationFeed, notificationWork } from "./notification-feed"
import { BotNotificationPresenter } from "./notification-presenter"
import { BotNotificationMonitor } from "./notification-monitor"
import {
  botNotificationTargets,
  botNotificationTargetKey,
  type BotNotificationTarget
} from "../../shared/bot-work-notifications"
import { BotWorkflowStore } from "./workflow-store"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture(maxBots?: number) {
  let now = 10000
  const store = new BotStore(":memory:", () => now, maxBots)
  stores.push(store)
  const owner = store.createBot({ nonce: "owner", name: "Engineer" }),
    helper = new BotWorkNotifications(store)
  let nonce = 0
  const task = () => {
    store.send({
      nonce: `task-${++nonce}`,
      conversationId: owner.conversationId,
      text: "PRIVATE_TASK"
    })
    return store.claim("fixture")!
  }
  const snapshot = (targets: BotNotificationTarget[] = []) =>
    store.readTransaction(() => {
      const snap = store.snapshot(
        {
          runProjection: "summary",
          workProjection: "paged",
          hostId: "fixture",
          dataEpoch: "initial"
        },
        "fixture"
      )
      snap.hostId = "fixture" // The production RPC attaches the held Host identity.
      const work = notificationWork(snap)!
      work.noticeStates = helper.states(targets, "fixture", "initial")
      for (const item of work.attention) {
        const route = helper.attention(item)
        if (route) item.notificationRoute = route
      }
      return snap
    })
  const frame = (targets: BotNotificationTarget[] = []) => ({
    snapshot: snapshot(targets),
    preferences: [],
    focused: false,
    now
  })
  const events = (after: number, through = store.snapshot().cursor) =>
    helper.events({ hostId: "fixture", dataEpoch: "initial", after, through }, "fixture")
  return {
    store,
    owner,
    helper,
    task,
    snapshot,
    frame,
    events,
    advance: (ms: number) => {
      now += ms
    }
  }
}

it("projects a durable exact completion without cached queue history or raw event contents", () => {
  const f = fixture(),
    feed = new BotNotificationFeed()
  feed.seed(f.frame())
  const task = f.task()
  f.store.finish(task.lease, "succeeded", "PRIVATE_RESULT")
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('fixture.private','private','{\"secret\":\"NEVER_RETURN\"}',10000)"
  )
  const snap = f.snapshot(),
    page = f.events(feed.cursor!, snap.cursor)
  expect(snap.runs).toEqual([])
  expect(snap.interactions).toEqual([])
  const settled = page.events.find((event) => event.kind === "run.settled")!
  expect(settled.completion?.target).toMatchObject({
    runId: task.run.id,
    fence: task.lease.fence,
    kind: "completion"
  })
  expect(
    f.store.message({
      id: settled.completion!.link.messageId,
      conversationId: f.owner.conversationId
    }).text
  ).toBe("PRIVATE_RESULT")
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE_|NEVER_RETURN|payload/)
  const notices = feed.consume({ ...f.frame(), snapshot: snap }, page.events)
  expect(notices).toHaveLength(1)
  expect(notices[0].link).toEqual(settled.completion!.link)
  expect(f.helper.states([notices[0].authority!.target], "fixture", "initial")[0].current).toBe(
    true
  )
  expect(feed.consume(f.frame(), page.events)).toEqual([])
})

it("rejects cross-owner and oversized reads, and checks exact branch, fence and interaction revision", () => {
  const f = fixture(),
    task = f.task()
  const card = f.store.requestInteraction(task.lease, {
    kind: "question",
    prompt: "PRIVATE_QUESTION"
  })
  const attention = notificationWork(f.snapshot())!.attention[0],
    target = attention.notificationRoute!.target
  expect(f.helper.states([target], "fixture", "initial")).toEqual([
    { key: botNotificationTargetKey(target), current: true }
  ])
  for (const changed of [
    { ...target, fence: target.fence + 1 },
    { ...target, threadRootId: "foreign" },
    { ...target, conversationId: "foreign" },
    { ...target, botId: "foreign" },
    { ...target, revision: card.revision + 1 }
  ])
    expect(f.helper.states([changed], "fixture", "initial")[0].current).toBe(false)
  expect(botNotificationTargets.safeParse(Array(33).fill(target)).success).toBe(false)
  expect(() => f.helper.states(Array(33).fill(target), "fixture", "initial")).toThrow()
  expect(() =>
    f.helper.events({ hostId: "foreign", dataEpoch: "initial", after: 0, through: 0 }, "fixture")
  ).toThrow()
  expect(() =>
    f.helper.events({ hostId: "fixture", dataEpoch: "foreign", after: 0, through: 0 }, "fixture")
  ).toThrow()
  expect(() =>
    f.helper.events(
      {
        hostId: "fixture",
        dataEpoch: "initial",
        after: 0,
        through: f.snapshot().cursor + 1
      },
      "fixture"
    )
  ).toThrow()
  const page = f.helper.events(
    {
      hostId: "fixture",
      dataEpoch: "initial",
      after: 0,
      through: f.snapshot().cursor,
      limit: 2
    },
    "fixture"
  )
  expect(page.events).toHaveLength(2)
  expect(JSON.stringify(page)).not.toContain("PRIVATE_QUESTION")
})

it("retains a notice absent from oldest attention until its exact state ends, including close-before-click", () => {
  const f = fixture(),
    task = f.task()
  f.store.requestInteraction(task.lease, {
    kind: "question",
    prompt: "PRIVATE_QUESTION"
  })
  const feed = new BotNotificationFeed()
  feed.seed({
    ...f.frame(),
    snapshot: {
      ...f.snapshot(),
      work: { ...notificationWork(f.snapshot())!, attention: [] }
    }
  })
  const notice = feed.consume(f.frame(), [])[0]
  const native = Object.assign(new EventEmitter(), {
      show: vi.fn(),
      close: vi.fn()
    }),
    navigate = vi.fn()
  const presenter = new BotNotificationPresenter({
    create: () => native,
    navigate
  })
  presenter.frame(f.snapshot())
  presenter.show(notice)
  native.emit("close")
  expect(presenter.targets()).toEqual([notice.authority!.target])
  const next = f.snapshot(presenter.targets())
  notificationWork(next)!.attention = [] // Partial representatives are not disappearance proof.
  presenter.frame(next)
  expect(native.close).not.toHaveBeenCalled()
  native.emit("click")
  expect(navigate).toHaveBeenCalledWith(notice)
  presenter.show(notice)
  f.store.finish(task.lease, "cancelled", "Stopped")
  presenter.frame(f.snapshot(presenter.targets()))
  expect(native.close).toHaveBeenCalledOnce()
  native.emit("click")
  expect(navigate).toHaveBeenCalledTimes(1)
})

it("bounds native target retention and the optional modern route cache without absence pruning", () => {
  const f = fixture(),
    task = f.task(),
    feed = new BotNotificationFeed()
  const snap = f.store.snapshot()
  snap.runs = Array.from({ length: 600 }, (_, index) => ({
    ...task.run,
    id: `run-${index}`
  }))
  const modern = { ...snap, work: f.snapshot().work }
  feed.seed({ ...f.frame(), snapshot: modern })
  const routes = (feed as unknown as { runs: Map<string, unknown> }).runs
  expect(routes.size).toBe(256)
  feed.consume({ ...f.frame(), snapshot: { ...modern, runs: [] } }, [])
  expect(routes.size).toBe(256)
  const presenter = new BotNotificationPresenter({
    create: () => Object.assign(new EventEmitter(), { show: vi.fn(), close: vi.fn() }),
    navigate: vi.fn()
  })
  const bots = Array.from({ length: 40 }, (_, i) => ({
    ...f.owner.bot,
    id: `bot-${i}`
  }))
  presenter.frame({ ...snap, bots })
  for (let i = 0; i < 40; i++)
    presenter.show({
      botId: `bot-${i}`,
      runId: `run-${i}`,
      kind: "agent-done",
      title: "Done",
      body: "Done",
      link: {
        conversationId: f.owner.conversationId,
        messageId: task.run.messageId
      }
    })
  expect((presenter as unknown as { active: Map<string, unknown> }).active.size).toBe(32)
})

it("uses only bounded safe events for modern monitor frames and rejects late or foreign generations", async () => {
  const f = fixture(),
    show = vi.fn(),
    unavailable = vi.fn()
  const reader = {
    snapshot: vi.fn(async () => f.snapshot()),
    events: vi.fn(async () => []),
    notificationEvents: vi.fn(async (input: Parameters<BotWorkNotifications["events"]>[0]) =>
      f.helper.events(input, "fixture")
    )
  }
  const monitor = new BotNotificationMonitor({
    connect: async () => reader,
    focused: () => false,
    now: () => 10000,
    frame: () => {},
    show,
    unavailable
  })
  await monitor.poll()
  const task = f.task()
  f.store.finish(task.lease, "succeeded", "PRIVATE_RESULT")
  await monitor.poll()
  expect(show).toHaveBeenCalledOnce()
  expect(reader.events).not.toHaveBeenCalled()
  const second = f.task()
  f.store.finish(second.lease, "succeeded", "PRIVATE_SECOND")
  reader.notificationEvents.mockImplementationOnce(async () => ({
    ...f.events(0),
    hostId: "foreign"
  }))
  await monitor.poll()
  expect(unavailable).toHaveBeenCalledOnce()
  expect(show).toHaveBeenCalledTimes(1)
  monitor.stop()
})

it("keeps workflow-child attention on the root message and suppresses child completion", () => {
  const f = fixture(),
    parent = f.task()
  const workflow = BotWorkflowStore.open(f.store, parent.lease, "workflow", {
    script: 'export const meta={name:"Review",description:"Review"}; return await agent("task");',
    maxConcurrency: 2,
    defaultModelId: "configured",
    agentProfiles: [],
    authority: { project: "test" }
  })
  const child = f.store.workflowChildren.claim(workflow, parent.lease, {
    prompt: "Review",
    agentIndex: 1,
    toolStreamKey: `${"a".repeat(64)}_c0`,
    durableCallKey: `${"a".repeat(64)}_n0`,
    label: "Review",
    phase: null,
    shellAccess: "read_only"
  })
  const card = f.store.requestInteraction(child.lease!, {
    kind: "question",
    prompt: "PRIVATE_CHILD"
  })
  const run = f.store.getRun(child.run.id)
  const route = f.helper.attention({
    botId: run.botId,
    id: card.id,
    kind: "question",
    runId: run.id,
    fence: run.fence,
    revision: card.revision,
    conversationId: run.conversationId,
    messageId: run.messageId
  })
  expect(route?.link).toEqual({
    conversationId: parent.run.conversationId,
    messageId: parent.run.messageId
  })
  const after = f.snapshot().cursor
  f.store.workflowChildren.settle(child.lease!, "failed", "failed")
  expect(
    f.events(after).events.filter((event) => event.completion?.target.runId === child.run.id)
  ).toEqual([])
})

it("reads a short deferred frame without deletion flush or writer reservation, and omits older settled events", () => {
  const f = fixture(),
    task = f.task()
  f.store.finish(task.lease, "succeeded", "PRIVATE_RESULT")
  const first = f.events(0).events.find((event) => event.completion)!
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('run.settled',?,'{\"status\":\"succeeded\"}',10000)",
    [task.run.id]
  )
  const through = f.snapshot().cursor
  const ledger = (f.store as unknown as { deletions: { flush(): void } }).deletions
  const run = vi.spyOn(f.store.db, "run"),
    flush = vi.spyOn(ledger, "flush")
  const page = f.helper.events(
    { hostId: "fixture", dataEpoch: "initial", after: 0, through },
    "fixture"
  )
  expect(page.events.find((event) => event.cursor === first.cursor)?.completion).toBeUndefined()
  expect(page.events.filter((event) => event.completion)).toHaveLength(1)
  expect(flush).not.toHaveBeenCalled()
  expect(run.mock.calls.map((call) => call[0])).toEqual(["BEGIN DEFERRED", "COMMIT"])
})

it("expires exact interaction targets and invalidates recovery targets when their fence changes", () => {
  const f = fixture(),
    task = f.task()
  f.store.requestInteraction(task.lease, { kind: "question", prompt: "PRIVATE_QUESTION" })
  const target = notificationWork(f.snapshot())!.attention[0].notificationRoute!.target
  f.advance(86400_000 * 8)
  expect(f.helper.states([target], "fixture", "initial")[0].current).toBe(false)
  f.store.fenceOwner("fixture", "Stopped")
  const attention = notificationWork(f.snapshot())!.attention[0]
  expect(attention.kind).toBe("recovery")
  const recovery = attention.notificationRoute!.target
  expect(f.helper.states([recovery], "fixture", "initial")[0].current).toBe(true)
  f.store.recover({
    id: task.run.id,
    revision: attention.revision,
    decision: "resume",
    effects: [],
    note: "Synthetic confirmed",
    dataEpoch: "initial",
    nonce: "synthetic-recover"
  })
  expect(f.helper.states([recovery], "fixture", "initial")[0].current).toBe(false)
})

it("drops a modern safe-event response after shutdown without new native notices", async () => {
  const f = fixture(),
    show = vi.fn()
  let release!: (value: ReturnType<BotWorkNotifications["events"]>) => void
  const reader = {
    snapshot: async () => f.snapshot(),
    events: vi.fn(async () => []),
    notificationEvents: vi.fn(async () => f.events(0))
  }
  const monitor = new BotNotificationMonitor({
    connect: async () => reader,
    focused: () => false,
    now: () => 10000,
    frame: () => {},
    show
  })
  await monitor.poll()
  const task = f.task()
  f.store.finish(task.lease, "succeeded", "PRIVATE_RESULT")
  reader.notificationEvents.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const pending = monitor.poll()
  await Promise.resolve()
  await Promise.resolve()
  monitor.stop()
  release(f.events(0))
  await pending
  expect(show).not.toHaveBeenCalled()
  expect(reader.events).not.toHaveBeenCalled()
})

it("keeps more than256 complete legacy active routes until a paged event backlog is consumed", async () => {
  const f = fixture(400),
    tasks: ReturnType<BotStore["claim"]>[] = []
  for (let i = 0; i < 300; i++) {
    const owner = f.store.createBot({ nonce: `legacy-owner-${i}`, name: `Legacy ${i}` })
    f.store.send({
      nonce: `legacy-task-${i}`,
      conversationId: owner.conversationId,
      text: "PRIVATE_LEGACY_TASK"
    })
    tasks.push(f.store.claim("fixture")!)
  }
  expect(f.store.snapshot().runs).toHaveLength(300)
  const show = vi.fn(),
    reader = {
      snapshot: vi.fn(async () => f.store.snapshot()),
      events: vi.fn(async (after: number) => f.store.events(after, 200))
    }
  const monitor = new BotNotificationMonitor({
    connect: async () => reader,
    focused: () => false,
    now: () => 10000,
    frame: () => {},
    show
  })
  await monitor.poll() // All early run.queued events are now behind the baseline.
  for (let i = 0; i < 1200; i++)
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('fixture.private',?,'{}',10000)",
      [`backlog-${i}`]
    )
  const oldest = tasks[0]!
  f.store.finish(oldest.lease, "succeeded", "PRIVATE_LEGACY_RESULT")
  expect(f.store.snapshot().runs).toHaveLength(299)
  await monitor.poll()
  expect(reader.events).toHaveBeenCalledTimes(4)
  expect(show).not.toHaveBeenCalled() // The result is beyond the first tick's four pages.
  await monitor.poll()
  expect(show).toHaveBeenCalledOnce()
  const notice = show.mock.calls[0][0] as Parameters<BotNotificationPresenter["show"]>[0]
  expect(notice.runId).toBe(oldest.run.id)
  expect(
    f.store.message({ conversationId: notice.link.conversationId, id: notice.link.messageId }).text
  ).toBe("PRIVATE_LEGACY_RESULT")
  await monitor.poll()
  expect(show).toHaveBeenCalledTimes(1)
  monitor.stop()
}, 15000)
