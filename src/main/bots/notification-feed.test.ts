import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotNotificationFeed } from "./notification-feed"
import type { BotNotificationSettings } from "../../shared/bot-notifications"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  let now = 10000,
    focused = false,
    preferences: BotNotificationSettings[] = []
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const owner = store.createBot({ nonce: "bot", name: "Engineer" })
  const feed = new BotNotificationFeed()
  const frame = () => ({ snapshot: store.snapshot(), preferences, focused, now })
  feed.seed(frame())
  let count = 0
  const task = () => {
    store.send({
      nonce: `task-${++count}`,
      conversationId: owner.conversationId,
      text: "PRIVATE_TASK"
    })
    return store.claim("host")!
  }
  return {
    store,
    owner,
    feed,
    frame,
    task,
    consume: () => feed.consume(frame(), store.events(feed.cursor ?? 0, 1000)),
    advance(ms: number) {
      now += ms
    },
    focus(value: boolean) {
      focused = value
    },
    mute() {
      preferences = [{ botId: owner.bot.id, revision: 1, enabled: false }]
    }
  }
}

it("notifies once for a real task completed between polls and links to its exact result without exposing it", () => {
  const f = fixture(),
    run = f.task()
  f.store.finish(run.lease, "succeeded", "PRIVATE_RESULT")
  const notices = f.consume()
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({
    botId: f.owner.bot.id,
    kind: "agent-done",
    body: "任务已完成，点击查看结果。"
  })
  expect(f.store.message({ ...notices[0].link, id: notices[0].link.messageId }).text).toBe(
    "PRIVATE_RESULT"
  )
  expect(JSON.stringify(notices)).not.toContain("PRIVATE_")
  expect(f.consume()).toEqual([])
})

it.each(["focused", "muted", "hidden"] as const)(
  "suppresses %s notifications without changing unread state or replaying them later",
  (mode) => {
    const f = fixture(),
      run = f.task()
    if (mode === "focused") f.focus(true)
    if (mode === "muted") f.mute()
    if (mode === "hidden") f.store.updateBot({ id: f.owner.bot.id, revision: 1, hidden: true })
    f.store.finish(run.lease, "succeeded", "Result")
    const unread = f.store.snapshot().conversations[0].readState
    expect(f.consume()).toEqual([])
    expect(f.store.snapshot().conversations[0].readState).toEqual(unread)
    f.focus(false)
    f.advance(6000)
    expect(f.consume()).toEqual([])
  }
)

it("notifies for pending human questions without exposing question or approval contents", () => {
  const f = fixture(),
    run = f.task()
  f.store.requestInteraction(run.lease, { kind: "question", prompt: "PRIVATE_INPUT_DETAILS" })
  const notices = f.consume()
  expect(notices).toHaveLength(1)
  expect(notices[0]).toMatchObject({
    kind: "agent-needs-input",
    runId: run.run.id,
    body: "有问题等待你回答，点击查看。"
  })
  expect(JSON.stringify(notices)).not.toContain("PRIVATE_INPUT")
  expect(f.consume()).toEqual([])
})

it("does not notify for an approval already answered by independent review", () => {
  const f = fixture()
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.owner.bot.id),
    isEnabled: true,
    nonce: "enable"
  })
  const run = f.task(),
    action = { connector: { id: "read", arguments: {} } }
  const autoReview = f.store.autoReview.stamp(
    run.lease,
    action,
    f.store.autoReview.read(f.owner.bot.id),
    { decision: "allow", reason: "Allowed", model: "test" }
  )
  f.store.requestInteraction(run.lease, {
    kind: "approval",
    action,
    prompt: JSON.stringify(action),
    autoReview
  })
  expect(f.consume()).toEqual([])
})

it("coalesces rapid completions and uses Grok's per-Bot notification throttle", () => {
  const f = fixture()
  let run = f.task()
  f.store.finish(run.lease, "succeeded", "first")
  run = f.task()
  f.store.finish(run.lease, "succeeded", "second")
  const first = f.consume()
  expect(first).toHaveLength(1)
  expect(first[0].runId).toBe(run.run.id)
  f.advance(1000)
  run = f.task()
  f.store.finish(run.lease, "succeeded", "third")
  expect(f.consume()).toEqual([])
  f.advance(5000)
  run = f.task()
  f.store.finish(run.lease, "succeeded", "fourth")
  expect(f.consume()).toHaveLength(1)
})

it("starts a fresh baseline after data restore and does not turn a cancellation into a completion notice", () => {
  const f = fixture(),
    run = f.task()
  f.store.finish(run.lease, "succeeded", "Before restore")
  expect(
    f.feed.consume(
      { ...f.frame(), snapshot: { ...f.store.snapshot(), dataEpoch: "restored" } },
      f.store.events(0)
    )
  ).toEqual([])
  const next = f.task()
  f.store.finish(next.lease, "cancelled", "Stopped by user")
  expect(f.consume()).toEqual([])
})

it("uses the original thread scope of a completed branch", () => {
  const f = fixture(),
    root = f.task()
  f.store.finish(root.lease, "succeeded", "Root")
  f.consume()
  f.advance(6000)
  const thread = f.store.threads.get({
    conversationId: f.owner.conversationId,
    rootId: root.run.messageId
  })
  f.store.send({
    nonce: "branch",
    conversationId: f.owner.conversationId,
    text: "Branch task",
    threadRootId: thread.rootId
  })
  const child = f.store.claim("host")!
  f.store.finish(child.lease, "succeeded", "Branch result")
  const notice = f.consume()[0]
  expect(
    f.store.message({ conversationId: notice.link.conversationId, id: notice.link.messageId })
  ).toMatchObject({ text: "Branch result", threadRootId: thread.rootId })
})

it("does not let an old completion consume the throttle for a new result", () => {
  const f = fixture()
  let run = f.task()
  f.store.finish(run.lease, "succeeded", "Old result")
  f.advance(300001)
  expect(f.consume()).toEqual([])
  run = f.task()
  f.store.finish(run.lease, "succeeded", "Fresh result")
  expect(f.consume()[0]?.runId).toBe(run.run.id)
})
