import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { hasOwnedShellPhysicalClosure } from "./owned-shell-receipt-contract"
import { inspectOwnedShellReceiptEntries, type OwnedShellReceipt } from "./owned-shell-receipts"
import { assertNativeDesktopMaintenance } from "./native-desktop-maintenance"

/** This directory is private current physical-resource evidence. It is never
 * captured/replaced by DB, workspace, browser or CPU12 restore. The same path
 * is supplied to the trusted shell factory; no model/request selects it. */
export const BOT_OWNED_SHELL_RESOURCE_DIRECTORY = "shell-resources"
export { botShellResourceReviewSchema as botOwnedShellMaintenanceReview } from "../../shared/bot-shell-resources"
import { botShellResourceReviewSchema as botOwnedShellMaintenanceReview } from "../../shared/bot-shell-resources"
export type BotOwnedShellMaintenanceReview = z.infer<typeof botOwnedShellMaintenanceReview>
export interface OwnedShellMaintenanceOwner {
  /** Must come from the current held Host lifetime lock. Observer reads may
   * display review state, but must never authorize an offline mutation. */
  assertCurrent(): void | Promise<void>
  root: { dev: string; ino: string }
}
export function ownedShellMaintenanceOwner(lock: {
  checkCurrent(): Promise<void>
  recoveryOwnershipIdentity(): { root: { dev: string; ino: string } }
}): OwnedShellMaintenanceOwner {
  return { assertCurrent: () => lock.checkCurrent(), root: lock.recoveryOwnershipIdentity().root }
}
export class BotShellMaintenanceBlocked extends BotDomainError {
  readonly definitive = true
  constructor(readonly review: BotOwnedShellMaintenanceReview) {
    super("bot_shell_resource_requires_review", `${review.title}：${review.hint}`)
    this.name = "BotShellMaintenanceBlocked"
  }
}
const rootOf = (directory: string) => join(directory, BOT_OWNED_SHELL_RESOURCE_DIRECTORY)
export async function assertBotOwnedShellMaintenanceOwner(
  directory: string,
  owner: OwnedShellMaintenanceOwner,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  await owner.assertCurrent()
  signal?.throwIfAborted()
  const stat = await lstat(directory, { bigint: true })
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    String(stat.dev) !== owner.root.dev ||
    String(stat.ino) !== owner.root.ino ||
    (await realpath(directory)) !== directory
  )
    throw new Error("Owned shell Host root changed")
  await owner.assertCurrent()
  signal?.throwIfAborted()
}
async function readEntries(
  directory: string,
  owner: OwnedShellMaintenanceOwner,
  signal?: AbortSignal
) {
  await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
  const root = rootOf(directory)
  try {
    await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
    return []
  }
  const entries = await inspectOwnedShellReceiptEntries(root)
  await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
  return entries
}
function statusOf(receipt: OwnedShellReceipt) {
  if (hasOwnedShellPhysicalClosure(receipt)) return "cleanup-pending" as const
  return receipt.runAuthorized ? ("effect-unproven" as const) : ("prepared-only" as const)
}

/** Bounded read-only recovery status. This API does not open Store, reconcile
 * old effects, delete scratch, guess that a stale PID died, or signal a PID. */
export async function inspectBotOwnedShellMaintenance(
  directory: string,
  owner: OwnedShellMaintenanceOwner,
  signal?: AbortSignal
): Promise<BotOwnedShellMaintenanceReview> {
  // Ownership failures are distinct from corrupted evidence; never hide a
  // lost lifetime lock inside a recoverable review result.
  await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
  let entries
  try {
    entries = await readEntries(directory, owner, signal)
  } catch {
    await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
    return botOwnedShellMaintenanceReview.parse({
      state: "requires_review",
      reason: "invalid-resource-evidence",
      entries: [],
      title: "命令现场记录需要核对",
      hint: "现场记录不完整或位置发生变化，已暂停维护。请查看诊断记录，保留原目录；不要删除记录或重放任务。"
    })
  }
  const summary = entries.map(({ value }) => ({
    nonce: value.nonce,
    runId: value.runId,
    hostId: value.hostId,
    dataEpoch: value.dataEpoch,
    phase: value.phase,
    runAuthorized: value.runAuthorized,
    status: statusOf(value)
  }))
  const blocked = summary.some((entry) => entry.status === "effect-unproven")
  return botOwnedShellMaintenanceReview.parse({
    state: blocked ? "requires_review" : "ready",
    reason: blocked ? "physical-closure-unproven" : "none",
    entries: summary,
    title: blocked ? "有命令尚未确认停止" : "命令现场已核对",
    hint: blocked
      ? "请查看对应任务和现场记录，核对可能已发生的变更。确认隔离资源已关闭前，不能恢复工作文件或替换 Bot 数据；不会自动重试任务。"
      : summary.length > 0
        ? "未获执行授权的准备现场和已确认关闭的清理现场仍予保留；本检查不删除现场，也不重试任务。"
        : "没有未确认关闭的命令现场。"
  })
}

/** Call under the held lifetime lock, before migration/recovery/capture and
 * before opening Store. An OS lock becoming free does not prove descendants
 * stopped. The caller must retain its lock for the entire mutation. */
export async function assertBotOwnedShellMaintenance(
  directory: string,
  owner: OwnedShellMaintenanceOwner,
  signal?: AbortSignal
): Promise<void> {
  const review = await inspectBotOwnedShellMaintenance(directory, owner, signal)
  if (review.state === "requires_review") throw new BotShellMaintenanceBlocked(review)
  await assertNativeDesktopMaintenance(directory)
  await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
}

/** Native reveal selects an existing validated resource receipt; a UUID/path
 * existence check alone is never authority. Output is the private diagnostic
 * record only, not the scratch path, token, command output or user workspace. */
export async function resolveBotOwnedShellResourceRecord(
  directory: string,
  nonce: string,
  owner: OwnedShellMaintenanceOwner,
  signal?: AbortSignal
): Promise<string> {
  z.string().uuid().parse(nonce)
  const entry = (await readEntries(directory, owner, signal)).find(
    ({ value }) => value.nonce === nonce
  )
  if (!entry) throw new Error("命令现场记录不存在或已完成清理")
  await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
  return join(rootOf(directory), `operation-${entry.slot}`, "owner.json")
}

/** Diagnosis remains reachable when a receipt is corrupt. Revealing this
 * pinned private directory is read-only user action, not cleanup permission. */
export async function resolveBotOwnedShellResourceDiagnostics(
  directory: string,
  owner: OwnedShellMaintenanceOwner,
  signal?: AbortSignal
): Promise<string> {
  await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
  const root = rootOf(directory),
    stat = await lstat(root, { bigint: true })
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
  )
    throw new Error("命令现场目录不安全，保留原路径并查看后台诊断")
  await assertBotOwnedShellMaintenanceOwner(directory, owner, signal)
  const after = await lstat(root, { bigint: true })
  if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino)
    throw new Error("命令现场目录已变化")
  return root
}
