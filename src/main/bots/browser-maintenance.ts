import {
  assertBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, opendir, readdir, realpath, rename, rm, unlink } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import {
  BOT_BROWSER_CHECKPOINT_LIMIT,
  botBrowserCheckpointSchema,
  botBrowserMaintenanceRequest,
  botBrowserMaintenanceResult,
  type BotBrowserCheckpoint,
  type BotBrowserMaintenanceRequest,
  type BotBrowserMaintenanceResult
} from "../../shared/bot-browser-maintenance"
import {
  copyBackupFile,
  hashBackupFile,
  present,
  privateDirectory,
  readPrivateJson,
  syncDirectory,
  writePrivateJson
} from "./backup-io"
import { BotHostLock } from "./host-lock"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { migrateBotMaintenanceJsonReceipts } from "./maintenance-receipts-migration"
import { canonicalJson } from "./validation"
import {
  botBrowserMaintenanceReceipt,
  botBrowserMaintenanceJournal as journalSchema,
  browserMaintenanceJournalResult as resultOf,
  type BotBrowserMaintenanceJournal as Journal
} from "./maintenance-receipt-contract"

const MAX_BYTES = 2 * 1024 ** 3
const MAX_FILES = 50_000
const id = z.string().uuid()
const safePath = z
  .string()
  .max(4096)
  .refine((value) => {
    const parts = value.split("/")
    return (
      parts[0] === "profile" &&
      parts.length > 1 &&
      parts.every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          !/[\\:]/.test(part) &&
          !Array.from(part).some((character) => character.charCodeAt(0) < 32) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
    )
  })
const fileSchema = z
  .object({
    path: safePath,
    size: z.number().int().nonnegative().max(MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
const legacyManifestSchema = botBrowserCheckpointSchema
  .omit({ sha256: true, files: true, bytes: true })
  .extend({
    format: z.literal(1),
    entries: z.array(fileSchema).max(MAX_FILES)
  })
  .strict()
const manifestSchema = z.discriminatedUnion("format", [
  legacyManifestSchema,
  legacyManifestSchema.extend({ format: z.literal(2), originId: id }).strict()
])
type Manifest = z.infer<typeof manifestSchema>
type OwnershipGuard = () => void | Promise<void>
type StepHook = (step: string) => void | Promise<void>
const noGuard: OwnershipGuard = () => {}
const originSchema = z.object({ format: z.literal(1), id }).strict()
const transient = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "DevToolsActivePort"
])
type Replacement = Extract<BotBrowserMaintenanceRequest, { action: "reset" | "restore" }>
const stateRoot = (directory: string) => join(directory, "browser-maintenance")
const catalog = (directory: string) => join(stateRoot(directory), "checkpoints")
const channel = () => (process.platform === "win32" ? "msedge" : "chrome")

/** Independent of the replaced Chromium profile and the data restore epoch. */
export async function browserCheckpointOrigin(
  directory: string,
  guard: OwnershipGuard,
  create = true
): Promise<string> {
  const root = stateRoot(directory)
  await guard()
  await privateDirectory(root)
  if (!(await present(join(root, "origin.json")))) {
    if (!create) throw new Error("工作浏览器归属记录缺失，已停止恢复；请保留恢复点和当前浏览器数据")
    await guard()
    await rm(join(root, "origin.json.pending"), { force: true })
    await guard()
    await writePrivateJson(join(root, "origin.json"), { format: 1, id: randomUUID() })
  }
  return originSchema.parse((await readPrivateJson(root, "origin.json", 1024)).value).id
}

async function assertOrigin(directory: string, manifest: Manifest, guard: OwnershipGuard) {
  if (
    manifest.platform !== process.platform ||
    manifest.browser !== channel() ||
    (manifest.format === 2 &&
      manifest.originId !== (await browserCheckpointOrigin(directory, guard, false)))
  )
    throw new Error("此恢复点不属于当前后台的工作浏览器；登录状态只支持原电脑恢复")
}

async function checkDatabasePath(directory: string): Promise<void> {
  const path = join(directory, "bots.sqlite")
  if (await present(path)) {
    const info = await lstat(path)
    if (!info.isFile() || info.nlink !== 1 || (await realpath(path)) !== path)
      throw new Error("Bot 数据库不能是链接或其他特殊文件")
  }
}

function summary(manifest: Manifest, sha256: string): BotBrowserCheckpoint {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    reason: manifest.reason,
    platform: manifest.platform,
    browser: manifest.browser,
    sha256,
    files: manifest.entries.length,
    bytes: manifest.entries.reduce((sum, file) => sum + file.size, 0)
  }
}

async function readCheckpoint(directory: string, checkpointId: string, hash?: string) {
  id.parse(checkpointId)
  const root = join(catalog(directory), checkpointId)
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
    throw new Error("浏览器恢复点目录无效")
  const file = await readPrivateJson(root, "manifest.json")
  const manifest = manifestSchema.parse(file.value)
  if (manifest.id !== checkpointId || (hash && hash !== file.sha256))
    throw new Error("浏览器恢复点已变化，请刷新后重新选择")
  if (
    new Set(
      manifest.entries.map((entry) =>
        manifest.platform === "win32" ? entry.path.toLowerCase() : entry.path
      )
    ).size !== manifest.entries.length ||
    manifest.entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_BYTES
  )
    throw new Error("浏览器恢复点清单无效")
  return { root, manifest, summary: summary(manifest, file.sha256) }
}

export async function listBotBrowserCheckpoints(
  directory: string
): Promise<BotBrowserCheckpoint[]> {
  if (!(await present(directory))) return []
  directory = await realpath(directory)
  if (!(await present(catalog(directory)))) return []
  const result: BotBrowserCheckpoint[] = []
  const receipts = BotMaintenanceReceipts.readOnly(directory)
  try {
    for (const entry of await readdir(catalog(directory), { withFileTypes: true })) {
      if (!entry.isDirectory() || !id.safeParse(entry.name).success) continue
      if (receipts?.get("browser", entry.name)?.state === "deleted") continue
      const checkpoint = await readCheckpoint(directory, entry.name)
      receipts?.assertActive("browser", entry.name, checkpoint.summary.sha256)
      result.push(checkpoint.summary)
    }
  } finally {
    receipts?.close()
  }
  return result.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

async function createCheckpoint(
  directory: string,
  checkpointId: string,
  reason: Manifest["reason"],
  receipts: BotMaintenanceReceipts,
  guard: OwnershipGuard,
  afterStep?: StepHook
) {
  await guard()
  const originId = await browserCheckpointOrigin(directory, guard)
  receipts.assertActive("browser", checkpointId)
  await privateDirectory(catalog(directory))
  const destination = join(catalog(directory), checkpointId)
  if (await present(destination)) {
    const existing = await readCheckpoint(directory, checkpointId)
    if (existing.manifest.reason !== reason) throw new Error("恢复点标识已用于其他操作")
    await assertOrigin(directory, existing.manifest, guard)
    await guard()
    receipts.publish("browser", checkpointId, reason, existing.summary.sha256)
    return existing.summary
  }
  if (receipts.get("browser", checkpointId)?.state === "published")
    throw new Error("恢复点文件已丢失，未重新生成；请发起新的保存操作")
  if ((await listBotBrowserCheckpoints(directory)).length >= BOT_BROWSER_CHECKPOINT_LIMIT)
    throw new Error(
      `已保留 ${BOT_BROWSER_CHECKPOINT_LIMIT} 份浏览器恢复点，请先删除不再需要的恢复点`
    )
  const profile = join(directory, "browser-profile")
  if (!(await present(profile))) throw new Error("工作浏览器尚未建立，没有可保存的状态")
  const sourceIdentity = await lstat(profile, { bigint: true })
  if (!sourceIdentity.isDirectory() || (await realpath(profile)) !== profile)
    throw new Error("工作浏览器目录不能是符号链接")
  const pending = join(catalog(directory), `.pending-${checkpointId}`)
  await guard()
  receipts.reserve("browser", checkpointId, reason)
  let published = false
  await rm(pending, { recursive: true, force: true })
  await privateDirectory(join(pending, "profile"))
  const entries: Manifest["entries"] = [],
    directories = new Set<string>()
  let total = 0,
    visited = 0
  const copy = async (relative: string): Promise<void> => {
    if (++visited > MAX_FILES) throw new Error("浏览器恢复点超过文件数量上限")
    const path = relative ? join(profile, relative) : profile
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error("工作浏览器中存在不支持的符号链接，未创建恢复点")
    if (info.isDirectory()) {
      directories.add(relative)
      const handle = await opendir(path)
      for await (const entry of handle) {
        // Chromium owns these transient socket/lock links, never restore them.
        if (!relative && transient.has(entry.name)) continue
        const child = relative ? relative + "/" + entry.name : entry.name
        safePath.parse("profile/" + child)
        await copy(child)
      }
    } else if (info.isFile()) {
      if (total + info.size > MAX_BYTES) throw new Error("浏览器恢复点超过 2 GiB 上限")
      // Reuse the stable-handle byte hashing and fsync path from Bot data backups.
      const entry = await copyBackupFile(
        profile,
        relative,
        join(pending, "profile"),
        undefined,
        MAX_BYTES - total
      )
      entries.push({ ...entry, path: "profile/" + entry.path })
      total += entry.size
    } else throw new Error("工作浏览器中存在不支持的文件类型")
  }
  try {
    await copy("")
    await afterStep?.("copied")
    try {
      await verifyProfile(profile, entries, directories)
      const current = await lstat(profile, { bigint: true })
      if (current.dev !== sourceIdentity.dev || current.ino !== sourceIdentity.ino)
        throw new Error("source replaced")
    } catch {
      throw new Error("工作浏览器在保存期间发生变化，未创建恢复点，请关闭浏览器后重试")
    }
    const manifest = manifestSchema.parse({
      format: 2,
      originId,
      id: checkpointId,
      createdAt: Date.now(),
      reason,
      platform: process.platform,
      browser: channel(),
      entries
    })
    await assertOrigin(directory, manifest, guard)
    await guard()
    await writePrivateJson(join(pending, "manifest.json"), manifest)
    await guard()
    await rename(pending, destination)
    published = true
    await syncDirectory(catalog(directory))
    const saved = (await readCheckpoint(directory, checkpointId)).summary
    await guard()
    receipts.publish("browser", checkpointId, reason, saved.sha256)
    return saved
  } finally {
    await guard()
    await rm(pending, { recursive: true, force: true })
    if (!published) receipts.releaseReservation("browser", checkpointId)
  }
}

async function cleanupDeletedCheckpoints(directory: string, guard: OwnershipGuard): Promise<void> {
  await guard()
  const receipts = BotMaintenanceReceipts.readOnly(directory)
  if (!receipts) return
  try {
    if (!(await present(catalog(directory)))) return
    for (const entry of await readdir(catalog(directory), { withFileTypes: true })) {
      if (!entry.isDirectory() || !id.safeParse(entry.name).success) continue
      const receipt = receipts.get("browser", entry.name)
      if (receipt?.state !== "deleted") continue
      const path = join(catalog(directory), entry.name)
      if ((await realpath(path)) !== path) throw new Error("浏览器恢复点目录无效")
      await guard()
      await rm(path, { recursive: true })
      await syncDirectory(catalog(directory))
    }
  } finally {
    receipts.close()
  }
}

/** One stable streaming verifier for source capture and crash-resumed replacement.
 * Capture also seals the directory topology; Chromium's transient root locks are excluded. */
async function verifyProfile(
  profile: string,
  entries: Manifest["entries"],
  sourceDirectories?: Set<string>
): Promise<void> {
  if (!(await lstat(profile)).isDirectory() || (await realpath(profile)) !== profile)
    throw new Error("浏览器恢复目录无效")
  const expected = new Map(entries.map((entry) => [entry.path.slice("profile/".length), entry]))
  const directories = new Set<string>()
  let visited = 0
  const visit = async (relative: string): Promise<void> => {
    if (++visited > MAX_FILES) throw new Error("浏览器暂存文件过多")
    const path = relative ? join(profile, relative) : profile,
      info = await lstat(path)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      directories.add(relative)
      const handle = await opendir(path)
      for await (const child of handle) {
        if (sourceDirectories && !relative && transient.has(child.name)) continue
        const childPath = relative ? relative + "/" + child.name : child.name
        safePath.parse("profile/" + childPath)
        await visit(childPath)
      }
      return
    }
    const item = expected.get(relative)
    if (!info.isFile() || info.nlink !== 1 || !item)
      throw new Error("浏览器恢复文件不在清单中或被替换为链接")
    if (info.size !== item.size) throw new Error("浏览器恢复文件大小不匹配")
    await hashBackupFile(profile, relative, item)
    expected.delete(relative)
  }
  await visit("")
  if (expected.size) throw new Error("浏览器恢复文件缺失")
  if (
    sourceDirectories &&
    (directories.size !== sourceDirectories.size ||
      [...directories].some((path) => !sourceDirectories.has(path)))
  )
    throw new Error("浏览器目录已变化")
}

async function verifyReplacement(
  directory: string,
  profile: string,
  request: Replacement,
  guard: OwnershipGuard
): Promise<void> {
  const checkpoint =
    request.action === "restore"
      ? await readCheckpoint(directory, request.checkpoint.id, request.checkpoint.sha256)
      : null
  if (checkpoint) await assertOrigin(directory, checkpoint.manifest, guard)
  await verifyProfile(profile, checkpoint?.manifest.entries ?? [])
}

/** Call only while holding the Host lifetime lock, before opening any runtime.
 * Roll forward an interrupted profile replacement; never roll back task/effect records. */
export async function recoverBotBrowserMaintenance(
  directory: string,
  afterStep?: StepHook,
  guard: OwnershipGuard = noGuard
): Promise<void> {
  await guard()
  directory = await realpath(directory)
  await cleanupDeletedCheckpoints(directory, guard)
  const root = stateRoot(directory),
    journalPath = join(root, "pending.json")
  if (!(await present(journalPath))) return
  await checkDatabasePath(directory)
  const journalRecord = await readPrivateJson(root, "pending.json", 16 * 1024),
    journal = journalSchema.parse(journalRecord.value),
    ledger = new BotMaintenanceReceipts(directory)
  try {
    const result = resultOf(journal)
    ledger.reserveOperation(
      "browser",
      journal.request.nonce,
      journal.request.action,
      BotMaintenanceReceipts.requestHash(journal.request),
      result
    )
    ledger.sealOperation("browser", journal.request.nonce, journalRecord.sha256)
    const legacyPath = join(root, "receipts", `${journal.request.nonce}.json`)
    if (await present(legacyPath)) {
      const legacy = botBrowserMaintenanceReceipt.parse(
        (await readPrivateJson(join(root, "receipts"), `${journal.request.nonce}.json`, 32 * 1024))
          .value
      )
      if (
        canonicalJson(legacy.request) !== canonicalJson(journal.request) ||
        canonicalJson(legacy.result) !== canonicalJson(result)
      )
        throw new Error("操作标识已有不同收据，请重新核对")
      ledger.completeOperation("browser", journal.request.nonce, journalRecord.sha256)
    }
    if (ledger.getOperation("browser", journal.request.nonce)?.state === "completed") {
      const stage = join(root, `.replace-${journal.stage}`)
      if (await present(stage)) {
        if (!(await lstat(stage)).isDirectory() || (await realpath(stage)) !== stage)
          throw new Error("浏览器恢复暂存目录无效")
        await guard()
        await rm(stage, { recursive: true })
      }
      await guard()
      await unlink(journalPath)
      await syncDirectory(root)
      return
    }
    const stage = join(root, `.replace-${journal.stage}`)
    const current = join(directory, "browser-profile"),
      old = join(stage, "old"),
      next = join(stage, "next")
    // Do not recreate a missing stage: that would conceal lost recovery files.
    if (!(await lstat(stage)).isDirectory() || (await realpath(stage)) !== stage)
      throw new Error("浏览器恢复暂存目录缺失或无效")
    await verifyReplacement(
      directory,
      (await present(next)) ? next : current,
      journal.request,
      guard
    )
    if (journal.hadOriginal && !(await present(old))) {
      if (!(await present(current))) throw new Error("浏览器恢复前的目录缺失，已停止启动")
      await guard()
      await rename(current, old)
      await syncDirectory(directory)
      await syncDirectory(stage)
      await afterStep?.("old")
    }
    if (await present(next)) {
      if (await present(current)) throw new Error("浏览器恢复目标被占用，已停止启动")
      await guard()
      await rename(next, current)
      await syncDirectory(directory)
      await syncDirectory(stage)
      await afterStep?.("next")
    }
    if (!(await lstat(current)).isDirectory() || (await realpath(current)) !== current)
      throw new Error("浏览器恢复目录无效")
    await verifyReplacement(directory, current, journal.request, guard)
    await guard()
    if (await present(join(directory, "bots.sqlite"))) {
      const db = new DatabaseSync(join(directory, "bots.sqlite"))
      try {
        db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE")
        db.exec("DELETE FROM bot_browser_sessions")
        db.prepare(
          `INSERT INTO bot_events(kind,entity_id,payload,created_at)
        SELECT 'computer.replaced',?,?,? WHERE NOT EXISTS(
          SELECT 1 FROM bot_events WHERE kind='computer.replaced' AND entity_id=?)`
        ).run(
          journal.request.nonce,
          JSON.stringify({
            action: journal.request.action,
            message: "工作浏览器已更换；页面需重新打开，历史任务和外部操作记录保持原状。"
          }),
          Date.now(),
          journal.request.nonce
        )
        db.exec("COMMIT")
      } finally {
        db.close()
      }
    }
    await afterStep?.("database")
    await guard()
    ledger.completeOperation("browser", journal.request.nonce, journalRecord.sha256)
    await afterStep?.("receipt")
    // Remove the journal only after the receipt and complete replacement are durable.
    await guard()
    await unlink(journalPath)
    await syncDirectory(root)
    await guard()
    await rm(stage, { recursive: true, force: true })
  } finally {
    ledger.close()
  }
}

async function replaceProfile(
  directory: string,
  request: Replacement,
  receiptsLedger: BotMaintenanceReceipts,
  afterStep?: StepHook,
  guard: OwnershipGuard = noGuard
) {
  await guard()
  await checkDatabasePath(directory)
  const root = stateRoot(directory)
  const prior = receiptsLedger.getOperation("browser", request.nonce)
  if (prior) {
    if (
      prior.action !== request.action ||
      prior.requestSha256 !== BotMaintenanceReceipts.requestHash(request)
    )
      throw new Error("操作标识已用于其他浏览器操作")
    if (prior.state === "completed") return botBrowserMaintenanceResult.parse(prior.result)
    if (prior.state !== "reserved") throw new Error("浏览器恢复日志缺失，已停止重复执行")
    receiptsLedger.releaseOperation("browser", request.nonce)
  }
  if (
    receiptsLedger.get("browser", request.nonce) ||
    (await present(join(catalog(directory), request.nonce)))
  )
    throw new Error("操作标识已用于创建恢复点")
  if (request.action === "restore")
    receiptsLedger.assertActive("browser", request.checkpoint.id, request.checkpoint.sha256)
  const source =
    request.action === "restore"
      ? await readCheckpoint(directory, request.checkpoint.id, request.checkpoint.sha256)
      : null
  if (source) await assertOrigin(directory, source.manifest, guard)
  const stageId = randomUUID(),
    stage = join(root, `.replace-${stageId}`)
  await privateDirectory(join(stage, "next"))
  let published = false
  try {
    if (source)
      for (const file of source.manifest.entries) {
        // The sealed manifest is the only source of restore paths and digests.
        await copyBackupFile(source.root, file.path, join(stage, "copy"), file)
      }
    if (source && source.manifest.entries.length) {
      await guard()
      await rm(join(stage, "next"), { recursive: true })
      await guard()
      await rename(join(stage, "copy", "profile"), join(stage, "next"))
      await syncDirectory(join(stage, "copy"))
      await syncDirectory(stage)
    }
    const hadOriginal = await present(join(directory, "browser-profile"))
    // Refuse destructive replacement if a safety checkpoint cannot be saved.
    const safetyCheckpoint = hadOriginal
      ? await createCheckpoint(
          directory,
          randomUUID(),
          request.action === "reset" ? "before-reset" : "before-restore",
          receiptsLedger,
          guard
        )
      : undefined
    const journal: Journal = {
      format: 1,
      request,
      stage: stageId,
      hadOriginal,
      ...(safetyCheckpoint ? { safetyCheckpoint } : {})
    }
    await guard()
    receiptsLedger.reserveOperation(
      "browser",
      request.nonce,
      request.action,
      BotMaintenanceReceipts.requestHash(request),
      resultOf(journal)
    )
    await rm(join(root, "pending.json.pending"), { force: true })
    await guard()
    await writePrivateJson(join(root, "pending.json"), journal)
    published = true
    await afterStep?.("journal")
    await recoverBotBrowserMaintenance(directory, afterStep, guard)
    return resultOf(journal)
  } finally {
    // Publication can precede a directory fsync error; its pending journal
    // still owns these bytes and the operation reservation.
    if (!published && (await present(join(root, "pending.json")))) published = true
    if (!published) {
      await guard()
      await rm(stage, { recursive: true, force: true })
      receiptsLedger.releaseOperation("browser", request.nonce)
    }
  }
}

/** No Electron dependency, so the same owner can be run by a future Linux worker. */
export async function executeBotBrowserMaintenance(
  directory: string,
  untrusted: unknown,
  afterStep?: StepHook
): Promise<BotBrowserMaintenanceResult> {
  const request = botBrowserMaintenanceRequest.parse(untrusted)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  directory = await realpath(directory)
  const lock = BotHostLock.acquire(directory)
  if (!lock) throw new Error("Bot 后台仍在运行，请先完成任务并归还浏览器控制权")
  const guard = () => lock.assertCurrent()
  try {
    await assertBotOwnedShellMaintenance(directory, ownedShellMaintenanceOwner(lock))
    guard()
    if (await present(join(directory, "restore.json")))
      throw new Error("Bot 数据恢复尚未完成，请先启动后台完成恢复")
    if (await present(join(directory, "workspace-maintenance", "pending.json")))
      throw new Error("工作文件恢复尚未完成，请先启动后台完成恢复")
    await recoverBotBrowserMaintenance(directory, undefined, guard)
    await migrateBotMaintenanceJsonReceipts(directory, guard)
    if (await present(join(directory, "browser-profile", "SingletonLock")))
      throw new Error("工作浏览器仍有进程锁；请确认浏览器已退出，异常退出后可先重新打开再关闭后台")
    await privateDirectory(stateRoot(directory))
    // A crash before publication cannot change the current profile. Clean only owned staging.
    for (const name of await readdir(stateRoot(directory)))
      if (/^\.replace-[a-f0-9-]{36}$/.test(name)) {
        guard()
        await rm(join(stateRoot(directory), name), { recursive: true, force: true })
      }
    const receipts = new BotMaintenanceReceipts(directory)
    try {
      if (request.action === "create") {
        if (receipts.getOperation("browser", request.nonce))
          throw new Error("操作标识已用于其他浏览器操作")
        return {
          action: "create",
          checkpoint: await createCheckpoint(
            directory,
            request.nonce,
            "manual",
            receipts,
            guard,
            afterStep
          )
        }
      }
      if (request.action === "reset" || request.action === "restore")
        return await replaceProfile(directory, request, receipts, afterStep, guard)
      const path = join(catalog(directory), request.checkpoint.id)
      const existing = (await present(path))
        ? await readCheckpoint(directory, request.checkpoint.id, request.checkpoint.sha256)
        : undefined
      guard()
      receipts.retire(
        "browser",
        request.checkpoint.id,
        request.checkpoint.sha256,
        existing?.manifest.reason
      )
      if (existing) {
        await guard()
        await rm(path, { recursive: true })
        await syncDirectory(catalog(directory))
      }
      return { action: "delete" }
    } finally {
      receipts.close()
    }
  } finally {
    lock.release()
  }
}
