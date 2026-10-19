import assert from "node:assert/strict"
import test from "node:test"
import {
  ServiceConversationStore,
  serviceScopeKey,
  type ServiceScope
} from "../../src/main/services/bot/service-conversation-store"
import { ServiceConversationService } from "../../src/main/services/bot/service-conversation"
import { ServiceConversationRouter } from "../../src/main/services/bot/service-conversation-router"
import { serviceModelBinding } from "../../src/main/services/bot/service-model-binding"
import {
  PartnerLocalFault,
  type PartnerLocalClient
} from "../../src/main/services/bot/partner-local-client"
import type { Task } from "../../src/shared/bot/contracts.generated"
import type { PartnerRequirementRun } from "../../src/main/services/bot/requirement-execution-types"
import { inputFixture, runFixture, withSqlite } from "./requirement-execution-fixture"
import { model, setup, initialize, send } from "./service-conversation-fixture"
test("one send persists original commands; same request replay/conflict and same-text new request", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        first = await send(f, id, "request-1")
      await f.app.drain()
      assert.equal(f.stats.creates, 1)
      assert.equal(f.stats.enqueues, 1)
      assert.equal((await send(f, id, "request-1")).taskRef, first.taskRef)
      await assert.rejects(send(f, id, "request-1", null, "changed"), /COMMAND_CONFLICT/)
      await send(f, id, "request-2")
      await f.app.drain()
      assert.equal(f.stats.creates, 2)
      assert.equal(f.stats.enqueues, 2)
      assert.equal(f.journal.request(serviceScopeKey(f.scope), "request-1").model.hash, model.hash)
    } finally {
      await f.app.stop()
    }
  }))
for (const lossCode of ["DEPENDENCY_UNAVAILABLE", "OUTCOME_UNKNOWN"])
  for (const step of ["create", "message", "enqueue"] as const)
    test(`${step} ${lossCode} commit then lost response resumes exact command after reopen`, () =>
      withSqlite(async (db) => {
        const f = setup(db)
        try {
          const id = await initialize(f)
          if (step === "message") {
            const first = await send(f, id, "first")
            await f.app.drain()
            f.settle("run-1")
            await f.app.drain()
            await send(f, id, "followup", first.taskRef, "补充规则")
          } else await send(f, id, "first")
          f.setLost(step, lossCode)
          await f.app.drain()
          const snapshot = [...f.commands.keys()]
          await f.reopen()
          await f.app.drain()
          assert.equal(f.stats.creates, 1)
          assert.equal(f.stats.messages, step === "message" ? 1 : 0)
          assert.equal(f.stats.enqueues, step === "message" ? 2 : 1)
          assert.ok(snapshot.every((command) => f.commands.has(command)))
        } finally {
          await f.app.stop()
        }
      }))
test("local receipt write failure after HTTP success retries original create without duplication", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f)
      await send(f, id, "first")
      const original = f.journal.saveTask.bind(f.journal)
      let fail = true
      f.journal.saveTask = (key, record) => {
        if (fail) {
          fail = false
          throw new PartnerLocalFault("STORAGE_FAILURE")
        }
        original(key, record)
      }
      await f.app.drain()
      assert.equal(f.stats.creates, 1)
      await f.reopen()
      await f.app.drain()
      assert.equal(f.stats.creates, 1)
      assert.equal(f.stats.enqueues, 1)
    } finally {
      await f.app.stop()
    }
  }))
test("supplements wait for prior terminal, use same Task sequential CAS, two tasks isolate inputs", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        first = await send(f, id, "first")
      await f.app.drain()
      await send(f, id, "supplement-1", first.taskRef, "补充一")
      await send(f, id, "supplement-2", first.taskRef, "补充二")
      await f.app.drain()
      assert.equal(f.stats.messages, 0)
      assert.equal(f.journal.request(serviceScopeKey(f.scope), "supplement-1").status, "next_round")
      assert.equal(f.journal.request(serviceScopeKey(f.scope), "supplement-1").deadline, null)
      f.settle("run-1")
      await f.app.drain()
      await f.app.drain()
      assert.equal(f.stats.messages, 1)
      assert.equal(f.stats.enqueues, 2)
      f.settle("run-2")
      await f.app.drain()
      await f.app.drain()
      assert.equal(f.stats.messages, 2)
      assert.equal(f.tasks.get("task-1")!.version, 5)
      assert.equal(f.stats.enqueues, 3)
      const other = await send(f, id, "other", null, "另外一件工作")
      await f.app.drain()
      assert.notEqual(other.taskRef, first.taskRef)
      assert.equal(f.stats.creates, 2)
    } finally {
      await f.app.stop()
    }
  }))
test("cached success replay and history require current remote permission; identity switch never returns old journal", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        first = await send(f, id, "first")
      await f.app.drain()
      f.settle("run-1")
      await f.app.drain()
      const allowedContext = f.deps.context
      // Current group context can remain readable while this specific Run is denied.
      f.deps.context = async () => {
        const was = f.context
        return was()
      }
      const original = f.client.inspect
      f.client.inspect = async () => {
        throw new PartnerLocalFault("FORBIDDEN")
      }
      await assert.rejects(send(f, id, "first"), /FORBIDDEN/)
      await assert.rejects(
        f.app.read({ conversationId: id, taskRef: first.taskRef, cursor: null }),
        /FORBIDDEN/
      )
      f.client.inspect = original
      f.deps.context = allowedContext
      f.switchScope()
      await assert.rejects(f.app.tasks({ conversationId: id, cursor: null }), /FORBIDDEN/)
      await assert.rejects(send(f, id, "first"), /FORBIDDEN/)
      const next = await f.app.open()
      assert.notEqual(next.conversationId, id)
    } finally {
      await f.app.stop()
    }
  }))
test("cancel before submit and pending Run; unknown predecessor prevents automatic next analysis", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f)
      await send(f, id, "cancel-early")
      await f.app.cancel({ conversationId: id, requestId: "cancel-early" })
      await f.app.drain()
      assert.equal(f.stats.creates, 0)
      const first = await send(f, id, "first")
      await f.app.drain()
      await f.app.cancel({ conversationId: id, requestId: "first" })
      await f.app.drain()
      assert.equal(f.stats.cancels, 1)
      const second = await send(f, id, "second", first.taskRef, "继续")
      await f.app.drain()
      const r = f.journal.request(serviceScopeKey(f.scope), "second")
      f.runs.get(r.runId!)!.run.status = "outcome_unknown"
      await send(f, id, "after-unknown", second.taskRef, "不能自动重跑")
      await f.app.drain()
      await f.app.drain()
      assert.equal(f.journal.request(serviceScopeKey(f.scope), "after-unknown").status, "blocked")
      assert.equal(f.stats.enqueues, 2)
    } finally {
      await f.app.stop()
    }
  }))
test("exact enqueue binding admits early claim before HTTP receipt; changed command/task/principal denied", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        key = serviceScopeKey(f.scope)
      let executions = 0
      const executor = {
        execute: async (run: PartnerRequirementRun) => {
          executions++
          return {
            runId: run.id,
            attemptId: run.attemptId,
            outcome: "succeeded" as const,
            text: "done",
            settledAt: new Date().toISOString()
          }
        },
        cancel: () => true
      }
      const router = new ServiceConversationRouter({
        scope: f.scope,
        store: f.journal,
        legacy: executor,
        legacyRunId: null,
        model: f.deps.model,
        createExecutor: () => executor,
        claimed: (scope, run) => f.app.claimed(scope, run),
        finished: () => {}
      })
      f.setEarly(async (id) => {
        const run = {
          ...f.runs.get(id)!.run,
          status: "starting"
        } as unknown as PartnerRequirementRun
        await router.execute(run)
      })
      await send(f, id, "first")
      await f.app.drain()
      assert.equal(executions, 1)
      const r = f.journal.request(key, "first")
      assert.equal(r.runId, "run-1")
      assert.equal(r.status, "starting")
      const run = {
        ...f.runs.get("run-1")!.run,
        status: "starting"
      } as unknown as PartnerRequirementRun
      for (const altered of [
        { commandId: "another-command" },
        { taskVersion: 2 },
        { requesterPrincipalId: "another-user" },
        { id: "another-run" },
        { attemptId: "another-attempt" }
      ])
        await assert.rejects(router.execute({ ...run, ...altered }), /EXECUTION_BINDING_MISMATCH/)
    } finally {
      await f.app.stop()
    }
  }))
test("model drift rejects saved original intent; binding hashes non-secret execution fields only", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f)
      await send(f, id, "first")
      f.drift()
      await f.app.drain()
      assert.equal(f.stats.creates, 0)
      assert.equal(f.journal.request(serviceScopeKey(f.scope), "first").notice, "MODEL_CHANGED")
      const config = {
        ref: model.ref,
        name: "name",
        apiKey: "TEST_SECRET",
        baseUrl: "https://example.test/v1",
        model: "fixture",
        temperature: 1
      }
      const a = serviceModelBinding(config, model.ref),
        b = serviceModelBinding({ ...config, apiKey: "ROTATED_SECRET" }, model.ref)
      assert.equal(a.hash, b.hash)
      assert.ok(!JSON.stringify(a).includes("SECRET"))
      assert.notEqual(a.hash, serviceModelBinding({ ...config, temperature: 0.8 }, model.ref).hash)
      assert.throws(
        () =>
          serviceModelBinding(
            { ...config, baseUrl: "https://example.test/v1?api_key=secret" },
            model.ref
          ),
        /MODEL_UNAVAILABLE/
      )
    } finally {
      await f.app.stop()
    }
  }))
test("stable keyset task/request pages have no truncation, duplicates or cross-scope cursor reuse", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f)
      for (let i = 0; i < 95; i++)
        f.journal.accept(f.scope, id, null, "request-" + i, "task-" + i, model)
      let next: string | null = null
      const refs: string[] = []
      do {
        const page = await f.app.tasks({ conversationId: id, cursor: next })
        refs.push(...page.items.map((t) => t.taskRef))
        next = page.nextCursor
      } while (next)
      assert.equal(refs.length, 95)
      assert.equal(new Set(refs).size, 95)
      const page = await f.app.tasks({ conversationId: id, cursor: null })
      const oldCursor = page.nextCursor
      f.switchScope()
      const other = await f.app.open()
      await assert.rejects(
        f.app.tasks({ conversationId: other.conversationId, cursor: oldCursor }),
        /INVALID_PAYLOAD/
      )
    } finally {
      await f.app.stop()
    }
  }))

test("cancel racing claim preserves intent until exact owned attempt can stop", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f)
      await send(f, id, "request")
      await f.app.drain()
      let owned: string | null = null
      f.deps.cancelOwned = (id: string) => {
        owned = id
        return true
      }
      f.client.cancelPending = async (runId: string) => {
        f.runs.get(runId)!.run.status = "running"
        throw new PartnerLocalFault("OUTCOME_UNKNOWN")
      }
      await f.app.cancel({ conversationId: id, requestId: "request" })
      await f.app.drain()
      await f.app.drain()
      assert.equal(owned, "run-1")
      assert.equal(f.journal.request(serviceScopeKey(f.scope), "request").cancelRequested, true)
      assert.equal(f.stats.enqueues, 1)
    } finally {
      await f.app.stop()
    }
  }))

test("local unknown survives read-only remote running; only a real service result resolves it", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        first = await send(f, id, "request")
      await f.app.drain()
      const raw = f.runs.get("run-1")!.run
      raw.status = "running"
      f.app.markUnknown(f.scope, raw as unknown as PartnerRequirementRun)
      const unknown = await f.app.read({ conversationId: id, taskRef: first.taskRef, cursor: null })
      assert.equal(unknown.items[0].status, "outcome_unknown")
      await send(f, id, "waiting", first.taskRef, "等待核对的补充")
      await f.app.drain()
      assert.equal(f.stats.messages, 0)
      assert.equal(f.stats.enqueues, 1)
      assert.equal(f.journal.request(serviceScopeKey(f.scope), "waiting").status, "blocked")
      f.settle("run-1")
      const resolved = await f.app.read({
        conversationId: id,
        taskRef: first.taskRef,
        cursor: null
      })
      assert.equal(resolved.items.find((r) => r.requestId === "request")!.status, "succeeded")
      assert.equal(f.stats.enqueues, 1)
    } finally {
      await f.app.stop()
    }
  }))

test("message VERSION_CONFLICT is visible and later supplements cannot silently skip it", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    try {
      const id = await initialize(f),
        first = await send(f, id, "request")
      await f.app.drain()
      f.settle("run-1")
      await f.app.drain()
      f.client.createMessage = async () => {
        throw new PartnerLocalFault("VERSION_CONFLICT")
      }
      await send(f, id, "conflict", first.taskRef, "必须保留的补充")
      await send(f, id, "later", first.taskRef, "后来的补充")
      await f.app.drain()
      await f.app.drain()
      const key = serviceScopeKey(f.scope)
      assert.equal(f.journal.request(key, "conflict").notice, "VERSION_CONFLICT")
      assert.equal(f.journal.request(key, "later").status, "blocked")
      assert.equal(f.stats.messages, 0)
      assert.equal(f.stats.enqueues, 1)
    } finally {
      await f.app.stop()
    }
  }))

for (const state of [
  "outcome_unknown",
  "waiting_node",
  "running",
  "succeeded",
  "failed",
  "cancelled"
] as const)
  test(`late enqueue receipt preserves earlier ${state} projection`, () =>
    withSqlite(async (db) => {
      const f = setup(db)
      try {
        const conversationId = await initialize(f),
          key = serviceScopeKey(f.scope),
          requestId = "late-receipt"
        const projections: ReturnType<typeof f.journal.request>[] = []
        f.setEarly(async (runId) => {
          const remote = f.runs.get(runId)!,
            run = { ...remote.run, status: "starting" } as unknown as PartnerRequirementRun
          f.journal.claim(key, run)
          f.app.claimed(f.scope, run)
          if (state === "outcome_unknown") {
            remote.run.status = "running"
            f.app.markUnknown(f.scope, run)
          } else {
            remote.run.status = state
            remote.run.version = 3
            if (state === "succeeded" || state === "failed")
              remote.result = {
                runId,
                attemptId: run.attemptId,
                outcome: state,
                text: state === "succeeded" ? "已完成的分析" : "EXECUTION_FAILED",
                settledAt: new Date().toISOString()
              }
            const record = f.journal.request(key, requestId)
            await f.app.read({ conversationId, taskRef: record.taskRef, cursor: null })
          }
          projections.push(f.journal.request(key, requestId))
        })
        const first = await send(f, conversationId, requestId)
        await f.app.drain()
        assert.equal(projections.length, 1)
        const { revision: _beforeRevision, ...before } = projections[0]
        const { revision: _afterRevision, ...after } = f.journal.request(key, requestId)
        assert.deepEqual(
          after,
          before,
          "an enqueue acknowledgement cannot overwrite newer execution state, notice or result"
        )
        assert.equal(f.stats.creates, 1)
        assert.equal(f.stats.enqueues, 1)
        if (state === "outcome_unknown") {
          f.setEarly(null)
          await send(f, conversationId, "later-supplement", first.taskRef, "先核对上一轮")
          await f.app.drain()
          assert.equal(f.journal.request(key, "later-supplement").status, "blocked")
          assert.equal(f.stats.messages, 0)
          assert.equal(f.stats.enqueues, 1)
        }
      } finally {
        await f.app.stop()
      }
    }))
