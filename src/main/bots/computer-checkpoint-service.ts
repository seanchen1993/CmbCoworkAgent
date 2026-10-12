import {
  assertBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { BotDomainError } from "../../shared/bot-types"
import {
  botComputerCheckpointRequest,
  botComputerCheckpointSelection
} from "../../shared/bot-computer-checkpoint"
import type { BotComputerMaintenanceProgress } from "../../shared/bot-computer-maintenance-progress"
import { BotHostLock } from "./host-lock"
import { BotComputerCheckpoints } from "./computer-checkpoints"
import { ComputerNativeSQLite } from "./computer-checkpoint-native"
import { createComputerCheckpointPorts } from "./computer-checkpoint-adapter"
import { ComputerCheckpointProgress } from "./computer-checkpoint-progress"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { migrateBotMaintenanceJsonReceipts } from "./maintenance-receipts-migration"
import { present, readPrivateJson } from "./backup-io"
import { computerJournal } from "./computer-checkpoint-manifest"
import type { ComputerOwner } from "./computer-checkpoint-ports"
import { withBackupIoObserver } from "./backup-io-observer"
import {
  resolveComputerManagedDeliverables,
  listComputerManagedDeliverables
} from "./computer-checkpoint-managed"

export const computerCheckpointTerminalCodes = new Set([
  "snapshot_deleted",
  "computer_checkpoint_rejected",
  "computer_checkpoint_conflict"
])
export interface ComputerCheckpointOptions {
  signal?: AbortSignal
  afterStep?: (step: string) => void | Promise<void>
  lock?: BotHostLock
  token?: string
  progress?: (value: BotComputerMaintenanceProgress) => void
  nativeEntry?: string
  nativeExecArgv?: string[]
  // A stuck SQLite thread must end its lock-owning process. Test injects this
  // only inside a disposable owner process, never the shared test runner.
  fatalAbort?: () => never
}
function ownerPort(
  lock: Pick<BotHostLock, "assertCurrent" | "checkCurrent" | "recoveryOwnershipIdentity">
): ComputerOwner {
  return {
    assertCurrent: () => lock.assertCurrent(),
    checkCurrent: () => lock.checkCurrent(),
    identity: () => lock.recoveryOwnershipIdentity()
  }
}
function context(
  directory: string,
  owner: ComputerOwner,
  options: ComputerCheckpointOptions,
  controller: AbortController,
  progress?: ComputerCheckpointProgress
) {
  const native = new ComputerNativeSQLite(
    directory,
    owner,
    controller.signal,
    options.fatalAbort ?? (() => process.exit(1)),
    (active) => progress?.native(active),
    options.nativeEntry,
    options.nativeExecArgv
  )
  return new BotComputerCheckpoints(
    directory,
    owner,
    createComputerCheckpointPorts(native, progress),
    controller.signal,
    progress,
    options.afterStep
  )
}
function observeIo<T>(
  owner: ComputerOwner,
  signal: AbortSignal,
  progress: ComputerCheckpointProgress,
  options: ComputerCheckpointOptions,
  operation: () => Promise<T>
) {
  return withBackupIoObserver(
    {
      assertCurrent() {
        signal.throwIfAborted()
        owner.assertCurrent()
      },
      worked() {
        progress.worked()
      },
      git(active) {
        progress.git(active)
      },
      fatalAbort: options.fatalAbort ?? (() => process.exit(1))
    },
    operation
  )
}
async function classify(
  directory: string,
  raw: unknown,
  error: unknown,
  owner: ComputerOwner
): Promise<never> {
  if (error instanceof BotDomainError && computerCheckpointTerminalCodes.has(error.code))
    throw error
  try {
    await owner.checkCurrent()
    owner.assertCurrent()
    if (await present(join(directory, "computer-recovery", "pending.json")))
      throw new Error("sealed")
    const request = botComputerCheckpointRequest.safeParse(raw),
      ledger = BotMaintenanceReceipts.readOnly(directory)
    try {
      if (request.success && request.data.action === "create") {
        if (ledger?.get("computer", request.data.nonce)?.state === "deleted")
          throw new BotDomainError("snapshot_deleted", "该请求创建的恢复点已删除")
        if (await present(join(directory, "computer-recovery", "points", request.data.nonce)))
          throw new Error("published")
      } else if (
        request.success &&
        request.data.action === "restore" &&
        ["sealed", "completed"].includes(
          ledger?.getOperation("computer", request.data.nonce)?.state ?? ""
        )
      )
        throw new Error("reserved or completed")
      else if (
        request.success &&
        request.data.action === "delete" &&
        ledger?.get("computer", request.data.checkpoint.id)?.state === "deleted"
      )
        throw new Error("delete pending")
      throw new BotDomainError(
        "computer_checkpoint_rejected",
        error instanceof Error ? error.message : "电脑恢复请求未执行"
      )
    } finally {
      ledger?.close()
    }
  } catch (classified) {
    if (
      classified instanceof BotDomainError &&
      computerCheckpointTerminalCodes.has(classified.code)
    )
      throw classified
    throw new BotDomainError(
      "computer_checkpoint_incomplete",
      "电脑维护结果尚未确认，请使用原请求标识重试；恢复日志和原始现场已保留"
    )
  }
}
export async function executeBotComputerCheckpoint(
  directory: string,
  raw: unknown,
  options: ComputerCheckpointOptions = {}
) {
  const parsed = botComputerCheckpointRequest.safeParse(raw)
  if (!parsed.success)
    throw new BotDomainError("computer_checkpoint_rejected", "电脑维护请求格式无效，尚未执行")
  directory = await realpath(directory)
  const request = parsed.data,
    acquired = options.lock ?? BotHostLock.acquire(directory)
  if (!acquired)
    throw new BotDomainError(
      "computer_checkpoint_rejected",
      "Bot 后台正在运行，请先停止后台后执行电脑维护"
    )
  const owner = ownerPort(acquired),
    controller = new AbortController(),
    abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  const nonce = request.action === "delete" ? request.checkpoint.id : request.nonce,
    progress = new ComputerCheckpointProgress(
      directory,
      owner,
      nonce,
      request.action,
      options.token ?? randomUUID(),
      options.progress ?? (() => {}),
      (error) => controller.abort(error)
    )
  try {
    await progress.start()
    await assertBotOwnedShellMaintenance(
      directory,
      ownedShellMaintenanceOwner(acquired),
      controller.signal
    )
    await migrateBotMaintenanceJsonReceipts(directory, () => owner.assertCurrent())
    return await observeIo(owner, controller.signal, progress, options, () =>
      context(directory, owner, options, controller, progress).execute(request)
    )
  } catch (error) {
    return await classify(directory, request, error, owner)
  } finally {
    options.signal?.removeEventListener("abort", abort)
    try {
      await progress.close()
    } finally {
      if (!options.lock) acquired.release()
    }
  }
}
export async function recoverBotComputerCheckpoint(
  directory: string,
  lock: BotHostLock,
  options: ComputerCheckpointOptions = {}
) {
  const pending = join(directory, "computer-recovery", "pending.json")
  if (!(await present(pending))) return
  await assertBotOwnedShellMaintenance(directory, ownedShellMaintenanceOwner(lock), options.signal)
  const journal = computerJournal.parse(
      (await readPrivateJson(join(directory, "computer-recovery"), "pending.json", 16 * 1024)).value
    ),
    owner = ownerPort(lock),
    controller = new AbortController(),
    abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  const progress = new ComputerCheckpointProgress(
    directory,
    owner,
    journal.nonce,
    "startup-restore",
    options.token ?? "",
    options.progress ?? (() => {}),
    (error) => controller.abort(error)
  )
  try {
    await progress.start()
    await observeIo(owner, controller.signal, progress, options, () =>
      context(directory, owner, options, controller, progress).recover()
    )
  } finally {
    options.signal?.removeEventListener("abort", abort)
    await progress.close()
  }
}
export async function listBotComputerCheckpoints(directory: string) {
  if (!(await present(join(directory, "computer-recovery")))) return []
  directory = await realpath(directory)
  const owner = ownerPort(BotHostLock.observe(directory)),
    controller = new AbortController()
  return context(directory, owner, {}, controller).list()
}
export async function listBotComputerRecoveryCopies(directory: string) {
  if (!(await present(join(directory, "computer-recovery")))) return []
  directory = await realpath(directory)
  const owner = ownerPort(BotHostLock.observe(directory)),
    controller = new AbortController()
  return context(directory, owner, {}, controller).recoveryCopies()
}
export async function resolveBotComputerDeliverables(directory: string, id: string) {
  directory = await realpath(directory)
  const owner = ownerPort(BotHostLock.observe(directory))
  await owner.checkCurrent()
  owner.assertCurrent()
  const { path } = await resolveComputerManagedDeliverables(directory, id)
  await owner.checkCurrent()
  owner.assertCurrent()
  return path
}
export async function listBotComputerDeliverables(directory: string) {
  if (!(await present(join(directory, "computer-recovery", "deliverables")))) return []
  directory = await realpath(directory)
  const owner = ownerPort(BotHostLock.observe(directory))
  await owner.checkCurrent()
  owner.assertCurrent()
  const result = await listComputerManagedDeliverables(directory)
  await owner.checkCurrent()
  owner.assertCurrent()
  return result
}

export async function deleteBotComputerRecoveryCopy(
  directory: string,
  raw: unknown,
  options: ComputerCheckpointOptions = {}
) {
  const parsed = botComputerCheckpointSelection.safeParse(raw)
  if (!parsed.success)
    throw new BotDomainError("computer_checkpoint_rejected", "原现场选择格式无效，尚未执行")
  const selection = parsed.data
  directory = await realpath(directory)
  const acquired = options.lock ?? BotHostLock.acquire(directory)
  if (!acquired)
    throw new BotDomainError("computer_checkpoint_rejected", "Bot 后台正在运行，请先停止后台")
  const owner = ownerPort(acquired),
    controller = new AbortController(),
    abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  const progress = new ComputerCheckpointProgress(
    directory,
    owner,
    selection.id,
    "delete-recovery",
    options.token ?? randomUUID(),
    options.progress ?? (() => {}),
    (error) => controller.abort(error)
  )
  try {
    await progress.start()
    await assertBotOwnedShellMaintenance(
      directory,
      ownedShellMaintenanceOwner(acquired),
      controller.signal
    )
    progress.stage("cleanup", "control")
    await migrateBotMaintenanceJsonReceipts(directory, () => owner.assertCurrent())
    await observeIo(owner, controller.signal, progress, options, () =>
      context(directory, owner, options, controller, progress).deleteRecovery(
        selection.id,
        selection.sha256
      )
    )
    return { action: "delete-recovery" as const }
  } catch (error) {
    try {
      await owner.checkCurrent()
      owner.assertCurrent()
      const ledger = BotMaintenanceReceipts.readOnly(directory)
      try {
        const operation = ledger?.getOperation("recovery", selection.id)
        if (operation || (await present(join(directory, "computer-recovery", "pending.json"))))
          throw new Error("delete pending")
      } finally {
        ledger?.close()
      }
    } catch {
      throw new BotDomainError(
        "computer_checkpoint_incomplete",
        "原现场清理尚未确认完成，请保留当前选择后重试"
      )
    }
    throw new BotDomainError(
      "computer_checkpoint_rejected",
      error instanceof Error ? error.message : "原现场未清理"
    )
  } finally {
    options.signal?.removeEventListener("abort", abort)
    try {
      await progress.close()
    } finally {
      if (!options.lock) acquired.release()
    }
  }
}
