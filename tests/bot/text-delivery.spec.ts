import assert from "node:assert/strict"
import test from "node:test"
import { withSqlite, open } from "./requirement-execution-fixture"
import { setup, initialize, send, model } from "./service-conversation-fixture"
import {
  serviceScopeKey,
  ServiceConversationStore
} from "../../src/main/services/bot/service-conversation-store"
import { ServiceConversationService } from "../../src/main/services/bot/service-conversation"
import { PartnerLocalFault } from "../../src/main/services/bot/partner-local-client"
import {
  parseDeliveryInput,
  textDigest
} from "../../src/main/services/bot/text-delivery-validation"
async function ready(f: ReturnType<typeof setup>, id: string, request = "first") {
  const r = await send(f, id, request)
  await f.app.drain()
  f.settle("run-" + f.stats.enqueues, "原版正文 V1_SENTINEL")
  await f.app.drain()
  await f.app.drain()
  return r
}
async function pump(f: ReturnType<typeof setup>, n = 3) {
  for (let i = 0; i < n; i++) await f.app.drain()
}
for (const code of ["DEPENDENCY_UNAVAILABLE", "OUTCOME_UNKNOWN"])
  for (const step of ["publish", "review"] as const)
    test(`${step} committed ${code} reuses exact command and one version/feedback after reopen`, () =>
      withSqlite(async (db) => {
        const f = setup(db)
        try {
          const id = await initialize(f)
          if (step === "publish") f.setDeliveryLoss(step, code)
          const r = await ready(f, id)
          if (step === "review") {
            f.setDeliveryLoss(step, code)
            const view = await f.app.delivery({
              conversationId: id,
              taskRef: r.taskRef,
              before: null
            })
            await f.app.review({
              conversationId: id,
              taskRef: r.taskRef,
              operationId: "reject",
              versionId: view!.summary.head!.versionId,
              decision: "reject",
              comment: "修改意见 FIX_SENTINEL"
            })
            await f.app.drain()
          }
          await f.reopen()
          await pump(f)
          assert.equal(f.deliveryStats.publishes, 1)
          assert.equal(f.deliveryStats.decisions, step === "review" ? 1 : 0)
          assert.equal(f.stats.messages, step === "review" ? 1 : 0)
          assert.equal(f.stats.enqueues, step === "review" ? 2 : 1)
        } finally {
          await f.app.stop()
        }
      }))
test("complete v1 reject v2 approve; stale decisions, pending supplement, no-model confirm and immutable history", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        r = await ready(f, id),
        key = serviceScopeKey(f.scope),
        v1 = (await f.app.delivery({ conversationId: id, taskRef: r.taskRef, before: null }))!
          .summary.head!.versionId
      const reject = {
        conversationId: id,
        taskRef: r.taskRef,
        operationId: "reject",
        versionId: v1,
        decision: "reject",
        comment: "保留旧版，补充规则"
      }
      await f.app.review(reject)
      await pump(f)
      await f.app.review(reject)
      await pump(f)
      assert.equal(f.stats.enqueues, 2)
      assert.equal(f.stats.messages, 1)
      const revision = f.journal.latest(key, r.taskRef)!
      assert.equal(revision.phase, "run")
      assert.equal(revision.taskVersion, 3)
      f.settle(revision.runId!, "新版正文 V2_SENTINEL")
      await pump(f)
      const state = await f.app.delivery({ conversationId: id, taskRef: r.taskRef, before: null }),
        v2 = state!.summary.head!.versionId
      assert.notEqual(v1, v2)
      assert.equal(state!.versions.length, 2)
      assert.equal(
        (await f.app.deliveryVersion({ conversationId: id, taskRef: r.taskRef, versionId: v1 }))
          .decision!.comment,
        reject.comment
      )
      await assert.rejects(f.app.review({ ...reject, operationId: "stale" }), /INPUT_CHANGED/)
      f.drift() // confirmation never resolves a model
      const approve = {
        ...reject,
        operationId: "approve",
        versionId: v2,
        decision: "approve",
        comment: null
      }
      await f.app.review(approve)
      await pump(f)
      await f.app.review(approve)
      await pump(f)
      assert.equal(f.stats.enqueues, 2)
      assert.equal(f.deliveryStats.decisions, 2)
      assert.equal(
        (await f.app.delivery({ conversationId: id, taskRef: r.taskRef, before: null }))!.summary
          .taskStatus,
        "completed"
      )
      await assert.rejects(send(f, id, "closed", r.taskRef), /INPUT_CHANGED/)
    } finally {
      await f.app.stop()
    }
  }))
test("known prestart blocked revision can explicitly continue without duplicate feedback; retry replay survives in-flight new Run", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        r = await ready(f, id),
        key = serviceScopeKey(f.scope),
        v1 = f.heads.get("task-1")!.versionId
      await f.app.review({
        conversationId: id,
        taskRef: r.taskRef,
        operationId: "reject",
        versionId: v1,
        decision: "reject",
        comment: "修订"
      })
      await f.app.drain()
      const revision = f.journal.latest(key, r.taskRef)!
      f.drift()
      await f.app.drain()
      assert.equal(f.journal.request(key, revision.requestId).status, "blocked")
      await f.app.selectModel({ conversationId: id, modelRef: model.ref })
      const retry = {
        conversationId: id,
        taskRef: r.taskRef,
        actionId: "reject",
        operationId: "retry"
      }
      await f.app.retryRevision(retry)
      await f.reopen()
      await pump(f)
      await f.app.retryRevision(retry)
      await pump(f)
      assert.equal(f.stats.messages, 1)
      assert.equal(f.stats.enqueues, 2)
      const next = f.journal.latest(key, r.taskRef)!
      assert.equal(f.journal.request(key, revision.requestId).supersededBy, next.requestId)
      f.settle(next.runId!, "完成修改")
      await pump(f)
      assert.equal(f.journal.hasTaskPending(key, r.taskRef), false)
      const page = await f.app.read({ conversationId: id, taskRef: r.taskRef, cursor: null })
      assert.ok(page.items.find((e) => e.requestId === revision.requestId)!.supersededBy)
      const latest = (await f.app.delivery({
        conversationId: id,
        taskRef: r.taskRef,
        before: null
      }))!.summary
      await f.app.review({
        conversationId: id,
        taskRef: r.taskRef,
        operationId: "approve",
        versionId: latest.head!.versionId,
        decision: "approve",
        comment: null
      })
      await pump(f)
      assert.equal(f.tasks.get("task-1")!.status, "completed")
    } finally {
      await f.app.stop()
    }
  }))
test("revision row committed before action-save failure restores request association; unknown cannot be retried", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        r = await ready(f, id),
        key = serviceScopeKey(f.scope),
        v1 = f.heads.get("task-1")!.versionId
      await f.app.review({
        conversationId: id,
        taskRef: r.taskRef,
        operationId: "reject",
        versionId: v1,
        decision: "reject",
        comment: "修改"
      })
      const original = f.journal.deliveries.save.bind(f.journal.deliveries)
      let fail = true
      f.journal.deliveries.save = (a) => {
        if (fail && a.phase === "done") {
          fail = false
          throw new PartnerLocalFault("STORAGE_FAILURE")
        }
        original(a)
      }
      await f.app.drain()
      await f.reopen()
      await pump(f)
      const a = f.journal.deliveries.get(key, "reject")!
      assert.ok(a.requestId)
      assert.equal(a.requestId, a.revisionRequestId)
      assert.equal(f.stats.enqueues, 2)
      f.journal.update(key, a.requestId!, (v) => {
        v.status = "outcome_unknown"
        v.phase = "terminal"
      })
      f.runs.get(f.journal.request(key, a.requestId!).runId!)!.run.status = "running"
      await assert.rejects(
        f.app.retryRevision({
          conversationId: id,
          taskRef: r.taskRef,
          actionId: "reject",
          operationId: "unsafe"
        }),
        /INPUT_CHANGED/
      )
      assert.equal(f.stats.enqueues, 2)
    } finally {
      await f.app.stop()
    }
  }))
test("eight unavailable Task publications do not starve the ninth; SQL batch remains eight", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        key = serviceScopeKey(f.scope)
      for (let i = 0; i < 9; i++) {
        const r = await send(f, id, "r" + i)
        await f.app.drain()
        f.settle(f.journal.request(key, r.requestId).runId!)
      }
      f.setUnavailable(true)
      await pump(f, 4)
      const pending = f.journal.deliveries.pending(key)
      assert.equal(pending.length, 8)
      f.setUnavailable(false)
      await pump(f, 4)
      assert.equal(f.deliveryStats.publishes, 9)
    } finally {
      await f.app.stop()
    }
  }))
test("actual SQLite close/reopen retains original publish command after committed result response loss", () =>
  withSqlite(async (db, path) => {
    const f = setup(db)
    let second: ReturnType<typeof open> | undefined, app: ServiceConversationService | undefined
    try {
      const id = await initialize(f)
      f.setDeliveryLoss("publish")
      const r = await ready(f, id)
      await f.app.stop()
      db.close()
      second = open(path)
      const store = new ServiceConversationStore(second)
      app = new ServiceConversationService({ ...f.deps, store })
      await app.drain()
      assert.equal(f.deliveryStats.publishes, 1)
      assert.equal(
        (await app.delivery({ conversationId: id, taskRef: r.taskRef, before: null }))!.summary
          .head!.number,
        1
      )
    } finally {
      await app?.stop()
      await f.app.stop()
      second?.close()
    }
  }))
test("revision input validates run, task, version, digest and feedback association before prompt", () => {
  const v = {
    runId: "run",
    spaceId: "A",
    taskId: "task",
    taskVersion: 3,
    versionId: "v1",
    number: 1,
    digest: textDigest("v1"),
    text: "v1",
    feedbackMessageId: "m",
    feedbackText: "fix",
    feedbackTaskVersion: 3
  }
  assert.equal(parseDeliveryInput(v, "A", "task", "run", 3)!.text, "v1")
  for (const mutation of [
    { taskId: "other" },
    { runId: "other" },
    { digest: textDigest("other") },
    { feedbackTaskVersion: 4 },
    { extra: true }
  ])
    assert.throws(
      () => parseDeliveryInput({ ...v, ...mutation }, "A", "task", "run", 3),
      /INVALID_PAYLOAD/
    )
})
test("concurrent review final admission sees a supplement accepted during authorization await", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        r = await ready(f, id),
        version = f.heads.get("task-1")!.versionId
      const original = f.deps.context
      let calls = 0,
        release!: () => void,
        reached!: () => void
      const waiting = new Promise<void>((resolve) => {
        reached = resolve
      })
      f.deps.context = async () => {
        const c = await original()
        if (++calls === 3) {
          reached()
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return c
      }
      const confirming = f.app.review({
        conversationId: id,
        taskRef: r.taskRef,
        operationId: "approve",
        versionId: version,
        decision: "approve",
        comment: null
      })
      await waiting
      await send(f, id, "supplement", r.taskRef, "尚有待处理补充")
      release()
      await assert.rejects(confirming, /INPUT_CHANGED/)
      assert.equal(f.deliveryStats.decisions, 0)
      assert.equal(f.journal.deliveries.get(serviceScopeKey(f.scope), "approve"), null)
    } finally {
      await f.app.stop()
    }
  }))
test("concurrent supplement delayed at model resolution cannot pass an already durable approval", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        r = await ready(f, id),
        version = f.heads.get("task-1")!.versionId
      const original = f.deps.model
      let release!: () => void, reached!: () => void
      const waiting = new Promise<void>((resolve) => {
        reached = resolve
      })
      f.deps.model = async (ref) => {
        const result = await original(ref)
        reached()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return result
      }
      const supplement = send(f, id, "late", r.taskRef, "迟到补充")
      await waiting
      await f.app.review({
        conversationId: id,
        taskRef: r.taskRef,
        operationId: "approve",
        versionId: version,
        decision: "approve",
        comment: null
      })
      await f.app.drain()
      release()
      await assert.rejects(supplement, /INPUT_CHANGED/)
      assert.equal(f.journal.findRequest(serviceScopeKey(f.scope), "late"), null)
    } finally {
      await f.app.stop()
    }
  }))
test("model refusal notice survives a starting/running inspection before durable failure", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        r = await send(f, id, "refusal"),
        key = serviceScopeKey(f.scope)
      await f.app.drain()
      const local = f.journal.request(key, r.requestId),
        remote = f.runs.get(local.runId!)!
      f.app.markRefused(f.scope, remote.run as any, "MODEL_CHANGED")
      for (const status of ["starting", "running", "failed"]) {
        remote.run.status = status
        if (status === "failed")
          remote.result = {
            runId: local.runId,
            attemptId: remote.run.attemptId,
            outcome: "failed",
            text: "EXECUTION_FAILED",
            settledAt: new Date().toISOString()
          }
        await f.app.read({ conversationId: id, taskRef: r.taskRef, cursor: null })
        assert.equal(f.journal.request(key, r.requestId).notice, "MODEL_CHANGED")
      }
    } finally {
      await f.app.stop()
    }
  }))

test("two concurrent explicit retries admit only one revision; completion replay cannot replace its source again", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        r = await ready(f, id),
        key = serviceScopeKey(f.scope),
        versionId = f.heads.get("task-1")!.versionId
      await f.app.review({
        conversationId: id,
        taskRef: r.taskRef,
        operationId: "reject",
        versionId,
        decision: "reject",
        comment: "修改一次"
      })
      await f.app.drain()
      const source = f.journal.latest(key, r.taskRef)!
      f.drift()
      await f.app.drain()
      await f.app.selectModel({ conversationId: id, modelRef: model.ref })
      const original = f.deps.model,
        releases: Array<() => void> = []
      let reached!: () => void
      const waiting = new Promise<void>((resolve) => {
        reached = resolve
      })
      f.deps.model = async (ref) => {
        const value = await original(ref)
        await new Promise<void>((resolve) => {
          releases.push(resolve)
          if (releases.length === 2) reached()
        })
        return value
      }
      const base = { conversationId: id, taskRef: r.taskRef, actionId: "reject" }
      const first = f.app.retryRevision({ ...base, operationId: "retry-a" }),
        second = f.app.retryRevision({ ...base, operationId: "retry-b" })
      const rejected = assert.rejects(second, /INPUT_CHANGED/)
      await waiting
      releases[0]()
      await first
      releases[1]()
      await rejected
      f.deps.model = original
      await pump(f)
      assert.equal(f.stats.enqueues, 2)
      assert.equal(f.stats.messages, 1)
      assert.equal(f.journal.deliveries.get(key, "retry-b"), null)
      const replacement = f.journal.request(key, source.requestId).supersededBy
      await f.app.retryRevision({ ...base, operationId: "retry-a" })
      await pump(f)
      assert.equal(f.journal.request(key, source.requestId).supersededBy, replacement)
      assert.equal(f.stats.enqueues, 2)
    } finally {
      await f.app.stop()
    }
  }))
