import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { BotStore } from "./store"
import { BotDomainError } from "../../shared/bot-types"
import { BotMemorySynthesis, type BotMemoryModelSession } from "./memory-synthesis"
import type { MemoryChange } from "./upstream/grok-memory-synthesis"
import { APIError } from "openai"
import { BotHost } from "./host"
import { captureBotModelAttemptFailure } from "./model-error-diagnostic-scope"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
function fixture() {
  let now = 1_800_000_000_000
  const root = mkdtempSync(join(tmpdir(), "cmb-memory-")),
    path = join(root, "bots.sqlite")
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  let store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "测试助手" })
  const finish = (
    text = "项目采用 TypeScript，部署在内部 Kubernetes 集群。",
    outcome: "succeeded" | "failed" = "succeeded"
  ) => {
    const sent = store.send({ nonce: randomUUID(), conversationId, text }),
      claim = store.claim("fixture")!
    store.finish(claim.lease, outcome, "已按项目约定完成方案。")
    now += 16_000
    return sent
  }
  const session: BotMemoryModelSession = {
    assertCurrent: vi.fn(async () => {}),
    complete: vi.fn(async (system, data) => {
      if (system.includes("VERIFICATION")) return JSON.stringify({ approved: true })
      const input = data as { newEvidence: { id: string }[] }
      return JSON.stringify({
        changes: input.newEvidence.length
          ? [
              {
                action: "create",
                content: "项目采用 TypeScript，部署到内部 Kubernetes。",
                kind: "profile",
                sourceEvidenceIds: [input.newEvidence[0].id]
              }
            ]
          : []
      })
    })
  }
  const service = (monotonicClock?: () => number) => {
    const worker = new BotMemorySynthesis(store, async () => session, monotonicClock)
    cleanup.push(() => worker.close())
    return worker
  }
  return {
    get store() {
      return store
    },
    bot,
    conversationId,
    finish,
    session,
    service,
    advance: (ms: number) => (now += ms),
    reopen: () => {
      store.close()
      store = new BotStore(path, () => now)
    }
  }
}
const proposal = (evidence: string, content = "新的有效经验"): MemoryChange => ({
  action: "create",
  content,
  kind: "profile",
  sourceEvidenceIds: [evidence]
})

it("does not queue or synthesize a completed task the human excluded, including after reopening", async () => {
  const f = fixture()
  const sent = f.finish("请先读取项目偏好，生成摘要，不要新增记忆。")
  expect(f.store.memory.policy(f.bot.id).pending).toBe(0)
  expect(f.store.db.exec("SELECT run_id FROM bot_memory_evidence")[0].values).toEqual([])
  f.reopen()
  await f.service().runNow()
  expect(f.session.complete).not.toHaveBeenCalled()
  expect(f.store.memories(f.bot.id)).toEqual([])
  expect(f.store.getRun(sent.runIds[0]).status).toBe("succeeded")
})

it("skips legacy opted-out evidence without sending its data or discarding an allowed task", async () => {
  const f = fixture()
  const allowed = f.finish("项目采用 TypeScript。")
  // Model an old queue entry made before retention restrictions were enforced.
  f.store.db.run("UPDATE bot_messages SET text=? WHERE id=?", [
    "项目采用 TypeScript，但不要新增记忆。",
    allowed.messageId
  ])
  const next = f.finish("项目部署到 Kubernetes。")
  await f.service().runNow()
  expect(
    f.store.db.exec("SELECT state FROM bot_memory_evidence WHERE run_id=?", [allowed.runIds[0]])[0]
      .values
  ).toEqual([["skipped"]])
  const synthesisCall = vi.mocked(f.session.complete).mock.calls[0][1] as {
    newEvidence: { id: string; user: string }[]
  }
  expect(synthesisCall.newEvidence.map((item) => item.id)).toEqual([next.runIds[0]])
  expect(JSON.stringify(synthesisCall)).not.toContain("但不要新增记忆")
  expect(
    f.store.memories(f.bot.id).flatMap((memory) => memory.evidence!.map((e) => e.runId))
  ).toEqual([next.runIds[0]])
})

it("honors a human retention restriction accepted while the original task was running", async () => {
  const f = fixture()
  f.store.send({
    nonce: "original",
    conversationId: f.conversationId,
    text: "项目采用 TypeScript。"
  })
  const current = f.store.claim("fixture")!
  const instruction = f.store.send({
    nonce: "no-memory",
    conversationId: f.conversationId,
    steerRunId: current.run.id,
    text: "这次不要新增记忆。"
  })
  await f.store.steering.queue(current.lease).take({
    threadId: current.run.id,
    ownerRunToken: `${current.lease.owner}:${current.lease.fence}`,
    appliedIds: [],
    phase: "beforeModel"
  })
  expect(f.store.steering.acceptedMessageIds(current.run.id)).toContain(instruction.messageId)
  f.store.finish(current.lease, "succeeded", "已完成摘要。")
  f.advance(16_000)
  await f.service().runNow()
  expect(f.session.complete).not.toHaveBeenCalled()
  expect(f.store.memory.policy(f.bot.id).pending).toBe(0)
  expect(f.store.memories(f.bot.id)).toEqual([])
})

it("rejects a captured proposal at commit when its full original input excludes retention", () => {
  const f = fixture()
  const sent = f.finish()
  const snapshot = f.store.memory.prepare(f.bot.id)!
  expect(snapshot).toBeTruthy()
  // A bounded model excerpt cannot override a restriction elsewhere in the original.
  f.store.db.run("UPDATE bot_messages SET text=? WHERE id=?", [
    "项目采用 TypeScript。" + "背景".repeat(3000) + "不要新增记忆。" + "补充".repeat(3000),
    sent.messageId
  ])
  expect(f.store.memory.commit(snapshot, [proposal(sent.runIds[0])])).toBe("invalid-output")
  expect(f.store.memories(f.bot.id)).toEqual([])
})

it("reports a committed background model failure once with safe exact diagnostics and keeps deferred work silent", async () => {
  const f = fixture()
  f.finish()
  const host = new BotHost(f.store)
  cleanup.push(() => host.stop())
  const worker = f.service()
  worker.bindFailureReporter((notice, error) => {
    host.reportFailure(notice, error)
  })
  const error = APIError.generate(
    429,
    { message: "rejected opaque-private-key" },
    "rejected",
    new Headers({ "x-request-id": "memory-provider" })
  )
  captureBotModelAttemptFailure(
    error,
    { status: 429, requestId: "memory-provider", callId: "memory-model-call" },
    ["opaque-private-key"]
  )
  f.session.complete = vi.fn(async () => {
    throw error
  })
  await worker.runNow()
  const snapshot = host.getErrorTrays()
  expect(snapshot.items).toHaveLength(1)
  expect(snapshot.items[0]).toMatchObject({
    source: "memory",
    botId: f.bot.id,
    diagnostic: { requestId: "memory-provider", callId: "memory-model-call", status: 429 }
  })
  expect(JSON.stringify(snapshot)).not.toContain("opaque-private-key")
  expect(
    f.store
      .events(0, 1000)
      .filter((event) => event.kind === "memory.synthesis")
      .at(-1)?.payload
  ).toMatchObject({ outcome: "failed", diagnostic: snapshot.items[0]!.diagnostic })
  host.clearErrorTrays({
    hostId: snapshot.hostId,
    dataEpoch: snapshot.dataEpoch,
    throughRevision: snapshot.revision
  })
  await worker.runNow()
  expect(host.getErrorTrays().items).toEqual([]) // Pending retry has not become due.
  f.advance(60_000)
  f.session.complete = vi.fn(async () => {
    throw new BotDomainError("model_usage_budget", "deferred")
  })
  await worker.runNow()
  expect(host.getErrorTrays().items).toEqual([])
})

it("defers exhausted memory budgets across restart without losing evidence or spending retry attempts", async () => {
  const f = fixture()
  f.finish()
  const original = f.session.complete
  f.session.complete = vi.fn(async () => {
    throw new BotDomainError("model_usage_budget", "Exhausted")
  })
  const worker = f.service()
  await worker.runNow()
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({
    pending: 1,
    failed: 0,
    lastOutcome: "budget"
  })
  expect(f.store.db.exec("SELECT attempts FROM bot_memory_evidence")[0].values).toEqual([[0]])
  await worker.runNow()
  expect(f.session.complete).toHaveBeenCalledTimes(1)
  await worker.close()
  f.reopen()
  f.advance(60_000)
  f.session.complete = original
  await f.service().runNow()
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({
    pending: 0,
    failed: 0,
    lastOutcome: "committed"
  })
  expect(f.store.memories(f.bot.id)).toHaveLength(1)
})

it.each([
  { name: "forward clock change during synthesis", phase: "proposal", wall: 60_000, monotonic: 0 },
  {
    name: "clock rollback during verification",
    phase: "verification",
    wall: -60_000,
    monotonic: 0
  },
  {
    name: "lost supervision during verification",
    phase: "verification",
    wall: 60_000,
    monotonic: 60_000
  }
])("retains evidence and retries after $name", async ({ phase, wall, monotonic }) => {
  const f = fixture()
  f.store.saveMemory({ botId: f.bot.id, text: "必须保留的显式约定" })
  f.finish()
  let elapsed = 0,
    interrupted = false
  const normal = f.session.complete
  f.session.complete = vi.fn(async (system, data, signal) => {
    const text = await normal(system, data, signal)
    const currentPhase = system.includes("VERIFICATION") ? "verification" : "proposal"
    if (!interrupted && currentPhase === phase) {
      interrupted = true
      f.advance(wall)
      elapsed += monotonic
    }
    return text
  })
  const service = f.service(() => elapsed)
  await service.runNow()
  expect(f.store.memories(f.bot.id).map((memory) => memory.text)).toEqual(["必须保留的显式约定"])
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 1, lastOutcome: "interrupted" })
  expect(f.session.complete).toHaveBeenCalledTimes(phase === "proposal" ? 1 : 2)
  f.advance(31_000)
  await service.runNow()
  expect(f.store.memories(f.bot.id)).toHaveLength(2)
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 0, lastOutcome: "committed" })
})

it("persists completed-turn evidence across restart and commits independently verified facts with exact sources", async () => {
  const f = fixture(),
    sent = f.finish()
  f.reopen()
  await f.service().runNow()
  const memory = f.store.memories(f.bot.id)[0]
  expect(memory).toMatchObject({
    origin: "synthesized",
    kind: "profile",
    sourceMessageId: sent.messageId,
    evidence: [
      { runId: sent.runIds[0], messageId: sent.messageId, conversationId: f.conversationId }
    ]
  })
  expect(f.session.complete).toHaveBeenCalledTimes(2)
  const calls = vi.mocked(f.session.complete).mock.calls
  expect(calls[1][1]).toMatchObject({
    proposedChanges: [{ sourceEvidenceIds: [sent.runIds[0]] }],
    evidence: [{ id: sent.runIds[0] }]
  })
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 0, lastOutcome: "committed" })
  f.reopen()
  await f.service().runNow()
  expect(f.session.complete).toHaveBeenCalledTimes(2)
})

it("never extracts failed tasks, group work, or work finished while automatic memory is disabled", async () => {
  const f = fixture()
  f.finish("失败任务", "failed")
  expect(f.store.memory.prepare(f.bot.id)).toBeNull()
  const b = f.store.createBot({ nonce: "b", name: "b" })
  const group = f.store.createGroup({
    nonce: "group",
    name: "共享讨论",
    members: [f.bot.id, b.bot.id]
  })
  f.store.send({
    nonce: "group-message",
    conversationId: group.id,
    text: "仅供群聊使用",
    recipients: [f.bot.id]
  })
  const claim = f.store.claim("host")!
  f.store.finish(claim.lease, "succeeded", "组内结果")
  f.store.memory.setPolicy({ botId: f.bot.id, revision: 0, enabled: false })
  f.finish()
  expect(f.store.memory.policy(f.bot.id).pending).toBe(0)
  f.store.memory.setPolicy({ botId: f.bot.id, revision: 1, enabled: true })
  expect(f.store.memory.prepare(f.bot.id)).toBeNull()
})

it("does not treat manual routine output as fresh private-user evidence", () => {
  const f = fixture()
  const routine = f.store.saveRoutine({
    botId: f.bot.id,
    name: "例行检查",
    prompt: "复述历史情况",
    schedule: { kind: "interval", everyMs: 60000, anchor: 1_800_000_100_000 },
    timezone: "Asia/Shanghai",
    enabled: true
  })
  f.store.runRoutine({ id: routine.id, nonce: "manual" })
  const claim = f.store.claim("manual-host")!
  f.store.finish(claim.lease, "succeeded", "旧计划已经执行。")
  f.advance(16000)
  expect(f.store.memory.prepare(f.bot.id)).toBeNull()
})

it.each(["unknown-evidence", "clock-create", "malformed"])(
  "rejects %s without invoking the verifier or overwriting old memories",
  async (mode) => {
    const f = fixture()
    f.store.saveMemory({ botId: f.bot.id, text: "必须保留的显式约定" })
    f.finish()
    vi.mocked(f.session.complete).mockResolvedValue(
      mode === "malformed"
        ? "not JSON"
        : JSON.stringify({ changes: [proposal(mode === "clock-create" ? "clock" : "foreign-run")] })
    )
    await f.service().runNow()
    expect(f.session.complete).toHaveBeenCalledTimes(1)
    expect(f.store.memories(f.bot.id).map((m) => m.text)).toEqual(["必须保留的显式约定"])
    expect(f.store.memory.policy(f.bot.id)).toMatchObject({
      pending: 1,
      lastOutcome: "invalid-output"
    })
  }
)

it("retains prior state after a rejected independent verification and bounds retries durably", async () => {
  const f = fixture()
  f.finish()
  const normal = f.session.complete
  f.session.complete = vi.fn(async (system, data, signal) =>
    system.includes("VERIFICATION")
      ? JSON.stringify({ approved: false })
      : normal(system, data, signal)
  )
  for (let i = 0; i < 3; i++) {
    await f.service().runNow()
    f.advance(31_000)
    f.reopen()
  }
  expect(f.store.memories(f.bot.id)).toEqual([])
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 0, lastOutcome: "rejected" })
  expect(f.session.complete).toHaveBeenCalledTimes(6)
})

it("validates the entire proposal atomically even when the verifier erroneously approves an explicit-memory removal", async () => {
  const f = fixture(),
    explicit = f.store.saveMemory({ botId: f.bot.id, text: "必须由用户修订" }),
    sent = f.finish()
  vi.mocked(f.session.complete).mockImplementation(async (system) =>
    system.includes("VERIFICATION")
      ? JSON.stringify({ approved: true })
      : JSON.stringify({
          changes: [
            proposal(sent.runIds[0]),
            { action: "remove", id: explicit.id, sourceEvidenceIds: [sent.runIds[0]] }
          ]
        })
  )
  await f.service().runNow()
  expect(f.store.memories(f.bot.id)).toEqual([explicit])
  expect(f.store.memory.policy(f.bot.id).lastOutcome).toBe("invalid-output")
})

it("fences in-flight synthesis and older unfinished tasks after manual deletion", async () => {
  const f = fixture()
  f.finish()
  await f.service().runNow()
  const saved = f.store.memories(f.bot.id)[0]
  f.finish("新增偏好：后续沟通使用中文。")
  let release!: (value: string) => void
  vi.mocked(f.session.complete).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const working = f.service().runNow()
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  const sent = f.store.send({
    nonce: "late",
    conversationId: f.conversationId,
    text: "尚未结束的旧任务"
  })
  const running = f.store.claim("late-host")!
  f.store.deleteMemory(f.bot.id, saved.id, saved.revision)
  release(JSON.stringify({ changes: [] }))
  await working
  f.store.finish(running.lease, "succeeded", "复述已删除的偏好")
  f.advance(16_000)
  f.reopen()
  expect(f.store.getRun(sent.runIds[0]).status).toBe("succeeded")
  expect(f.store.memories(f.bot.id)).toEqual([])
  expect(f.store.memory.prepare(f.bot.id)).toBeNull()
})

it("promotes human revisions to explicit origin and prevents old normalized content being recreated", async () => {
  const f = fixture()
  f.finish()
  await f.service().runNow()
  const before = f.store.memories(f.bot.id)[0]
  const fixed = f.store.saveMemory({
    botId: f.bot.id,
    id: before.id,
    revision: before.revision,
    text: "项目已切换为 Go"
  })
  expect(fixed.origin).toBe("explicit")
  expect(fixed.evidence).toHaveLength(1)
  const sent = f.finish()
  vi.mocked(f.session.complete).mockImplementation(async (system) =>
    system.includes("VERIFICATION")
      ? JSON.stringify({ approved: true })
      : JSON.stringify({ changes: [proposal(sent.runIds[0], ` ${before.text.toUpperCase()} `)] })
  )
  await f.service().runNow()
  expect(f.store.memories(f.bot.id)).toEqual([fixed])
})

it("rejects a stale snapshot when another writer commits, without consuming newer evidence", async () => {
  const f = fixture()
  f.finish()
  const snapshot = f.store.memory.prepare(f.bot.id)!
  f.store.memory.begin(snapshot)
  const first = proposal(snapshot.evidence[0].id)
  expect(f.store.memory.commit(snapshot, [first])).toBe("committed")
  f.finish("另一条工作约定")
  expect(f.store.memory.commit(snapshot, [first])).toBe("stale")
  expect(f.store.memory.policy(f.bot.id).pending).toBe(1)
})

it("accepts clock-only updates to synthesized facts, retaining evidence and never inventing a new source", async () => {
  const f = fixture()
  f.finish()
  await f.service().runNow()
  const before = f.store.memories(f.bot.id)[0]
  f.advance(86_400_001)
  vi.mocked(f.session.complete).mockImplementation(async (system) =>
    system.includes("VERIFICATION")
      ? JSON.stringify({ approved: true })
      : JSON.stringify({
          changes: [
            {
              action: "update",
              id: before.id,
              content: "该项目计划属于过去，实际结果尚未确认。",
              kind: "log",
              sourceEvidenceIds: ["clock"]
            }
          ]
        })
  )
  await f.service().runNow()
  expect(f.store.memories(f.bot.id)[0]).toMatchObject({
    revision: 2,
    evidence: before.evidence,
    sourceMessageId: before.sourceMessageId
  })
})

it("does not commit when model settings change during verification", async () => {
  const f = fixture()
  f.finish()
  vi.mocked(f.session.assertCurrent).mockRejectedValue(new Error("settings revoked"))
  await f.service().runNow()
  expect(f.store.memories(f.bot.id)).toEqual([])
  expect(f.store.memory.policy(f.bot.id).pending).toBe(1)
})

it("coalesces concurrent triggers and stops safely while a model response is outstanding", async () => {
  const f = fixture()
  f.finish()
  vi.mocked(f.session.complete).mockImplementation(
    (_s, _d, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      )
  )
  const service = f.service(),
    one = service.runNow(),
    two = service.runNow()
  expect(one).toBe(two)
  await vi.waitFor(() => expect(f.session.complete).toHaveBeenCalledTimes(1))
  await service.close()
  await one
  expect(f.store.memory.policy(f.bot.id).pending).toBe(1)
  f.reopen()
  f.store.memory.recover()
  expect(f.store.memory.policy(f.bot.id).lastOutcome).toBe("interrupted")
})

it("rejects stale or malformed memory policy updates", () => {
  const f = fixture()
  expect(() => f.store.memory.setPolicy({ botId: f.bot.id, revision: 0, enabled: "yes" })).toThrow()
  expect(() =>
    f.store.memory.setPolicy({
      botId: f.bot.id,
      revision: 0,
      enabled: true,
      sourceMessageId: "foreign"
    })
  ).toThrow()
  f.store.memory.setPolicy({ botId: f.bot.id, revision: 0, enabled: false })
  expect(() => f.store.memory.setPolicy({ botId: f.bot.id, revision: 0, enabled: true })).toThrow(
    "已变化"
  )
})

it("retries failed evidence durably without resetting a second attempt on receipt replay", async () => {
  const f = fixture()
  f.finish()
  vi.mocked(f.session.complete).mockResolvedValue("invalid")
  for (let i = 0; i < 3; i++) {
    await f.service().runNow()
    f.advance(31_000)
  }
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 0, failed: 1 })
  const input = { botId: f.bot.id, revision: 0, dataEpoch: "initial", nonce: "retry-once" }
  const receipt = f.store.memory.retry(input)
  expect(receipt).toMatchObject({ pending: 1, failed: 0, revision: 1, lastOutcome: "queued" })
  f.reopen()
  await f.service().runNow()
  expect(f.store.memory.retry(input)).toEqual(receipt)
  expect(f.store.db.exec("SELECT attempts FROM bot_memory_evidence")[0].values).toEqual([[1]])
  expect(f.session.complete).toHaveBeenCalledTimes(4)
  expect(() => f.store.memory.retry({ ...input, revision: 1 })).toThrow()
  expect(() => f.store.memory.retry({ ...input, nonce: "stale" })).toThrow("已变化")
})

it.each(["correction", "deletion", "disable"])(
  "does not resurrect failed evidence after a manual %s",
  async (operation) => {
    const f = fixture()
    const memory = f.store.saveMemory({ botId: f.bot.id, text: "必须由用户修订" })
    f.finish()
    vi.mocked(f.session.complete).mockResolvedValue("invalid")
    for (let i = 0; i < 3; i++) {
      await f.service().runNow()
      f.advance(31_000)
    }
    if (operation === "correction")
      f.store.saveMemory({
        botId: f.bot.id,
        id: memory.id,
        revision: memory.revision,
        text: "已经修正的新约定"
      })
    else if (operation === "deletion") f.store.deleteMemory(f.bot.id, memory.id, memory.revision)
    else {
      f.store.memory.setPolicy({ botId: f.bot.id, revision: 0, enabled: false })
      f.store.memory.setPolicy({ botId: f.bot.id, revision: 1, enabled: true })
    }
    const before = f.store.memories(f.bot.id)
    const policy = f.store.memory.policy(f.bot.id)
    f.store.memory.retry({
      botId: f.bot.id,
      revision: policy.revision,
      dataEpoch: "initial",
      nonce: "new-retry"
    })
    f.reopen()
    await f.service().runNow()
    expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 0, failed: 0 })
    expect(f.store.memories(f.bot.id)).toEqual(before)
    expect(f.session.complete).toHaveBeenCalledTimes(3)
  }
)

it("fences retries by restore epoch, policy revision, active pass and exact input shape", () => {
  const f = fixture()
  f.finish()
  const input = { botId: f.bot.id, revision: 0, dataEpoch: "initial", nonce: "retry" }
  for (const invalid of [
    { ...input, dataEpoch: "old-database" },
    { ...input, revision: 9 },
    { ...input, enabled: true },
    { ...input, botId: "../outside" }
  ])
    expect(() => f.store.memory.retry(invalid)).toThrow()
  const snapshot = f.store.memory.prepare(f.bot.id)!
  f.store.memory.begin(snapshot)
  expect(() => f.store.memory.retry(input)).toThrow("正在整理")
  f.store.memory.setPolicy({ botId: f.bot.id, revision: 0, enabled: false })
  expect(() => f.store.memory.retry({ ...input, revision: 1 })).toThrow("请先开启")
})

it("keeps the outstanding evidence queue bounded when retrying a large failed backlog", () => {
  const f = fixture()
  for (let i = 0; i < 70; i++) {
    f.finish(`较早的任务 ${i}`)
    const snapshot = f.store.memory.prepare(f.bot.id)!
    f.store.memory.begin(snapshot)
    f.store.memory.failed(snapshot, "context-limit")
  }
  for (let i = 0; i < 10; i++) f.finish(`新的任务 ${i}`)
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 10, failed: 70 })
  const input = { botId: f.bot.id, revision: 0, dataEpoch: "initial", nonce: "bounded-retry" }
  const accepted = f.store.memory.retry(input)
  expect(accepted).toMatchObject({ pending: 64, failed: 16 })
  expect(f.store.memory.retry(input)).toEqual(accepted)
  expect(() => f.store.memory.retry({ ...input, nonce: "overfull", revision: 1 })).toThrow(
    "待整理记录较多"
  )
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 64, failed: 16 })
})
