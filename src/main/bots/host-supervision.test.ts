import { afterEach, expect, it, vi } from "vitest"
import { BotHost, type BotRuntimeRequest } from "./host"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
import { botWorkflowChildRunner } from "./workflow-child-runner"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function fixture(afterAbort?: () => Promise<unknown>) {
  let wall = 1_900_000_000_000,
    monotonic = 0
  const store = new BotStore(":memory:", () => wall)
  cleanup.push(() => store.close())
  let request!: BotRuntimeRequest
  const host = new BotHost(
    store,
    {
      execute: async (input) => {
        request = input
        await new Promise<void>((done) =>
          input.signal.addEventListener("abort", () => done(), { once: true })
        )
        if (afterAbort) await afterAbort()
        return "stopped"
      }
    },
    1,
    undefined,
    undefined,
    undefined,
    () => monotonic
  )
  cleanup.push(() => host.stop())
  const { conversationId } = store.createBot({ nonce: "bot", name: "Long-running Bot" })
  store.send({ nonce: "task", conversationId, text: "Work" })
  host.tick()
  await Promise.resolve()
  return {
    store,
    host,
    request,
    advance(ms = 1000) {
      wall += ms
      monotonic += ms
      host.tick()
    }
  }
}

it.each([false, true])(
  "bounds durable lease writes while still supervising every heartbeat (waiting=%s)",
  async (waiting) => {
    const f = await fixture()
    if (waiting) f.store.requestInteraction(f.request.lease, { kind: "question", prompt: "请选择" })
    const renew = vi.spyOn(f.store, "renew")
    for (let n = 0; n < 60; n++) {
      f.advance()
      const current = f.store.assertLease(f.request.lease, true)
      expect(current.leaseUntil! - f.store.now()).toBeGreaterThanOrEqual(20_000)
      expect(f.request.signal.aborted).toBe(false)
    }
    expect(renew.mock.calls.length).toBeGreaterThan(0)
    expect(renew.mock.calls.length).toBeLessThanOrEqual(6)
    f.store.cancel(f.request.run.id)
    f.advance(1)
    expect(f.request.signal.aborted).toBe(true)
  }
)

it("aborts a fenced executor on the next heartbeat even before renewal is due", async () => {
  const f = await fixture()
  const renew = vi.spyOn(f.store, "renew")
  f.store.fenceOwner(f.host.id, "Ownership revoked")
  f.advance(1)
  expect(f.request.signal.aborted).toBe(true)
  expect(renew).not.toHaveBeenCalled()
  expect(f.store.getRun(f.request.run.id).status).toBe("needs_review")
})

it("commits shutdown handoff before aborting a live effect and preserves queued work", async () => {
  const f = await fixture(),
    action = { submit: "shutdown fixture" },
    approval = f.store.requestInteraction(f.request.lease, {
      kind: "approval",
      action,
      prompt: "Approve controlled effect"
    })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(f.request.lease, { id: "shutdown-effect", action, approvalId: approval.id })
  f.store.saveCheckpoint(f.request.lease, "controlled-shutdown-checkpoint")
  const queued = f.store.send({
    nonce: "queued-during-effect",
    conversationId: f.request.run.conversationId,
    text: "Keep this work"
  }).runIds[0]
  let atAbort: { run: string; effect: string; stale: boolean } | undefined
  f.request.signal.addEventListener(
    "abort",
    () => {
      let stale = false
      try {
        f.store.assertLease(f.request.lease, true, true)
      } catch {
        stale = true
      }
      atAbort = {
        run: f.store.getRun(f.request.run.id).status,
        effect: f.store.effects(f.request.run.id)[0].status,
        stale
      }
    },
    { once: true }
  )
  await f.host.stop()
  expect(atAbort).toEqual({ run: "needs_review", effect: "unknown", stale: true })
  expect(f.store.getRun(f.request.run.id)).toMatchObject({
    status: "needs_review",
    checkpoint: "controlled-shutdown-checkpoint",
    leaseOwner: null,
    leaseUntil: null
  })
  expect(f.store.getRun(queued).status).toBe("queued")
  expect(f.store.events().filter((event) => event.kind === "run.cancel_requested")).toEqual([])
  const interrupted = f.store.getRun(f.request.run.id)
  expect(() =>
    f.store.recover({
      id: interrupted.id,
      revision: interrupted.revision,
      decision: "resume",
      note: "Must reconcile the actual started effect",
      effects: []
    })
  ).toThrow("逐项核对")
})

it("still aborts the physical executor when a shutdown handoff cannot be written", async () => {
  const f = await fixture()
  const approval = f.store.requestInteraction(f.request.lease, {
    kind: "approval",
    prompt: "Keep original wait",
    action: { controlled: true }
  })
  f.store.saveCheckpoint(f.request.lease, "read-only-handoff-checkpoint")
  // A real SQLite write refusal, rather than a mocked cancel/fence method.
  f.store.db.run("PRAGMA query_only=ON")
  try {
    await expect(f.host.stop()).rejects.toBeInstanceOf(AggregateError)
    expect(f.request.signal.aborted).toBe(true)
    expect(f.store.getRun(f.request.run.id)).toMatchObject({
      status: "waiting_input",
      checkpoint: "read-only-handoff-checkpoint"
    })
    expect(f.store.getInteraction(approval.id).status).toBe("pending")
    expect(f.store.events().filter((event) => event.kind === "run.cancel_requested")).toEqual([])
  } finally {
    f.store.db.run("PRAGMA query_only=OFF")
  }
})

it.each([true, false])(
  "fences nested shutdown settlement after a one-time SQLite refusal while preserving explicit user cancel (shutdown=%s)",
  async (shutdown) => {
    let childCleanup: Promise<unknown> = Promise.resolve()
    const f = await fixture(() => childCleanup),
      definition = {
        script:
          'export const meta={name:"Nested shutdown",description:"Lifecycle"}; return await agent("task");',
        maxConcurrency: 1,
        defaultModelId: "fixture",
        agentProfiles: [],
        authority: { project: "controlled" }
      },
      workflow = BotWorkflowStore.open(f.store, f.request.lease, "shutdown-workflow", definition),
      input = {
        prompt: "Wait for the original authorization",
        agentIndex: 1,
        toolStreamKey: `${"a".repeat(64)}_c0`,
        durableCallKey: `${"a".repeat(64)}_n0`,
        label: "Controlled child",
        phase: null,
        shellAccess: "read_only" as const
      }
    let child!: BotRuntimeRequest
    // Restore actual persistent writes before the production runner's abort
    // listener executes. Only the handoff transaction sees query_only=ON.
    let restoredWrite: string | undefined
    if (shutdown)
      f.request.signal.addEventListener(
        "abort",
        () => {
          f.store.db.run("PRAGMA query_only=OFF")
          restoredWrite = f.store.createBot({
            nonce: "write-after-refusal",
            name: "SQLite is writable again"
          }).bot.id
        },
        { once: true }
      )
    const runner = botWorkflowChildRunner(f.request, workflow, async (request) => {
      child = request
      f.store.saveCheckpoint(request.lease, "nested-original-checkpoint")
      f.store.requestInteraction(request.lease, {
        kind: "approval",
        prompt: "Original child approval",
        action: { controlled: "child" }
      })
      return new Promise<string>((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true
        })
      )
    })
    const execution = runner({ ...input, signal: f.request.signal })
    childCleanup = execution.catch((error: unknown) => error)
    const stopped = expect(execution).rejects.toThrow("停止")
    f.store.saveCheckpoint(f.request.lease, "parent-original-checkpoint")
    const parentApproval = f.store.requestInteraction(f.request.lease, {
      kind: "question",
      prompt: "Original parent wait"
    })
    const childApproval = f.store
      .snapshot()
      .interactions.find((item) => item.runId === child.run.id)!
    if (!shutdown) {
      f.store.cancel(f.request.run.id)
      f.advance(1)
      await stopped
      await expect.poll(() => f.store.getRun(f.request.run.id).status).toBe("cancelled")
      expect(f.store.getRun(child.run.id).status).toBe("cancelled")
      expect(f.store.getInteraction(childApproval.id).status).toBe("cancelled")
      expect(f.store.getInteraction(parentApproval.id).status).toBe("cancelled")
      return
    }
    f.store.db.run("PRAGMA query_only=ON")
    await expect(f.host.stop()).rejects.toBeInstanceOf(AggregateError)
    await stopped
    expect(restoredWrite).toEqual(expect.any(String))
    expect(f.store.getBot(restoredWrite!).name).toBe("SQLite is writable again")
    expect(f.store.getRun(f.request.run.id)).toMatchObject({
      status: "waiting_input",
      checkpoint: "parent-original-checkpoint"
    })
    expect(f.store.getRun(child.run.id)).toMatchObject({
      status: "waiting_input",
      checkpoint: "nested-original-checkpoint"
    })
    expect(f.store.getInteraction(childApproval.id).status).toBe("pending")
    expect(f.store.getInteraction(parentApproval.id).status).toBe("pending")
    expect(f.store.events().filter((event) => event.kind === "run.cancel_requested")).toEqual([])
    expect(() => f.store.assertLease(child.lease, true, true)).toThrow("执行权已失效")
    expect(() => f.host.start()).toThrow("已停止")
    // A new Host applies the same startup recovery to the original parent and
    // child, then resumes their exact existing workflow identities after review.
    f.store.recoverAbandonedAtStartup()
    for (const id of [child.run.id, f.request.run.id]) {
      const current = f.store.getRun(id)
      expect(current.status).toBe("needs_review")
      f.store.recover({
        id,
        revision: current.revision,
        decision: "resume",
        note: "Verified no external effect was dispatched",
        effects: []
      })
    }
    let resumedChild: string | undefined
    const next = new BotHost(f.store, {
      execute: async (request) => {
        const restored = BotWorkflowStore.open(
            f.store,
            request.lease,
            "shutdown-workflow",
            definition
          ),
          runChild = botWorkflowChildRunner(request, restored, async (resumed) => {
            resumedChild = resumed.run.id
            expect(resumed.run.checkpoint).toBe("nested-original-checkpoint")
            return "Recovered nested task"
          })
        return (await runChild({ ...input, signal: request.signal })).text
      }
    })
    cleanup.push(() => next.stop())
    next.tick()
    await expect.poll(() => f.store.getRun(f.request.run.id).status).toBe("succeeded")
    expect(resumedChild).toBe(child.run.id)
    expect(f.store.getRun(child.run.id).status).toBe("succeeded")
    expect(f.store.getInteraction(childApproval.id).status).toBe("expired")
    expect(f.store.getInteraction(parentApproval.id).status).toBe("expired")
  }
)

it("fences lost filesystem ownership without preventing an already started effect from settling", async () => {
  const f = await fixture(),
    action = { shell: "fixture effect" },
    approval = f.store.requestInteraction(f.request.lease, {
      kind: "approval",
      action,
      prompt: "Approve fixture"
    })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(f.request.lease, { id: "owned-effect", action, approvalId: approval.id })
  let lost = false
  const owner = {
      assertCurrent: () => {
        if (lost) throw new Error("filesystem ownership changed")
      },
      checkCurrent: async () => owner.assertCurrent()
    },
    onLost = vi.fn()
  f.host.bindOwnership(owner, onLost)
  lost = true
  f.advance()
  expect(f.request.signal.aborted).toBe(true)
  expect(() => f.request.assertOwnership?.()).toThrow("锁")
  f.store.settleEffect(f.request.lease, "owned-effect", "unknown", "verify the external result")
  await Promise.resolve()
  await Promise.resolve()
  expect(f.store.effects(f.request.run.id)[0].status).toBe("unknown")
  expect(f.store.getRun(f.request.run.id).status).toBe("needs_review")
  expect(onLost).toHaveBeenCalledTimes(1)
  const queued = f.store.send({
    nonce: "after-loss",
    conversationId: f.request.run.conversationId,
    text: "must remain queued"
  }).runIds[0]
  f.host.tick()
  expect(f.store.getRun(queued).status).toBe("queued")
  expect(() => f.host.start()).toThrow("锁")
})

it("bounds concurrent asynchronous ownership checks and keeps a failed owner fenced", async () => {
  const f = await fixture()
  let reject!: (reason: Error) => void
  const check = vi.fn(() => new Promise<void>((_resolve, fail) => (reject = fail))),
    onLost = vi.fn()
  f.host.bindOwnership({ assertCurrent: () => {}, checkCurrent: check }, onLost)
  const pending = Array.from({ length: 8 }, () => f.host.checkOwnership())
  expect(check).toHaveBeenCalledTimes(1)
  reject(new Error("owner disappeared"))
  const results = await Promise.allSettled(pending)
  expect(results.every((result) => result.status === "rejected")).toBe(true)
  expect(onLost).toHaveBeenCalledTimes(1)
  await expect(f.host.checkOwnership()).rejects.toMatchObject({ code: "host_ownership_lost" })
  expect(check).toHaveBeenCalledTimes(1)
  expect(f.request.signal.aborted).toBe(true)
})
