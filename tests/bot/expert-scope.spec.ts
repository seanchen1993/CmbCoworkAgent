import test from "node:test"
import assert from "node:assert/strict"
import { withSqlite } from "./requirement-execution-fixture"
import { expertSetup } from "./expert-conversation-fixture"
import { model } from "./service-conversation-fixture"
import { serviceScopeKey } from "../../src/main/services/bot/service-conversation-store"
import { prepareServiceConversationScope } from "../../src/main/services/bot/service-conversation-scope"
import type { PartnerLocalClient } from "../../src/main/services/bot/partner-local-client"
test("populated old URL wins over an empty sibling, retaining model, refs, original commands and pending intents", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    try {
      const info = await f.app.openChats(),
        id = info.conversationId!,
        oldScope = f.scope,
        key = serviceScopeKey(oldScope)
      await f.app.selectModel({ conversationId: id, modelRef: model.ref })
      const first = await f.app.send({
        conversationId: id,
        taskRef: null,
        requestId: "old-request",
        text: "原任务"
      })
      await f.app.drain()
      f.settle("run-1", "原正文")
      await f.app.drain()
      await f.app.stop()
      f.journal.accept(oldScope, id, first.taskRef, "pending-latest", "下一轮", model)
      f.journal.accept(oldScope, id, null, "pending-uncreated", "尚未建立Task", model)
      const command = f.journal.request(key, "pending-latest").enqueueCommand
      const empty = f.journal.conversation({ ...oldScope, url: "http://127.0.0.1:60439" })
      const current = {
          ...oldScope,
          url: "http://127.0.0.1:61614",
          serviceInstanceId: "instance-one"
        },
        next = serviceScopeKey(current)
      await prepareServiceConversationScope(
        f.journal,
        current,
        f.client as unknown as PartnerLocalClient
      )
      const restored = f.journal.requireConversation(current, id)
      assert.equal(restored.id, id)
      assert.deepEqual(restored.model, model)
      assert.equal(f.journal.request(next, "pending-latest").enqueueCommand, command)
      assert.equal(f.journal.request(next, "pending-latest").runId, null)
      assert.equal(f.journal.request(next, "pending-uncreated").phase, "saved")
      assert.equal(f.journal.task(next, first.taskRef).task!.id, "task-1")
      assert.equal(
        f.journal.conversation({ ...oldScope, url: "http://127.0.0.1:60439" }).id,
        empty.id
      )
      await prepareServiceConversationScope(
        f.journal,
        { ...current, url: "http://127.0.0.1:62222" },
        f.client as unknown as PartnerLocalClient
      )
      assert.equal(serviceScopeKey({ ...current, url: "http://127.0.0.1:62222" }), next)
    } finally {
      await f.app.stop()
    }
  }))
test("a scope with only local unsent intent is explicitly blocked instead of hidden or adopted without service proof", () =>
  withSqlite(async (db) => {
    const f = expertSetup(db)
    try {
      const old = f.journal.conversation(f.scope)
      f.journal.accept(f.scope, old.id, null, "only-local", "仅在本地", model)
      await assert.rejects(
        prepareServiceConversationScope(
          f.journal,
          { ...f.scope, url: "http://127.0.0.1:61614", serviceInstanceId: "different-service" },
          f.client as unknown as PartnerLocalClient
        ),
        /SCOPE_MIGRATION_CONFLICT/
      )
      assert.equal(f.journal.request(serviceScopeKey(f.scope), "only-local").text, "仅在本地")
    } finally {
      await f.app.stop()
    }
  }))
