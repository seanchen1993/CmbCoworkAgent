import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { rename } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  commitWorkflowThreadDisposal,
  createWorkflowRunStore,
  getWorkflowRunsDir
} from "./run-store"
import type { PersistedWorkflowRun } from "./types"

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")

function initial(threadId: string, name = "current"): PersistedWorkflowRun {
  return {
    version: 1,
    runId: "wf_atomicrename01",
    threadId,
    workflowName: name,
    script: "export default async () => null",
    scriptSha256: "original-script",
    status: "running",
    phases: [],
    currentPhase: null,
    agents: [],
    logs: [],
    journal: [{ index: 0, hash: "real-journal", result: "executed-once" }],
    stats: {
      agentsTotal: 0,
      agentsCached: 0,
      agentsFailed: 0,
      outputTokens: 0,
      durationMs: 0
    },
    startedAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z"
  }
}

describe("workflow primary atomic rename", () => {
  let root: string
  let workspace: string
  let threadId: string
  let target: string
  let priorHome: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cmb-workflow-rename-"))
    workspace = join(root, "workspace")
    mkdirSync(workspace)
    priorHome = process.env.CMB_COWORK_AGENT_HOME
    process.env.CMB_COWORK_AGENT_HOME = join(root, "data")
    threadId = `thread-${root.split(/[\\/]/u).at(-1)}`
    const directory = getWorkflowRunsDir(workspace, threadId)
    mkdirSync(directory, { recursive: true })
    target = join(directory, "wf_atomicrename01.json")
    vi.mocked(rename).mockReset().mockImplementation(actualFs.rename)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (priorHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = priorHome
    rmSync(root, { recursive: true, force: true })
  })

  function failPrimary(code: string, onFirst?: () => void): () => number {
    let attempts = 0
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === target) {
        attempts += 1
        if (attempts === 1) onFirst?.()
        throw Object.assign(new Error("controlled rename denial"), { code })
      }
      return actualFs.rename(from, to)
    })
    return () => attempts
  }

  test.each(["EPERM", "EACCES", "EBUSY"])(
    "%s retries the real temporary file and publishes the complete run after the journal",
    async (code) => {
      const order: string[] = []
      let attempts = 0
      vi.mocked(rename).mockImplementation(async (from, to) => {
        if (String(to) === target) {
          attempts += 1
          expect(JSON.parse(readFileSync(String(from), "utf8")).workflowName).toBe("current")
          if (attempts < 3) throw Object.assign(new Error("transient"), { code })
        }
        await actualFs.rename(from, to)
        order.push(String(to))
      })
      const store = createWorkflowRunStore({
        workspacePath: workspace,
        threadId,
        initial: initial(threadId)
      })
      expect(await store.whenInitialPersisted).toBe(true)
      expect(attempts).toBe(3)
      expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
        threadId,
        workflowName: "current",
        journal: []
      })
      const journal = target.replace(/\.json$/u, ".journal")
      expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual(initial(threadId).journal)
      expect(order.indexOf(journal)).toBeLessThan(order.indexOf(target))
      expect(await store.flush()).toBe(true)
    }
  )

  test("permanent denial preserves the old primary and failed flush retains ownership for retry", async () => {
    const store = createWorkflowRunStore({
      workspacePath: workspace,
      threadId,
      initial: initial(threadId)
    })
    expect(await store.whenInitialPersisted).toBe(true)
    const oldBytes = readFileSync(target, "utf8")
    const attempts = failPrimary("EPERM")
    store.state.workflowName = "pending-change"
    expect(await store.flush()).toBe(false)
    expect(attempts()).toBe(6)
    expect(readFileSync(target, "utf8")).toBe(oldBytes)
    vi.mocked(rename).mockImplementation(actualFs.rename)
    expect(await store.flush()).toBe(true)
    expect(JSON.parse(readFileSync(target, "utf8")).workflowName).toBe("pending-change")
  })

  test("applies the terminal mutation after preceding physical writes and only once on retry", async () => {
    const store = createWorkflowRunStore({
      workspacePath: workspace,
      threadId,
      initial: initial(threadId)
    })
    expect(await store.whenInitialPersisted).toBe(true)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const attemptedStatuses: string[] = []
    let deniedTerminal = false
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === target) {
        const { status } = JSON.parse(readFileSync(String(from), "utf8"))
        attemptedStatuses.push(status)
        if (status === "completed" && !deniedTerminal) {
          deniedTerminal = true
          throw Object.assign(new Error("controlled terminal write denial"), { code: "ENOSPC" })
        }
      } else if (String(to) === target.replace(/\.json$/u, ".result")) {
        entered.resolve()
        await release.promise
      }
      return actualFs.rename(from, to)
    })
    const preceding = store.persistFullResult(JSON.stringify("full outcome"))
    await entered.promise
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000)
    try {
      // A normal tail update must queue behind the held physical write and
      // publish while the run still appears running.
      store.update((run) => {
        run.logs.push("worktree reclaim completed")
      })
    } finally {
      clock.mockRestore()
    }
    const terminal = vi.fn((run: PersistedWorkflowRun) => {
      run.status = "completed"
      run.result = "bounded outcome"
    })
    const final = store.flush(terminal)
    let statusBeforeRelease: unknown
    const terminalCallsBeforeRelease = terminal.mock.calls.length
    try {
      statusBeforeRelease = JSON.parse(readFileSync(target, "utf8")).status
    } finally {
      release.resolve()
    }
    expect(await preceding).toBe(true)
    expect(await final).toBe(false)
    expect(terminalCallsBeforeRelease).toBe(0)
    expect(statusBeforeRelease).toBe("running")
    expect(terminal).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      status: "running",
      logs: ["worktree reclaim completed"]
    })
    expect(await store.flush()).toBe(true)
    expect(terminal).toHaveBeenCalledOnce()
    expect(attemptedStatuses).toEqual(["running", "completed", "completed"])
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      status: "completed",
      result: "bounded outcome"
    })
  })

  test("cannot rearm a retired writer when the same path opens its next store", async () => {
    const oldStore = createWorkflowRunStore({
      workspacePath: workspace,
      threadId,
      initial: initial(threadId, "old-owner")
    })
    expect(await oldStore.whenInitialPersisted).toBe(true)
    expect(await oldStore.flush()).toBe(true)

    const replacement = createWorkflowRunStore({
      workspacePath: workspace,
      threadId,
      initial: {
        ...initial(threadId, "replacement"),
        startedAt: "2026-10-18T00:00:01.000Z"
      }
    })
    expect(await replacement.whenInitialPersisted).toBe(true)
    const published = readFileSync(target, "utf8")
    oldStore.state.workflowName = "retired-owner-must-not-write"
    expect(await oldStore.flush()).toBe(true)
    expect(readFileSync(target, "utf8")).toBe(published)

    replacement.state.workflowName = "replacement-still-owns-writes"
    expect(await replacement.flush()).toBe(true)
    expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({
      workflowName: "replacement-still-owns-writes",
      startedAt: replacement.state.startedAt
    })
  })

  test("unrelated errors are not retried", async () => {
    const attempts = failPrimary("ENOSPC")
    const store = createWorkflowRunStore({
      workspacePath: workspace,
      threadId,
      initial: initial(threadId)
    })
    expect(await store.whenInitialPersisted).toBe(false)
    expect(attempts()).toBe(1)
  })

  test.each(["generation", "disposal", "directory"])(
    "a %s change during retry cannot publish into the new owner",
    async (change) => {
      vi.useFakeTimers({ toFake: ["setTimeout"] })
      const hit = Promise.withResolvers<void>()
      const attempts = failPrimary("EPERM", hit.resolve)
      writeFileSync(target, "old-primary")
      const store = createWorkflowRunStore({
        workspacePath: workspace,
        threadId,
        initial: initial(threadId)
      })
      await hit.promise
      // Change ownership while the actual retry delay is pending, after the
      // pre-wait owner check has passed. The post-wait check must reject it.
      for (let index = 0; index < 10 && vi.getTimerCount() === 0; index += 1) {
        await Promise.resolve()
      }
      expect(vi.getTimerCount()).toBe(1)
      let replacement: ReturnType<typeof createWorkflowRunStore> | undefined
      if (change === "generation") {
        replacement = createWorkflowRunStore({
          workspacePath: workspace,
          threadId,
          initial: initial(threadId, "new-owner")
        })
        vi.mocked(rename).mockImplementation(actualFs.rename)
      } else if (change === "disposal") {
        commitWorkflowThreadDisposal(threadId)
      } else {
        const directory = getWorkflowRunsDir(workspace, threadId)
        renameSync(directory, `${directory}-old`)
        mkdirSync(directory)
        writeFileSync(target, "foreign-owner")
      }
      await vi.advanceTimersByTimeAsync(5)
      expect(await store.whenInitialPersisted).toBe(false)
      expect(attempts()).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
      if (replacement) {
        expect(await replacement.whenInitialPersisted).toBe(true)
        expect(vi.mocked(rename).mock.calls.filter(([, to]) => String(to) === target)).toHaveLength(
          2
        )
        expect(JSON.parse(readFileSync(target, "utf8")).workflowName).toBe("new-owner")
        expect(await replacement.flush()).toBe(true)
      } else {
        expect(readFileSync(target, "utf8")).toBe(
          change === "directory" ? "foreign-owner" : "old-primary"
        )
      }
    }
  )
})
