import { BotWorktreeSettings } from "./worktree-settings"
import type { BotWorktreeOperation } from "./worktree-contract"
import { dirname, join } from "node:path"
import { BotDomainError } from "../../shared/bot-types"
import { BotOperationProcess, type BotOperationLauncher } from "./operation-process"
import {
  botWorktreeAcquired,
  botWorktreeDetail,
  botWorktreeRecord,
  botWorktreeSource
} from "./worktree-contract"
import type { BotRuntimeRequest } from "./host"
import { BotProjectFiles } from "./project-files"
import type { BotStore } from "./store"
import type { BotRunAddress } from "../../shared/bot-run-history"
import type {
  BotWorktreeDetail,
  BotWorktreeCleanup,
  BotWorktreeMerge,
  BotWorktreeSummary
} from "../../shared/bot-worktree"
import { z } from "zod"
import { canonicalJson } from "./validation"
import { withBotProjectMutation } from "./project-lock"

function summary(record: ReturnType<typeof botWorktreeRecord.parse>): BotWorktreeSummary {
  const {
    id,
    branch,
    sourceBranch,
    workspaceDirectory: directory,
    baseCommit,
    headCommit,
    dirty,
    status,
    error,
    cleanupPending
  } = record
  return {
    id,
    branch,
    sourceBranch,
    directory,
    baseCommit,
    headCommit,
    dirty,
    status,
    error,
    cleanupPending
  }
}

/** Durable binding over Cmb's existing managed-worktree implementation. The
 * worker owns Git and manifests; Host owns task leases and model authority. */
export class BotWorktrees {
  readonly appDataRoot: string
  private readonly process: BotOperationProcess
  private readonly settings: BotWorktreeSettings
  private operations = 0
  get busy(): boolean {
    return this.operations > 0
  }
  constructor(
    private readonly modelFile: string,
    launcher: BotOperationLauncher = { entry: join(__dirname, "bot-worktree.js") }
  ) {
    // Keep project checkouts outside the private Host directory. Existing file
    // and shell tools continue to deny the whole Host directory without holes.
    this.appDataRoot = `${dirname(modelFile)}-workspaces`
    this.process = new BotOperationProcess(launcher, "工作区执行器")
    this.settings = new BotWorktreeSettings(modelFile)
  }

  private async perform<T>(
    input: BotWorktreeOperation,
    fallbackMs: number,
    parse: (value: unknown) => T,
    signal: AbortSignal
  ): Promise<T> {
    signal.throwIfAborted()
    const prepared = await this.settings.prepare(input, fallbackMs)
    signal.throwIfAborted()
    return this.process.execute(prepared.input, prepared.timeoutMs, parse, signal)
  }

  private async binding(store: BotStore, address: BotRunAddress, signal: AbortSignal) {
    this.operations++
    try {
      const run = store.assertRunAddress(address)
      const saved = store.db.exec("SELECT record FROM bot_worktrees WHERE run_id=?", [run.id])[0]
        ?.values[0]?.[0]
      const metadata = store.workflowChildren.metadata(run.id)
      if (!metadata || metadata.input.isolation !== "worktree")
        throw new Error("此任务没有独立代码工作区")
      const frozen = store.db.exec("SELECT source FROM bot_worktree_sources WHERE workflow_id=?", [
        metadata.workflowId
      ])[0]?.values[0]?.[0]
      if (typeof frozen !== "string") throw new Error("工作区尚未开始准备")
      const source = botWorktreeSource.parse(JSON.parse(frozen))
      let record: ReturnType<typeof botWorktreeRecord.parse>
      if (typeof saved === "string") record = botWorktreeRecord.parse(JSON.parse(saved))
      else {
        // Host may have stopped after the worker persisted ownership but before
        // acknowledging it in SQLite. Discover that exact checkout, never create
        // a replacement from a history/read request.
        const found = await this.perform(
          {
            op: "lookup",
            source,
            workspacePath: source.workspacePath,
            appDataRoot: this.appDataRoot,
            runId: metadata.workflowId,
            childId: run.id
          },
          60_000,
          (value) => botWorktreeRecord.nullable().parse(value),
          signal
        )
        if (!found) throw new Error("工作区尚未创建；未找到已登记目录")
        record = found
        if (record.threadId !== run.id || record.runId !== metadata.workflowId)
          throw new Error("工作区操作结果归属不符")
        store.transaction(() => {
          store.assertRunAddress(address)
          const old = store.db.exec("SELECT record FROM bot_worktrees WHERE run_id=?", [run.id])[0]
            ?.values[0]?.[0]
          if (old && botWorktreeRecord.parse(JSON.parse(String(old))).id !== record.id)
            throw new Error("不能替换任务的原工作区")
          store.db.run("INSERT OR IGNORE INTO bot_worktrees VALUES(?,?,?,?)", [
            run.id,
            metadata.workflowId,
            JSON.stringify(record),
            store.now()
          ])
        })
      }
      if (record.threadId !== run.id) throw new Error("工作区不属于此任务")
      if (record.runId !== metadata.workflowId) throw new Error("工作区不属于此工作流")
      const workspacePath = source.workspacePath
      return { run, record, workspacePath, appDataRoot: this.appDataRoot }
    } finally {
      this.operations--
    }
  }

  async detail(
    store: BotStore,
    address: BotRunAddress,
    signal: AbortSignal
  ): Promise<BotWorktreeDetail> {
    const binding = await this.binding(store, address, signal)
    this.operations++
    try {
      const common = {
        workspacePath: binding.workspacePath,
        appDataRoot: binding.appDataRoot,
        record: binding.record
      }
      let current = await this.perform(
        { ...common, op: "status" },
        60_000,
        (value) => botWorktreeRecord.parse(value),
        signal
      )
      // A cancelled/restored task may retain a running manifest if Host exited
      // before settlement. Reconcile only terminal tasks, under the same worker
      // repository lock as any surviving operation. Never restart the model.
      if (
        ["succeeded", "failed", "cancelled"].includes(binding.run.status) &&
        ["provisioning", "running", "integrating"].includes(current.status)
      ) {
        current = await this.perform(
          { ...common, record: current, op: "recover" },
          60_000,
          (value) => botWorktreeRecord.parse(value),
          signal
        )
      }
      if (["merged", "discarded"].includes(current.status))
        return {
          worktree: summary(current),
          summary: current.status === "merged" ? "变更已合并到源分支。" : "工作区已丢弃。",
          patch: "",
          patchTruncated: false
        }
      let detail: ReturnType<typeof botWorktreeDetail.parse>
      try {
        detail = await this.perform(
          { ...common, record: current, op: "diff" },
          60_000,
          (value) => botWorktreeDetail.parse(value),
          signal
        )
      } catch (cause) {
        signal.throwIfAborted()
        // Broken/missing checkouts still need an owned record and explicit
        // cleanup affordance. Git's action path revalidates ownership itself.
        const error = cause instanceof Error ? cause.message : "无法读取工作区差异"
        return {
          worktree: { ...summary(current), error },
          summary: error,
          patch: "",
          patchTruncated: true
        }
      }
      return {
        worktree: summary(detail.record),
        summary: detail.summary,
        patch: detail.patch ?? "",
        patchTruncated: detail.patchTruncated ?? false
      }
    } finally {
      this.operations--
    }
  }

  async merge(
    store: BotStore,
    input: BotWorktreeMerge,
    signal: AbortSignal
  ): Promise<BotWorktreeSummary> {
    return this.mutate(store, input, "merge", signal)
  }

  async cleanup(
    store: BotStore,
    input: BotWorktreeCleanup,
    signal: AbortSignal
  ): Promise<BotWorktreeSummary> {
    const operation = z.enum(["discard", "cleanup"]).parse(input.operation)
    return this.mutate(store, input, operation, signal)
  }

  private async mutate(
    store: BotStore,
    input: BotWorktreeMerge,
    operation: "merge" | "discard" | "cleanup",
    signal: AbortSignal
  ): Promise<BotWorktreeSummary> {
    const binding = await this.binding(store, input, signal)
    const nonce = z.string().min(1).max(160).parse(input.nonce)
    const expectedHeadCommit = z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .parse(input.expectedHeadCommit)
    if (!["succeeded", "failed", "cancelled"].includes(binding.run.status))
      throw new Error("请先结束或核对任务，再处理工作区")
    const encoded = canonicalJson({
      runId: binding.run.id,
      worktreeId: binding.record.id,
      expectedHeadCommit,
      ...(operation !== "merge" ? { operation } : {})
    })
    const previous = store.transaction(() => {
      const old = store.db.exec("SELECT input,result FROM bot_worktree_actions WHERE nonce=?", [
        nonce
      ])[0]?.values[0]
      if (old) {
        if (old[0] !== encoded) throw new Error("工作区请求标识已用于另一项操作")
        return typeof old[1] === "string" ? botWorktreeRecord.parse(JSON.parse(old[1])) : null
      }
      const count = Number(
        store.db.exec("SELECT COUNT(*) FROM bot_worktree_actions WHERE run_id=?", [
          binding.run.id
        ])[0].values[0][0]
      )
      if (count >= 50) throw new Error("此工作区的操作请求已达上限，请核对已有记录")
      store.db.run("INSERT INTO bot_worktree_actions VALUES(?,?,?,NULL,?)", [
        nonce,
        binding.run.id,
        encoded,
        store.now()
      ])
      return null
    })
    if (previous) return summary(previous)
    this.operations++
    try {
      return await withBotProjectMutation(binding.workspacePath, async () => {
        signal.throwIfAborted()
        const common = {
          workspacePath: binding.workspacePath,
          appDataRoot: binding.appDataRoot,
          record: binding.record
        }
        const current = await this.perform(
          { ...common, op: "status" },
          60_000,
          (value) => botWorktreeRecord.parse(value),
          signal
        )
        const record =
          ((operation === "merge" && current.status === "merged") ||
            (operation === "discard" && current.status === "discarded")) &&
          current.headCommit === expectedHeadCommit
            ? current
            : await this.perform(
                { ...common, record: current, op: operation, expectedHeadCommit },
                120_000,
                (value) => botWorktreeRecord.parse(value),
                signal
              )
        if (record.threadId !== binding.run.id || record.id !== binding.record.id)
          throw new Error("工作区操作结果归属不符")
        store.transaction(() => {
          store.db.run("UPDATE bot_worktrees SET record=?,updated_at=? WHERE run_id=?", [
            JSON.stringify(record),
            store.now(),
            binding.run.id
          ])
          store.db.run("UPDATE bot_worktree_actions SET result=? WHERE nonce=? AND input=?", [
            JSON.stringify(record),
            nonce,
            encoded
          ])
        })
        return summary(record)
      })
    } finally {
      this.operations--
    }
  }

  async execute(
    request: BotRuntimeRequest,
    execute: (request: BotRuntimeRequest) => Promise<string>
  ): Promise<string> {
    const { store, lease, run, signal, bot } = request
    const child = store.workflowChildren.metadata(run.id)
    if (child?.input.isolation !== "worktree" || !bot.workspacePath)
      throw new BotDomainError(
        "workflow_worktree_scope",
        "隔离任务需要明确的 Git 项目目录，不能降级为共享目录"
      )
    const check = () => {
      signal.throwIfAborted()
      store.assertDispatch(lease)
      if (store.getBot(bot.id).revision !== bot.revision)
        throw new BotDomainError("workflow_worktree_scope", "Bot 的项目授权已变化")
    }
    check()
    const project = await BotProjectFiles.open(bot.workspacePath, [dirname(this.modelFile)])
    const common = { appDataRoot: this.appDataRoot, workspacePath: project.root }
    const source = await (async () => {
      const saved = store.db.exec("SELECT source FROM bot_worktree_sources WHERE workflow_id=?", [
        child.workflowId
      ])[0]?.values[0]?.[0]
      if (typeof saved === "string") return botWorktreeSource.parse(JSON.parse(saved))
      const source = await this.perform(
        { ...common, op: "prepare" },
        60_000,
        (value) => botWorktreeSource.parse(value),
        signal
      )
      check()
      return store.transaction(() => {
        store.assertDispatch(lease)
        store.db.run("INSERT OR IGNORE INTO bot_worktree_sources VALUES(?,?)", [
          child.workflowId,
          JSON.stringify(source)
        ])
        return botWorktreeSource.parse(
          JSON.parse(
            String(
              store.db.exec("SELECT source FROM bot_worktree_sources WHERE workflow_id=?", [
                child.workflowId
              ])[0].values[0][0]
            )
          )
        )
      })
    })()
    check()
    if (source.workspacePath !== project.root) throw new Error("工作区源目录与当前项目不一致")
    store.activity(lease, "正在准备独立代码工作区", "collaboration")
    const acquired = await this.perform(
      { ...common, op: "acquire", source, runId: child.workflowId, childId: run.id },
      60_000,
      (value) => botWorktreeAcquired.parse(value),
      signal
    )
    check()
    const persist = (record: ReturnType<typeof botWorktreeRecord.parse>) =>
      store.transaction(() => {
        store.assertLease(lease, true, true)
        if (record.runId !== child.workflowId || record.threadId !== run.id)
          throw new Error("工作区执行器返回了错误的任务归属")
        const old = store.db.exec("SELECT record FROM bot_worktrees WHERE run_id=?", [run.id])[0]
          ?.values[0]?.[0]
        if (old && botWorktreeRecord.parse(JSON.parse(String(old))).id !== record.id)
          throw new Error("不能替换任务的原工作区")
        store.db.run(
          "INSERT INTO bot_worktrees VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at",
          [run.id, child.workflowId, JSON.stringify(record), store.now()]
        )
      })
    persist(acquired.record)
    let succeeded = false
    try {
      const result = await execute({
        ...request,
        bot: { ...bot, workspacePath: acquired.boundary.workspaceRoot },
        worktree: { sourceWorkspacePath: bot.workspacePath, boundary: acquired.boundary }
      })
      check()
      const record = await this.perform(
        { ...common, op: "settle", record: acquired.record, succeeded: true },
        60_000,
        (value) => botWorktreeRecord.parse(value),
        signal
      )
      check()
      persist(record)
      succeeded = true
      return result
    } finally {
      if (!succeeded) {
        // Do not let a replaced executor change its successor's worktree state.
        // If cancellation prevents inspection, the durable running manifest is
        // retained and revalidated on the next explicit task recovery.
        try {
          store.assertLease(lease, true, true)
          const record = await this.perform(
            { ...common, op: "settle", record: acquired.record, succeeded: false },
            60_000,
            (value) => botWorktreeRecord.parse(value),
            AbortSignal.timeout(15_000)
          )
          persist(record)
        } catch {
          /* ownership manifest preserves the unresolved worktree */
        }
      }
    }
  }
}
