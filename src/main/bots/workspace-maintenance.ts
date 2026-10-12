import {
  assertBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, realpath, rename, rm, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import {
  BOT_WORKSPACE_CHECKPOINT_LIMIT,
  botWorkspaceCheckpointSchema,
  botWorkspaceMaintenanceRequest,
  botWorkspaceMaintenanceResult,
  type BotWorkspaceCheckpoint,
  type BotWorkspaceMaintenanceRequest,
  type BotWorkspaceMaintenanceResult
} from "../../shared/bot-workspace-maintenance"
import { BotHostLock } from "./host-lock"
import {
  BotSharedWorkspace,
  botSharedWorkspaceReference,
  type BotSharedWorkspaceReference
} from "./shared-workspace"
import {
  botDirectoryEntries,
  captureBotDirectory,
  restoreBotDirectory,
  verifyBotDirectory
} from "./directory-checkpoint"
import {
  present,
  privateDirectory,
  readPrivateJson,
  syncDirectory,
  writePrivateJson
} from "./backup-io"
import { canonicalJson } from "./validation"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { botWorkspaceMaintenanceReceipt } from "./maintenance-receipt-contract"
import { migrateBotMaintenanceJsonReceipts } from "./maintenance-receipts-migration"

const stateRoot = (directory: string) => join(directory, "workspace-maintenance")
const catalog = (directory: string) => join(stateRoot(directory), "checkpoints")
const id = z.string().uuid()
const manifestSchema = botWorkspaceCheckpointSchema
  .omit({ sha256: true, files: true, bytes: true })
  .extend({
    format: z.literal(1),
    entries: botDirectoryEntries
  })
  .strict()
type Manifest = z.infer<typeof manifestSchema>
type Replacement = Extract<BotWorkspaceMaintenanceRequest, { action: "restore" | "reset" }>
const journalSchema = z
  .object({
    format: z.literal(1),
    request: botWorkspaceMaintenanceRequest.transform((request, ctx) => {
      if (request.action === "restore" || request.action === "reset") return request
      ctx.addIssue({ code: "custom", message: "工作文件替换请求必须是恢复或重置" })
      return z.NEVER
    }),
    stage: id,
    original: botSharedWorkspaceReference,
    replacement: botSharedWorkspaceReference,
    hadOriginal: z.boolean(),
    safetyCheckpoint: botWorkspaceCheckpointSchema.optional()
  })
  .strict()
  .refine(
    (journal) =>
      journal.original.id === journal.replacement.id &&
      journal.hadOriginal === Boolean(journal.safetyCheckpoint)
  )
type Journal = z.infer<typeof journalSchema>

function summary(manifest: Manifest, sha256: string): BotWorkspaceCheckpoint {
  const { entries, id, createdAt, reason, platform, workspaceId } = manifest
  return {
    id,
    createdAt,
    reason,
    platform,
    workspaceId,
    sha256,
    files: entries.filter((entry) => entry.kind === "file").length,
    bytes: entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0)
  }
}
function resultOf(journal: Journal): BotWorkspaceMaintenanceResult {
  return {
    action: journal.request.action,
    ...(journal.safetyCheckpoint
      ? { safetyCheckpoint: journal.safetyCheckpoint, recoveryCopy: journal.request.nonce }
      : {})
  }
}
async function readCheckpoint(directory: string, checkpointId: string, sha256?: string) {
  id.parse(checkpointId)
  const root = join(catalog(directory), checkpointId)
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
    throw new Error("工作文件恢复点目录无效")
  const sealed = await readPrivateJson(root, "manifest.json"),
    manifest = manifestSchema.parse(sealed.value)
  if (manifest.id !== checkpointId || (sha256 && sha256 !== sealed.sha256))
    throw new Error("工作文件恢复点已变化，请刷新后重新选择")
  return { root, manifest, summary: summary(manifest, sealed.sha256) }
}
export async function listBotWorkspaceCheckpoints(
  directory: string
): Promise<BotWorkspaceCheckpoint[]> {
  if (!(await present(directory))) return []
  directory = await realpath(directory)
  if (!(await present(catalog(directory)))) return []
  const result: BotWorkspaceCheckpoint[] = [],
    ledger = BotMaintenanceReceipts.readOnly(directory)
  try {
    for (const entry of await readdir(catalog(directory), { withFileTypes: true }))
      if (entry.isDirectory() && id.safeParse(entry.name).success) {
        if (ledger?.get("workspace", entry.name)?.state === "deleted") continue
        const checkpoint = await readCheckpoint(directory, entry.name)
        ledger?.assertActive("workspace", entry.name, checkpoint.summary.sha256)
        result.push(checkpoint.summary)
      }
  } finally {
    ledger?.close()
  }
  return result.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}
async function saveReceipt(
  directory: string,
  request: BotWorkspaceMaintenanceRequest,
  result: BotWorkspaceMaintenanceResult,
  journalSha256?: string
): Promise<void> {
  const parsed = botWorkspaceMaintenanceResult.parse(result)
  if (parsed.action !== request.action) throw new Error("操作收据不匹配")
  const ledger = new BotMaintenanceReceipts(directory)
  try {
    if (request.action === "create") {
      if (parsed.checkpoint?.id !== request.nonce) throw new Error("恢复点收据不匹配")
      ledger.publish("workspace", request.nonce, "manual", parsed.checkpoint.sha256)
    } else if (request.action === "delete") {
      ledger.retire("workspace", request.checkpoint.id, request.checkpoint.sha256)
    } else {
      if (!journalSha256) throw new Error("工作文件恢复日志缺失")
      ledger.reserveOperation(
        "workspace",
        request.nonce,
        request.action,
        BotMaintenanceReceipts.requestHash(request),
        parsed
      )
      ledger.sealOperation("workspace", request.nonce, journalSha256)
      ledger.completeOperation("workspace", request.nonce, journalSha256)
    }
  } finally {
    ledger.close()
  }
}
async function readReceipt(directory: string, request: BotWorkspaceMaintenanceRequest) {
  const ledger = BotMaintenanceReceipts.readOnly(directory)
  if (!ledger) return null
  try {
    if (request.action === "delete") {
      const point = ledger.get("workspace", request.checkpoint.id)
      if (point?.state !== "deleted") return null
      if (point.sha256 !== request.checkpoint.sha256)
        throw new Error("恢复点已变化，请刷新后重新选择")
      return { action: "delete" } as const
    }
    const operation = ledger.getOperation("workspace", request.nonce),
      point = ledger.get("workspace", request.nonce)
    if (request.action === "create") {
      if (operation) throw new Error("操作标识已用于其他工作文件操作")
      ledger.assertActive("workspace", request.nonce)
      if (point?.state !== "published") return null
      if (!(await present(join(catalog(directory), request.nonce))))
        throw new Error("恢复点文件已丢失，未重新生成；请发起新的保存操作")
      return {
        action: "create",
        checkpoint: (await readCheckpoint(directory, request.nonce, point.sha256)).summary
      } as const
    }
    if (point) throw new Error("操作标识已用于保存恢复点")
    if (!operation) return null
    if (
      operation.action !== request.action ||
      operation.requestSha256 !== BotMaintenanceReceipts.requestHash(request)
    )
      throw new Error("操作标识已用于其他工作文件操作")
    if (operation.state === "completed")
      return botWorkspaceMaintenanceResult.parse(operation.result)
    if (operation.state !== "reserved") throw new Error("工作文件恢复日志缺失，已停止重复执行")
    return null
  } finally {
    ledger.close()
  }
}

async function createCheckpoint(
  directory: string,
  checkpointId: string,
  reason: Manifest["reason"]
): Promise<BotWorkspaceCheckpoint> {
  const ledger = new BotMaintenanceReceipts(directory)
  try {
    ledger.assertActive("workspace", checkpointId)
    if (ledger.getOperation("workspace", checkpointId)) throw new Error("恢复点标识已用于其他操作")
    const destination = join(catalog(directory), checkpointId)
    if (await present(destination)) {
      const existing = await readCheckpoint(directory, checkpointId)
      if (existing.manifest.reason !== reason) throw new Error("恢复点标识已用于其他操作")
      ledger.publish("workspace", checkpointId, reason, existing.summary.sha256)
      return existing.summary
    }
    if (ledger.get("workspace", checkpointId)?.state === "published")
      throw new Error("恢复点文件已丢失，未重新生成；请发起新的保存操作")
    if ((await listBotWorkspaceCheckpoints(directory)).length >= BOT_WORKSPACE_CHECKPOINT_LIMIT)
      throw new Error("已保留 20 份工作文件恢复点，请先删除不再需要的恢复点")
    const workspace = await BotSharedWorkspace.open(directory)
    await privateDirectory(catalog(directory))
    const pending = join(catalog(directory), `.pending-${checkpointId}`)
    ledger.reserve("workspace", checkpointId, reason)
    let published = false
    await rm(pending, { recursive: true, force: true })
    await privateDirectory(pending)
    try {
      const entries = await captureBotDirectory(workspace.path, join(pending, "files"), () =>
        workspace.assertCurrent()
      )
      const manifest = manifestSchema.parse({
        format: 1,
        id: checkpointId,
        createdAt: Date.now(),
        reason,
        platform: process.platform,
        workspaceId: workspace.reference.id,
        entries
      })
      await writePrivateJson(join(pending, "manifest.json"), manifest)
      await rename(pending, destination)
      published = true
      await syncDirectory(catalog(directory))
      const saved = (await readCheckpoint(directory, checkpointId)).summary
      ledger.publish("workspace", checkpointId, reason, saved.sha256)
      return saved
    } finally {
      await rm(pending, { recursive: true, force: true })
      if (!published) ledger.releaseReservation("workspace", checkpointId)
    }
  } finally {
    ledger.close()
  }
}

async function assertDirectoryIdentity(
  path: string,
  reference: BotSharedWorkspaceReference
): Promise<void> {
  const info = await lstat(path, { bigint: true })
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    String(info.dev) !== reference.identity.dev ||
    String(info.ino) !== reference.identity.ino
  )
    throw new Error("工作文件恢复目录已被替换，已停止操作")
}
async function recordReplacement(directory: string, journal: Journal): Promise<void> {
  await assertDatabase(directory)
  const path = join(directory, "bots.sqlite")
  if (!(await present(path))) return
  const db = new DatabaseSync(path)
  try {
    db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE")
    db.prepare(
      `INSERT INTO bot_events(kind,entity_id,payload,created_at)
      SELECT 'workspace.files_replaced',?,?,? WHERE NOT EXISTS(SELECT 1 FROM bot_events WHERE kind='workspace.files_replaced' AND entity_id=?)`
    ).run(
      journal.request.nonce,
      JSON.stringify({
        action: journal.request.action,
        workspaceId: journal.original.id,
        message: "共享工作文件已恢复或重置；任务及外部操作记录没有回退，请核对后继续工作。"
      }),
      Date.now(),
      journal.request.nonce
    )
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

async function assertDatabase(directory: string): Promise<void> {
  for (const name of ["bots.sqlite", "bots.sqlite-wal", "bots.sqlite-shm"]) {
    const path = join(directory, name)
    if (!(await present(path))) continue
    const info = await lstat(path)
    if (!info.isFile() || info.nlink !== 1 || (await realpath(path)) !== path)
      throw new Error("Bot 数据库不能是链接或特殊文件")
  }
}

async function cleanupUnpublished(directory: string): Promise<void> {
  const container = `${directory}.workspace`
  if (await present(container)) {
    if ((await realpath(container)) !== container) throw new Error("共享工作目录位置已变化")
    for (const entry of await readdir(container, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !entry.name.startsWith(".restore-") ||
        !id.safeParse(entry.name.slice(9)).success
      )
        continue
      const path = join(container, entry.name)
      const names = await readdir(path)
      // Never remove a displaced original, even when the journal was removed
      // externally. Unpublished staging can contain only the newly copied tree.
      if (names.every((name) => name === "next")) await rm(path, { recursive: true, force: true })
    }
  }
  if (await present(catalog(directory))) {
    if ((await realpath(catalog(directory))) !== catalog(directory))
      throw new Error("恢复点目录位置已变化")
    for (const entry of await readdir(catalog(directory), { withFileTypes: true }))
      if (
        entry.isDirectory() &&
        entry.name.startsWith(".pending-") &&
        id.safeParse(entry.name.slice(9)).success
      )
        await rm(join(catalog(directory), entry.name), { recursive: true, force: true })
  }
}

async function cleanupDeletedCheckpoints(directory: string): Promise<void> {
  if (!(await present(catalog(directory)))) return
  const ledger = BotMaintenanceReceipts.readOnly(directory)
  if (!ledger) return
  try {
    for (const entry of await readdir(catalog(directory), { withFileTypes: true })) {
      if (
        !id.safeParse(entry.name).success ||
        ledger.get("workspace", entry.name)?.state !== "deleted"
      )
        continue
      const path = join(catalog(directory), entry.name)
      if (!entry.isDirectory() || (await realpath(path)) !== path)
        throw new Error("已删除的恢复点目录无效")
      await rm(path, { recursive: true })
      await syncDirectory(catalog(directory))
    }
  } finally {
    ledger.close()
  }
}

/** Offline owner only. Complete the durable rename journal before any Bot can
 * open the new working directory. Displaced files remain available for recovery. */
export async function recoverBotWorkspaceMaintenance(
  directory: string,
  afterStep?: (step: string) => void
): Promise<void> {
  directory = await realpath(directory)
  await cleanupDeletedCheckpoints(directory)
  const root = stateRoot(directory),
    journalPath = join(root, "pending.json")
  if (!(await present(journalPath))) {
    await cleanupUnpublished(directory)
    return
  }
  const journalRecord = await readPrivateJson(root, "pending.json", 32 * 1024),
    journal = journalSchema.parse(journalRecord.value)
  const ledger = new BotMaintenanceReceipts(directory)
  try {
    ledger.reserveOperation(
      "workspace",
      journal.request.nonce,
      journal.request.action,
      BotMaintenanceReceipts.requestHash(journal.request),
      resultOf(journal)
    )
    ledger.sealOperation("workspace", journal.request.nonce, journalRecord.sha256)
    const legacyRoot = join(root, "receipts"),
      legacyName = `${journal.request.nonce}.json`
    if (await present(join(legacyRoot, legacyName))) {
      const legacy = botWorkspaceMaintenanceReceipt.parse(
        (await readPrivateJson(legacyRoot, legacyName, 32 * 1024)).value
      )
      if (
        canonicalJson(legacy.request) !== canonicalJson(journal.request) ||
        canonicalJson(legacy.result) !== canonicalJson(resultOf(journal))
      )
        throw new Error("操作标识已有不同收据，请重新核对")
      ledger.completeOperation("workspace", journal.request.nonce, journalRecord.sha256)
    }
    const workspace = await BotSharedWorkspace.reference(directory)
    if (
      ![journal.original, journal.replacement].some(
        (reference) => canonicalJson(reference) === canonicalJson(workspace.reference)
      )
    )
      throw new Error("恢复日志不属于当前共享工作目录")
    await assertDatabase(directory)
    const container = dirname(workspace.path)
    if ((await realpath(container)) !== container) throw new Error("共享工作目录位置已变化")
    const retained = join(container, `recovery-${journal.request.nonce}`),
      originalStage = join(container, `.restore-${journal.stage}`)
    const stage = (await present(originalStage)) ? originalStage : retained
    if (!(await lstat(stage)).isDirectory() || (await realpath(stage)) !== stage)
      throw new Error("工作文件恢复暂存目录缺失或无效")
    if (ledger.getOperation("workspace", journal.request.nonce)?.state === "completed") {
      if (journal.hadOriginal && stage !== retained) {
        if (await present(retained)) throw new Error("旧工作目录的保留位置已被占用")
        await rename(stage, retained)
        await syncDirectory(container)
      }
      await unlink(journalPath)
      await syncDirectory(root)
      if (!journal.hadOriginal) await rm(stage, { recursive: true, force: true })
      return
    }
    const old = join(stage, "old"),
      next = join(stage, "next"),
      current = workspace.path
    const pending = await present(next)
    await assertDirectoryIdentity(pending ? next : current, journal.replacement)
    const source =
      journal.request.action === "restore"
        ? await readCheckpoint(
            directory,
            journal.request.checkpoint.id,
            journal.request.checkpoint.sha256
          )
        : null
    if (
      source &&
      (source.manifest.workspaceId !== journal.original.id ||
        source.manifest.platform !== process.platform)
    )
      throw new Error("此恢复点不属于当前系统的共享工作目录")
    await verifyBotDirectory(pending ? next : current, source?.manifest.entries ?? [])
    if (journal.hadOriginal && !(await present(old))) {
      await assertDirectoryIdentity(current, journal.original)
      await rename(current, old)
      await syncDirectory(container)
      await syncDirectory(stage)
      afterStep?.("old")
    }
    if (journal.hadOriginal) await assertDirectoryIdentity(old, journal.original)
    if (pending) {
      if (await present(current)) throw new Error("恢复目标被占用，未替换该目录")
      await rename(next, current)
      await syncDirectory(container)
      await syncDirectory(stage)
      afterStep?.("next")
    }
    await BotSharedWorkspace.finishReplacement(directory, journal.original, journal.replacement)
    afterStep?.("identity")
    await recordReplacement(directory, journal)
    afterStep?.("database")
    await saveReceipt(directory, journal.request, resultOf(journal), journalRecord.sha256)
    afterStep?.("receipt")
    if (journal.hadOriginal && stage !== retained) {
      if (await present(retained)) throw new Error("旧工作目录的保留位置已被占用")
      await rename(stage, retained)
      await syncDirectory(container)
    }
    afterStep?.("retained")
    await unlink(journalPath)
    await syncDirectory(root)
    if (!journal.hadOriginal) await rm(stage, { recursive: true, force: true })
  } finally {
    ledger.close()
  }
}

async function replaceWorkspace(
  directory: string,
  request: Replacement,
  afterStep?: (step: string) => void
): Promise<BotWorkspaceMaintenanceResult> {
  await assertDatabase(directory)
  const ledger = new BotMaintenanceReceipts(directory)
  try {
    const previous = ledger.getOperation("workspace", request.nonce)
    if (previous?.state === "reserved") ledger.releaseOperation("workspace", request.nonce)
    if (request.action === "restore")
      ledger.assertActive("workspace", request.checkpoint.id, request.checkpoint.sha256)
    const workspace = await BotSharedWorkspace.reference(directory),
      container = dirname(workspace.path)
    await privateDirectory(container)
    const hadOriginal = await present(workspace.path)
    if (hadOriginal) await assertDirectoryIdentity(workspace.path, workspace.reference)
    const source =
      request.action === "restore"
        ? await readCheckpoint(directory, request.checkpoint.id, request.checkpoint.sha256)
        : null
    if (
      source &&
      (source.manifest.workspaceId !== workspace.reference.id ||
        source.manifest.platform !== process.platform)
    )
      throw new Error("此恢复点不属于当前系统的共享工作目录")
    const stageId = randomUUID(),
      stage = join(container, `.restore-${stageId}`),
      next = join(stage, "next")
    await privateDirectory(stage)
    let published = false
    try {
      if (source)
        await restoreBotDirectory(join(source.root, "files"), next, source.manifest.entries)
      else {
        await mkdir(next, { mode: 0o700 })
        await syncDirectory(stage)
      }
      const info = await lstat(next, { bigint: true })
      const safetyCheckpoint = hadOriginal
        ? await createCheckpoint(
            directory,
            randomUUID(),
            request.action === "reset" ? "before-reset" : "before-restore"
          )
        : undefined
      const journal = journalSchema.parse({
        format: 1,
        request,
        stage: stageId,
        original: workspace.reference,
        replacement: {
          id: workspace.reference.id,
          identity: { dev: String(info.dev), ino: String(info.ino) }
        },
        hadOriginal,
        ...(safetyCheckpoint ? { safetyCheckpoint } : {})
      })
      ledger.reserveOperation(
        "workspace",
        request.nonce,
        request.action,
        BotMaintenanceReceipts.requestHash(request),
        resultOf(journal)
      )
      const path = join(stateRoot(directory), "pending.json")
      await rm(path + ".pending", { force: true })
      await writePrivateJson(path, journal)
      published = true
      afterStep?.("journal")
      await recoverBotWorkspaceMaintenance(directory, afterStep)
      return resultOf(journal)
    } finally {
      // writePrivateJson may have renamed the durable journal before a directory
      // fsync error. Retain its stage/reservation for recovery in that case.
      if (!published && (await present(join(stateRoot(directory), "pending.json"))))
        published = true
      if (!published) {
        await rm(stage, { recursive: true, force: true })
        ledger.releaseOperation("workspace", request.nonce)
      }
    }
  } finally {
    ledger.close()
  }
}

/** Maintenance never accepts a project path: it operates only on this Host's
 * managed default. User-selected repositories and task/effect records stay intact. */
export async function executeBotWorkspaceMaintenance(
  directory: string,
  raw: unknown,
  afterStep?: (step: string) => void
): Promise<BotWorkspaceMaintenanceResult> {
  const request = botWorkspaceMaintenanceRequest.parse(raw)
  directory = await realpath(directory)
  const lock = BotHostLock.acquire(directory)
  if (!lock) throw new Error("Bot 后台仍在运行，请先完成任务再维护工作文件")
  try {
    await assertBotOwnedShellMaintenance(directory, ownedShellMaintenanceOwner(lock))
    if (
      (await present(join(directory, "restore.json"))) ||
      (await present(join(directory, "browser-maintenance", "pending.json")))
    )
      throw new Error("其他恢复尚未完成，请先启动后台完成恢复")
    await recoverBotWorkspaceMaintenance(directory)
    await migrateBotMaintenanceJsonReceipts(directory, () => lock.assertCurrent())
    const prior = await readReceipt(directory, request)
    if (prior) return prior
    await privateDirectory(stateRoot(directory))
    if (request.action === "create") {
      const result = {
        action: "create",
        checkpoint: await createCheckpoint(directory, request.nonce, "manual")
      } as const
      await saveReceipt(directory, request, result)
      return result
    }
    if (request.action === "restore" || request.action === "reset") {
      if (await present(join(catalog(directory), request.nonce)))
        throw new Error("操作标识已用于保存恢复点")
      return await replaceWorkspace(directory, request, afterStep)
    }
    const path = join(catalog(directory), request.checkpoint.id),
      ledger = new BotMaintenanceReceipts(directory)
    try {
      const previous = ledger.get("workspace", request.checkpoint.id)
      if (previous?.state === "deleted") {
        if (previous.sha256 !== request.checkpoint.sha256)
          throw new Error("恢复点已变化，请刷新后重新选择")
      } else {
        const checkpoint = (await present(path))
          ? await readCheckpoint(directory, request.checkpoint.id, request.checkpoint.sha256)
          : null
        ledger.retire(
          "workspace",
          request.checkpoint.id,
          request.checkpoint.sha256,
          checkpoint?.manifest.reason
        )
      }
      lock.assertCurrent()
      await rm(path, { recursive: true, force: true })
      if (await present(catalog(directory))) await syncDirectory(catalog(directory))
      return { action: "delete" }
    } finally {
      ledger.close()
    }
  } finally {
    lock.release()
  }
}
