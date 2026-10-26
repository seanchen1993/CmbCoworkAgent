import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { WorkflowWorktreeLedger } from "./worktree-lease"
import { createWorkflowWorktreeResourceRunner } from "./worktree-resource"
import type { WorkflowWorktreeRecord } from "./types"
import type { WorkflowWorktreeMergePlan } from "./worktree-lease"
import * as gitWorktrees from "../../services/git-worktree"
import { prepareWorkflowDeadlineProcess, withWorkflowDeadlineAction } from "./resource-deadline"

const cleanup: Array<() => Promise<void>> = []
vi.setConfig({ testTimeout: 20_000 })
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

it("persists absolute deadline history across cold recovery and never reopens a closed key", async () => {
  const f = await fixture(), owner = f.open()
  const resource = await owner.call({ op: "acquire", resourceId: "deadline" })
  const policy = { firstExecutionMs: 60_000, totalMs: 120_000, commandMs: 30_000 }
  const input = { op: "deadline-begin", handle: resource.handle, budgetId: "batch-1", policy }
  const original = await owner.call(input)
  expect((await owner.call(input)).budgets).toEqual(original.budgets)
  await expect(owner.call({ ...input, policy: { ...policy, totalMs: 180_000 } }))
    .rejects.toThrow("POLICY_CHANGED")
  await expect(owner.call({ ...input, budgetId: "batch-2" })).rejects.toThrow("UNSETTLED")
  const cold = f.open()
  const recovered = await cold.call({ op: "acquire", resourceId: "deadline" })
  expect(recovered.state).toBe("unknown")
  expect(recovered.budgets).toEqual(original.budgets)
  const reconciled = await cold.call({ op: "reconcile", handle: recovered.handle, expectedCommit: recovered.headCommit })
  expect(reconciled.generation).toBe(2)
  await expect(owner.call({ op: "deadline-command", handle: resource.handle, budgetId: "batch-1", commandId: "stale", argv: ["test"] }))
    .rejects.toThrow("newer worktree resource generation")
  await expect(cold.call({ op: "deadline-command", handle: reconciled.handle, budgetId: "batch-1", commandId: "ut", argv: ["test"] }))
    .rejects.toThrow("GENERATION_CHANGED")
  const closed = await cold.call({ op: "deadline-settle", handle: reconciled.handle, budgetId: "batch-1", outcome: "failed" })
  expect((await cold.call({ ...input, handle: reconciled.handle })).budgets).toEqual(closed.budgets)
  await expect(cold.ledger.useResource(String(reconciled.handle), async () => {}))
    .rejects.toThrow("BINDING_REQUIRED")
})

it("checks original authority at the final durable deadline publication boundary", async () => {
  const f = await fixture(), owner = f.open()
  const resource = await owner.call({ op: "acquire", resourceId: "publication" })
  let live = true
  const runner = createWorkflowWorktreeResourceRunner(owner.ledger, "a".repeat(64), () => {
    if (!live) throw Error("original source revoked")
  })
  const original = gitWorktrees.persistWorkflowWorktreeRecord
  vi.spyOn(gitWorktrees, "persistWorkflowWorktreeRecord").mockImplementationOnce((record, root, guard) =>
    original(record, root, () => { live = false; guard?.() }))
  await expect(runner({ op: "deadline-begin", handle: resource.handle, budgetId: "batch-1",
    policy: { firstExecutionMs: 60_000, totalMs: 120_000, commandMs: 30_000 } }, undefined, f.controller.signal))
    .rejects.toThrow("original source revoked")
  const cold = f.open()
  const originalFacts = await cold.call({ op: "acquire", resourceId: "publication" })
  expect(originalFacts.budgets).toEqual([])
})

it("rejects unconfirmed success receipts and permits failed settlement after expiry", async () => {
  const f = await fixture(), owner = f.open()
  const resource = await owner.call({ op: "acquire", resourceId: "deadline" })
  await owner.call({ op: "deadline-begin", handle: resource.handle, budgetId: "batch-1",
    policy: { firstExecutionMs: 60_000, totalMs: 120_000, commandMs: 30_000 } })
  await owner.call({ op: "deadline-command", handle: resource.handle, budgetId: "batch-1", commandId: "ut", argv: ["test"] })
  await owner.ledger.useResource(String(resource.handle), () => withWorkflowDeadlineAction("ut", "original-action", async () => {
    const process = await prepareWorkflowDeadlineProcess(["test"])
    await process!.started()
    await process!.finished(0)
  }), "batch-1")
  await expect(owner.call({ op: "deadline-settle", handle: resource.handle, budgetId: "batch-1", outcome: "succeeded", executionId: "original-action" }))
    .rejects.toThrow("RECEIPT_UNCONFIRMED")
  const record = [...f.records.values()][0]
  vi.spyOn(Date, "now").mockReturnValue(record.resource!.budgets![0].deadlineAt)
  await expect(owner.call({ op: "seal", handle: resource.handle, expectedCommit: resource.headCommit }))
    .rejects.toThrow("UNSETTLED")
  const failed = await owner.call({ op: "deadline-settle", handle: resource.handle, budgetId: "batch-1", outcome: "failed" })
  expect((failed.budgets as Array<{ status: string }>)[0].status).toBe("failed")
})

it("reconciles the exact merge-train CAS after interruption without constructing a second integration", async () => {
  const f = await fixture(),
    owner = f.open()
  const target = await owner.call({ op: "acquire", resourceId: "integration" })
  const child = await owner.call({ op: "acquire", resourceId: "child" })
  const committed = await f.commit(owner.ledger, String(child.handle), "candidate.txt")
  await owner.call({ op: "seal", handle: child.handle, expectedCommit: committed.head })
  const original = gitWorktrees.mergeWorkflowWorktree
  const interrupted = vi
    .spyOn(gitWorktrees, "mergeWorkflowWorktree")
    .mockImplementationOnce((input) =>
      original({
        ...input,
        testHooks: {
          afterSourceRefAdvanced: () => {
            throw Error("SIMULATED_CAS_INTERRUPTION")
          }
        }
      })
    )
  await expect(
    owner.call({
      op: "merge-into",
      handle: child.handle,
      targetHandle: target.handle,
      expectedCommit: committed.head,
      expectedTargetCommit: target.headCommit
    })
  ).rejects.toThrow("SIMULATED_CAS_INTERRUPTION")
  const record = [...f.records.values()].find(
    (record) => record.resource?.ownerToken === target.handle
  )!
  const mergedHead = f.git(record.directory, "rev-parse", "HEAD")
  expect(mergedHead).not.toBe(target.headCommit)
  interrupted.mockRestore()
  const reconciled = await owner.call({
    op: "reconcile-merge",
    handle: child.handle,
    targetHandle: target.handle,
    expectedCommit: committed.head,
    expectedTargetCommit: mergedHead
  })
  expect(reconciled.outcome).toBe("merged")
  expect((reconciled.target as { headCommit: string }).headCommit).toBe(mergedHead)
  expect(f.git(record.directory, "rev-parse", "HEAD")).toBe(mergedHead)
  expect(f.git(record.directory, "status", "--porcelain")).toBe("")
  expect(await readFile(join(record.directory, "candidate.txt"), "utf8")).toBe("candidate.txt\n")
  await owner.ledger.reclaimAll()
}, 60_000)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wf-resource-")),
    repo = join(root, "repo")
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(repo)
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
  git(repo, "init", "--initial-branch=main")
  git(repo, "config", "user.name", "Resource Test")
  git(repo, "config", "user.email", "resource@example.test")
  git(repo, "config", "core.autocrlf", "false")
  await writeFile(join(repo, "base.txt"), "base\n")
  git(repo, "add", ".")
  git(repo, "commit", "-m", "base")
  const records = new Map<string, WorkflowWorktreeRecord>()
  const controller = new AbortController()
  function open(
    parentIdentity = "a".repeat(64),
    approveMerge: (plan: WorkflowWorktreeMergePlan) => Promise<boolean> = async () => true,
    beforeIntegrate?: () => Promise<void>,
    executionResources?: import("../../plugins/runtime-source-scope").RuntimeExecutionResources
  ) {
    const ledger = new WorkflowWorktreeLedger({
      executionResources,
      workspacePath: repo,
      runId: "wf_resource01",
      threadId: "resource-thread",
      parentIdentity,
      signal: controller.signal,
      appDataRoot: join(root, "app"),
      existingWorktrees: [...records.values()],
      integrate: async (_root, work) => {
        await beforeIntegrate?.()
        return work()
      },
      approveMerge,
      onRecordChange: (record) => records.set(record.id, record),
      onRecordDelete: (record) => records.delete(record.id)
    })
    const runner = createWorkflowWorktreeResourceRunner(ledger, parentIdentity, () =>
      controller.signal.throwIfAborted()
    )
    const call = (input: unknown) => runner(input, undefined, controller.signal)
    return { ledger, call }
  }
  const commit = async (ledger: WorkflowWorktreeLedger, handle: string, name = "result.txt") => {
    let directory = ""
    await ledger.useResource(handle, async (info) => {
      directory = info.directory
      await writeFile(join(info.workspaceDirectory, name), name + "\n")
      git(info.directory, "add", name)
      git(info.directory, "commit", "-m", name)
    })
    return { head: git(directory, "rev-parse", "HEAD"), directory }
  }
  return { root, repo, git, open, records, controller, commit }
}

it("uses only Host-bound repository refs and preserves both original Git manifests across restart", async () => {
  const f = await fixture(),
    other = join(f.root, "other")
  await mkdir(other)
  f.git(other, "init", "--initial-branch=main")
  f.git(other, "config", "user.name", "Resource Test")
  f.git(other, "config", "user.email", "resource@example.test")
  await writeFile(join(other, "base.txt"), "other base\n")
  f.git(other, "add", ".")
  f.git(other, "commit", "-m", "base")
  const resources = {
    profiles: [],
    workspaces: [{ id: "secondary", path: other }],
    fingerprint: "b".repeat(64)
  }
  const owner = f.open(undefined, undefined, undefined, resources)
  await expect(
    owner.call({ op: "acquire", resourceId: "foreign", workspaceRef: "ungranted" })
  ).rejects.toThrow("UNAUTHORIZED")
  const first = await owner.call({ op: "acquire", resourceId: "one" })
  const second = await owner.call({ op: "acquire", resourceId: "two", workspaceRef: "secondary" })
  const a = await f.commit(owner.ledger, String(first.handle), "first.txt")
  const b = await f.commit(owner.ledger, String(second.handle), "second.txt")
  await owner.call({ op: "seal", handle: first.handle, expectedCommit: a.head })
  await owner.call({ op: "seal", handle: second.handle, expectedCommit: b.head })
  await expect(
    owner.call({ op: "acquire", resourceId: "one", workspaceRef: "secondary" })
  ).rejects.toThrow("BINDING_CHANGED")
  await owner.ledger.reclaimAll()
  const cold = f.open(undefined, undefined, undefined, resources)
  const restored = await cold.call({ op: "acquire", resourceId: "two", workspaceRef: "secondary" })
  expect(restored.handle).toBe(second.handle)
  await cold.call({ op: "acquire", resourceId: "one" })
  await cold.call({ op: "merge", handle: first.handle, expectedCommit: a.head })
  await cold.call({ op: "merge", handle: second.handle, expectedCommit: b.head })
  expect(await readFile(join(f.repo, "first.txt"), "utf8")).toContain("first")
  expect(await readFile(join(other, "second.txt"), "utf8")).toContain("second")
  expect(f.git(f.repo, "ls-files")).not.toContain("second.txt")
  expect(f.git(other, "ls-files")).not.toContain("first.txt")
  const changed = f.open(undefined, undefined, undefined, {
    ...resources,
    fingerprint: "c".repeat(64)
  })
  await expect(
    changed.call({ op: "acquire", resourceId: "two", workspaceRef: "secondary" })
  ).rejects.toThrow("BINDING_CHANGED")
  await cold.ledger.reclaimAll()
}, 60_000)

it("merges sealed parallel candidates through a native-approved integration resource and replays original evidence", async () => {
  const f = await fixture(),
    approvals: WorkflowWorktreeMergePlan[] = []
  const owner = f.open(undefined, async (plan) => {
    approvals.push(plan)
    return true
  })
  const integration = await owner.call({ op: "acquire", resourceId: "integration" })
  const [left, right] = await Promise.all([
    owner.call({ op: "acquire", resourceId: "left" }),
    owner.call({ op: "acquire", resourceId: "right" })
  ])
  const a = await f.commit(owner.ledger, String(left.handle), "left.txt")
  const b = await f.commit(owner.ledger, String(right.handle), "right.txt")
  const journal = await owner.ledger.captureResourceJournalCheckpoint(String(left.handle))
  await owner.call({ op: "seal", handle: left.handle, expectedCommit: a.head })
  await owner.call({ op: "seal", handle: right.handle, expectedCommit: b.head })
  let targetHead = integration.headCommit
  let firstTargetHead: unknown
  for (const [resource, head] of [
    [left, a.head],
    [right, b.head]
  ] as const) {
    const merged = await owner.call({
      op: "merge-into",
      handle: resource.handle,
      targetHandle: integration.handle,
      expectedCommit: head,
      expectedTargetCommit: targetHead
    })
    expect(merged.outcome).toBe("merged")
    targetHead = (merged.target as { headCommit: string }).headCommit
    firstTargetHead ??= targetHead
  }
  expect(f.git(f.repo, "ls-files")).not.toContain("left.txt")
  await owner.ledger.validateResourceJournalCheckpoint(String(left.handle), journal)
  await owner.call({ op: "seal", handle: integration.handle, expectedCommit: targetHead })
  await owner.call({ op: "merge", handle: integration.handle, expectedCommit: targetHead })
  expect(f.git(f.repo, "ls-files")).toContain("left.txt")
  expect(f.git(f.repo, "ls-files")).toContain("right.txt")
  expect(approvals).toHaveLength(3)
  expect(
    approvals.slice(0, 2).every((plan) => plan.targetResource?.handle === integration.handle)
  ).toBe(true)
  await owner.ledger.reclaimAll()
  const cold = f.open()
  await cold.call({ op: "acquire", resourceId: "left" })
  await cold.call({ op: "acquire", resourceId: "integration" })
  const replay = await cold.call({
    op: "merge-into",
    handle: left.handle,
    targetHandle: integration.handle,
    expectedCommit: a.head,
    expectedTargetCommit: integration.headCommit
  })
  expect((replay.target as { headCommit: string }).headCommit).toBe(firstTargetHead)
  await cold.ledger.validateResourceJournalCheckpoint(String(left.handle), journal)
  await cold.ledger.reclaimAll()
}, 90_000)

it("retains both resources on train conflicts and explicit reconciliation does not retry the merge", async () => {
  const f = await fixture(),
    owner = f.open()
  const target = await owner.call({ op: "acquire", resourceId: "integration" })
  const child = await owner.call({ op: "acquire", resourceId: "child" })
  const left = await f.commit(owner.ledger, String(target.handle), "conflict.txt")
  let head = ""
  await owner.ledger.useResource(String(child.handle), async (info) => {
    await writeFile(join(info.directory, "conflict.txt"), "different\n")
    f.git(info.directory, "add", ".")
    f.git(info.directory, "commit", "-m", "conflict")
    head = f.git(info.directory, "rev-parse", "HEAD")
  })
  await owner.call({ op: "seal", handle: child.handle, expectedCommit: head })
  const input = {
    handle: child.handle,
    targetHandle: target.handle,
    expectedCommit: head,
    expectedTargetCommit: left.head
  }
  await expect(owner.call({ ...input, op: "merge-into" })).rejects.toThrow("conflict")
  await expect(owner.call({ ...input, op: "merge-into" })).rejects.toThrow("RECONCILE")
  const recovered = await owner.call({ ...input, op: "reconcile-merge" })
  expect(recovered.outcome).toBe("not-applied")
  expect(recovered.state).toBe("sealed")
  expect((recovered.target as { state: string }).state).toBe("leased")
  expect(f.git(left.directory, "rev-parse", "HEAD")).toBe(left.head)
  expect(await readFile(join(left.directory, "conflict.txt"), "utf8")).toBe("conflict.txt\n")
  await owner.ledger.reclaimAll()
}, 60_000)

it("native checkpoint refuses a stale parent and retains dirty work without replaying a commit", async () => {
  const f = await fixture(),
    owner = f.open()
  const resource = await owner.call({ op: "acquire", resourceId: "files" })
  const before = String(resource.headCommit)
  const committed = await f.commit(owner.ledger, String(resource.handle))
  await owner.ledger.useResource(String(resource.handle), async (info) => {
    await writeFile(join(info.workspaceDirectory, "later.txt"), "later\n")
  })
  await expect(owner.ledger.commitResourceChanges(String(resource.handle), before)).rejects.toThrow(
    "parent changed"
  )
  expect(f.git(committed.directory, "rev-parse", "HEAD")).toBe(committed.head)
  expect(await readFile(join(committed.directory, "later.txt"), "utf8")).toBe("later\n")
  await expect(
    owner.ledger.commitResourceChanges(String(resource.handle), committed.head)
  ).rejects.toThrow("NOT_WRITABLE")
  await owner.ledger.reclaimAll()
}, 30_000)

it("reuses one original lease across agents, seals the actual commit and uses the real merge service", async () => {
  const f = await fixture(),
    owner = f.open()
  const acquired = await owner.call({ op: "acquire", resourceId: "code" })
  const handle = String(acquired.handle)
  const first = await f.commit(owner.ledger, handle, "one.txt")
  const second = await f.commit(owner.ledger, handle, "two.txt")
  expect(first.directory).toBe(second.directory)
  const inspected = await owner.call({ op: "inspect", resourceId: "code" })
  expect(inspected).toMatchObject({ headCommit: second.head, dirty: false, generation: 1 })
  const sealed = await owner.call({ op: "seal", handle, expectedCommit: second.head })
  expect(sealed).toMatchObject({ state: "sealed", sealedCommit: second.head, status: "ready" })
  await expect(owner.ledger.useResource(handle, async () => {})).rejects.toThrow("NOT_WRITABLE")
  const merged = await owner.call({ op: "merge", handle, expectedCommit: second.head })
  expect(merged.status).toBe("merged")
  expect(await readFile(join(f.repo, "two.txt"), "utf8")).toBe("two.txt\n")
  expect((await owner.call({ op: "merge", handle, expectedCommit: second.head })).status).toBe(
    "merged"
  )
  await owner.ledger.reclaimAll()
})

it("does not admit a stale or foreign handle and serializes actual checkout users", async () => {
  const f = await fixture(),
    owner = f.open()
  const acquired = await owner.call({ op: "acquire", resourceId: "code" })
  let finish!: () => void
  const work = owner.ledger.useResource(
    String(acquired.handle),
    () =>
      new Promise<void>((done) => {
        finish = done
      })
  )
  while (!finish) await new Promise<void>((done) => setImmediate(done))
  await expect(owner.ledger.useResource(String(acquired.handle), async () => {})).rejects.toThrow(
    "BUSY"
  )
  await expect(owner.ledger.useResource("forged", async () => {})).rejects.toThrow("HANDLE_INVALID")
  finish()
  await work
  await owner.ledger.reclaimAll()
})

it("validates named agent journal checkpoints against real sealed, merged and changed Git boundaries", async () => {
  const f = await fixture(),
    owner = f.open()
  const acquired = await owner.call({ op: "acquire", resourceId: "journal" })
  const handle = String(acquired.handle)
  await f.commit(owner.ledger, handle, "first.txt")
  const checkpoint = await owner.ledger.captureResourceJournalCheckpoint(handle)
  const final = await f.commit(owner.ledger, handle, "second.txt")
  await owner.call({ op: "seal", handle, expectedCommit: final.head })
  await owner.ledger.validateResourceJournalCheckpoint(handle, checkpoint)
  await writeFile(join(final.directory, "unexpected.txt"), "outside original owner")
  await expect(owner.ledger.validateResourceJournalCheckpoint(handle, checkpoint)).rejects.toThrow(
    "JOURNAL_CHANGED"
  )
  await rm(join(final.directory, "unexpected.txt"))
  await owner.call({ op: "merge", handle, expectedCommit: final.head })
  await owner.ledger.validateResourceJournalCheckpoint(handle, checkpoint)
  await expect(
    owner.ledger.validateResourceJournalCheckpoint(handle, { ...checkpoint, generation: 2 })
  ).rejects.toThrow("UNCONFIRMED")
  await owner.ledger.reclaimAll()
})

it("cold restart keeps the same resource unknown until exact clean HEAD reconciliation rotates ownership", async () => {
  const f = await fixture(),
    first = f.open()
  const acquired = await first.call({ op: "acquire", resourceId: "code" })
  const committed = await f.commit(first.ledger, String(acquired.handle))
  await first.ledger.reclaimAll()
  const cold = f.open()
  const unknown = await cold.call({ op: "acquire", resourceId: "code" })
  expect(unknown).toMatchObject({ state: "unknown", generation: 1, handle: acquired.handle })
  expect(f.records.size).toBe(1)
  await expect(cold.ledger.useResource(String(unknown.handle), async () => {})).rejects.toThrow(
    "NOT_WRITABLE"
  )
  await expect(
    cold.call({ op: "reconcile", handle: unknown.handle, expectedCommit: "0".repeat(40) })
  ).rejects.toThrow("COMMIT_CHANGED")
  const reconciled = await cold.call({
    op: "reconcile",
    handle: unknown.handle,
    expectedCommit: committed.head
  })
  expect(reconciled).toMatchObject({ state: "leased", generation: 2 })
  expect(reconciled.handle).not.toBe(unknown.handle)
  await expect(cold.ledger.useResource(String(unknown.handle), async () => {})).rejects.toThrow(
    "HANDLE_INVALID"
  )
  await f.commit(cold.ledger, String(reconciled.handle), "after-reconcile.txt")
  await cold.ledger.reclaimAll()
})

it("rejects changed parent source instead of provisioning another resource on a reused run", async () => {
  const f = await fixture(),
    first = f.open()
  await first.call({ op: "acquire", resourceId: "code" })
  await first.ledger.reclaimAll()
  const changed = f.open("b".repeat(64))
  await expect(changed.call({ op: "acquire", resourceId: "different-id" })).rejects.toThrow(
    "SOURCE_CHANGED"
  )
  expect(f.records.size).toBe(1)
})

it("sealing rejects dirty or changed HEAD, while a source conflict is retained for reconciliation", async () => {
  const f = await fixture(),
    owner = f.open()
  const acquired = await owner.call({ op: "acquire", resourceId: "code" }),
    handle = String(acquired.handle)
  const committed = await f.commit(owner.ledger, handle)
  await expect(owner.call({ op: "seal", handle, expectedCommit: "0".repeat(40) })).rejects.toThrow(
    "COMMIT_CHANGED"
  )
  await writeFile(join(committed.directory, "dirty.txt"), "not committed")
  await expect(owner.call({ op: "seal", handle, expectedCommit: committed.head })).rejects.toThrow(
    "COMMIT_CHANGED"
  )
  await rm(join(committed.directory, "dirty.txt"))
  await owner.call({ op: "seal", handle, expectedCommit: committed.head })
  await writeFile(join(f.repo, "result.txt"), "source conflict")
  f.git(f.repo, "add", "result.txt")
  f.git(f.repo, "commit", "-m", "conflicting source")
  await expect(
    owner.call({ op: "merge", handle, expectedCommit: committed.head })
  ).rejects.toThrow()
  expect([...f.records.values()][0].resource?.state).toBe("unknown")
  expect(await readFile(join(committed.directory, "result.txt"), "utf8")).toBe("result.txt\n")
  await owner.ledger.reclaimAll()
})

it("parent cancellation retains the checkout and rejects late results", async () => {
  const f = await fixture(),
    owner = f.open()
  const acquired = await owner.call({ op: "acquire", resourceId: "code" })
  let finish!: () => void
  const pending = owner.ledger.useResource(
    String(acquired.handle),
    () =>
      new Promise<void>((done) => {
        finish = done
      })
  )
  while (!finish) await new Promise<void>((done) => setImmediate(done))
  f.controller.abort()
  finish()
  await expect(pending).rejects.toThrow()
  expect([...f.records.values()][0].resource?.state).toBe("unknown")
  await owner.ledger.reclaimAll()
})

it("merge requires native confirmation and rechecks the sealed commit after the user decision", async () => {
  const f = await fixture()
  let accepted = false,
    changed = false,
    directory = ""
  const approve = vi.fn(async () => {
    if (changed) {
      await writeFile(join(directory, "late.txt"), "late\n")
      f.git(directory, "add", "late.txt")
      f.git(directory, "commit", "-m", "after-review")
    }
    return accepted
  })
  const owner = f.open(undefined, approve)
  const acquired = await owner.call({ op: "acquire", resourceId: "code" }),
    handle = String(acquired.handle)
  const committed = await f.commit(owner.ledger, handle)
  directory = committed.directory
  await owner.call({ op: "seal", handle, expectedCommit: committed.head })
  const sourceBefore = f.git(f.repo, "rev-parse", "HEAD")
  expect(await owner.call({ op: "merge", handle, expectedCommit: committed.head })).toMatchObject({
    outcome: "rejected",
    status: "ready"
  })
  expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(sourceBefore)
  expect(approve).toHaveBeenCalledWith(
    expect.objectContaining({
      headCommit: committed.head,
      sourceCommit: sourceBefore,
      generation: 1,
      runId: "wf_resource01"
    })
  )
  accepted = true
  changed = true
  await expect(owner.call({ op: "merge", handle, expectedCommit: committed.head })).rejects.toThrow(
    "APPROVAL_CHANGED"
  )
  expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(sourceBefore)
  await owner.ledger.reclaimAll()
})

it("checks the approved source inside the original Git transaction before already-integrated cleanup", async () => {
  const f = await fixture()
  let commit = ""
  const owner = f.open(
    undefined,
    async () => true,
    async () => {
      f.git(f.repo, "merge", "--ff-only", commit)
    }
  )
  const acquired = await owner.call({ op: "acquire", resourceId: "code" })
  const handle = String(acquired.handle)
  const created = await f.commit(owner.ledger, handle)
  commit = created.head
  await owner.call({ op: "seal", handle, expectedCommit: commit })
  await expect(owner.call({ op: "merge", handle, expectedCommit: commit })).rejects.toThrow(
    "approved source checkout changed"
  )
  expect([...f.records.values()][0].resource?.state).toBe("unknown")
  expect(await readFile(join(created.directory, "result.txt"), "utf8")).toBe("result.txt\n")
  await owner.ledger.reclaimAll()
})

it("cancels a pending promotion decision and cannot apply a late approval", async () => {
  const f = await fixture()
  let approve!: (value: boolean) => void, entered!: () => void
  const ready = new Promise<void>((done) => {
    entered = done
  })
  const owner = f.open(
    undefined,
    () =>
      new Promise<boolean>((done) => {
        approve = done
        entered()
      })
  )
  const acquired = await owner.call({ op: "acquire", resourceId: "pending" })
  const handle = String(acquired.handle),
    committed = await f.commit(owner.ledger, handle)
  await owner.call({ op: "seal", handle, expectedCommit: committed.head })
  const before = f.git(f.repo, "rev-parse", "HEAD")
  const pending = owner.call({ op: "merge", handle, expectedCommit: committed.head })
  const rejected = expect(pending).rejects.toThrow()
  await ready
  f.controller.abort()
  await rejected
  approve(true)
  await new Promise<void>((done) => setImmediate(done))
  expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(before)
  expect([...f.records.values()][0].status).toBe("ready")
  await owner.ledger.reclaimAll()
})
