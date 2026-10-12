import { afterEach, expect, it, vi } from "vitest"
import { BotClockFence } from "./clock-fence"
import { BotHost, type BotRuntimeRequest } from "./host"
import { BotStore } from "./store"
import { LocalBotComputerProvider } from "./computer-provider"
import { chromium } from "playwright"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("tolerates small adjustments but latches a clock discontinuity until durable fencing", () => {
  let wall = 100000,
    monotonic = 0
  const fence = new BotClockFence(
    () => wall,
    () => monotonic
  )
  for (let n = 0; n < 100; n++) {
    wall += 1001
    monotonic += 1000
    expect(fence.heartbeat()).toBe(true)
    expect(() => fence.assert()).not.toThrow()
  }
  wall -= 3600000
  expect(() => fence.assert()).toThrow("系统时间")
  wall += 3600000
  expect(fence.heartbeat()).toBe(false)
  expect(() => fence.assert()).toThrow()
  fence.resetAfterFencing()
  expect(fence.heartbeat()).toBe(true)
  monotonic += 30000
  wall += 30000
  expect(() => fence.assert()).toThrow()
})

it.each(["backward", "forward", "sleep"] as const)(
  "fences %s time changes before another effect can begin and preserves accepted work",
  async (mode) => {
    let wall = 1900000000000,
      monotonic = 0
    const store = new BotStore(":memory:", () => wall)
    cleanup.push(() => store.close())
    let running: BotRuntimeRequest | undefined
    const host = new BotHost(
      store,
      {
        execute: async (request) => {
          running = request
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), { once: true })
          )
          return "LATE_OUTPUT_MUST_NOT_COMMIT"
        }
      },
      1,
      undefined,
      undefined,
      undefined,
      () => monotonic
    )
    cleanup.push(() => host.stop())
    const { conversationId } = store.createBot({ nonce: "create", name: "A" })
    const sent = store.send({ nonce: "send", conversationId, text: "执行任务" })
    host.tick()
    await Promise.resolve()
    const request = running!
    const action = { connector: "Notes", text: "once" }
    const approval = store.requestInteraction(request.lease, {
      kind: "approval",
      action,
      prompt: JSON.stringify(action)
    })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    store.beginEffect(request.lease, { id: "uncertain", action, approvalId: approval.id })
    const question = store.requestInteraction(request.lease, {
      kind: "question",
      prompt: "补充信息"
    })
    const queued = store.send({ nonce: "next", conversationId, text: "后续工作" })
    if (mode === "backward") {
      wall -= 3600000
      monotonic += 1000
    }
    if (mode === "forward") {
      wall += 3600000
      monotonic += 1000
    }
    if (mode === "sleep") {
      wall += 60000
      monotonic += 60000
    }
    expect(() =>
      store.toolOnce(request.lease, "forbidden", {}, () =>
        store.saveMemory({ botId: request.bot.id, text: "must not write" })
      )
    ).toThrow("系统时间")
    expect(() => store.renew(request.lease)).toThrow("系统时间")
    host.tick()
    await Promise.resolve()
    expect(request.signal.aborted).toBe(true)
    expect(store.getRun(sent.runIds[0])).toMatchObject({
      status: "needs_review",
      leaseOwner: null,
      leaseUntil: null
    })
    expect(store.getRun(sent.runIds[0]).fence).toBeGreaterThan(request.lease.fence)
    expect(store.effects(sent.runIds[0])[0].status).toBe("unknown")
    expect(store.getInteraction(question.id).status).toBe("expired")
    expect(store.getRun(queued.runIds[0]).status).toBe("queued")
    expect(store.memories(request.bot.id)).toEqual([])
    expect(() => store.assertLease(request.lease)).toThrow("执行权")
    expect(JSON.stringify(store.messages(conversationId))).not.toContain("LATE_OUTPUT")
  }
)

it("recovers abandoned leases at exclusive startup even when the old wall time is in the future", () => {
  let wall = 1900000000000
  const store = new BotStore(":memory:", () => wall)
  cleanup.push(() => store.close())
  const { conversationId } = store.createBot({ nonce: "create", name: "A" })
  const first = store.send({ nonce: "first", conversationId, text: "old" })
  const { lease } = store.claim("old-host")!
  const second = store.send({ nonce: "second", conversationId, text: "next" })
  wall -= 3600000
  expect(store.recoverExpired()).toBe(0)
  expect(store.recoverAbandonedAtStartup()).toBe(1)
  expect(store.getRun(first.runIds[0]).status).toBe("needs_review")
  expect(store.getRun(second.runIds[0]).status).toBe("queued")
  expect(() => store.saveCheckpoint(lease, "stale")).toThrow("执行权")
  expect(store.recoverAbandonedAtStartup()).toBe(0)
})

async function computerSupervisor() {
  let wall = 1900000000000,
    monotonic = 0,
    running: BotRuntimeRequest | undefined
  const store = new BotStore(":memory:", () => wall)
  cleanup.push(() => store.close())
  const computer = new LocalBotComputerProvider("/unused-supervision-fixture")
  cleanup.push(() => computer.close())
  const host = new BotHost(
    store,
    {
      execute: async (request) => {
        running = request
        await new Promise<void>((done) =>
          request.signal.addEventListener("abort", () => done(), { once: true })
        )
        return "LATE_OUTPUT_MUST_NOT_COMMIT"
      }
    },
    1,
    computer,
    undefined,
    undefined,
    () => monotonic
  )
  cleanup.push(() => host.stop())
  const { bot, conversationId } = store.createBot({
    nonce: "clock-computer",
    name: "Clock computer"
  })
  const sent = store.send({ nonce: "clock-task", conversationId, text: "Hold" })
  host.tick()
  await expect.poll(() => running?.run.id).toBe(sent.runIds[0])
  return {
    host,
    store,
    computer,
    bot,
    runId: sent.runIds[0],
    request: () => running!,
    advance: (ms: number) => {
      wall += ms
      monotonic += ms
    },
    unknown: (value: number) => {
      monotonic = value
    }
  }
}

it("durably revokes leases/effects before invalidating observation and aborting old work", async () => {
  const f = await computerSupervisor(),
    request = f.request(),
    action = { connector: "Notes", text: "once" },
    approval = f.store.requestInteraction(request.lease, {
      kind: "approval",
      action,
      prompt: JSON.stringify(action)
    })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(request.lease, {
    id: "uncertain-computer-gap",
    action,
    approvalId: approval.id
  })
  const order: string[] = []
  const observe = vi.spyOn(f.computer, "invalidateObservations").mockImplementation(() => {
    order.push("observations")
    expect(f.store.getRun(f.runId)).toMatchObject({ status: "needs_review", leaseOwner: null })
    expect(f.store.getRun(f.runId).fence).toBeGreaterThan(request.lease.fence)
    expect(f.store.effects(f.runId)[0].status).toBe("unknown")
    expect(request.signal.aborted).toBe(false)
  })
  request.signal.addEventListener(
    "abort",
    () => {
      order.push("abort")
      expect(f.store.getRun(f.runId).status).toBe("needs_review")
      expect(observe).toHaveBeenCalledOnce()
    },
    { once: true }
  )
  f.advance(60_000)
  f.host.assertComputerSupervision()
  expect(order).toEqual(["observations", "abort"])
  expect(() => f.store.assertLease(request.lease)).toThrow("执行权")
})

it("does not let computer admission traffic renew the heartbeat baseline", async () => {
  const f = await computerSupervisor(),
    observe = vi.spyOn(f.computer, "invalidateObservations")
  for (let n = 0; n < 2; n++) {
    f.advance(10_000)
    f.host.assertComputerSupervision()
    expect(f.store.getRun(f.runId).status).toBe("running")
  }
  f.advance(10_000)
  f.host.assertComputerSupervision()
  expect(f.store.getRun(f.runId).status).toBe("needs_review")
  expect(f.request().signal.aborted).toBe(true)
  expect(observe).toHaveBeenCalledOnce()
})

it.each([NaN, Infinity])(
  "never admits provider startup with an unknown monotonic clock (%s)",
  async (value) => {
    const f = await computerSupervisor(),
      launch = vi
        .spyOn(chromium, "launchPersistentContext")
        .mockRejectedValue(new Error("Unexpected browser launch"))
    f.unknown(value)
    await expect(f.computer.get()).rejects.toMatchObject({ code: "clock_changed" })
    await expect(f.computer.get()).rejects.toMatchObject({ code: "clock_changed" })
    expect(launch).not.toHaveBeenCalled()
    expect(f.store.getRun(f.runId).status).toBe("needs_review")
    expect(f.request().signal.aborted).toBe(true)
  }
)

it("does not admit provider startup after Host shutdown begins", async () => {
  const f = await computerSupervisor(),
    launch = vi
      .spyOn(chromium, "launchPersistentContext")
      .mockRejectedValue(new Error("Unexpected browser launch"))
  await f.host.stop()
  await expect(f.computer.get()).rejects.toMatchObject({ code: "host_stopping" })
  expect(launch).not.toHaveBeenCalled()
})
