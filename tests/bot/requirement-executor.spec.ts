import assert from "node:assert/strict"
import test from "node:test"
import type { TaskMessageResult } from "../../src/shared/bot/contracts.generated"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { FakeChatModel } from "@langchain/core/utils/testing"
import { insertThreadRecord } from "../../src/main/db/thread-record"
import {
  registerAgentRunImplementation,
  registerPartnerInputOnlyImplementation,
  startAgentRun
} from "../../src/main/agent/agent-run-service"
import { getLocalThreadRunLease } from "../../src/main/agent/thread-run-lease"
import { createInputOnlyRequirementImplementation } from "../../src/main/services/bot/input-only-requirement-run"
import { PartnerRequirementAttemptStore } from "../../src/main/services/bot/requirement-attempt-store"
import { PartnerTaskThreadStore } from "../../src/main/services/bot/task-thread-store"
import { PartnerRequirementExecutor } from "../../src/main/services/bot/requirement-executor"
import type {
  PartnerRequirementControl,
  PartnerRequirementResult
} from "../../src/main/services/bot/requirement-execution-types"
import {
  delivery,
  inputFixture,
  open,
  runFixture,
  withSqlite
} from "./requirement-execution-fixture"
import type { GroupMemorySnapshot } from "../../src/shared/bot/group-memory"
import { memoryFixture } from "./group-memory-fixture"

test("uninitialized restricted profile never falls back to personal execution; default callers unchanged", async () => {
  let personalCalls = 0
  registerAgentRunImplementation(async () => {
    personalCalls++
  })
  await assert.rejects(
    startAgentRun({ threadId: "task-thread", message: "test" }, delivery, {
      source: "im",
      partnerInputOnly: { systemPrompt: "test", modelRef: "explicit-model" }
    }),
    /not initialized/
  )
  assert.equal(personalCalls, 0)
  await (
    await startAgentRun({ threadId: "personal", message: "test" }, delivery)
  ).completion
  assert.equal(personalCalls, 1)
})

function setup(
  db: Parameters<typeof insertThreadRecord>[0],
  options: {
    response?: AIMessage
    wait?: boolean
    leaseMs?: number
    renewFails?: boolean
    loseSettlement?: boolean
    memory?: GroupMemorySnapshot | null
    memoryPolicy?: "disabled" | "explicit_only"
    renewMemoryChanged?: boolean
    settleMemoryChanged?: boolean
  } = {}
) {
  const run = runFixture(),
    input = inputFixture(),
    threads = new PartnerTaskThreadStore(db),
    attempts = new PartnerRequirementAttemptStore(db)
  if (options.leaseMs) run.leaseExpiresAt = new Date(Date.now() + options.leaseMs).toISOString()
  input.memorySnapshot = options.memory ?? null
  input.botVersion.config.memoryPolicy = options.memoryPolicy ?? "disabled"
  const stats = {
    models: 0,
    starts: 0,
    renews: 0,
    settles: 0,
    personal: 0,
    prompts: [] as string[],
    tools: [] as unknown[]
  }
  let currentSignal: AbortSignal | undefined
  class Model extends FakeChatModel {
    bindTools(tools: unknown[]) {
      stats.tools.push(...tools)
      return this
    }
    async _generate(messages: BaseMessage[]) {
      stats.models++
      stats.prompts.push(
        messages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n")
      )
      if (options.wait)
        await new Promise<void>((resolve) => {
          if (currentSignal?.aborted) resolve()
          else currentSignal?.addEventListener("abort", () => resolve(), { once: true })
        })
      const message =
        options.response ??
        new AIMessage("## 需求说明书草稿\n范围：日期查询。待澄清：可查账户与日期边界。")
      return {
        generations: [{ message, text: typeof message.content === "string" ? message.content : "" }]
      }
    }
  }
  registerAgentRunImplementation(async () => {
    stats.personal++
  })
  registerPartnerInputOnlyImplementation(
    createInputOnlyRequirementImplementation({
      resolveThread(threadId) {
        const r = db.exec("SELECT metadata FROM threads WHERE thread_id=?", [threadId])[0]
          .values[0][0]
        const metadata = JSON.parse(String(r))
        return { metadata, workspacePath: metadata.workspacePath }
      },
      resolveModel(ref) {
        assert.equal(ref, "owner-model")
        return new Model({})
      }
    })
  )
  let persisted: PartnerRequirementResult | undefined
  const control: PartnerRequirementControl = {
    async start(ticket) {
      stats.starts++
      assert.equal(ticket.attemptId, run.attemptId)
      return { run: { ...run, status: "running" }, input }
    },
    async renew(value) {
      stats.renews++
      if (options.renewMemoryChanged) throw Error("INPUT_CHANGED")
      if (options.renewFails) throw Error("AUTH_REVOKED")
      return { ...value, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() }
    },
    async settle(value, outcome, text) {
      stats.settles++
      if (options.settleMemoryChanged) throw Error("INPUT_CHANGED")
      if (persisted) {
        assert.equal(persisted.outcome, outcome)
        assert.equal(persisted.text, text)
        return persisted
      }
      persisted = {
        runId: value.id,
        attemptId: value.attemptId,
        outcome,
        text,
        settledAt: new Date().toISOString()
      }
      if (options.loseSettlement) throw Error("LOST_RECEIPT")
      return persisted
    },
    async memoryChanged() {
      return !!options.renewMemoryChanged || !!options.settleMemoryChanged
    }
  }
  const dependencies = {
    config: {
      spaceId: "A",
      nodeId: "node",
      ownerPrincipalId: "owner",
      modelRef: "owner-model",
      workspaces: new Map([["workspace", "/explicit-workspace"]])
    },
    control,
    threads,
    attempts,
    delivery,
    renewalIntervalMs: 20,
    startRun: ((request, target, context) => {
      currentSignal = context?.signal
      return startAgentRun(request, target, context)
    }) as typeof startAgentRun
  }
  return {
    run,
    input,
    stats,
    attempts,
    threads,
    control,
    dependencies,
    executor: new PartnerRequirementExecutor(dependencies)
  }
}

test("actual existing DeepAgent graph, zero tools, dedicated Thread and no personal context; duplicate invocation shares one completion", () =>
  withSqlite(async (db) => {
    const privateThread = insertThreadRecord(db, "personal", {
      workspacePath: "/private",
      memoryEnabled: true,
      identity: "PERSONAL_SENTINEL",
      history: "PRIVATE_CHAT"
    })
    const f = setup(db)
    const first = f.executor.execute(f.run),
      duplicate = f.executor.execute(f.run)
    assert.equal(first, duplicate)
    await assert.rejects(
      f.executor.execute({ ...f.run, leaseId: "different-lease" }),
      /INPUT_CHANGED/
    )
    const result = await first
    assert.equal(result.outcome, "succeeded")
    assert.match(result.text, /需求说明书草稿/)
    assert.equal(f.stats.models, 1)
    assert.equal(f.stats.starts, 1)
    assert.equal(f.stats.personal, 0)
    assert.equal(f.stats.tools.length, 0)
    assert.ok(f.stats.prompts.every((p) => !/PERSONAL_SENTINEL|PRIVATE_CHAT|\/private/.test(p)))
    assert.match(f.stats.prompts[0], /支付专家/)
    assert.match(f.stats.prompts[0], /交易查询/)
    assert.equal(
      String(db.exec("SELECT metadata FROM threads WHERE thread_id='personal'")[0].values[0][0]),
      privateThread.metadata
    )
    assert.equal(f.attempts.get(f.run)?.state, "settled")
    assert.equal(getLocalThreadRunLease(f.attempts.get(f.run)!.threadId), undefined)
  }))

test("Thread repurposed between admission and graph start fails before a model or personal fallback", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    f.dependencies.startRun = ((request, target, context) => {
      const metadata = JSON.parse(
        String(
          db.exec("SELECT metadata FROM threads WHERE thread_id=?", [request.threadId])[0]
            .values[0][0]
        )
      )
      metadata.memoryEnabled = true
      db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [
        JSON.stringify(metadata),
        request.threadId
      ])
      return startAgentRun(request, target, context)
    }) as typeof startAgentRun
    const executor = new PartnerRequirementExecutor(f.dependencies)
    const result = await executor.execute(f.run)
    assert.equal(result.outcome, "failed")
    assert.equal(result.text, "EXECUTION_FAILED")
    assert.equal(f.stats.models, 0)
    assert.equal(f.stats.personal, 0)
  }))

test("explicit Task clarifications enter the same frozen task input, never ambient history", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    f.run.taskVersion = 2
    f.input.task.version = 2
    f.input.messages = [
      {
        taskVersion: 2,
        message: {
          id: "message",
          spaceId: "A",
          taskId: "task",
          authorPrincipalId: "business",
          text: "CLARIFICATION_SENTINEL 只查本人可见账户",
          artifactVersions: [],
          createdAt: "2026-10-11T08:01:00Z"
        }
      }
    ]
    assert.equal((await f.executor.execute(f.run)).outcome, "succeeded")
    assert.match(f.stats.prompts[0], /CLARIFICATION_SENTINEL/)
  }))

test("foreign, future, duplicate or attachment clarification input is refused before a model", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    f.run.taskVersion = 2
    f.input.task.version = 2
    const original: TaskMessageResult = {
      taskVersion: 2,
      message: {
        id: "message",
        spaceId: "A",
        taskId: "task",
        authorPrincipalId: "business",
        text: "explicit",
        artifactVersions: [],
        createdAt: "2026-10-11T08:01:00Z"
      }
    }
    for (const change of ["foreign", "future", "duplicate", "attachment"]) {
      const value = structuredClone(original)
      if (change === "foreign") value.message.taskId = "other-task"
      if (change === "future") value.taskVersion = 3
      if (change === "attachment")
        value.message.artifactVersions.push({
          artifactId: "artifact",
          versionId: "version",
          digest: "a".repeat(64)
        })
      f.input.messages = change === "duplicate" ? [value, value] : [value]
      await assert.rejects(f.executor.execute(f.run), /INPUT_CHANGED/)
    }
    assert.equal(f.stats.models, 0)
  }))

test("lost server receipt and SQLite reopen resubmit only the identical persisted result", () =>
  withSqlite(async (db, path) => {
    const f = setup(db, { loseSettlement: true })
    await assert.rejects(f.executor.execute(f.run), /LOST_RECEIPT/)
    assert.equal(f.attempts.get(f.run)?.state, "result_ready")
    const reopened = open(path)
    try {
      const next = new PartnerRequirementExecutor({
        ...f.dependencies,
        threads: new PartnerTaskThreadStore(reopened),
        attempts: new PartnerRequirementAttemptStore(reopened)
      })
      const a = await next.execute(f.run),
        b = await next.execute(f.run)
      assert.deepEqual(a, b)
      assert.equal(f.stats.models, 1)
      assert.equal(f.stats.starts, 1)
      assert.equal(f.stats.settles, 3)
    } finally {
      reopened.close()
    }
  }))

test("crash/reserved and a different attempt never restart or inherit the original result", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    const binding = f.threads.ensure({
      spaceId: "A",
      taskId: "task",
      stageId: "stage",
      runtimeNodeId: "node",
      groupId: "group",
      ownerPrincipalId: "owner",
      workspaceRef: "workspace",
      workspacePath: "/explicit-workspace"
    })
    f.attempts.reserve(f.run, binding.localThreadId, "a".repeat(64))
    await assert.rejects(f.executor.execute(f.run), /OUTCOME_UNKNOWN/)
    await assert.rejects(
      f.executor.execute({ ...f.run, attemptId: "other-attempt" }),
      /ATTEMPT_CHANGED/
    )
    assert.equal(f.stats.models, 0)
    assert.equal(f.stats.starts, 0)
  }))

test("two independent App connections cannot admit two models", () =>
  withSqlite(async (db, path) => {
    const f = setup(db),
      other = open(path)
    try {
      const next = new PartnerRequirementExecutor({
        ...f.dependencies,
        threads: new PartnerTaskThreadStore(other),
        attempts: new PartnerRequirementAttemptStore(other)
      })
      const result = await Promise.allSettled([f.executor.execute(f.run), next.execute(f.run)])
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1)
      assert.equal(f.stats.models, 1)
    } finally {
      other.close()
    }
  }))

test("renewal denial aborts actual graph; no success/settlement and no replay", () =>
  withSqlite(async (db) => {
    const f = setup(db, { wait: true, renewFails: true })
    await assert.rejects(f.executor.execute(f.run), /LEASE_LOST/)
    assert.equal(f.stats.models, 1)
    assert.equal(f.stats.renews, 1)
    assert.equal(f.stats.settles, 0)
    assert.equal(getLocalThreadRunLease(f.attempts.get(f.run)!.threadId), undefined)
    await assert.rejects(f.executor.execute(f.run), /OUTCOME_UNKNOWN/)
  }))

test("lease expiry stops graph even while renew is stuck", () =>
  withSqlite(async (db) => {
    const f = setup(db, { wait: true, leaseMs: 100 })
    f.control.renew = () => new Promise(() => {})
    await assert.rejects(f.executor.execute(f.run), /LEASE_LOST/)
    assert.equal(f.stats.models, 1)
    assert.equal(f.stats.settles, 0)
  }))

test("stop during server admission is retained and never invokes a model", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    let release!: () => void
    const started = f.control.start
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.control.start = async (run) => {
      await gate
      return started(run)
    }
    const pending = f.executor.execute(f.run)
    assert.equal(f.executor.cancel(f.run), true)
    release()
    const result = await pending
    assert.equal(result.outcome, "failed")
    assert.equal(result.text, "CANCELLED")
    assert.equal(f.stats.models, 0)
  }))

test("manual stop records only a safe failure after the graph stops", () =>
  withSqlite(async (db) => {
    const f = setup(db, { wait: true })
    const pending = f.executor.execute(f.run)
    const timeout = setTimeout(() => f.executor.cancel(f.run), 80)
    try {
      const result = await pending
      assert.equal(result.outcome, "failed")
      assert.equal(result.text, "CANCELLED")
    } finally {
      clearTimeout(timeout)
    }
    assert.equal(f.stats.models, 1)
  }))

for (const [name, response, expected] of [
  [
    "tools",
    new AIMessage({
      content: "",
      tool_calls: [
        { id: "shell", name: "execute", args: { command: "read secret" }, type: "tool_call" }
      ]
    }),
    "TOOL_CALL_REJECTED"
  ],
  ["empty", new AIMessage("  "), "EMPTY_OUTPUT"],
  [
    "truncated",
    new AIMessage({ content: "partial", response_metadata: { finish_reason: "length" } }),
    "EXECUTION_FAILED"
  ]
] as const)
  test(`actual graph refuses ${name} rather than claiming completion`, () =>
    withSqlite(async (db) => {
      const f = setup(db, { response })
      const result = await f.executor.execute(f.run)
      assert.equal(result.outcome, "failed")
      assert.equal(result.text, expected)
      assert.equal(f.stats.models, 1)
      assert.equal(f.stats.personal, 0)
    }))

test("server denial, frozen input drift, wrong node and malformed IDs cannot call a model", () =>
  withSqlite(async (db) => {
    const f = setup(db)
    await assert.rejects(f.executor.execute({ ...f.run, nodeId: "other" }), /NODE_MISMATCH/)
    assert.throws(() => f.executor.execute({ ...f.run, attemptId: undefined! }), /INPUT_INVALID/)
    f.input.task.version = 2
    await assert.rejects(f.executor.execute(f.run), /INPUT_CHANGED/)
    f.control.start = async () => {
      throw Error("FORBIDDEN")
    }
    await assert.rejects(f.executor.execute(f.run), /FORBIDDEN/)
    assert.equal(f.stats.models, 0)
    assert.equal(db.exec("SELECT COUNT(*) FROM threads")[0].values[0][0], 0)
  }))

test("server Group snapshot is injected into the actual zero-tool graph with versions and no personal memory", () =>
  withSqlite(async (db) => {
    const f = setup(db, {
      memoryPolicy: "explicit_only",
      memory: { revision: 3, memories: [memoryFixture()] }
    })
    await f.executor.execute(f.run)
    assert.match(f.stats.prompts[0], /交易查询仅提供T\+1数据/)
    assert.match(f.stats.prompts[0], /memory:memory-a:v1/)
    assert.equal(f.stats.tools.length, 0)
    assert.equal(f.stats.models, 1)
    await f.executor.execute(f.run)
    assert.equal(f.stats.models, 1)
  }))

test("disabled and explicit-only policies require corresponding server snapshots, no implicit fallback", () =>
  withSqlite(async (db) => {
    const disabled = setup(db, { memory: { revision: 1, memories: [memoryFixture()] } })
    await assert.rejects(disabled.executor.execute(disabled.run), /INPUT_CHANGED/)
    assert.equal(disabled.stats.models, 0)
    const enabled = setup(db, { memoryPolicy: "explicit_only" })
    await assert.rejects(enabled.executor.execute(enabled.run), /INPUT_CHANGED/)
    assert.equal(enabled.stats.models, 0)
  }))

test("cross-Group, duplicate and inactive snapshot entries are refused before model or Thread allocation", () =>
  withSqlite(async (db) => {
    for (const memories of [
      [memoryFixture({ groupId: "other" })],
      [memoryFixture(), memoryFixture()],
      [memoryFixture({ status: "disabled" })]
    ]) {
      const f = setup(db, { memoryPolicy: "explicit_only", memory: { revision: 1, memories } })
      await assert.rejects(f.executor.execute(f.run))
      assert.equal(f.stats.models, 0)
    }
    assert.equal(db.exec("SELECT COUNT(*) FROM threads")[0].values[0][0], 0)
  }))

test("confirmed memory revision invalidation aborts the actual graph and does not settle or rerun", () =>
  withSqlite(async (db) => {
    const f = setup(db, {
      wait: true,
      renewMemoryChanged: true,
      memoryPolicy: "explicit_only",
      memory: { revision: 1, memories: [memoryFixture()] }
    })
    await assert.rejects(f.executor.execute(f.run), /PARTNER_MEMORY_CHANGED/)
    assert.equal(f.stats.models, 1)
    assert.equal(f.stats.settles, 0)
    await assert.rejects(f.executor.execute(f.run), /OUTCOME_UNKNOWN/)
    assert.equal(f.stats.models, 1)
  }))

test("revision change at settlement keeps unpublished local result and retry never calls a model again", () =>
  withSqlite(async (db) => {
    const f = setup(db, {
      settleMemoryChanged: true,
      memoryPolicy: "explicit_only",
      memory: { revision: 1, memories: [memoryFixture()] }
    })
    await assert.rejects(f.executor.execute(f.run), /PARTNER_MEMORY_CHANGED/)
    await assert.rejects(f.executor.execute(f.run), /PARTNER_MEMORY_CHANGED/)
    assert.equal(f.stats.models, 1)
    assert.equal(f.stats.settles, 2)
  }))
