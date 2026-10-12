import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import type { BotRunLease } from "../../shared/bot-types"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  let now = 1_800_000_000_000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const { conversationId } = store.createBot({ nonce: "bot", name: "Bot" })
  store.send({ nonce: "task", conversationId, text: "work" })
  const { lease } = store.claim("host")!
  const action = { operation: "write", value: 1 }
  const primary = store.requestInteraction(lease, { kind: "approval", prompt: "write", action })
  return {
    store,
    lease,
    action,
    primary,
    advance: (ms: number) => {
      now += ms
    }
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function approve(store: BotStore, id: string) {
  const request = store.getInteraction(id)
  store.answerInteraction({ id, revision: request.revision, answer: "approve" })
}
function nested(store: BotStore, lease: BotRunLease, invocation: string, id = "hook:notify") {
  const action = { hook: { name: id, event: "Notification", invocation, command: "notify" } }
  store.hookNotifications.registerAction(lease, id, action)
  const request = store.requestInteraction(lease, { kind: "approval", prompt: "notify", action })
  return { action, request, id }
}

it.each(["primary", "notification"] as const)(
  "keeps both gates intact when %s is answered first",
  async (first) => {
    const f = fixture(),
      ready = deferred(),
      release = deferred()
    let hook!: ReturnType<typeof nested>
    const work = f.store.hookNotifications.run(
      f.lease,
      {
        key: "write:1",
        interactionId: f.primary.id,
        action: f.action
      },
      async (invocation) => {
        hook = nested(f.store, f.lease, invocation)
        ready.resolve()
        await release.promise
        f.store.beginEffect(f.lease, {
          id: hook.id,
          action: hook.action,
          approvalId: hook.request.id
        })
        f.store.settleEffect(f.lease, hook.id, "succeeded", "notified")
      }
    )
    await ready.promise
    expect(f.store.hookNotifications.executing(f.lease.runId)).toBe(false)
    approve(f.store, first === "primary" ? f.primary.id : hook.request.id)
    expect(f.store.getRun(f.lease.runId).status).toBe("waiting_input")
    expect(() =>
      f.store.beginEffect(f.lease, {
        id: "root-write",
        action: f.action,
        approvalId: f.primary.id
      })
    ).toThrow()
    if (first === "primary") approve(f.store, hook.request.id)
    expect(f.store.hookNotifications.executing(f.lease.runId)).toBe(true)
    release.resolve()
    await work
    expect(f.store.getRun(f.lease.runId).status).toBe(
      first === "primary" ? "running" : "waiting_input"
    )
    if (first === "notification") approve(f.store, f.primary.id)
    f.store.beginEffect(f.lease, { id: "root-write", action: f.action, approvalId: f.primary.id })
    expect(f.store.effects(f.lease.runId).map((effect) => effect.id)).toEqual([
      hook.id,
      "root-write"
    ])
  }
)

it("refuses ordinary actions, recursion, unregistered hooks and reuse outside the stage", async () => {
  const f = fixture()
  let hook!: ReturnType<typeof nested>
  await f.store.hookNotifications.run(
    f.lease,
    {
      key: "write:1",
      interactionId: f.primary.id,
      action: f.action
    },
    async (invocation) => {
      expect(() =>
        f.store.requestInteraction(f.lease, { kind: "question", prompt: "escape" })
      ).toThrow("只能申请")
      expect(() =>
        f.store.requestInteraction(f.lease, {
          kind: "approval",
          prompt: "escape",
          action: f.action
        })
      ).toThrow("只能申请")
      expect(() => f.store.hookNotifications.registerAction(f.lease, "ordinary", f.action)).toThrow(
        "不能发起"
      )
      await expect(
        f.store.hookNotifications.run(
          f.lease,
          {
            key: "recursive",
            interactionId: f.primary.id,
            action: f.action
          },
          async () => {}
        )
      ).rejects.toThrow("递归")
      hook = nested(f.store, f.lease, invocation)
      approve(f.store, hook.request.id)
      expect(() =>
        f.store.beginEffect(f.lease, {
          id: "different-id",
          action: hook.action,
          approvalId: hook.request.id
        })
      ).toThrow("不能用于其他")
      expect(() =>
        f.store.beginEffect(f.lease, {
          id: hook.id,
          action: f.action,
          approvalId: f.primary.id
        })
      ).toThrow("不能用于其他")
    }
  )
  approve(f.store, f.primary.id)
  expect(() =>
    f.store.beginEffect(f.lease, {
      id: hook.id,
      action: hook.action,
      approvalId: hook.request.id
    })
  ).toThrow("不能用于其他")
})

it("expires the capability inherited by late asynchronous callbacks", async () => {
  const f = fixture(),
    release = deferred()
  let late!: Promise<unknown>
  await f.store.hookNotifications.run(
    f.lease,
    {
      key: "write:1",
      interactionId: f.primary.id,
      action: f.action
    },
    async () => {
      late = release.promise.then(() => f.store.toolOnce(f.lease, "late", {}, () => true))
    }
  )
  approve(f.store, f.primary.id)
  const rejected = expect(late).rejects.toThrow("执行权已失效")
  release.resolve()
  await rejected
})

it("does not notify resolved approvals and verifies the original run and action", async () => {
  const f = fixture()
  await expect(
    f.store.hookNotifications.run(
      f.lease,
      {
        key: "write:1",
        interactionId: f.primary.id,
        action: { different: true }
      },
      async () => {
        throw new Error("unexpected")
      }
    )
  ).rejects.toThrow("不属于")
  approve(f.store, f.primary.id)
  await f.store.hookNotifications.run(
    f.lease,
    {
      key: "write:1",
      interactionId: f.primary.id,
      action: f.action
    },
    async () => {
      throw new Error("unexpected")
    }
  )
  expect(f.store.db.exec("SELECT * FROM bot_hook_notifications")[0]?.values ?? []).toEqual([])
})

it("does not repeat a completed notification and rejects changed trigger content", async () => {
  const f = fixture()
  let count = 0
  const trigger = { key: "write:1", interactionId: f.primary.id, action: f.action }
  await f.store.hookNotifications.run(f.lease, trigger, async () => {
    count++
  })
  await f.store.hookNotifications.run(f.lease, trigger, async () => {
    count++
  })
  expect(count).toBe(1)
  approve(f.store, f.primary.id)
  const action = { operation: "different" }
  const changed = f.store.requestInteraction(f.lease, {
    kind: "approval",
    prompt: "changed",
    action
  })
  await expect(
    f.store.hookNotifications.run(
      f.lease,
      {
        key: "write:1",
        interactionId: changed.id,
        action
      },
      async () => {}
    )
  ).rejects.toThrow("内容已改变")
})

it("cancels the notification approval on failure without answering the primary request", async () => {
  const f = fixture()
  let hook!: ReturnType<typeof nested>
  await expect(
    f.store.hookNotifications.run(
      f.lease,
      {
        key: "write:1",
        interactionId: f.primary.id,
        action: f.action
      },
      async (invocation) => {
        hook = nested(f.store, f.lease, invocation)
        throw new Error("failed")
      }
    )
  ).rejects.toThrow("failed")
  expect(f.store.getInteraction(hook.request.id).status).toBe("cancelled")
  expect(f.store.getInteraction(f.primary.id).status).toBe("pending")
  expect(f.store.getRun(f.lease.runId).status).toBe("waiting_input")
  expect(f.store.hookNotifications.active(f.lease.runId)).toBe(false)
})

it("revokes a cancelled stage before late callbacks can perform any effect", async () => {
  const f = fixture(),
    ready = deferred(),
    release = deferred()
  const work = f.store.hookNotifications.run(
    f.lease,
    {
      key: "write:1",
      interactionId: f.primary.id,
      action: f.action
    },
    async (invocation) => {
      nested(f.store, f.lease, invocation)
      ready.resolve()
      await release.promise
      f.store.toolOnce(f.lease, "late", {}, () => true)
    }
  )
  await ready.promise
  f.store.cancel(f.lease.runId)
  const rejected = expect(work).rejects.toThrow("执行权已失效")
  release.resolve()
  await rejected
  expect(f.store.hookNotifications.active(f.lease.runId)).toBe(false)
  expect(f.store.getRun(f.lease.runId).status).toBe("cancelling")
  expect(f.store.effects(f.lease.runId)).toEqual([])
})

it("resumes the same notification identity after lease recovery and preserves completed effects", async () => {
  const f = fixture(),
    ready = deferred(),
    release = deferred()
  let originalInvocation!: string
  const work = f.store.hookNotifications.run(
    f.lease,
    {
      key: "write:1",
      interactionId: f.primary.id,
      action: f.action
    },
    async (invocation) => {
      originalInvocation = invocation
      const hook = nested(f.store, f.lease, invocation, "hook:first")
      approve(f.store, hook.request.id)
      f.store.beginEffect(f.lease, {
        id: hook.id,
        action: hook.action,
        approvalId: hook.request.id
      })
      f.store.settleEffect(f.lease, hook.id, "succeeded", "first done")
      ready.resolve()
      await release.promise
      f.store.assertDispatch(f.lease)
    }
  )
  await ready.promise
  f.store.recoverAbandonedAtStartup()
  const rejected = expect(work).rejects.toThrow("执行权已失效")
  release.resolve()
  await rejected
  const stopped = f.store.getRun(f.lease.runId)
  f.store.recover({
    id: stopped.id,
    revision: stopped.revision,
    decision: "resume",
    note: "checked",
    effects: []
  })
  const { lease } = f.store.claim("next-host")!
  const primary = f.store.requestInteraction(lease, {
    kind: "approval",
    prompt: "write",
    action: f.action
  })
  await f.store.hookNotifications.run(
    lease,
    {
      key: "write:1",
      interactionId: primary.id,
      action: f.action
    },
    async (invocation) => {
      expect(invocation).toBe(originalInvocation)
      expect(f.store.effectResult(lease, "hook:first")?.result).toBe("first done")
      const hook = nested(f.store, lease, invocation, "hook:second")
      approve(f.store, hook.request.id)
      f.store.beginEffect(lease, { id: hook.id, action: hook.action, approvalId: hook.request.id })
      f.store.settleEffect(lease, hook.id, "succeeded", "second done")
    }
  )
  expect(f.store.effects(lease.runId).map((effect) => effect.result)).toEqual([
    "first done",
    "second done"
  ])
})
