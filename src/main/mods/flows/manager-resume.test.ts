import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { FlowManager } from "./manager"
import { FlowStore, flowDigest } from "./store"
import {
  bindFlowPromptReceipt,
  flowPromptStructuredOutputDigest,
  flowPromptTaskGoalDigest
} from "./prompt-recovery-receipt"
import { verifyCurrentFlowPromptReceipt } from "./prompt-recovery-current"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import type { FlowRun, FlowStepResult } from "../../../shared/mods/flows/types"
import type { FlowPromptRuntimeSettledCapture } from "../../../shared/mods/flows/prompt-recovery"
import type { FlowExecution, FlowHost } from "./contracts"
import type { RecoveryHistoryRun } from "./recovery-history"
import {
  getLocalThreadRunLease,
  releaseLocalThreadRunLease,
  claimLocalThreadRunLease
} from "../../agent/thread-run-lease"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const hash = sha("fixed")
const pass = (summary: string): FlowStepResult => ({
  passed: true,
  summary,
  source: "agent",
  modelId: "model"
})
let sequence = 0
function capture(
  run: FlowRun,
  executionId: string,
  stepId: string,
  result: FlowStepResult
): FlowPromptRuntimeSettledCapture {
  const index = run.flow.definition.steps.findIndex((step) => step.id === stepId)
  const ids = run.flow.definition.steps
    .slice(0, index)
    .filter((step) => step.enabled && step.kind === "agent")
    .map((step) => step.id)
  const prior = run.attempts
    .filter((row) => ids.includes(row.stepId))
    .map((row) => ({ stepId: row.stepId, summary: row.result!.summary }))
  return {
    schemaVersion: 1,
    binding: {
      workspace: run.workspace,
      parentThreadId: run.threadId,
      parentThreadIncarnation: "inc",
      runId: run.id,
      executionId,
      childThreadId: `child-${executionId}`,
      childThreadIncarnation: "child-inc",
      leaseGeneration: "lease"
    },
    dependencies: {
      schemaVersion: 1,
      coverage: "prompt-and-prior-receipts",
      profile: "prompt-only-v1",
      runtimeProtocol: "flow-text-runtime-v1",
      definitionDigest: run.flow.digest,
      taskGoalDigest: flowPromptTaskGoalDigest(run),
      stepId,
      modelRef: "model",
      modelConfigurationDigest: hash,
      mandatoryPolicyDigest: hash,
      systemPromptDigest: hash,
      rolePromptDigest: hash,
      stableInput: { version: 1, digest: hash },
      context: { version: 1, digest: sha(JSON.stringify(prior)) },
      priorProjection: "prompt-only-prior-v1",
      resultTool: {
        protocol: "host-workflow-structured-output-v1",
        name: "structured_output",
        schemaDigest: hash,
        implementationDigest: hash
      }
    },
    actualCapabilitiesDigest: hash,
    modelRequestLedgerDigest: hash,
    invocationLedgerDigest: hash,
    structuredOutputDigest: flowPromptStructuredOutputDigest(result),
    modelCalls: 1,
    providerUsageEvidenceIds: []
  }
}
function fixture(options: { maxExecutions?: number; approval?: boolean } = {}) {
  const number = ++sequence,
    workspace = `resume-workspace-${number}`,
    threadId = `resume-thread-${number}`
  const data = new Map<string, string>()
  const state = {
    live: true,
    cas: true,
    disposed: 0,
    prepares: 0,
    validates: 0,
    capture: true,
    receiptValid: true,
    beforePrepare: undefined as undefined | (() => Promise<void>),
    beforeValidate: undefined as undefined | (() => Promise<void>)
  }
  const store = new FlowStore({
    getSetting: (key, fallback = "") => data.get(key) ?? fallback,
    setSetting: (key, value) => {
      data.set(key, value)
    },
    compareAndSetSetting: (key, expected, value) => {
      if (!state.cas || data.get(key) !== expected) return false
      data.set(key, value)
      return true
    }
  })
  const definition = parseFlowDefinition({
    schemaVersion: 2,
    id: "flow",
    name: "Flow",
    execution: { kind: "host", profile: "prompt-only-v1" },
    goal: "Write then review",
    timeoutMs: 60000,
    maxExecutions: options.maxExecutions ?? 32,
    steps: [
      { id: "write", name: "Write", kind: "agent", enabled: true, prompt: "Write" },
      { id: "review", name: "Review", kind: "agent", enabled: true, prompt: "Review" },
      ...(options.approval
        ? [{ id: "approval", name: "Approval", kind: "approval", enabled: true, prompt: "Confirm" }]
        : [])
    ]
  })
  const startedAt = Date.now() - 10
  const source: RecoveryHistoryRun = {
    id: "source",
    workspace,
    threadId,
    status: "running",
    startedAt,
    flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: startedAt },
    epoch: 0,
    failureCounts: {},
    attempts: [
      {
        stepId: "write",
        executionId: "original-execution",
        attempt: 1,
        epoch: 0,
        status: "passed",
        startedAt: startedAt + 1,
        finishedAt: startedAt + 2,
        inputFingerprint: "original-before",
        outputFingerprint: "original-after",
        result: pass("Original full text")
      }
    ]
  }
  source.attempts[0].recoveryEvidence = bindFlowPromptReceipt({
    run: source,
    attempt: source.attempts[0],
    capture: capture(source, "original-execution", "write", source.attempts[0].result!),
    parentThreadIncarnation: "inc",
    priorReceipts: []
  })
  store.put(source)
  const calls: string[] = [],
    captures = new Map<string, FlowPromptRuntimeSettledCapture>()
  const execution: FlowExecution = {
    assertLive() {
      if (!state.live) throw Error("scope revoked")
    },
    fingerprint: async () => "new-run-artifacts",
    promptRecovery: {
      parentThreadIncarnation: "inc",
      async validateSource() {
        state.validates++
        await state.beforeValidate?.()
      },
      assertReceiptCurrent(run, receipt) {
        if (!state.receiptValid || !receipt.recoveryEvidence || receipt.invalidated)
          throw Error("receipt revoked")
        verifyCurrentFlowPromptReceipt({
          run,
          attempt: receipt,
          history: store.runs(workspace, threadId),
          parentThreadIncarnation: "inc",
          currentDependencies: (originalRun, originalAttempt) =>
            capture(
              originalRun,
              originalAttempt.executionId,
              originalAttempt.stepId,
              originalAttempt.result!
            ).dependencies,
          assertCurrent: () => {
            if (!state.live) throw Error("scope revoked")
          }
        })
      },
      settledCapture: (id) => (state.capture ? captures.get(id) : undefined)
    },
    async execute(step, context) {
      calls.push(step.id)
      expect(context.run.attempts.find((row) => row.stepId === "write")?.result?.summary).toBe(
        "Original full text"
      )
      const result = pass(`Finished ${step.id}`)
      captures.set(context.executionId, capture(context.run, context.executionId, step.id, result))
      return result
    },
    async finalize(_context, confirm, recordCheck) {
      calls.push("final")
      recordCheck(
        "mandatory",
        { passed: true, summary: "fresh check", source: "native-check" },
        "new-run-artifacts"
      )
      await confirm()
      return { passed: true, summary: "Complete", source: "native-check" }
    },
    async dispose() {
      state.disposed++
    }
  }
  const host: FlowHost = {
    assertScope() {
      if (!state.live) throw Error("scope revoked")
    },
    changed() {
      /* Notifications are outside this sequencing test. */
    },
    async prepare() {
      state.prepares++
      await state.beforePrepare?.()
      return execution
    }
  }
  const manager = new FlowManager(store, host)
  return {
    source,
    state,
    store,
    data,
    calls,
    execution,
    host,
    manager,
    workspace,
    threadId,
    resume: () => manager.resume(workspace, threadId, source.id, flowDigest(source))
  }
}
async function until<T>(read: () => T | undefined): Promise<T> {
  for (let index = 0; index < 400; index++) {
    const result = read()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw Error("test did not settle")
}
async function ended(f: ReturnType<typeof fixture>, id: string) {
  return until(() => {
    const run = f.store.run(f.workspace, f.threadId, id)
    return run?.finishedAt ? run : undefined
  })
}

describe("manager resume sequencing with a controlled host (not runtime proof acceptance)", () => {
  it("keeps diagnostic queries pure and does not prepare a runtime", async () => {
    const f = fixture()
    const before = structuredClone([...f.data])
    await f.manager.recovery(f.workspace, f.threadId, f.source.id)
    expect([...f.data]).toEqual(before)
    expect(f.state.prepares).toBe(0)
    expect(f.calls).toEqual([])
  })

  it("rejects a query result when history changes across its host observation", async () => {
    const f = fixture()
    f.host.observeRecovery = async () => {
      f.store.put({ ...f.source, id: "external-run" })
      return {
        authority: "current",
        definitionDigest: f.source.flow.digest,
        promptReceipts: { verifiedExecutionIds: [f.source.attempts[0].executionId] }
      }
    }
    await expect(f.manager.recovery(f.workspace, f.threadId, f.source.id)).rejects.toThrow(
      "FLOW_RECOVERY_STALE"
    )
    expect(f.state.prepares).toBe(0)
  })
  it("returns a blocked diagnostic for an old record missing its flow definition", async () => {
    const f = fixture()
    f.store.put({ ...f.source, flow: undefined } as unknown as FlowRun)
    const report = await f.manager.recovery(f.workspace, f.threadId, f.source.id)
    expect(report.status).toBe("blocked")
    expect(report.reasons.some((reason) => reason.code === "invalid-history")).toBe(true)
    expect(f.state.prepares).toBe(0)
    expect(f.calls).toEqual([])
  })
  it("prepares once, consumes once, reuses text unchanged and makes fresh final evidence", async () => {
    const f = fixture()
    const old = structuredClone(f.source.attempts[0])
    const child = await f.resume()
    const final = await ended(f, child.id)
    expect(final.status).toBe("complete")
    expect(f.calls).toEqual(["review", "final"])
    expect(f.state.prepares).toBe(1)
    expect(f.state.validates).toBe(1)
    expect(final.attempts[0]).toEqual({
      ...old,
      reusedFrom: { runId: "source", executionId: old.executionId }
    })
    expect(final.attempts.find((row) => row.stepId === "review")?.recoveryEvidence).toBeDefined()
    expect(final.attempts.find((row) => row.stepId === "__final_check")?.result?.summary).toBe(
      "fresh check"
    )
    expect(
      (f.store.run(f.workspace, f.threadId, "source") as RecoveryHistoryRun).recovery?.consumedBy
    ).toBe(child.id)
    expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
    await expect(f.resume()).rejects.toThrow("FLOW_RECOVERY_STALE")
  })
  it("requires a new approval after fresh final checks", async () => {
    const f = fixture({ approval: true })
    const child = await f.resume()
    const waiting = await until(() => {
      const run = f.store.run(f.workspace, f.threadId, child.id)
      return run?.pendingApproval ? run : undefined
    })
    expect(f.calls).toEqual(["review", "final"])
    await f.manager.decide(f.workspace, f.threadId, child.id, waiting.pendingApproval!.nonce, true)
    expect((await ended(f, child.id)).status).toBe("complete")
  })
  it("registers the pending owner before prepare and keeps history reads from rewriting the source", async () => {
    const f = fixture()
    let release!: () => void
    f.state.beforePrepare = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const pending = f.resume()
    await until(() => release)
    expect(f.manager.runs(f.workspace, f.threadId)[0]).toEqual(f.source)
    expect((await f.manager.recovery(f.workspace, f.threadId, f.source.id)).status).toBe("active")
    await expect(f.resume()).rejects.toThrow("FLOW_RECOVERY_OWNER_ACTIVE")
    release()
    await ended(f, (await pending).id)
    expect(f.calls.filter((call) => call === "review")).toHaveLength(1)
  })
  it("allows cancellation while preparing without consuming the source", async () => {
    const f = fixture()
    let release!: () => void
    f.state.beforePrepare = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const pending = f.resume()
    const rejection = expect(pending).rejects.toThrow("用户已取消")
    await until(() => release)
    const cancelled = f.manager.cancel(f.workspace, f.threadId, "source")
    release()
    await Promise.all([cancelled, rejection])
    expect(f.calls).toEqual([])
    expect(f.store.runs(f.workspace, f.threadId)).toEqual([f.source])
    expect(f.state.disposed).toBe(1)
    expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
  })

  it("leaves a discoverable consumed source when the store commits but its reply is lost", async () => {
    const f = fixture()
    const reserve = f.store.reserveRecovery.bind(f.store)
    f.store.reserveRecovery = (...args) => {
      reserve(...args)
      throw Error("commit reply lost")
    }
    await expect(f.resume()).rejects.toThrow("commit reply lost")
    const rows = f.store.runs(f.workspace, f.threadId) as RecoveryHistoryRun[]
    expect(rows).toHaveLength(2)
    const source = rows.find((row) => row.id === "source")!
    expect(rows.find((row) => row.id === source.recovery?.consumedBy)?.status).toBe("queued")
    expect(f.calls).toEqual([])
    expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
    await expect(f.resume()).rejects.toThrow("FLOW_RECOVERY_STALE")
  })
  it.each(["prepare", "validate", "scope", "receipt", "cas", "source"])(
    "cleans up %s failure before the atomic reservation",
    async (kind) => {
      const f = fixture()
      if (kind === "prepare")
        f.state.beforePrepare = async () => {
          throw Error("prepare failed")
        }
      if (kind === "validate")
        f.state.beforeValidate = async () => {
          throw Error("validate failed")
        }
      if (kind === "scope")
        f.state.beforeValidate = async () => {
          f.state.live = false
        }
      if (kind === "receipt") f.state.receiptValid = false
      if (kind === "cas") f.state.cas = false
      if (kind === "source")
        f.state.beforeValidate = async () => {
          f.store.put({ ...f.source, summary: "external change" })
        }
      await expect(f.resume()).rejects.toThrow()
      expect(f.calls).toEqual([])
      expect(f.store.runs(f.workspace, f.threadId)).toHaveLength(1)
      expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
      expect(f.state.disposed).toBe(kind === "prepare" ? 0 : 1)
    }
  )
  it("rejects exhausted inherited budget before preparing and enforces remaining budget during execution", async () => {
    const empty = fixture({ maxExecutions: 1 })
    await expect(empty.resume()).rejects.toThrow("FLOW_RECOVERY_BUDGET_EXHAUSTED")
    expect(empty.state.prepares).toBe(0)
    const f = fixture({ maxExecutions: 2 })
    const run = await ended(f, (await f.resume()).id)
    expect(f.calls).toEqual(["review"])
    expect(run.status).toBe("failed")
    expect(run.summary).toContain("最大执行次数")
  })
  it("rejects elapsed root deadlines instead of granting a new timeout", async () => {
    const f = fixture()
    f.source.startedAt = Date.now() - 60001
    f.store.put(f.source)
    await expect(f.resume()).rejects.toThrow("FLOW_RECOVERY_BUDGET_EXHAUSTED")
    expect(f.state.prepares).toBe(0)
  })

  it("rechecks the root deadline after preparation without writing a child", async () => {
    const f = fixture()
    const now = Date.now()
    const clock = vi.spyOn(Date, "now")
    f.state.beforeValidate = async () => {
      clock.mockReturnValue(now + 60001)
    }
    try {
      await expect(f.resume()).rejects.toThrow("FLOW_RECOVERY_DEADLINE")
      expect(f.store.runs(f.workspace, f.threadId)).toEqual([f.source])
      expect(f.calls).toEqual([])
      expect(f.state.disposed).toBe(1)
    } finally {
      clock.mockRestore()
    }
  })

  it("does not execute or release another owner's lease after a preparation race", async () => {
    const f = fixture()
    f.state.beforeValidate = async () => {
      const lease = getLocalThreadRunLease(f.threadId)!
      releaseLocalThreadRunLease(f.threadId, lease.owner, lease.runId)
      claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "foreign" })
    }
    try {
      await expect(f.resume()).rejects.toThrow("FLOW_EXECUTION_EXPIRED")
      expect(getLocalThreadRunLease(f.threadId)?.runId).toBe("foreign")
      expect(f.store.runs(f.workspace, f.threadId)).toEqual([f.source])
      expect(f.calls).toEqual([])
    } finally {
      releaseLocalThreadRunLease(f.threadId, "desktop", "foreign")
    }
  })

  it("propagates host revocation to the pending validation signal", async () => {
    const f = fixture()
    const controller = new AbortController()
    Object.assign(f.execution, { signal: controller.signal })
    f.execution.promptRecovery!.validateSource = async (_source, _history, signal) => {
      controller.abort(Error("host revoked"))
      expect(signal.aborted).toBe(true)
      signal.throwIfAborted()
    }
    await expect(f.resume()).rejects.toThrow("host revoked")
    expect(f.store.runs(f.workspace, f.threadId)).toEqual([f.source])
    expect(f.calls).toEqual([])
  })
  it("never persists a recoverable pass when the host has no settled capture", async () => {
    const f = fixture()
    f.state.capture = false
    const run = await ended(f, (await f.resume()).id)
    const attempt = run.attempts.find((row) => row.stepId === "review")!
    expect(attempt.status).toBe("unknown")
    expect(attempt.recoveryEvidence).toBeUndefined()
    expect(run.status).toBe("failed")
    expect(f.calls).toEqual(["review"])
  })
  it("rejects old missing evidence and unknown Agent effects before preparing", async () => {
    const old = fixture()
    delete old.source.attempts[0].recoveryEvidence
    old.store.put(old.source)
    await expect(old.resume()).rejects.toThrow("FLOW_PROMPT_RECEIPT_REQUIRED")
    const unknown = fixture()
    unknown.source.attempts.push({
      executionId: "unknown",
      stepId: "review",
      attempt: 1,
      epoch: 0,
      status: "running",
      startedAt: Date.now()
    })
    unknown.store.put(unknown.source)
    await expect(unknown.resume()).rejects.toThrow("FLOW_RECOVERY_UNKNOWN_EFFECT")
    expect(unknown.state.prepares).toBe(0)
  })
})
