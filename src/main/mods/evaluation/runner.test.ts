import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { FlowRun, SavedFlow, HostFlowDefinition } from "../../../shared/mods/flows/types"
import { flowDigest } from "../flows/store"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import { EvaluationNotStarted, EvaluationRunner } from "./runner"
import { EvaluationStore } from "./store"

function fixture() {
  const values = new Map<string, string>()
  const store = new EvaluationStore({
    getSetting: (key, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key, expected, value) => {
      if (values.get(key) !== expected) return false
      values.set(key, value)
      return true
    }
  })
  const flow = (id: string): SavedFlow => {
    const definition: HostFlowDefinition = {
      schemaVersion: 2,
      id,
      name: id,
      goal: "Fixed",
      timeoutMs: 1000,
      maxExecutions: 3,
      execution: { kind: "host", profile: "prompt-only-v1" },
      steps: [
        { id: "agent", name: "Agent", kind: "agent", enabled: true, prompt: id },
        { id: "test", name: "Test", kind: "check", enabled: true, check: "unit-test" }
      ]
    }
    const parsed = parseFlowDefinition(definition)
    return { definition: parsed, revision: 1, digest: flowDigest(parsed), updatedAt: 1 }
  }
  const baseline = flow("baseline"),
    candidate = flow("candidate")
  const launches: FlowRun[] = []
  let resolveSettlement: (() => void) | undefined
  let pause = false
  const flows = {
    startSaved: vi.fn(
      async (workspace: string, threadId: string, saved: SavedFlow, task?: { goal: string }) => {
        const run: FlowRun = {
          id: "flow_" + randomUUID(),
          workspace,
          threadId,
          flow: saved,
          status: "complete",
          startedAt: 100,
          finishedAt: 110,
          epoch: 0,
          failureCounts: {},
          attempts: [],
          taskGoal: task?.goal
        }
        launches.push(run)
        return run
      }
    ),
    waitForSettlement: vi.fn(async () => {
      if (pause)
        await new Promise<void>((resolve) => {
          resolveSettlement = resolve
        })
    }),
    cancel: vi.fn(async () => {
      launches.at(-1)!.status = "cancelled"
      pause = false
      resolveSettlement?.()
    })
  }
  const controller = new AbortController()
  const assertCurrent = vi.fn()
  const scope = {
    workspace: "workspace",
    threadId: "thread",
    signal: controller.signal,
    assertCurrent
  }
  const deps = {
    flows,
    history: {
      get: (_workspace: string, id: string) =>
        [baseline, candidate].find((row) => row.definition.id === id),
      run: (_workspace: string, _thread: string, id: string) =>
        launches.find((row) => row.id === id)
    },
    evidence: {
      completionEvidenceByIds: () => ({
        records: [],
        missingIds: [],
        invalidIds: [],
        limitedIds: []
      })
    },
    store,
    provider: "controlled" as const
  }
  const runner = new EvaluationRunner(deps)
  const input = {
    threadId: "thread",
    expectedWorkspace: "workspace",
    baseline: { id: "baseline", revision: 1, digest: baseline.digest },
    candidate: { id: "candidate", revision: 1, digest: candidate.digest },
    tasks: [{ id: "task", goal: "Fixed task" }],
    budget: { timeoutMs: 5000, maxExecutions: 6 }
  }
  return {
    runner,
    deps,
    store,
    scope,
    input,
    launches,
    flows,
    controller,
    assertCurrent,
    pause: () => {
      pause = true
    },
    release: () => {
      pause = false
      resolveSettlement?.()
    }
  }
}
describe("explicit bounded Flow evaluation", () => {
  it("runs both real adapter calls sequentially; missing native/runtime proofs stay unknown", async () => {
    const f = fixture()
    const view = await f.runner.start(f.input, f.scope)
    await f.runner.wait("workspace", "thread", view.id)
    expect(f.launches.map((row) => row.flow.definition.id)).toEqual(["baseline", "candidate"])
    expect(f.launches.map((row) => row.taskGoal)).toEqual(["Fixed task", "Fixed task"])
    const result = f.runner.list(f.scope)[0]
    expect(result.state).toBe("complete")
    expect(result.provider).toBe("controlled")
    expect(result.comparison.comparable).toBe(false)
    expect(result.comparison.baseline.unknown).toBe(1)
    expect(result.comparison.baseline.confirmedPassRate).toBe(0)
    expect(result.comparison.canAutoApply).toBe(false)
  })
  it("will not launch the next case until disposal/settlement completes", async () => {
    const f = fixture()
    f.pause()
    const first = await f.runner.start(f.input, f.scope)
    await vi.waitFor(() => expect(f.flows.waitForSettlement).toHaveBeenCalledTimes(1))
    expect(f.launches).toHaveLength(1)
    expect(f.runner.list(f.scope)[0].activeRunId).toBe(f.launches[0].id)
    await expect(f.runner.start(f.input, f.scope)).rejects.toThrow("BUSY")
    f.release()
    await f.runner.wait("workspace", "thread", first.id)
    expect(f.launches).toHaveLength(2)
  })
  it("scope revocation cancels only the owned Flow and awaits its cleanup", async () => {
    const f = fixture()
    f.pause()
    const row = await f.runner.start(f.input, f.scope)
    await vi.waitFor(() => expect(f.flows.waitForSettlement).toHaveBeenCalled())
    f.controller.abort()
    await f.runner.wait("workspace", "thread", row.id)
    expect(f.flows.cancel).toHaveBeenCalledTimes(1)
    expect(f.launches).toHaveLength(1)
    const stored = f.store.list("workspace", "thread")[0]
    expect(stored.state).toBe("cancelled")
    expect(stored.results.baseline[0].fact.result).toBe("cancelled")
  })
  it("rejects stale selections and insufficient execution budgets before any launch", async () => {
    const f = fixture()
    await expect(
      f.runner.start({ ...f.input, baseline: { ...f.input.baseline, revision: 2 } }, f.scope)
    ).rejects.toThrow("STALE")
    await expect(
      f.runner.start({ ...f.input, budget: { ...f.input.budget, maxExecutions: 5 } }, f.scope)
    ).rejects.toThrow("INVALID")
    expect(f.launches).toHaveLength(0)
    expect(f.store.list("workspace", "thread")).toEqual([])
  })
  it("read-only reopen labels interrupted work and never launches it", async () => {
    const f = fixture()
    f.pause()
    const row = await f.runner.start(f.input, f.scope)
    await vi.waitFor(() => expect(f.launches).toHaveLength(1))
    const reopened = new EvaluationRunner(f.deps)
    expect(reopened.list(f.scope)[0].state).toBe("interrupted")
    expect(reopened.list(f.scope)[0].activeRunId).toBeUndefined()
    expect(f.launches).toHaveLength(1)
    await f.runner.cancel(f.scope, row.id)
  })
  it("source edits after start cannot rewrite the fixed task set", async () => {
    const f = fixture()
    const row = await f.runner.start(f.input, f.scope)
    f.input.tasks[0].goal = "tampered"
    await f.runner.wait("workspace", "thread", row.id)
    expect(f.launches.every((run) => run.taskGoal === "Fixed task")).toBe(true)
  })
  it("unknown cleanup or explicit Flow cancellation stops the batch before another run", async () => {
    for (const status of ["interrupted", "cancelled"] as const) {
      const f = fixture()
      const start = f.flows.startSaved.getMockImplementation()!
      f.flows.startSaved.mockImplementationOnce(async (...args) => {
        const row = await start(...args)
        row.status = status
        return row
      })
      const row = await f.runner.start(f.input, f.scope)
      await f.runner.wait("workspace", "thread", row.id)
      expect(f.launches).toHaveLength(1)
      expect(f.runner.list(f.scope)[0].state).toBe(status)
    }
  })
})

describe("host selected immutable evaluation snapshots", () => {
  it("runs exact host pair without saving templates or trusting renderer selections", async () => {
    const f = fixture()
    const baseline = structuredClone(f.deps.history.get("workspace", "baseline")!)
    const candidate = structuredClone(f.deps.history.get("workspace", "candidate")!)
    const step = candidate.definition.steps[0]
    if (step.kind !== "agent") throw Error("fixture")
    step.prompt = "Frozen Skill instruction"
    candidate.digest = flowDigest(candidate.definition)
    const input = {
      ...f.input,
      candidate: {
        id: candidate.definition.id,
        revision: candidate.revision,
        digest: candidate.digest
      }
    }
    await expect(f.runner.start(input, f.scope)).rejects.toThrow(/STALE/)
    const view = await f.runner.startSnapshots(
      input,
      f.scope,
      { baseline, candidate },
      {
        baseline: f.deps.history.get("workspace", "baseline")!,
        candidate: f.deps.history.get("workspace", "candidate")!
      }
    )
    step.prompt = "caller mutation"
    await f.runner.wait("workspace", "thread", view.id)
    expect(f.launches[1].flow.definition.steps[0]).toMatchObject({
      prompt: "Frozen Skill instruction"
    })
    expect(f.deps.history.get("workspace", "candidate")?.digest).not.toBe(candidate.digest)
  })
  it("host snapshots still obey identical allowed-profile checks and total budgets", async () => {
    const f = fixture(),
      baseline = structuredClone(f.deps.history.get("workspace", "baseline")!),
      candidate = structuredClone(f.deps.history.get("workspace", "candidate")!)
    await expect(
      f.runner.startSnapshots(
        { ...f.input, budget: { timeoutMs: 5000, maxExecutions: 1 } },
        f.scope,
        { baseline, candidate },
        { baseline, candidate }
      )
    ).rejects.toThrow(/INVALID/)
    candidate.definition.steps.push({
      id: "mcp",
      name: "MCP",
      enabled: true,
      kind: "approval",
      prompt: "Wait"
    })
    candidate.digest = "a".repeat(64)
    await expect(
      f.runner.startSnapshots(
        { ...f.input, candidate: { id: "candidate", revision: 1, digest: candidate.digest } },
        f.scope,
        { baseline, candidate },
        { baseline, candidate }
      )
    ).rejects.toThrow(/STALE/)
    expect(f.launches).toEqual([])
  })
})

it("revokes the active snapshot when its original fixture changes and never launches the next case", async () => {
  const f = fixture()
  f.pause()
  const baseline = structuredClone(f.deps.history.get("workspace", "baseline")!)
  const candidate = structuredClone(f.deps.history.get("workspace", "candidate")!)
  const started = await f.runner.startSnapshots(
    f.input,
    f.scope,
    { baseline, candidate },
    { baseline, candidate }
  )
  await vi.waitFor(() => expect(f.launches).toHaveLength(1))
  f.deps.history.get("workspace", "baseline")!.revision++
  await vi.waitFor(() => expect(f.flows.cancel).toHaveBeenCalled())
  await f.runner.wait("workspace", "thread", started.id)
  expect(f.launches).toHaveLength(1)
  expect(f.runner.list(f.scope)[0].state).toBe("cancelled")
})


it("proves only rejection before create is unstarted, including busy and invalid budget", async () => {
  const f = fixture()
  const create = vi.spyOn(f.store, "create")
  await expect(f.runner.start({ ...f.input, budget: { timeoutMs: 0, maxExecutions: 6 } }, f.scope))
    .rejects.toBeInstanceOf(EvaluationNotStarted)
  expect(create).not.toHaveBeenCalled()
  f.pause()
  const running = await f.runner.start(f.input, f.scope)
  await expect(f.runner.start(f.input, f.scope)).rejects.toBeInstanceOf(EvaluationNotStarted)
  expect(create).toHaveBeenCalledOnce()
  expect(f.runner.isSettled(f.scope, running.id)).toBe(false)
  await f.runner.cancel(f.scope, running.id)
  expect(f.runner.isSettled(f.scope, running.id)).toBe(true)
})


it("store capacity rejection proves no run while a persistence failure remains unknown", async () => {
  const f = fixture()
  for (let index = 0; index < 16; index++) {
    f.store.create({ workspace: f.scope.workspace, threadId: f.scope.threadId,
      baseline: f.deps.history.get("", "baseline")!, candidate: f.deps.history.get("", "candidate")!,
      tasks: f.input.tasks, budget: f.input.budget, provider: "controlled" })
  }
  await expect(f.runner.start(f.input, f.scope)).rejects.toBeInstanceOf(EvaluationNotStarted)
  expect(f.flows.startSaved).not.toHaveBeenCalled()
  const failure = new EvaluationStore({ getSetting: () => "",
    compareAndSetSetting: () => { throw Error("write uncertain") } })
  const runner = new EvaluationRunner({ ...f.deps, store: failure })
  await expect(runner.start(f.input, f.scope)).rejects.not.toBeInstanceOf(EvaluationNotStarted)
  expect(f.flows.startSaved).not.toHaveBeenCalled()
})


it("terminal state with unresolved launch intent remains protected from discard after restart", () => {
  const f = fixture()
  const row = f.store.create({ workspace: f.scope.workspace, threadId: f.scope.threadId,
    baseline: f.deps.history.get("", "baseline")!, candidate: f.deps.history.get("", "candidate")!,
    tasks: f.input.tasks, budget: f.input.budget, provider: "controlled" })
  f.store.put({ ...row, revision: 2, state: "cancelled", pending: { variant: "baseline", caseId: "task" } }, 1)
  expect(new EvaluationRunner(f.deps).isSettled(f.scope, row.id)).toBe(false)
})


it("report disposal requires settled cleanup, exact preview digest and no host references", async () => {
  const f = fixture()
  f.pause()
  const result = await f.runner.start(f.input, f.scope)
  expect(result.discardDigest).toBeUndefined()
  expect(() => f.runner.discard(f.scope, result.id, "a".repeat(64))).toThrow("STALE")
  await f.runner.cancel(f.scope, result.id)
  let referenced = true
  f.runner.protectReports(() => referenced)
  expect(f.runner.list(f.scope)[0].discardDigest).toBeUndefined()
  referenced = false
  const ready = f.runner.list(f.scope)[0]
  expect(ready.discardDigest).toBeTruthy()
  expect(() => f.runner.discard(f.scope, ready.id, "a".repeat(64))).toThrow("STALE")
  referenced = true
  expect(() => f.runner.discard(f.scope, ready.id, ready.discardDigest!)).toThrow("BUSY")
  referenced = false
  f.runner.discard(f.scope, ready.id, ready.discardDigest!)
  expect(new EvaluationRunner(f.deps).list(f.scope)).toEqual([])
  expect(() => f.runner.discard(f.scope, ready.id, ready.discardDigest!)).toThrow("STALE")
})
