import { PartnerLocalFault } from "../../src/main/services/bot/partner-local-boundary"
import assert from "node:assert/strict"
import test from "node:test"
import { withSqlite } from "./requirement-execution-fixture"
import { expertSetup } from "./expert-conversation-fixture"
import { model } from "./service-conversation-fixture"
import { serviceScopeKey } from "../../src/main/services/bot/service-conversation-store"
async function init(f: ReturnType<typeof expertSetup>) {
  const info = await f.app.openChats()
  await f.app.selectModel({ conversationId: info.conversationId, modelRef: model.ref })
  return info
}
async function pump(f: ReturnType<typeof expertSetup>, count = 3) {
  for (let i = 0; i < count; i++) await f.app.drain()
}
async function chat(
  f: ReturnType<typeof expertSetup>,
  id: string,
  requestId: string,
  text: string,
  taskRef: string | null = null
) {
  return f.app.chat({
    conversationId: id,
    requestId,
    text,
    taskRef,
    role: taskRef ? "task" : "main"
  })
}
test("normal main conversation, real task receipt, same-task supplement, complete/reopen and no new delivery", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    try {
      const { conversationId: id, mainTaskRef } = await init(f)
      await chat(f, id!, "question", "你好，帮我理解一下")
      await pump(f)
      f.settle("run-1", JSON.stringify({ reply: "先讨论问题。", intent: null }))
      await pump(f)
      assert.equal(
        (await f.app.chatTasks({ conversationId: id, cursor: null, query: "" })).items.length,
        0
      )
      assert.equal(f.journal.taskPage(serviceScopeKey((await f.context()).scope), id!, 0).length, 0)
      await chat(f, id!, "delegate", "请帮我写一份计划")
      await pump(f)
      f.settle(
        "run-2",
        JSON.stringify({
          reply: "等待交办",
          intent: {
            kind: "create_task",
            sourceRequestId: "delegate",
            title: "计划",
            contextSourceIds: []
          }
        })
      )
      await pump(f)
      const page = await f.app.read({ conversationId: id, taskRef: mainTaskRef, cursor: null }),
        card = page.items.at(-1)!.coordination!
      assert.equal(card.state, "delivered")
      assert.ok(card.taskRef)
      assert.equal(f.stats.creates, 2)
      assert.equal(f.stats.enqueues, 3)
      f.settle("run-3", "计划 V1")
      await pump(f)
      await chat(f, id!, "modify", "改得更短", card.taskRef)
      await pump(f)
      assert.equal(f.stats.creates, 2)
      f.settle("run-4", "短版 V2")
      await pump(f)
      const input = [...f.inputs.values()].at(-1)!
      assert.ok(input.messages.some((m) => m.role === "assistant" && m.text === "计划 V1"))
      await f.app.taskLifecycle({
        conversationId: id,
        taskRef: card.taskRef,
        operationId: "complete",
        action: "complete"
      })
      await pump(f)
      await assert.rejects(chat(f, id!, "closed", "再改", card.taskRef), /INPUT_CHANGED/)
      await f.app.taskLifecycle({
        conversationId: id,
        taskRef: card.taskRef,
        operationId: "reopen",
        action: "reopen"
      })
      await pump(f)
      await chat(f, id!, "continue", "补一项", card.taskRef)
      await pump(f)
      assert.equal(f.stats.creates, 2)
      assert.equal(f.stats.enqueues, 5)
      assert.equal(f.deliveryStats.publishes, 0)
    } finally {
      await f.app.stop()
    }
  }))
for (const step of ["ensure", "freeze", "coordinate", "lifecycle"])
  test(step + " lost reply reopens original command without duplicate effects", () =>
    withSqlite(async (db) => {
      const f = expertSetup(db)
      try {
        const { conversationId: id, mainTaskRef } = await init(f)
        if (["ensure", "freeze"].includes(step)) f.loss(step)
        await chat(f, id!, "delegate", "请做一项任务")
        await pump(f, 1)
        await f.reopen()
        await pump(f)
        if (step === "coordinate") f.loss(step)
        f.settle(
          "run-1",
          JSON.stringify({
            reply: "等待",
            intent: {
              kind: "create_task",
              sourceRequestId: "delegate",
              title: "工作",
              contextSourceIds: []
            }
          })
        )
        await pump(f, 1)
        await f.reopen()
        await pump(f)
        const card = (
          await f.app.read({ conversationId: id, taskRef: mainTaskRef, cursor: null })
        ).items.at(-1)!.coordination!
        f.settle("run-2", "完成草稿")
        await pump(f)
        if (step === "lifecycle") {
          f.loss(step)
          await f.app.taskLifecycle({
            conversationId: id,
            taskRef: card.taskRef,
            operationId: "complete",
            action: "complete"
          })
          await pump(f, 1)
          await f.reopen()
          await pump(f)
        }
        assert.equal(f.stats.creates, 2)
        assert.equal(f.stats.enqueues, 2)
        assert.equal(f.consumed.size, 1)
      } finally {
        await f.app.stop()
      }
    })
  )
test("bad main JSON is visible failure and does not poison subsequent chat", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    try {
      const { conversationId: id, mainTaskRef } = await init(f)
      await chat(f, id!, "bad", "你好")
      await pump(f)
      f.settle("run-1", "{bad}")
      await pump(f)
      const old = (await f.app.read({ conversationId: id, taskRef: mainTaskRef, cursor: null }))
        .items[0]
      assert.equal(old.status, "failed")
      assert.equal(old.result, null)
      assert.match(old.notice!, /格式/)
      await chat(f, id!, "next", "重新解释")
      await pump(f)
      assert.equal(f.stats.enqueues, 2)
      assert.ok([...f.inputs.values()].at(-1)!.messages.some((m) => m.text.includes("无法解析")))
      assert.equal(f.journal.hasPendingMain(serviceScopeKey(f.scope)), true)
    } finally {
      await f.app.stop()
    }
  }))

for (const output of [
  '{"reply":"bad","intent":null,"extra":true}',
  '{"reply":false,"intent":null}',
  '{"reply":"bad","intent":{"kind":"create_task","sourceRequestId":"bad-shape","title":"Task","contextSourceIds":["/bad/path"]}}'
])
  test("all malformed model shapes are recoverable protocol failures", () =>
    withSqlite(async (db) => {
      const f = expertSetup(db)
      try {
        const { conversationId: id, mainTaskRef } = await init(f)
        await chat(f, id!, "bad-shape", "讨论")
        await pump(f)
        f.settle("run-1", output)
        await pump(f)
        const old = (await f.app.read({ conversationId: id, taskRef: mainTaskRef, cursor: null }))
          .items[0]
        assert.equal(old.status, "failed")
        assert.equal(old.result, null)
        await chat(f, id!, "following", "继续讨论")
        await pump(f)
        assert.equal(f.stats.enqueues, 2)
      } finally {
        await f.app.stop()
      }
    }))
test("known coordinate refusal closes the barrier, uncertain refusal preserves original command", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    try {
      const { conversationId: id } = await init(f)
      await chat(f, id!, "refused", "请做任务")
      await pump(f)
      f.client.coordinateExpertTask = async () => {
        throw new PartnerLocalFault("INPUT_CHANGED")
      }
      f.settle(
        "run-1",
        JSON.stringify({
          reply: "等待",
          intent: {
            kind: "create_task",
            sourceRequestId: "refused",
            title: "Task",
            contextSourceIds: []
          }
        })
      )
      await pump(f)
      assert.equal(f.journal.hasPendingMain(serviceScopeKey(f.scope)), false)
      await chat(f, id!, "following", "正常解释")
      await pump(f)
      assert.equal(f.stats.enqueues, 2)
    } finally {
      await f.app.stop()
    }
  }))
test("running-target transfer waits without appending, and late stop after summary await prevents HTTP", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    try {
      const { conversationId: id } = await init(f)
      const work = await f.app.chat({
        conversationId: id,
        taskRef: null,
        role: "task",
        requestId: "work",
        text: "独立任务"
      })
      await pump(f)
      const task = f.journal.task(serviceScopeKey(f.scope), work.taskRef).task!
      await chat(f, id!, "transfer", "补充已有任务")
      await pump(f)
      f.settle(
        "run-2",
        JSON.stringify({
          reply: "等待",
          intent: { kind: "append_task", sourceRequestId: "transfer", targetTaskRef: task.id }
        })
      )
      await pump(f)
      assert.equal(f.stats.messages, 0)
      assert.equal(f.journal.hasPendingMain(serviceScopeKey(f.scope)), true)
      f.settle("run-1", "任务前文")
      const original = f.client.expertConversationSummaries
      let release: () => void = () => {}
      let entered = false
      f.client.expertConversationSummaries = async (...args: any[]) => {
        const value = await original(...args)
        if (!entered) {
          entered = true
          await new Promise<void>((resolve) => (release = resolve))
        }
        return value
      }
      const draining = f.app.drain()
      for (let i = 0; i < 20 && !entered; i++) await new Promise((r) => setTimeout(r, 1))
      await f.app.cancel({ conversationId: id, requestId: "transfer" })
      release()
      await draining
      assert.equal(f.stats.messages, 0)
      assert.equal(
        f.journal.request(serviceScopeKey(f.scope), "transfer").coordinationCancelled,
        true
      )
    } finally {
      await f.app.stop()
    }
  }))
test("the 41st task can be explicitly included by number without reading its goal", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    try {
      const { conversationId: id } = await init(f)
      for (let i = 0; i < 41; i++) {
        const task = await f.client.createTask("group", "Target " + i, "seed-" + i)
        f.journal.attachExpertTask(f.scope, id!, task)
      }
      const targets = f.journal.allowedTargets(serviceScopeKey(f.scope), id!, "给 TASK-1 补充说明")
      assert.equal(targets.length, 40)
      assert.equal(targets[0].task.id, "task-1")
      assert.equal(Object.hasOwn(targets[0].task, "goal"), false)
    } finally {
      await f.app.stop()
    }
  }))

test("completion that finishes during delayed model lookup rejects the late supplement", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    let release: () => void = () => {}
    try {
      const { conversationId: id } = await init(f)
      const r = await f.app.chat({
        conversationId: id,
        taskRef: null,
        role: "task",
        requestId: "work",
        text: "独立工作"
      })
      await pump(f)
      f.settle("run-1", "已回复")
      await pump(f)
      let entered = false
      const original = f.deps.model
      f.deps.model = async (ref) => {
        entered = true
        await new Promise<void>((resolve) => (release = resolve))
        return original(ref)
      }
      const delayed = chat(f, id!, "late", "补充", r.taskRef)
      for (let i = 0; i < 20 && !entered; i++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      await f.app.taskLifecycle({
        conversationId: id,
        taskRef: r.taskRef,
        operationId: "complete-race",
        action: "complete"
      })
      await f.app.drain()
      release()
      await assert.rejects(delayed, /INPUT_CHANGED/)
      assert.equal(f.stats.messages, 0)
    } finally {
      release()
      await f.app.stop()
    }
  }))
test("concurrent explicit retries admit one stable child; unknown outcomes cannot retry", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db),
      releases: Array<() => void> = []
    try {
      const { conversationId: id } = await init(f)
      const r = await f.app.chat({
        conversationId: id,
        taskRef: null,
        role: "task",
        requestId: "work",
        text: "原工作"
      })
      await pump(f)
      const key = serviceScopeKey(f.scope),
        old = f.journal.request(key, "work")
      f.runs.get("run-1")!.run.status = "failed"
      f.runs.get("run-1")!.run.version = 2
      f.runs.get("run-1")!.result = {
        runId: "run-1",
        attemptId: f.runs.get("run-1")!.run.attemptId,
        outcome: "failed",
        text: "EXECUTION_FAILED",
        settledAt: new Date().toISOString()
      }
      await pump(f)
      const original = f.deps.model
      f.deps.model = async (ref) => {
        await new Promise<void>((resolve) => releases.push(resolve))
        return original(ref)
      }
      const input = { conversationId: id, taskRef: r.taskRef, requestId: old.requestId }
      const a = f.app.retryChat({ ...input, operationId: "retry-a" }),
        b = f.app.retryChat({ ...input, operationId: "retry-b" })
      for (let i = 0; i < 30 && releases.length < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 1))
      assert.equal(releases.length, 2)
      for (const release of releases) release()
      const results = await Promise.allSettled([a, b])
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
      f.deps.model = original
      await pump(f)
      assert.equal(f.stats.enqueues, 2)
      assert.equal(f.stats.messages, 0)
      const active = f.journal.latest(key, r.taskRef)!
      f.app.markUnknown(f.scope, f.runs.get(active.runId!)!.run as any)
      await assert.rejects(
        f.app.retryChat({
          conversationId: id,
          taskRef: r.taskRef,
          requestId: active.requestId,
          operationId: "unknown-retry"
        }),
        /INPUT_CHANGED/
      )
    } finally {
      for (const release of releases) release()
      await f.app.stop()
    }
  }))

test("101 immutable replies page in bounded 40s with one current authorization and no per-result inspect", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    try {
      const { conversationId: id } = await init(f)
      const first = await f.app.chat({
        conversationId: id,
        taskRef: null,
        role: "task",
        requestId: "first",
        text: "任务目标"
      })
      await pump(f)
      f.settle("run-1", "原回复")
      await pump(f)
      const key = serviceScopeKey(f.scope)
      for (let i = 1; i <= 100; i++) {
        const r = f.journal.accept(
          f.scope,
          id!,
          first.taskRef,
          "history-" + i,
          "历史文本 " + i,
          model,
          1,
          "expert_task_v1"
        )
        f.journal.update(key, r.requestId, (v) => {
          v.phase = "terminal"
          v.status = "succeeded"
          v.result = {
            runId: "history-run-" + i,
            attemptId: "history-attempt-" + i,
            outcome: "succeeded",
            text: "历史回复 " + i,
            settledAt: new Date().toISOString()
          }
          v.runId = v.result.runId
        })
      }
      let authorizations = 0,
        maxBatch = 0
      const original = f.client.expertConversationSummaries
      f.client.expertConversationSummaries = async (group: string, bot: string, ids: string[]) => {
        authorizations++
        maxBatch = Math.max(maxBatch, ids.length)
        return original(group, bot, ids)
      }
      const before = f.stats.inspects
      let cursor: string | null = null
      const ids = new Set<string>()
      let pages = 0
      do {
        const page = await f.app.read({ conversationId: id, taskRef: first.taskRef, cursor })
        assert.ok(page.items.length <= 40)
        for (const r of page.items) {
          assert.equal(ids.has(r.requestId), false)
          ids.add(r.requestId)
        }
        cursor = page.nextCursor
        pages++
      } while (cursor)
      assert.equal(ids.size, 101)
      assert.equal(pages, 3)
      assert.equal(authorizations, 3)
      assert.equal(maxBatch, 1)
      assert.equal(f.stats.inspects, before)
    } finally {
      await f.app.stop()
    }
  }))
