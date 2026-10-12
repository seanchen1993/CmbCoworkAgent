import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  assertWorkflowWorktreeDeliverableDescendsFromBase,
  assertWorkflowWorktreeDeliverablePathsInScope,
  createWorkflowWorktree,
  cleanupWorkflowWorktree,
  diffWorkflowWorktree,
  discardWorkflowWorktree,
  inspectWorkflowWorktree,
  listWorkflowWorktreeRecordsForPrune,
  loadCurrentWorkflowWorktreeRecord,
  mergeWorkflowWorktree,
  persistWorkflowWorktreeRecord,
  prepareWorkflowWorktreeSource,
  recoverInterruptedWorkflowWorktree,
  resolveWorkflowWorktreeIsolationBoundary
} from "../services/git-worktree"
import type { WorkflowWorktreeRecord } from "../agent/workflow/types"
import { BotHostLock } from "./host-lock"
import { botWorktreeOperation, type BotWorktreeOperation } from "./worktree-contract"

function assertFrozenSource(
  record: WorkflowWorktreeRecord,
  source: Extract<BotWorktreeOperation, { op: "acquire" | "lookup" }>["source"]
): void {
  if (
    record.sourceRoot !== source.sourceRoot ||
    record.baseCommit !== source.baseCommit ||
    record.sourceRelativePath !== source.sourceRelativePath ||
    record.sourceBranch !== source.sourceBranch ||
    record.gitRoot !== source.gitRoot ||
    record.commonDir !== source.commonDir
  )
    throw new Error("工作区不属于当前任务冻结的项目版本")
}

/** Reuses the desktop's Git ownership, checkout, diff and integration code. A
 * process-lifetime SQLite lock also serializes old/new Host workers on restart. */
export async function executeBotWorktreeOperation(
  raw: BotWorktreeOperation,
  signal: AbortSignal
): Promise<unknown> {
  const input = botWorktreeOperation.parse(raw)
  signal.throwIfAborted()
  const key =
    "source" in input
      ? input.source.commonDir
      : "record" in input
        ? input.record.commonDir
        : input.workspacePath
  const lockDirectory = join(
    input.appDataRoot,
    ".locks",
    createHash("sha256").update(key).digest("hex")
  )
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
  let lock: BotHostLock | null = null
  while (!lock) {
    signal.throwIfAborted()
    lock = BotHostLock.acquire(lockDirectory)
    if (!lock) await delay(100, undefined, { signal })
  }
  try {
    if (input.op === "prepare")
      return await prepareWorkflowWorktreeSource(input.workspacePath, signal)
    if (input.op === "acquire" || input.op === "lookup") {
      const scan = await listWorkflowWorktreeRecordsForPrune(
        input.source.commonDir,
        input.appDataRoot
      )
      if (!scan.reliable) throw new Error("工作区归属记录不可完整核对，禁止创建重复工作区")
      const matches = scan.records.filter(
        (record) => record.threadId === input.childId && record.runId === input.runId
      )
      if (matches.length > 1) throw new Error("子任务存在多个工作区归属记录，请先核对")
      let record = matches[0]
      if (input.op === "lookup") {
        if (!record) return null
        assertFrozenSource(record, input.source)
        return record
      }
      if (!record) {
        const info = await createWorkflowWorktree({
          workspacePath: input.workspacePath,
          appDataRoot: input.appDataRoot,
          source: input.source,
          runId: input.runId,
          threadId: input.childId,
          label: input.childId,
          persistOwnership: true,
          signal
        })
        record = {
          ...info,
          id: info.name,
          runId: input.runId,
          threadId: input.childId,
          headCommit: info.baseCommit,
          dirty: false,
          status: "running",
          updatedAt: new Date().toISOString()
        }
        // WorkflowWorktreeInfo.name is a transport alias, not manifest state.
        delete (record as WorkflowWorktreeRecord & { name?: string }).name
      }
      if (["merged", "discarded", "integrating"].includes(record.status))
        throw new Error("工作区已交付或正在整合，不能继续执行旧任务")
      assertFrozenSource(record, input.source)
      const boundary = await resolveWorkflowWorktreeIsolationBoundary(
        { ...record, name: record.id },
        input.appDataRoot
      )
      signal.throwIfAborted()
      record = { ...record, status: "running", updatedAt: new Date().toISOString() }
      await persistWorkflowWorktreeRecord(record, input.appDataRoot)
      return { record, boundary }
    }
    if (input.op === "status") {
      return await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
    }
    if (input.op === "recover") {
      return await recoverInterruptedWorkflowWorktree({
        ...input,
        error: "任务已结束，独立工作区保留供核对"
      })
    }
    if (input.op === "diff") return await diffWorkflowWorktree({ ...input, includePatch: true })
    if (input.op === "merge") return (await mergeWorkflowWorktree({ ...input, signal })).record
    if (input.op === "discard") return (await discardWorkflowWorktree(input)).record
    if (input.op === "cleanup") {
      const current = await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
      if (current.headCommit !== input.expectedHeadCommit)
        throw new Error("工作区提交已变化，请刷新后重新确认清理")
      return (await cleanupWorkflowWorktree({ ...input, record: current })).record
    }
    if (input.op !== "settle") throw new Error("不支持的工作区操作")
    const current = await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
    if (["merged", "discarded", "integrating"].includes(current.status))
      throw new Error("工作区已进入交付处理，不能覆盖记录")
    await resolveWorkflowWorktreeIsolationBoundary(
      { ...current, name: current.id },
      input.appDataRoot
    )
    const inspected = await inspectWorkflowWorktree(current.directory, current.baseCommit)
    if (!inspected.headCommit) throw new Error("无法核对工作区 HEAD，已保留修改")
    if (input.succeeded) {
      await assertWorkflowWorktreeDeliverableDescendsFromBase(
        current.directory,
        current.baseCommit,
        inspected.headCommit,
        60_000,
        signal
      )
      await assertWorkflowWorktreeDeliverablePathsInScope(
        current.directory,
        current.baseCommit,
        inspected.headCommit,
        current.sourceRelativePath,
        60_000,
        signal
      )
    }
    signal.throwIfAborted()
    const record: WorkflowWorktreeRecord = {
      ...current,
      headCommit: inspected.headCommit,
      dirty: inspected.dirty,
      status: input.succeeded ? "ready" : "recoverable",
      updatedAt: new Date().toISOString(),
      error: input.succeeded ? undefined : "任务中断，工作区和修改已保留供核对"
    }
    // Even a pristine checkout remains until the child receipt is durable. A
    // crash between settlement and that receipt must still resume the same path.
    await persistWorkflowWorktreeRecord(record, input.appDataRoot)
    return record
  } finally {
    lock.release()
  }
}
