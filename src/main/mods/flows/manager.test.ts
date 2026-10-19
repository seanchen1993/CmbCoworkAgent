import { registerFlowRuntimeAdmission } from "./runtime-admission"
import { describe, expect, it, vi } from "vitest"
import type {
  FlowDefinition,
  FlowRun,
  FlowStep,
  FlowStepResult
} from "../../../shared/mods/flows/types"
import { FlowStore } from "./store"
import { FlowManager } from "./manager"
import type { FlowExecution } from "./contracts"
import { getLocalThreadRunLease } from "../../agent/thread-run-lease"

const pass = (summary = "passed"): FlowStepResult => ({
  passed: true,
  summary,
  source: "native-check"
})
const agent = (id: string): FlowStep => ({ id, name: id, enabled: true, kind: "agent", prompt: id })
const check = (id = "test"): FlowStep => ({
  id,
  name: id,
  enabled: true,
  kind: "check",
  check: "unit-test"
})
let number = 0
it("waits for native admission settlement after the completed Flow releases its active owner", async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const unregister = registerFlowRuntimeAdmission(async () => ({
    run: (work) => work(),
    settle: async () => { entered.resolve(); await gate.promise }
  }))
  try {
    const f = fixture([check()])
    const run = await f.start()
    await entered.promise
    expect(f.state.disposed).toBe(true)
    expect(getLocalThreadRunLease(f.thread)).toBeUndefined()
    let settled = false
    const pending = f.manager.waitForSettlement(f.workspace, f.thread, run.id)
      .then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve()
    await pending
    expect(settled).toBe(true)
  } finally { gate.resolve(); unregister() }
})

function fixture(steps: FlowStep[], overrides: Partial<FlowExecution> = {},
  options: { host?: boolean; maxExecutions?: number } = {}) {
  const settings = new Map<string, string>()
  const store = new FlowStore({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    setSetting: (key, value) => {
      settings.set(key, value)
    }
  })
  const thread = `flow-test-${++number}`
  const workspace = `workspace-${number}`
  const calls: string[] = []
  const state = { fingerprint: "v1", live: true, disposed: false }
  const execution: FlowExecution = {
    assertLive: () => {
      if (!state.live) throw Error("revoked")
    },
    fingerprint: async () => state.fingerprint,
    execute: async (step) => {
      calls.push(step.id)
      return pass(step.id)
    },
    finalize: async (_context, confirm) => {
      calls.push("final")
      await confirm()
      return pass("业务验证通过")
    },
    dispose: async () => {
      state.disposed = true
    },
    ...overrides
  }
  const host = { assertScope: () => {}, prepare: async () => execution, changed: () => {} }
  const manager = new FlowManager(store, host)
  const definition: FlowDefinition = {
    ...(options.host ? { schemaVersion: 2 as const, execution: { kind: "host" as const } }
      : { schemaVersion: 1 as const, plugin: "plugin" }),
    id: "delivery",
    name: "delivery",
    goal: "test",
    timeoutMs: 10_000,
    maxExecutions: options.maxExecutions ?? 64,
    steps
  }
  const saved = manager.save(workspace, definition, 0)
  return {
    manager,
    store,
    host,
    state,
    calls,
    thread,
    workspace,
    saved,
    settings,
    start: () => manager.start(workspace, thread, "delivery", saved.revision)
  }
}
async function wait(
  f: ReturnType<typeof fixture>,
  id: string,
  predicate: (run: FlowRun) => boolean
): Promise<FlowRun> {
  for (let n = 0; n < 400; n++) {
    const run = f.manager.run(f.workspace, f.thread, id)!
    if (predicate(run)) return run
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw Error("flow did not settle")
}

it("executes a bound saved copy after its project template changes and rejects a tampered digest", async () => {
  const f = fixture([agent("original")])
  f.manager.save(f.workspace, { ...f.saved.definition, steps: [agent("replacement")] }, 1)
  const run = await f.manager.startSaved(f.workspace, f.thread, f.saved, {
    workspace: f.workspace,
    goal: "bound task"
  })
  await wait(f, run.id, (value) => value.status === "complete")
  expect(f.calls).toContain("original")
  expect(f.calls).not.toContain("replacement")
  await expect(
    f.manager.startSaved(f.workspace, f.thread, { ...f.saved, digest: "0".repeat(64) })
  ).rejects.toThrow("FLOW_SNAPSHOT_INVALID")
})
const terminal = (run: FlowRun) =>
  ["complete", "failed", "cancelled", "interrupted"].includes(run.status)

it("reads bounded live progress without writing every update and rejects late observations", async () => {
  let report: NonNullable<Parameters<FlowExecution["execute"]>[1]["onProgress"]> | undefined
  let finish!: () => void
  const f = fixture([agent("live")], {
    execute: async (_step, context) => {
      report = context.onProgress
      await new Promise<void>((resolve) => { finish = resolve })
      return pass("real settled result")
    }
  }, { host: true })
  const started = await f.start()
  await vi.waitFor(() => expect(report).toBeDefined())
  const durable = JSON.stringify([...f.settings])
  for (let i = 0; i < 100; i++) report!({ phase: "model", text: "x".repeat(4000) + i })
  expect(JSON.stringify([...f.settings])).toBe(durable)
  const live = f.manager.run(f.workspace, f.thread, started.id)!
  expect(live.attempts[0].progress?.text?.length).toBe(2000)
  expect(live.attempts[0].result).toBeUndefined()
  finish()
  const settled = await wait(f, started.id, terminal)
  expect(settled.status).toBe("complete")
  expect(settled.attempts[0].result?.summary).toBe("real settled result")
  const previous = JSON.stringify(f.manager.run(f.workspace, f.thread, started.id))
  report!({ phase: "tool", toolName: "late" })
  expect(JSON.stringify(f.manager.run(f.workspace, f.thread, started.id))).toBe(previous)
})

it("notifies again after physical cleanup releases the active workspace", async () => {
  let release!: () => void
  let disposing = false
  const f = fixture([agent("work")], {
    dispose: async () => {
      disposing = true
      await new Promise<void>((resolve) => { release = resolve })
    }
  }, { host: true })
  const observations: boolean[] = []
  f.host.changed = () => {
    observations.push(f.manager.activeSummary(f.workspace, f.thread) !== null)
  }
  const started = await f.start()
  await vi.waitFor(() => expect(disposing).toBe(true))
  expect(f.manager.activeSummary(f.workspace, f.thread)?.status).toBe("running")
  expect(getLocalThreadRunLease(f.thread)?.owner).toBe("mods")
  expect(terminal(f.manager.run(f.workspace, f.thread, started.id)!)).toBe(false)
  release()
  expect((await wait(f, started.id, terminal)).status).toBe("complete")
  expect(f.manager.activeSummary(f.workspace, f.thread)).toBeNull()
  expect(getLocalThreadRunLease(f.thread)).toBeUndefined()
  expect(observations.at(-1)).toBe(false)
})

it("completes two host steps at their exact execution budget without charging the summary receipt", async () => {
  const f = fixture([agent("first"), agent("second")], {}, { host: true, maxExecutions: 2 })
  const run = await wait(f, (await f.start()).id, terminal)
  expect(run.status).toBe("complete")
  expect(f.calls).toEqual(["first", "second", "final"])
  expect(run.attempts.map(row => [row.stepId, row.status])).toEqual([
    ["first", "passed"], ["second", "passed"], ["__final", "passed"]
  ])
})
it("still blocks a real second host invocation when only one execution is allowed", async () => {
  const f = fixture([agent("first"), agent("second")], {}, { host: true, maxExecutions: 1 })
  const run = await wait(f, (await f.start()).id, terminal)
  expect(run.status).toBe("failed")
  expect(run.summary).toContain("最大执行次数")
  expect(f.calls).toEqual(["first"])
})
it("does not bypass failed native finalization at an exactly exhausted host budget", async () => {
  const f = fixture([agent("first")], {
    finalize: async () => ({ passed: false, summary: "native final check failed", source: "native-check" })
  }, { host: true, maxExecutions: 1 })
  const run = await wait(f, (await f.start()).id, terminal)
  expect(run.status).toBe("failed")
  expect(run.summary).toBe("native final check failed")
})
it("preserves legacy final-stage execution accounting", async () => {
  const f = fixture([agent("first")], {}, { maxExecutions: 1 })
  const run = await wait(f, (await f.start()).id, terminal)
  expect(run.status).toBe("failed")
  expect(run.summary).toContain("最大执行次数")
  expect(f.calls).toEqual(["first"])
})

it("preserves the authority revocation reason when a child normalizes its abort error", async () => {
  const revoked = new AbortController()
  let executing = false
  const f = fixture([agent("repair")], {
    signal: revoked.signal,
    execute: async (_step, context) => {
      executing = true
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(Error("Workflow aborted")), {
          once: true
        })
      })
    }
  })
  const started = await f.start()
  await wait(f, started.id, () => executing)
  revoked.abort(Error("MODS_SCOPE_CHANGED"))
  const result = await wait(f, started.id, terminal)
  expect(result.status).toBe("cancelled")
  expect(result.summary).toBe("MODS_SCOPE_CHANGED")
  expect(result.attempts[0].reason).toBe("MODS_SCOPE_CHANGED")
})

it("ends an approval wait and releases its lease when the prepared source becomes invalid", async () => {
  let invalid = false
  const f = fixture(
    [
      { id: "accept", name: "Accept", kind: "approval", enabled: true, prompt: "Review" },
      agent("must-not-run")
    ],
    {
      fingerprint: async () => {
        if (invalid) throw Error("CLAW_SKILL_SOURCE_CHANGED")
        return "valid"
      }
    }
  )
  const started = await f.start()
  const pending = await wait(f, started.id, (run) => run.status === "waiting")
  invalid = true
  await expect(
    f.manager.decide(f.workspace, f.thread, started.id, pending.pendingApproval!.nonce, true)
  ).rejects.toThrow("CLAW_SKILL_SOURCE_CHANGED")
  const stopped = f.manager.run(f.workspace, f.thread, started.id)!
  expect(terminal(stopped)).toBe(true)
  expect(stopped.pendingApproval).toBeUndefined()
  expect(f.calls).not.toContain("must-not-run")
  expect(f.state.disposed).toBe(true)
  expect(getLocalThreadRunLease(f.thread)).toBeUndefined()
})

it("keeps a valid pending approval alive after an unrelated stale nonce", async () => {
  const f = fixture([
    { id: "accept", name: "Accept", kind: "approval", enabled: true, prompt: "Review" }
  ])
  const started = await f.start()
  const pending = await wait(f, started.id, (run) => run.status === "waiting")
  await expect(
    f.manager.decide(f.workspace, f.thread, started.id, "stale-nonce", true)
  ).rejects.toThrow()
  expect(f.manager.run(f.workspace, f.thread, started.id)?.pendingApproval).toEqual(
    pending.pendingApproval
  )
  expect(getLocalThreadRunLease(f.thread)?.runId).toBe(started.id)
  await f.manager.cancel(f.workspace, f.thread, started.id)
})

it("finishes cleanup before rejecting an approval with an expired runtime scope", async () => {
  const f = fixture([
    { id: "accept", name: "Accept", kind: "approval", enabled: true, prompt: "Review" }
  ])
  const started = await f.start()
  const pending = await wait(f, started.id, (run) => run.status === "waiting")
  f.state.live = false
  await expect(
    f.manager.decide(f.workspace, f.thread, started.id, pending.pendingApproval!.nonce, true)
  ).rejects.toThrow("revoked")
  expect(terminal(f.manager.run(f.workspace, f.thread, started.id)!)).toBe(true)
  expect(f.state.disposed).toBe(true)
  expect(getLocalThreadRunLease(f.thread)).toBeUndefined()
})

it("concurrent replies consume a nonce once without cancelling the accepted run", async () => {
  let block = false
  let release = () => {}
  const gate = new Promise<string>((resolve) => {
    release = () => resolve("v1")
  })
  const f = fixture(
    [{ id: "accept", name: "Accept", kind: "approval", enabled: true, prompt: "Review" }],
    { fingerprint: async () => (block ? gate : "v1") }
  )
  const started = await f.start()
  const pending = await wait(f, started.id, (run) => run.status === "waiting")
  block = true
  const decide = () =>
    f.manager.decide(f.workspace, f.thread, started.id, pending.pendingApproval!.nonce, true)
  const replies = [decide(), decide()]
  block = false
  release()
  const results = await Promise.allSettled(replies)
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  expect((await wait(f, started.id, terminal)).status).toBe("complete")
})

describe("DIY business execution", () => {
  it("freezes each chat task separately without changing the saved template, including after restart", async () => {
    const f = fixture([
      agent("a"),
      { id: "confirm", name: "Confirm", kind: "approval", enabled: true, prompt: "Accept" }
    ])
    const original = structuredClone(f.saved)
    const first = await f.manager.start(f.workspace, f.thread, "delivery", 1, {
      workspace: f.workspace,
      goal: "  Review order export  "
    })
    const waiting = await wait(f, first.id, (run) => run.status === "waiting")
    expect(waiting.taskGoal).toBe("Review order export")
    expect(waiting.pendingApproval?.summary).toContain("Review order export")
    expect(waiting.flow).toEqual(original)
    await f.manager.decide(f.workspace, f.thread, first.id, waiting.pendingApproval!.nonce, true)
    await wait(f, first.id, terminal)
    const second = await f.manager.start(f.workspace, f.thread, "delivery", 1, {
      workspace: f.workspace,
      goal: "Review permissions"
    })
    await wait(f, second.id, (run) => run.status === "waiting")
    await f.manager.cancel(f.workspace, f.thread, second.id)
    expect(f.manager.list(f.workspace)).toEqual([original])
    const restarted = new FlowManager(f.store, f.host)
    expect(restarted.run(f.workspace, f.thread, first.id)?.taskGoal).toBe("Review order export")
    expect(restarted.run(f.workspace, f.thread, second.id)?.taskGoal).toBe("Review permissions")
  })

  it("rejects invalid chat tasks, stale workspace and revision before acquiring a run lease", async () => {
    const f = fixture([agent("a")])
    for (const task of [
      null,
      { workspace: "other", goal: "Work" },
      { workspace: f.workspace, goal: " " },
      { workspace: f.workspace, goal: "x".repeat(16001) },
      { workspace: f.workspace, goal: 42 }
    ]) {
      await expect(
        f.manager.start(f.workspace, f.thread, "delivery", 1, task as never)
      ).rejects.toThrow()
      expect(getLocalThreadRunLease(f.thread)).toBeUndefined()
      expect(f.manager.runs(f.workspace, f.thread)).toEqual([])
    }
    await expect(
      f.manager.start(f.workspace, f.thread, "delivery", 2, {
        workspace: f.workspace,
        goal: "Work"
      })
    ).rejects.toThrow("FLOW_REVISION_CHANGED")
  })
  it("invalidates the prior final round and excludes its result from the new confirmation", async () => {
    const f = fixture(
      [{ id: "accept", name: "Accept", kind: "approval", enabled: true, prompt: "Review" }],
      {
        fingerprint: async () => "v2",
        finalize: async (_context, confirm, record) => {
          record("Final test", pass("OLD_FINAL_RECEIPT"), "v1")
          record("Final test", pass("NEW_FINAL_RECEIPT"), "v2")
          await confirm()
          return pass()
        }
      }
    )
    const run = await f.start()
    const waiting = await wait(f, run.id, (r) => r.status === "waiting")
    const receipts = waiting.attempts.filter((a) => a.stepId === "__final_check")
    expect(receipts[0].invalidated).toBe(true)
    expect(receipts[1].outputFingerprint).toBe("v2")
    expect(waiting.pendingApproval!.summary).not.toContain("OLD_FINAL_RECEIPT")
    expect(waiting.pendingApproval!.summary).toContain("NEW_FINAL_RECEIPT")
    await f.manager.decide(f.workspace, f.thread, run.id, waiting.pendingApproval!.nonce, true)
    expect((await wait(f, run.id, terminal)).status).toBe("complete")
  })
  it("defers terminal human approval until final checks and asks only once", async () => {
    let confirmed = 0
    const f = fixture(
      [{ id: "accept", name: "Accept", kind: "approval", enabled: true, prompt: "Review" }],
      {
        finalize: async (_context, confirm, record) => {
          record("Final test", pass("fresh test receipt"), "v1")
          await confirm()
          confirmed++
          return pass()
        }
      }
    )
    const run = await f.start()
    const waiting = await wait(f, run.id, (r) => r.status === "waiting")
    expect(waiting.pendingApproval!.summary).toContain("fresh test receipt")
    await f.manager.decide(f.workspace, f.thread, run.id, waiting.pendingApproval!.nonce, true)
    const complete = await wait(f, run.id, terminal)
    expect(complete.status).toBe("complete")
    expect(confirmed).toBe(1)
    expect(complete.attempts.filter((a) => a.stepId === "accept")).toHaveLength(1)
  })
  it("does not ask a terminal human when final checks fail or its condition is skipped", async () => {
    const f = fixture(
      [{ id: "accept", name: "Accept", kind: "approval", enabled: true, prompt: "Review" }],
      {
        finalize: async () => ({ ...pass(), passed: false })
      }
    )
    const started = await f.start()
    const failed = await wait(f, started.id, terminal)
    expect(failed.status).toBe("failed")
    expect(failed.attempts.find((a) => a.stepId === "accept")?.status).toBe("skipped")
    const skipped = fixture([
      agent("source"),
      {
        id: "accept",
        name: "Accept",
        kind: "approval",
        enabled: true,
        prompt: "Review",
        when: { stepId: "source", outcome: "failed" }
      }
    ])
    const second = await skipped.start()
    expect((await wait(skipped, second.id, terminal)).status).toBe("complete")
  })
  it("rejects immediately even when artifacts changed after the displayed approval", async () => {
    const f = fixture([
      { id: "approve", name: "approve", kind: "approval", enabled: true, prompt: "Review" }
    ])
    const run = await f.start()
    const waiting = await wait(f, run.id, (run) => run.status === "waiting")
    f.state.fingerprint = "externally changed"
    const rejected = await f.manager.decide(
      f.workspace,
      f.thread,
      run.id,
      waiting.pendingApproval!.nonce,
      false
    )
    expect(rejected.status).toBe("cancelled")
    expect(rejected.pendingApproval).toBeUndefined()
    expect(rejected.attempts.some((a) => ["running", "waiting"].includes(a.status))).toBe(false)
    expect(rejected.attempts.some((a) => a.stepId === "__final" && a.status === "passed")).toBe(
      false
    )
  })
  it("does not route on an old PASS after an external inter-step write", async () => {
    let fingerprints = 0
    const f = fixture(
      [check(), { ...agent("conditional"), when: { stepId: "test", outcome: "passed" } }],
      {
        fingerprint: async () => (++fingerprints <= 2 ? "before" : "external-write")
      }
    )
    const started = await f.start()
    const result = await wait(f, started.id, terminal)
    expect(result.attempts.find((a) => a.stepId === "test")?.invalidated).toBe(true)
    expect(f.calls).not.toContain("conditional")
  })
  it("binds final check receipts into a renewed approval before completing", async () => {
    const f = fixture(
      [
        { id: "accept", name: "accept", kind: "approval", enabled: true, prompt: "Review" },
        agent("after")
      ],
      {
        finalize: async (_context, confirm, record) => {
          record("Final mandatory test", pass("Latest actual test passed"), "v1")
          await confirm()
          return pass()
        }
      }
    )
    const started = await f.start()
    const first = await wait(f, started.id, (run) => run.status === "waiting")
    await f.manager.decide(f.workspace, f.thread, started.id, first.pendingApproval!.nonce, true)
    const final = await wait(f, started.id, (run) => run.status === "waiting")
    expect(final.pendingApproval!.nonce).not.toBe(first.pendingApproval!.nonce)
    expect(final.pendingApproval!.summary).toContain("Latest actual test passed")
    expect(final.pendingApproval!.inputDigest).not.toBe(first.pendingApproval!.inputDigest)
    await f.manager.decide(f.workspace, f.thread, started.id, final.pendingApproval!.nonce, true)
    expect((await wait(f, started.id, terminal)).status).toBe("complete")
  })
  it("executes the saved order and disabled steps make zero calls", async () => {
    const f = fixture([agent("second"), { ...agent("off"), enabled: false }, agent("first")])
    const run = await f.start()
    expect((await wait(f, run.id, terminal)).status).toBe("complete")
    expect(f.calls).toEqual(["second", "first", "final"])
    expect(f.state.disposed).toBe(true)
    expect(getLocalThreadRunLease(f.thread)).toBeUndefined()
  })
  it("failure re-enters the chosen repair step and reruns the real check", async () => {
    let checks = 0
    const f = fixture([agent("fix"), { ...check(), onFailure: { stepId: "fix", maxRetries: 2 } }])
    f.host.prepare = async () => ({
      assertLive() {
        /* This fixture retains a live authority. */
      },
      fingerprint: async () => "v1",
      dispose: async () => {},
      execute: async (step) => {
        f.calls.push(step.id)
        return step.kind === "check" && ++checks === 1 ? { ...pass(), passed: false } : pass()
      },
      finalize: async (_ctx, confirm) => {
        await confirm()
        return pass()
      }
    })
    const run = await f.start()
    const result = await wait(f, run.id, terminal)
    expect(result.status).toBe("complete")
    expect(f.calls).toEqual(["fix", "test", "fix", "test"])
    expect(result.attempts[0].invalidated).toBe(true)
    expect(result.failureCounts.test).toBe(1)
  })
  it("stops bounded failures instead of treating the end of a script as business success", async () => {
    const f = fixture([{ ...check(), onFailure: { stepId: "test", maxRetries: 2 } }], {
      execute: async () => ({ ...pass(), passed: false })
    })
    const run = await f.start()
    const result = await wait(f, run.id, terminal)
    expect(result.status).toBe("failed")
    expect(result.attempts).toHaveLength(3)
    expect(result.summary).toContain("最大回退次数")
    expect(f.calls).not.toContain("final")
  })
  it.each([true, false])(
    "routes the typed outcome %s and never runs the other branch",
    async (passed) => {
      const f = fixture([
        { ...agent("judge"), onSuccess: "yes", onFailure: { stepId: "no", maxRetries: 1 } },
        { ...agent("no"), when: { stepId: "judge", outcome: "failed" }, onSuccess: "end" },
        { ...agent("yes"), when: { stepId: "judge", outcome: "passed" } },
        agent("end")
      ])
      const original = f.host.prepare
      f.host.prepare = async () => {
        const execution = await original()
        const execute = execution.execute
        return {
          ...execution,
          execute: async (step, context) =>
            step.id === "judge" ? { ...pass(), passed } : execute(step, context)
        }
      }
      const run = await f.start()
      expect((await wait(f, run.id, terminal)).status).toBe("complete")
      expect(f.calls).toEqual([passed ? "yes" : "no", "end", "final"])
    }
  )
  it("execution exceptions never use business failure routes", async () => {
    const f = fixture(
      [{ ...agent("first"), onFailure: { stepId: "repair", maxRetries: 1 } }, agent("repair")],
      {
        execute: async () => {
          throw Error("permission denied")
        }
      }
    )
    const run = await f.start()
    const result = await wait(f, run.id, terminal)
    expect(result.status).toBe("failed")
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0].status).toBe("unknown")
  })
  it("skipped results cannot satisfy a business-failed condition", async () => {
    const f = fixture([
      agent("source"),
      { ...agent("skip"), when: { stepId: "source", outcome: "failed" } },
      { ...agent("not-failed"), when: { stepId: "skip", outcome: "failed" } }
    ])
    const run = await f.start()
    await wait(f, run.id, terminal)
    expect(f.calls).toEqual(["source", "final"])
  })
  it("requires explicit human approval and rejects duplicate replies", async () => {
    const f = fixture([
      agent("build"),
      { id: "accept", name: "accept", enabled: true, kind: "approval", prompt: "check it" },
      agent("publish")
    ])
    const run = await f.start()
    const waiting = await wait(f, run.id, (row) => row.status === "waiting")
    expect(f.calls).toEqual(["build"])
    const nonce = waiting.pendingApproval!.nonce
    await f.manager.decide(f.workspace, f.thread, run.id, nonce, true)
    await expect(f.manager.decide(f.workspace, f.thread, run.id, nonce, true)).rejects.toThrow()
    const finalWait = await wait(
      f,
      run.id,
      (row) => row.status === "waiting" && row.pendingApproval!.nonce !== nonce
    )
    await f.manager.decide(f.workspace, f.thread, run.id, finalWait.pendingApproval!.nonce, true)
    expect((await wait(f, run.id, terminal)).status).toBe("complete")
  })
  it("a changed artifact invalidates the displayed approval nonce", async () => {
    const f = fixture([
      { id: "accept", name: "accept", enabled: true, kind: "approval", prompt: "check it" },
      agent("later")
    ])
    const run = await f.start()
    const waiting = await wait(f, run.id, (row) => row.status === "waiting")
    f.state.fingerprint = "changed"
    const changed = await f.manager.decide(
      f.workspace,
      f.thread,
      run.id,
      waiting.pendingApproval!.nonce,
      true
    )
    expect(changed.status).toBe("waiting")
    expect(changed.pendingApproval!.nonce).not.toBe(waiting.pendingApproval!.nonce)
    expect(f.calls).toEqual([])
    await f.manager.cancel(f.workspace, f.thread, run.id)
  })
  it("revocation wakes a waiting human gate and blocks late decisions", async () => {
    const revoked = new AbortController()
    const f = fixture(
      [{ id: "accept", name: "accept", enabled: true, kind: "approval", prompt: "confirm" }],
      { signal: revoked.signal }
    )
    const run = await f.start()
    const waiting = await wait(f, run.id, (row) => row.status === "waiting")
    revoked.abort(Error("grant revoked"))
    expect((await wait(f, run.id, terminal)).status).toBe("cancelled")
    await expect(
      f.manager.decide(f.workspace, f.thread, run.id, waiting.pendingApproval!.nonce, true)
    ).rejects.toThrow()
    expect(
      (await wait(f, run.id, terminal)).attempts.some(
        (a) => a.stepId === "__final" && a.status === "passed"
      )
    ).toBe(false)
  })
  it("mandatory final gate failure prevents a successful flow", async () => {
    const f = fixture([agent("build")], {
      finalize: async () => ({ ...pass("mandatory tests failed"), passed: false })
    })
    const run = await f.start()
    expect((await wait(f, run.id, terminal)).status).toBe("failed")
  })
  it("a host cannot report final PASS without running the confirmation barrier", async () => {
    const f = fixture([agent("build")], { finalize: async () => pass() })
    const run = await f.start()
    const result = await wait(f, run.id, terminal)
    expect(result.status).toBe("failed")
    expect(result.summary).toContain("CONFIRMATION_BARRIER")
  })
  it("never schedules a successor after a cancelled in-flight operation settles late", async () => {
    let complete!: (value: FlowStepResult) => void
    let entered = false
    const f = fixture([agent("one"), agent("two")], {
      execute: () => {
        entered = true
        return new Promise((resolve) => {
          complete = resolve
        })
      }
    })
    const run = await f.start()
    await wait(f, run.id, () => entered)
    const cancelled = f.manager.cancel(f.workspace, f.thread, run.id)
    complete(pass())
    await cancelled
    expect(f.manager.run(f.workspace, f.thread, run.id)!.status).toBe("cancelled")
    expect(f.manager.run(f.workspace, f.thread, run.id)!.attempts).toHaveLength(1)
  })
  it("does not replay an effect after its result cannot be persisted", async () => {
    const f = fixture([
      { ...agent("write"), onFailure: { stepId: "write", maxRetries: 2 } },
      agent("later")
    ])
    const put = f.store.put.bind(f.store)
    f.store.put = (run) => {
      if (run.attempts.some((row) => row.status === "passed")) throw Error("disk unavailable")
      put(run)
    }
    const run = await f.start()
    for (let n = 0; n < 100 && getLocalThreadRunLease(f.thread); n++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    f.store.put = put
    expect(f.calls).toEqual(["write"])
    expect(f.manager.run(f.workspace, f.thread, run.id)!.status).toBe("interrupted")
  })
  it("excludes a stale PASS from conditions after another agent changes artifacts", async () => {
    const f = fixture([
      check("before"),
      agent("change"),
      { ...agent("conditional"), when: { stepId: "before", outcome: "passed" } }
    ])
    const prepare = f.host.prepare
    f.host.prepare = async () => {
      const execution = await prepare()
      const execute = execution.execute
      return {
        ...execution,
        execute: async (step, context) => {
          if (step.id === "change") f.state.fingerprint = "v2"
          return execute(step, context)
        }
      }
    }
    const run = await f.start()
    const result = await wait(f, run.id, terminal)
    expect(result.attempts.find((row) => row.stepId === "before")?.invalidated).toBe(true)
    expect(f.calls).not.toContain("conditional")
  })
  it("a restart exposes interrupted work without running or replaying it", async () => {
    const f = fixture([agent("build")])
    f.store.put({
      id: "old",
      threadId: f.thread,
      workspace: f.workspace,
      flow: f.saved,
      status: "running",
      startedAt: 1,
      epoch: 0,
      failureCounts: {},
      attempts: [
        {
          stepId: "build",
          executionId: "old-execution",
          epoch: 0,
          attempt: 1,
          startedAt: 1,
          status: "running"
        }
      ]
    })
    const recovered = f.manager.run(f.workspace, f.thread, "old")!
    expect(recovered.status).toBe("interrupted")
    expect(recovered.attempts[0].status).toBe("unknown")
    expect(f.calls).toEqual([])
  })
  it("rejects stale saves and double-starts while retaining a frozen definition", async () => {
    const f = fixture([
      { id: "accept", name: "accept", enabled: true, kind: "approval", prompt: "confirm" }
    ])
    const run = await f.start()
    await wait(f, run.id, (row) => row.status === "waiting")
    await expect(f.start()).rejects.toThrow()
    expect(() => f.manager.save(f.workspace, f.saved.definition, 0)).toThrow("REVISION")
    f.manager.save(f.workspace, { ...f.saved.definition, name: "next version" }, 1)
    expect(f.manager.run(f.workspace, f.thread, run.id)!.flow.definition.name).toBe("delivery")
    await f.manager.cancel(f.workspace, f.thread, run.id)
  })
})

it.each([false, true])("host-only start fence rejects before queued prepare and releases its run lease (provider installed: %s)", async (installed) => {
  const unregister = installed ? registerFlowRuntimeAdmission(() => undefined) : () => {}
  try {
  const f = fixture([agent("agent"), check()])
  let current = true,
    preparations = 0
  const prepare = f.host.prepare
  f.host.prepare = async () => {
    preparations++
    return prepare()
  }
  const pending = f.manager.start(
    f.workspace,
    f.thread,
    "delivery",
    f.saved.revision,
    undefined,
    () => {
      if (!current) throw Error("FLOW_SCOPE_CHANGED")
    }
  )
  current = false
  const run = await pending
  await f.manager.waitForSettlement(f.workspace, f.thread, run.id)
  expect(preparations).toBe(0)
  expect(f.calls).toEqual([])
  expect(getLocalThreadRunLease(f.thread)).toBeUndefined()
  } finally { unregister() }
})

it("host-only start fence rechecks after asynchronous prepare before any step executes", async () => {
  const f = fixture([agent("agent"), check()])
  let current = true,
    release!: () => void,
    entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const prepare = f.host.prepare
  f.host.prepare = async () => {
    entered()
    await gate
    return prepare()
  }
  const run = await f.manager.start(
    f.workspace,
    f.thread,
    "delivery",
    f.saved.revision,
    undefined,
    () => {
      if (!current) throw Error("FLOW_SCOPE_CHANGED")
    }
  )
  await ready
  current = false
  release()
  await f.manager.waitForSettlement(f.workspace, f.thread, run.id)
  expect(f.calls).toEqual([])
  expect(f.state.disposed).toBe(true)
  expect(getLocalThreadRunLease(f.thread)).toBeUndefined()
})


it("exposes only the active owner summary within the workspace and clears it after cancellation", async () => {
  const f = fixture([{ id: "approval", name: "确认", enabled: true, kind: "approval", prompt: "check" }])
  const run = await f.start()
  await wait(f, run.id, value => value.status === "waiting")
  expect(f.manager.activeSummary(f.workspace, "other-chat")).toEqual({
    runId: run.id, threadId: f.thread, flowName: "delivery", status: "waiting"
  })
  expect(f.manager.activeSummary("other-workspace", "other-chat")).toBeNull()
  f.host.assertScope = () => { throw Error("scope changed") }
  expect(() => f.manager.activeSummary(f.workspace, "other-chat")).toThrow("scope changed")
  f.host.assertScope = () => {}
  await f.manager.cancel(f.workspace, f.thread, run.id)
  expect(f.manager.activeSummary(f.workspace, f.thread)).toBeNull()
})
