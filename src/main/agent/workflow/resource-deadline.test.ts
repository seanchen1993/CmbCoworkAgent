import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FunctionProcessHost } from "../../mods/v2/process-sdk"
import type { WorkflowResourceDeadline } from "./types"
import {
  assertWorkflowResourceAdmission,
  captureWorkflowResourceAdmission,
  assertWorkflowDeadlineHistoryTransition,
  prepareWorkflowDeadlineProcess,
  validWorkflowDeadlines,
  withWorkflowDeadlineAction,
  withWorkflowResourceDeadline,
  workflowResourceDeadlineSignal
} from "./resource-deadline"

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

function fixture(firstExecutionMs = 2000, totalMs = 4000, commandMs = 1000) {
  const startedAt = Date.now()
  let budget: WorkflowResourceDeadline = {
    budgetId: "batch-1",
    generation: 1,
    policy: { firstExecutionMs, totalMs, commandMs },
    startedAt,
    firstDeadlineAt: startedAt + firstExecutionMs,
    deadlineAt: startedAt + totalMs,
    status: "active",
    commands: []
  }
  const assertCurrent = vi.fn()
  const save = vi.fn(async (value: WorkflowResourceDeadline) => {
    budget = structuredClone(value)
  })
  return {
    get budget() {
      return budget
    },
    save,
    assertCurrent,
    run: <T>(work: () => Promise<T>) =>
      withWorkflowResourceDeadline(
        {
          identity: "run:source:owner:1:batch-1",
          read: () => budget,
          save,
          assertCurrent
        },
        work
      )
  }
}

it("keeps helper processes distinct from the declared exact action and actual startup ACK", async () => {
  const f = fixture()
  f.budget.commands.push({ commandId: "ut", argv: ["test", "exact"], status: "prepared" })
  await f.run(() =>
    withWorkflowDeadlineAction("ut", "execution-1", async () => {
      await (await prepareWorkflowDeadlineProcess(["python", "preflight"]))!.started()
      expect(f.budget.firstCommandAt).toBeUndefined()
      const process = await prepareWorkflowDeadlineProcess(["test", "exact"])
      expect(f.budget.commands[0]).toMatchObject({ status: "unknown", executionId: "execution-1" })
      expect(f.budget.firstCommandAt).toBeUndefined()
      await process!.started()
      expect(f.budget.firstCommandAt).toBe(f.budget.commands[0].startedAt)
      await process!.finished(0)
    })
  )
  expect(validWorkflowDeadlines([f.budget])).toBe(true)
})

it("does not lift the first deadline for another action or different argv", async () => {
  const f = fixture()
  f.budget.commands.push({ commandId: "ut", argv: ["test"], status: "prepared" })
  await f.run(() =>
    withWorkflowDeadlineAction("other", "execution-2", async () => {
      await (await prepareWorkflowDeadlineProcess(["test"]))!.started()
      expect(f.budget.commands[0].status).toBe("prepared")
      expect(f.budget.firstCommandAt).toBeUndefined()
    })
  )
})

it("keeps unknown startup intent across a new scope instead of replaying", async () => {
  const f = fixture()
  f.budget.commands.push({ commandId: "ut", argv: ["test"], status: "prepared" })
  await f.run(() =>
    withWorkflowDeadlineAction("ut", "execution", async () => {
      await prepareWorkflowDeadlineProcess(["test"])
    })
  )
  const work = vi.fn(async () => {})
  await expect(f.run(work)).rejects.toThrow("COMMAND_UNKNOWN")
  expect(work).not.toHaveBeenCalled()
})

it("records a late ACK as fact without resurrecting an expired first deadline", async () => {
  const f = fixture(100, 5000)
  f.budget.commands.push({ commandId: "ut", argv: ["test"], status: "prepared" })
  await expect(
    f.run(() =>
      withWorkflowDeadlineAction("ut", "execution", async () => {
        const process = await prepareWorkflowDeadlineProcess(["test"])
        vi.spyOn(Date, "now").mockReturnValue(f.budget.firstDeadlineAt)
        await process!.started()
      })
    )
  ).rejects.toThrow("EXPIRED")
  expect(f.budget.commands[0].status).toBe("unknown")
  expect(f.budget.firstCommandAt).toBe(f.budget.firstDeadlineAt)
})

it("lets a timely first ACK use its command budget beyond the first-start deadline", async () => {
  const f = fixture(1000, 5000, 3000)
  f.budget.commands.push({ commandId: "ut", argv: ["test"], status: "prepared" })
  await f.run(() => withWorkflowDeadlineAction("ut", "execution", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.budget.firstDeadlineAt - 1)
    const process = await prepareWorkflowDeadlineProcess(["test"])
    expect(process!.timeoutMs).toBe(3000)
    await process!.started()
    clock.mockReturnValue(f.budget.firstDeadlineAt + 100)
    expect(() => assertWorkflowResourceAdmission()).not.toThrow()
    await process!.finished(0)
  }))
})

it("cancels an in-flight child and rejects its late success and retained callbacks", async () => {
  const f = fixture(35, 1000)
  let guard!: () => void
  await expect(
    f.run(async () => {
      guard = captureWorkflowResourceAdmission()
      const signal = workflowResourceDeadlineSignal()!
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
      expect(signal.aborted).toBe(true)
      return "late success"
    })
  ).rejects.toThrow("EXPIRED")
  expect(guard).toThrow("SCOPE_CLOSED")
  expect(() => assertWorkflowResourceAdmission()).not.toThrow()
})

it("rejects an expired approval before spawning or recording process intent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wf-deadline-"))
  directories.push(directory)
  const marker = join(directory, "started")
  const argv = [
    process.execPath,
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`
  ]
  const f = fixture()
  f.budget.commands.push({ commandId: "ut", argv, status: "prepared" })
  const publish = vi.fn(async (value) => value)
  await expect(
    f.run(() =>
      withWorkflowDeadlineAction("ut", "execution", () =>
        new FunctionProcessHost().run(
          { argv },
          {
            cwd: directory,
            signal: new AbortController().signal,
            assertLive: vi.fn(),
            publish,
            authorize: async () => {
              vi.spyOn(Date, "now").mockReturnValue(f.budget.firstDeadlineAt)
            }
          }
        )
      )
    )
  ).rejects.toThrow("EXPIRED")
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  expect(f.budget.commands[0].status).toBe("prepared")
  expect(publish).not.toHaveBeenCalled()
})

it("records actual native process startup and completion with the original execution identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wf-deadline-"))
  directories.push(directory)
  const argv = [process.execPath, "-e", "process.stdout.write('actual')"]
  const f = fixture()
  f.budget.commands.push({ commandId: "ut", argv, status: "prepared" })
  const result = await f.run(() =>
    withWorkflowDeadlineAction("ut", "action-execution", () =>
      new FunctionProcessHost().run(
        { argv },
        {
          cwd: directory,
          signal: new AbortController().signal,
          assertLive: vi.fn(),
          authorize: async () => {},
          publish: async (value) => value
        }
      )
    )
  )
  expect(result).toEqual({ exitCode: 0, stdout: "actual", stderr: "" })
  expect(f.budget.commands[0]).toMatchObject({
    status: "finished",
    executionId: "action-execution",
    exitCode: 0
  })
  expect(validWorkflowDeadlines([f.budget])).toBe(true)
})

it("kills a real process at its declared command cap without publishing a success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wf-deadline-"))
  directories.push(directory)
  const marker = join(directory, "late-write")
  const argv = [
    process.execPath,
    "-e",
    `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),5000)`
  ]
  const f = fixture(3000, 5000, 150)
  f.budget.commands.push({ commandId: "ut", argv, status: "prepared" })
  const publish = vi.fn(async (value) => value)
  await expect(
    f.run(() =>
      withWorkflowDeadlineAction("ut", "execution", () =>
        new FunctionProcessHost().run(
          { argv },
          {
            cwd: directory,
            signal: new AbortController().signal,
            assertLive: vi.fn(),
            authorize: async () => {},
            publish
          }
        )
      )
    )
  ).rejects.toThrow("TIMEOUT")
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  expect(publish).not.toHaveBeenCalled()
})

it("rejects closed and forged histories and keeps authority revocation separate", async () => {
  const f = fixture()
  f.budget.status = "failed"
  f.budget.settledAt = Date.now()
  await expect(f.run(async () => {})).rejects.toThrow("SETTLED")
  expect(validWorkflowDeadlines([f.budget, f.budget])).toBe(false)
  expect(validWorkflowDeadlines([{ ...f.budget, deadlineAt: f.budget.deadlineAt + 1 }])).toBe(false)
  f.budget.status = "active"
  delete f.budget.settledAt
  f.assertCurrent.mockImplementation(() => {
    throw Error("original authority revoked")
  })
  await expect(f.run(async () => {})).rejects.toThrow("original authority revoked")
})

it("refuses durable history rollback, refreshed deadlines, removed keys and invented ACKs", () => {
  const f = fixture()
  const original = structuredClone(f.budget)
  for (const next of [
    [],
    [{ ...original, deadlineAt: original.deadlineAt + 1 }],
    [{ ...original, generation: 2 }]
  ])
    expect(() => assertWorkflowDeadlineHistoryTransition([original], next)).toThrow(
      "HISTORY_CHANGED"
    )
  original.commands.push({
    commandId: "ut",
    argv: ["test"],
    status: "unknown",
    executionId: "actual-action",
    intentAt: original.startedAt,
    startedAt: original.startedAt
  })
  original.firstCommandAt = original.startedAt
  const changed = structuredClone(original)
  changed.commands[0].executionId = "new-action"
  expect(() => assertWorkflowDeadlineHistoryTransition([original], [changed])).toThrow(
    "HISTORY_CHANGED"
  )
  expect(
    validWorkflowDeadlines(
      Array.from({ length: 33 }, (_, index) => ({
        ...f.budget,
        budgetId: `batch-${index}`,
        status: "failed",
        settledAt: f.budget.startedAt
      }))
    )
  ).toBe(false)
})
