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
