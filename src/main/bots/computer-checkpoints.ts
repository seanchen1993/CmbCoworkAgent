import { removeComputerRecoveryTree } from "./computer-checkpoint-cleanup"
import { cleanupComputerDeliveryRecords } from "./computer-checkpoint-managed"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, opendir, realpath, rename, rm, rmdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import {
  present,
  privateDirectory,
  readPrivateJson,
  syncDirectory,
  writePrivateJson
} from "./backup-io"
import {
  botComputerCheckpointRestoreResult,
  botComputerCheckpointRequest,
  botComputerCheckpointSummary,
  type BotComputerCheckpointRequest,
  type BotComputerCheckpointResult,
  type BotComputerCheckpointSummary
} from "../../shared/bot-computer-checkpoint"
import {
  COMPUTER_SLOT_ORDER,
  computerIdentity,
  computerJournal,
  computerManifest,
  validatePrepared,
  type ComputerJournal,
  type ComputerManifest,
  type ComputerPrepared,
  type ComputerSlot,
  type ComputerSlotName
} from "./computer-checkpoint-manifest"
import type { ComputerCheckpointProgress } from "./computer-checkpoint-progress"
import {
  ComputerBudget,
  type ComputerOwner,
  type ComputerPorts,
  type ComputerPreparationInput,
  type ComponentLocations
} from "./computer-checkpoint-ports"

const originSchema = z.object({ format: z.literal(1), id: z.string().uuid() }).strict()
const preparationSchema = z
  .object({
    format: z.literal(1),
    nonce: z.string().uuid(),
    originId: z.string().uuid(),
    owner: z.object({ root: computerIdentity, lock: computerIdentity }).strict(),
    host: computerIdentity,
    shared: computerIdentity
  })
  .strict()
const invalid = () =>
  new Error("电脑恢复准备或所有权校验失败，已停止启动；原始数据、恢复日志和暂存文件已保留")
const absent = { state: "absent" } as const
const physical = async (path: string, directory: boolean) => {
  const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return undefined
  if (
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n) ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== resolve(path)
  )
    throw invalid()
  return computerIdentity.parse({ dev: String(info.dev), ino: String(info.ino) })
}
const same = (a: { dev: string; ino: string }, b: { dev: string; ino: string }) =>
  a.dev === b.dev && a.ino === b.ino
const stateMatches = async (path: string, state: ComputerSlot["original"], directory: boolean) => {
  const found = await physical(path, directory)
  return state.state === "absent"
    ? found === undefined
    : found !== undefined && same(found, state.identity)
}
const slotIsDirectory = (name: ComputerSlotName) => !name.startsWith("database")
const fileNames: Partial<Record<ComputerSlotName, string>> = {
  database: "bots.sqlite",
  "database-wal": "bots.sqlite-wal",
  "database-shm": "bots.sqlite-shm",
  "database-journal": "bots.sqlite-journal",
  objects: "objects",
  teach: "teach",
  browser: "browser-profile"
}
function paths(
  input: ComputerPreparationInput,
  prepared: ComputerPrepared,
  name: ComputerSlotName
) {
  if (name !== "shared")
    return {
      original: join(input.directory, fileNames[name]!),
      target: join(input.directory, fileNames[name]!),
      next: join(input.hostStage, "next", fileNames[name]!),
      old: join(input.hostStage, "old", fileNames[name]!)
    }
  const originalId =
    prepared.originalShared.state === "established"
      ? prepared.originalShared.reference.id
      : prepared.sharedTargetId
  const targetId =
    prepared.replacementShared.state === "established"
      ? prepared.replacementShared.reference.id
      : originalId
  return {
    original: originalId ? join(`${input.directory}.workspace`, originalId) : undefined,
    target: targetId ? join(`${input.directory}.workspace`, targetId) : undefined,
    next: join(input.sharedStage, "next"),
    old: join(input.sharedStage, "old")
  }
}
function summary(
  value: ComputerManifest,
  sha256: string,
  managedGit: BotComputerCheckpointSummary["managedGit"]
) {
  return botComputerCheckpointSummary.parse({
    id: value.id,
    sha256,
    createdAt: value.createdAt,
    platform: value.platform,
    files: value.files,
    bytes: value.bytes,
    data: value.components.data.state,
    shared: value.components.shared.state,
    browser: value.components.browser.state,
    managedGit
  })
}

/** Called only after all Host writers have closed, under one physical Host
 * ownership lease. Startup calls recover before opening Store/Chromium or any
 * legacy component recovery. No public component maintenance method is called. */
export class BotComputerCheckpoints {
  private readonly root: string
  constructor(
    private readonly directory: string,
    private readonly owner: ComputerOwner,
    private readonly ports: ComputerPorts,
    private readonly signal: AbortSignal,
    private readonly progress?: ComputerCheckpointProgress,
    private readonly afterStep?: (step: string) => void | Promise<void>
  ) {
    this.root = join(directory, "computer-recovery")
  }
  private async guard() {
    this.signal.throwIfAborted()
    await this.owner.checkCurrent()
    this.owner.assertCurrent()
  }
  private async cleanupGuard() {
    await this.owner.checkCurrent()
    this.owner.assertCurrent()
  }
  private async origin(create = false) {
    await this.guard()
    await privateDirectory(this.root)
    if (!(await present(join(this.root, "origin.json")))) {
      if (!create) throw invalid()
      await writePrivateJson(join(this.root, "origin.json"), { format: 1, id: randomUUID() })
    }
    return originSchema.parse((await readPrivateJson(this.root, "origin.json", 4096)).value).id
  }
  private async point(id: string, expected?: string, verify = true) {
    const path = join(this.root, "points", z.string().uuid().parse(id))
    if (!(await physical(path, true))) throw new Error("电脑恢复点已丢失，请刷新列表")
    const record = await readPrivateJson(path, "manifest.json", 16 * 1024)
    const value = computerManifest.parse(record.value)
    if (
      value.id !== id ||
      value.originId !== (await this.origin()) ||
      value.platform !== process.platform ||
      (expected && record.sha256 !== expected)
    )
      throw invalid()
    if (verify) await this.ports.verifyPoint(path, value.components, value.originId)
    const auxiliary = await readPrivateJson(path, "summary.json", 4096)
    if (
      JSON.stringify(botComputerCheckpointSummary.shape.managedGit.parse(auxiliary.value)) !==
      JSON.stringify(value.managedGit)
    )
      throw invalid()
    return {
      path,
      value,
      sha256: record.sha256,
      summary: summary(
        value,
        record.sha256,
        botComputerCheckpointSummary.shape.managedGit.parse(auxiliary.value)
      )
    }
  }
  private async catalogNames() {
    const path = join(this.root, "points")
    if (!(await present(path))) return []
    if (!(await physical(path, true))) throw invalid()
    const names: string[] = [],
      directory = await opendir(path)
    for await (const entry of directory) {
      if (names.length >= 40) throw new Error("电脑恢复目录超出数量上限，请检查本机文件")
      names.push(entry.name)
    }
    return names
  }
  async list() {
    if (!(await present(this.root))) return []
    await this.guard()
    if (await present(join(this.root, "pending.json")))
      throw new Error("电脑恢复尚未完成，请先重启 Bot 后台")
    const receipts = BotMaintenanceReceipts.readOnly(this.directory)
    try {
      const result: BotComputerCheckpointSummary[] = []
      for (const id of await this.catalogNames()) {
        if (
          !z.string().uuid().safeParse(id).success ||
          receipts?.get("computer", id)?.state === "deleted"
        )
          continue
        result.push((await this.point(id, undefined, false)).summary)
        if (result.length > 20) throw invalid()
      }
      return result.sort((a, b) => b.createdAt - a.createdAt)
    } finally {
      receipts?.close()
    }
  }
  async execute(raw: BotComputerCheckpointRequest): Promise<BotComputerCheckpointResult> {
    const request = botComputerCheckpointRequest.parse(raw)
    await this.guard()
    // These journals cannot be independently completed against a global point.
    for (const pending of [
      join(this.directory, "restore.json"),
      join(this.directory, "workspace-maintenance", "pending.json"),
      join(this.directory, "browser-maintenance", "pending.json")
    ])
      if (await present(pending)) throw new Error("已有组件恢复待完成，请先完成原恢复操作")
    await this.recover()
    const receipts = new BotMaintenanceReceipts(this.directory)
    try {
      await this.discardReservedPreparations(receipts)
      await cleanupComputerDeliveryRecords(this.directory, this.owner)
      if (request.action === "delete") {
        const previous = receipts.get("computer", request.checkpoint.id)
        let operation = receipts.getOperation("computer-delete", request.checkpoint.id)
        const requestHash = BotMaintenanceReceipts.requestHash(request),
          path = join(this.root, "points", request.checkpoint.id)
        if (operation?.requestSha256 !== undefined && operation.requestSha256 !== requestHash)
          throw invalid()
        if (previous?.state !== "deleted")
          receipts.assertActive("computer", request.checkpoint.id, request.checkpoint.sha256)
        else if (previous.sha256 !== request.checkpoint.sha256) throw invalid()
        if (!operation) {
          const point = await this.point(request.checkpoint.id, request.checkpoint.sha256)
          const identity = await physical(path, true)
          if (!identity) throw invalid()
          await this.guard()
          receipts.reserveOperation(
            "computer-delete",
            request.checkpoint.id,
            "delete",
            requestHash,
            { identity }
          )
          receipts.sealOperation("computer-delete", request.checkpoint.id, point.sha256)
          operation = receipts.getOperation("computer-delete", request.checkpoint.id)!
        }
        if (operation.state === "reserved") {
          await this.guard()
          receipts.sealOperation(
            "computer-delete",
            request.checkpoint.id,
            request.checkpoint.sha256
          )
        }
        const authorized = z.object({ identity: computerIdentity }).strict().parse(operation.result)
        await this.guard()
        receipts.retire("computer", request.checkpoint.id, request.checkpoint.sha256, "manual")
        await this.afterStep?.("point.deletion-sealed")
        if (await present(path)) {
          if (
            !(await stateMatches(
              path,
              { state: "established", identity: authorized.identity },
              true
            ))
          )
            throw invalid()
          await this.guard()
          await removeComputerRecoveryTree(path, this.owner, this.signal, (entries) => {
            this.progress?.worked()
            this.progress?.update({ phase: "cleanup", component: "data", entries, bytes: 0 })
          })
          await syncDirectory(dirname(path))
        }
        await this.guard()
        receipts.completeOperation(
          "computer-delete",
          request.checkpoint.id,
          request.checkpoint.sha256
        )
        return { action: "delete" }
      }
      if (request.action === "create") return await this.create(request.nonce, receipts)
      const requestHash = BotMaintenanceReceipts.requestHash(request)
      const operation = receipts.getOperation("computer", request.nonce)
      if (operation && operation.requestSha256 !== requestHash)
        throw new Error("请求标识已用于其他恢复操作")
      if (operation?.state === "completed")
        return botComputerCheckpointRestoreResult.parse(operation.result)
      return await this.restore(request, requestHash, receipts)
    } finally {
      receipts.close()
    }
  }
  private async discardReservedPreparations(receipts: BotMaintenanceReceipts) {
    if (!(await present(this.root))) return
    const names: string[] = [],
      directory = await opendir(this.root)
    for await (const entry of directory) {
      if (
        !/^preparing-[a-f0-9-]{36}\.json(?:\.pending)?$/.test(entry.name) &&
        !/^\.restore-[a-f0-9-]{36}$/.test(entry.name)
      )
        continue
      if (names.length >= 40) throw invalid()
      names.push(entry.name)
    }
    for (const name of names) {
      if (name.startsWith(".restore-")) {
        const nonce = name.slice(9),
          marker = `preparing-${nonce}.json`
        if (
          (await present(join(this.root, marker))) ||
          (await present(join(this.root, marker + ".pending")))
        )
          continue
        // A death before provenance publication cannot have started copying or
        // fencing. Use rmdir only: arbitrary/nonempty trees are never adopted.
        const host = join(this.root, name),
          shared = join(`${this.directory}.workspace`, `.computer-restore-${nonce}`)
        const operation = receipts.getOperation("computer", nonce)
        if (operation && operation.state !== "reserved") throw invalid()
        for (const path of [join(host, "old"), join(host, "next"), shared, host]) {
          if (!(await present(path))) continue
          if (!(await physical(path, true))) throw invalid()
          await this.guard()
          await rmdir(path)
          await syncDirectory(dirname(path))
        }
        receipts.releaseOperation("computer", nonce)
        receipts.releaseReservation("recovery", nonce)
        continue
      }
      const preparation = preparationSchema.parse(
          (await readPrivateJson(this.root, name, 4096)).value
        ),
        operation = receipts.getOperation("computer", preparation.nonce),
        identity = this.owner.identity()
      if (
        !operation ||
        preparation.originId !== (await this.origin()) ||
        !same(identity.root, preparation.owner.root) ||
        !same(identity.lock, preparation.owner.lock)
      )
        throw invalid()
      if (name.endsWith(".pending")) {
        const target = name.slice(0, -8)
        if (await present(join(this.root, target))) throw invalid()
        await this.guard()
        await rename(join(this.root, name), join(this.root, target))
        await syncDirectory(this.root)
      }
      const markerName = name.replace(/\.pending$/, "")
      // A published journal/completed receipt owns its stage; it is never an
      // abandoned preparation, even after a caller lost its ACK.
      if (operation.state !== "reserved") {
        await this.guard()
        await rm(join(this.root, markerName))
        await syncDirectory(this.root)
        continue
      }
      const host = join(this.root, `.restore-${preparation.nonce}`),
        shared = join(`${this.directory}.workspace`, `.computer-restore-${preparation.nonce}`)
      for (const [path, expected] of [
        [host, preparation.host],
        [shared, preparation.shared]
      ] as const) {
        if (
          (await present(path)) &&
          !(await stateMatches(path, { state: "established", identity: expected }, true))
        )
          throw invalid()
      }
      // Nothing may have been displaced before the single main journal. This
      // also refuses a corrupt/foreign preparation instead of deleting safety
      // data merely because the primary journal is missing.
      if (await present(join(shared, "old"))) throw invalid()
      if (await present(join(host, "old"))) {
        const old = await opendir(join(host, "old"))
        try {
          if (await old.read()) throw invalid()
        } finally {
          await old.close()
        }
      }
      for (const path of [shared, host])
        if (await present(path)) {
          await this.guard()
          await removeComputerRecoveryTree(path, this.owner, this.signal, () =>
            this.progress?.worked()
          )
          await syncDirectory(dirname(path))
        }
      await this.guard()
      await rm(join(this.root, markerName))
      await syncDirectory(this.root)
      receipts.releaseOperation("computer", preparation.nonce)
      receipts.releaseReservation("recovery", preparation.nonce)
    }
  }
  private async create(
    nonce: string,
    receipts: BotMaintenanceReceipts
  ): Promise<BotComputerCheckpointResult> {
    const originId = await this.origin(true)
    receipts.assertActive("computer", nonce)
    const previous = receipts.get("computer", nonce)
    const target = join(this.root, "points", nonce)
    if (await present(target)) {
      const point = await this.point(nonce)
      await this.guard()
      receipts.publish("computer", nonce, "manual", point.sha256)
      return { action: "create", checkpoint: point.summary }
    }
    if (previous?.state === "published")
      throw new Error("已保存的电脑恢复点丢失，未重复创建；请重新发起保存")
    const established = (await this.catalogNames()).filter(
      (name) => z.string().uuid().safeParse(name).success
    )
    if (established.length >= 20)
      throw new Error("已保留 20 个电脑恢复点，请先删除不再需要的恢复点")
    receipts.reserve("computer", nonce, "manual")
    await privateDirectory(join(this.root, "points"))
    const stage = join(this.root, "points", `.pending-${nonce}`)
    // Only an unsealed, empty-original create staging area may be retried.
    if (await present(stage)) {
      if (!(await physical(stage, true))) throw invalid()
      await this.guard()
      await rm(stage, { recursive: true })
    }
    await mkdir(stage, { mode: 0o700 })
    let published = false
    try {
      const budget = new ComputerBudget(),
        capture = await this.ports.capture({
          directory: this.directory,
          destination: stage,
          originId,
          owner: this.owner,
          budget,
          signal: this.signal,
          progress: (value) => this.progress?.update(value)
        })
      const value = computerManifest.parse({
        format: 1,
        id: nonce,
        originId,
        createdAt: Date.now(),
        platform: process.platform,
        components: capture.components,
        managedGit: capture.managedGit,
        ...budget.totals(),
        includes: "committed-data-referenced-evidence-shared-browser-managed-deliverables",
        excludes:
          "external-projects-provider-vault-credentials-processes-unreferenced-data-host-caches-external-git-metadata"
      })
      await writePrivateJson(join(stage, "manifest.json"), value)
      await writePrivateJson(join(stage, "summary.json"), capture.managedGit)
      await this.ports.verifyPoint(stage, value.components, originId)
      const sealed = await readPrivateJson(stage, "manifest.json", 16 * 1024)
      await this.guard()
      await rename(stage, target)
      published = true
      await syncDirectory(dirname(target))
      await this.afterStep?.("point.published")
      receipts.publish("computer", nonce, "manual", sealed.sha256)
      return { action: "create", checkpoint: summary(value, sealed.sha256, capture.managedGit) }
    } catch (error) {
      if (!published) {
        // Cancellation prevents new work, but does not skip settling a private
        // unpublished create after its native writer has actually exited.
        await this.cleanupGuard()
        await rm(stage, { recursive: true, force: true })
        receipts.releaseReservation("computer", nonce)
      }
      throw error
    }
  }
  private async restore(
    request: Extract<BotComputerCheckpointRequest, { action: "restore" }>,
    requestHash: string,
    receipts: BotMaintenanceReceipts
  ): Promise<BotComputerCheckpointResult> {
    const point = await this.point(request.checkpoint.id, request.checkpoint.sha256)
    if ((await this.recoveryNames()).length >= 5)
      throw new Error("已保留 5 份恢复前现场，请先清理不再需要的恢复现场")
    if (point.value.components.managed.state === "established") {
      const deliverables = join(this.root, "deliverables")
      if (await present(deliverables)) {
        if (!(await physical(deliverables, true))) throw invalid()
        let count = 0
        const directory = await opendir(deliverables)
        for await (const entry of directory) {
          if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success)
            throw invalid()
          if (++count >= 20)
            throw new Error("已保留 20 份独立代码恢复成果，请先导出并整理恢复成果目录后重试")
        }
      }
    }
    receipts.assertActive("computer", request.checkpoint.id, request.checkpoint.sha256)
    const stageId = request.nonce,
      hostStage = join(this.root, `.restore-${stageId}`),
      sharedStage = join(`${this.directory}.workspace`, `.computer-restore-${stageId}`)
    await privateDirectory(`${this.directory}.workspace`)
    await mkdir(hostStage, { mode: 0o700 })
    await mkdir(sharedStage, { mode: 0o700 })
    await mkdir(join(hostStage, "next"), { mode: 0o700 })
    await mkdir(join(hostStage, "old"), { mode: 0o700 })
    const input: ComputerPreparationInput = {
      directory: this.directory,
      pointRoot: point.path,
      hostStage,
      sharedStage,
      originId: point.value.originId,
      nonce: request.nonce,
      owner: this.owner,
      signal: this.signal
    }
    const result = {
      action: "restore",
      checkpoint: request.checkpoint,
      recoveryCopy: request.nonce,
      restartRequired: true,
      reviewRequired: true
    } as const
    receipts.reserveOperation("computer", request.nonce, "restore", requestHash, result)
    receipts.reserve("recovery", request.nonce, "manual")
    let sealed = false
    try {
      await writePrivateJson(
        join(this.root, `preparing-${request.nonce}.json`),
        preparationSchema.parse({
          format: 1,
          nonce: request.nonce,
          originId: input.originId,
          owner: this.owner.identity(),
          host: await physical(hostStage, true),
          shared: await physical(sharedStage, true)
        })
      )
      await this.afterStep?.("prepare.started")
      // The sealed source header is part of this prepared transaction. Startup
      // does not depend on a user retaining the original catalog directory.
      await writePrivateJson(join(hostStage, "point.json"), point.value)
      const preparedWithoutSlots = await this.ports.prepare(input, point.value.components)
      const draft = {
        format: 1 as const,
        nonce: request.nonce,
        originId: input.originId,
        checkpoint: request.checkpoint,
        ...preparedWithoutSlots,
        slots: [] as ComputerSlot[]
      }
      for (const name of COMPUTER_SLOT_ORDER) {
        const path = paths(input, draft, name),
          directory = slotIsDirectory(name)
        const original = path.original ? await physical(path.original, directory) : undefined
        const replacement = await physical(path.next, directory)
        if (path.target && path.target !== path.original && (await present(path.target)))
          throw invalid()
        draft.slots.push({
          name,
          original: original ? { state: "established", identity: original } : absent,
          replacement: replacement ? { state: "established", identity: replacement } : absent
        })
      }
      const prepared = validatePrepared(draft)
      await this.ports.verifyPrepared(
        input,
        prepared,
        new Map(
          prepared.slots
            .filter((s) => s.replacement.state === "established")
            .map((s) => [s.name, paths(input, prepared, s.name).next])
        )
      )
      await writePrivateJson(join(hostStage, "prepared.json"), prepared)
      const preparedSha256 = (await readPrivateJson(hostStage, "prepared.json")).sha256
      const journal = computerJournal.parse({
        format: 1,
        nonce: request.nonce,
        stage: stageId,
        originId: input.originId,
        owner: this.owner.identity(),
        checkpoint: request.checkpoint,
        preparedSha256,
        result
      })
      await writePrivateJson(join(hostStage, "journal.json"), journal)
      await this.guard()
      await writePrivateJson(join(this.root, "pending.json"), journal)
      sealed = true
      receipts.sealOperation(
        "computer",
        request.nonce,
        (await readPrivateJson(this.root, "pending.json", 16 * 1024)).sha256
      )
      await this.afterStep?.("journal.published")
      await this.recover()
      await this.guard()
      await rm(join(this.root, `preparing-${request.nonce}.json`), { force: true })
      await syncDirectory(this.root)
      return result
    } catch (error) {
      // writePrivateJson may have renamed successfully before a directory
      // flush fails. A visible journal owns the prepared originals, even when
      // the caller never received success from publication.
      if (!sealed && (await present(join(this.root, "pending.json")))) sealed = true
      if (!sealed) {
        await this.cleanupGuard()
        await rm(hostStage, { recursive: true, force: true })
        await rm(sharedStage, { recursive: true, force: true })
        await rm(join(this.root, `preparing-${request.nonce}.json`), { force: true })
        await syncDirectory(this.root)
        receipts.releaseOperation("computer", request.nonce)
        receipts.releaseReservation("recovery", request.nonce)
      }
      throw error
    }
  }
  private async recoveryNames() {
    const root = join(this.root, "recovery")
    if (!(await present(root))) return []
    if (!(await physical(root, true))) throw invalid()
    const names: string[] = [],
      directory = await opendir(root)
    for await (const entry of directory) {
      if (names.length >= 5 || !z.string().uuid().safeParse(entry.name).success) throw invalid()
      names.push(entry.name)
    }
    return names
  }
  async recoveryCopies() {
    await this.guard()
    const receipts = BotMaintenanceReceipts.readOnly(this.directory)
    try {
      const result: { id: string; sha256: string; checkpoint: ComputerJournal["checkpoint"] }[] = []
      for (const id of await this.recoveryNames()) {
        const operation = receipts?.getOperation("computer", id),
          state = receipts?.get("recovery", id),
          deletion = receipts?.getOperation("recovery", id),
          root = join(this.root, "recovery", id)
        if (operation?.state !== "completed" || !state || operation.journalSha256 !== state.sha256)
          throw invalid()
        if (deletion) {
          // Partial cleanup may already have removed journal.json. Keep its
          // original selection discoverable using the independent durable
          // receipt and root identity, so a closed dialog can resume cleanup.
          const authorized = z
              .object({ host: computerIdentity, shared: computerIdentity })
              .strict()
              .parse(deletion.result),
            restored = botComputerCheckpointRestoreResult.parse(operation.result)
          if (
            deletion.state === "completed" ||
            deletion.requestSha256 !==
              BotMaintenanceReceipts.requestHash({ id, sha256: state.sha256 }) ||
            (deletion.state !== "reserved" && deletion.journalSha256 !== state.sha256) ||
            restored.recoveryCopy !== id ||
            !(await stateMatches(root, { state: "established", identity: authorized.host }, true))
          )
            throw invalid()
          result.push({ id, sha256: state.sha256, checkpoint: restored.checkpoint })
        } else {
          const record = await readPrivateJson(root, "journal.json", 16 * 1024),
            journal = computerJournal.parse(record.value)
          if (journal.nonce !== id || record.sha256 !== state.sha256 || state.state === "deleted")
            throw invalid()
          result.push({ id, sha256: record.sha256, checkpoint: journal.checkpoint })
        }
      }
      return result
    } finally {
      receipts?.close()
    }
  }
  async deleteRecovery(id: string, sha256: string) {
    z.string().uuid().parse(id)
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(sha256)
    await this.guard()
    if (await present(join(this.root, "pending.json"))) throw invalid()
    const receipts = new BotMaintenanceReceipts(this.directory),
      root = join(this.root, "recovery", id),
      shared = join(`${this.directory}.workspace`, `.computer-recovery-${id}`)
    try {
      const receipt = receipts.get("recovery", id)
      if (!receipt || receipt.sha256 !== sha256) throw invalid()
      let deletion = receipts.getOperation("recovery", id)
      if (!deletion) {
        if (!(await present(root))) throw invalid()
        const record = await readPrivateJson(root, "journal.json", 16 * 1024)
        const journal = computerJournal.parse(record.value),
          preparedRecord = await readPrivateJson(root, "prepared.json"),
          prepared = validatePrepared(preparedRecord.value)
        if (
          record.sha256 !== sha256 ||
          journal.nonce !== id ||
          preparedRecord.sha256 !== journal.preparedSha256 ||
          prepared.nonce !== id
        )
          throw invalid()
        const operation = receipts.getOperation("computer", id)
        if (operation?.state !== "completed" || operation.journalSha256 !== sha256) throw invalid()
        const original = prepared.slots.find((slot) => slot.name === "shared")!.original
        if (
          (await present(join(shared, "old"))) &&
          !(await stateMatches(join(shared, "old"), original, true))
        )
          throw invalid()
        const hostIdentity = await physical(root, true),
          sharedIdentity = await physical(shared, true)
        if (!hostIdentity || !sharedIdentity) throw invalid()
        receipts.reserveOperation(
          "recovery",
          id,
          "delete-recovery",
          BotMaintenanceReceipts.requestHash({ id, sha256 }),
          { host: hostIdentity, shared: sharedIdentity }
        )
        receipts.sealOperation("recovery", id, sha256)
        deletion = receipts.getOperation("recovery", id)!
      }
      if (deletion.state === "reserved") {
        await this.guard()
        receipts.sealOperation("recovery", id, sha256)
        deletion = receipts.getOperation("recovery", id)!
      }
      if (
        deletion.requestSha256 !== BotMaintenanceReceipts.requestHash({ id, sha256 }) ||
        deletion.journalSha256 !== sha256
      )
        throw invalid()
      const authorized = z
        .object({ host: computerIdentity, shared: computerIdentity })
        .strict()
        .parse(deletion.result)
      // A recursive delete may remove journal.json before the process exits.
      // Its independently persisted inode proof keeps that retry authorized.
      if (
        (await present(root)) &&
        !(await stateMatches(root, { state: "established", identity: authorized.host }, true))
      )
        throw invalid()
      if (
        (await present(shared)) &&
        !(await stateMatches(shared, { state: "established", identity: authorized.shared }, true))
      )
        throw invalid()
      await this.guard()
      receipts.retire("recovery", id, sha256, "manual")
      await this.afterStep?.("recovery.deletion-sealed")
      // Delete the shared recovery first. The host journal remains available for
      // validating any retry until the final host root is removed.
      if (await present(shared)) {
        if (!(await physical(shared, true))) throw invalid()
        await this.guard()
        await removeComputerRecoveryTree(shared, this.owner, this.signal, (entries) => {
          this.progress?.worked()
          this.progress?.update({ phase: "cleanup", component: "shared", entries, bytes: 0 })
        })
        await syncDirectory(`${this.directory}.workspace`)
      }
      await this.afterStep?.("recovery.shared-deleted")
      if (await present(root)) {
        await this.guard()
        await removeComputerRecoveryTree(root, this.owner, this.signal, (entries) => {
          this.progress?.worked()
          this.progress?.update({ phase: "cleanup", component: "data", entries, bytes: 0 })
        })
        await syncDirectory(dirname(root))
      }
      await this.guard()
      receipts.completeOperation("recovery", id, sha256)
    } finally {
      receipts.close()
    }
  }

  async recover(): Promise<void> {
    const pending = join(this.root, "pending.json")
    if (!(await present(pending))) return
    for (const path of [
      join(this.directory, "restore.json"),
      join(this.directory, "workspace-maintenance", "pending.json"),
      join(this.directory, "browser-maintenance", "pending.json")
    ])
      if (await present(path)) throw invalid()
    const initial = await readPrivateJson(this.root, "pending.json", 16 * 1024),
      journal = computerJournal.parse(initial.value)
    const guard = async () => {
      await this.guard()
      const current = this.owner.identity()
      if (
        !same(current.root, journal.owner.root) ||
        !same(current.lock, journal.owner.lock) ||
        (await readPrivateJson(this.root, "pending.json", 16 * 1024)).sha256 !== initial.sha256 ||
        (await this.origin()) !== journal.originId
      )
        throw invalid()
    }
    await guard()
    const hostStage = join(this.root, `.restore-${journal.stage}`),
      sharedStage = join(`${this.directory}.workspace`, `.computer-restore-${journal.stage}`),
      hostRecovery = join(this.root, "recovery", journal.nonce),
      sharedRecovery = join(`${this.directory}.workspace`, `.computer-recovery-${journal.nonce}`)
    const receipts = new BotMaintenanceReceipts(this.directory)
    try {
      const receipt = receipts.getOperation("computer", journal.nonce)
      if (
        !receipt ||
        receipt.requestSha256 !==
          BotMaintenanceReceipts.requestHash({
            action: "restore",
            nonce: journal.nonce,
            checkpoint: journal.checkpoint
          })
      )
        throw invalid()
      if (receipt.state === "reserved") {
        await guard()
        receipts.sealOperation("computer", journal.nonce, initial.sha256)
      } else if (receipt.journalSha256 !== initial.sha256) throw invalid()
      const stage = (await present(hostStage)) ? hostStage : hostRecovery
      if (!(await physical(stage, true))) throw invalid()
      const preparedRecord = await readPrivateJson(stage, "prepared.json"),
        prepared = validatePrepared(preparedRecord.value)
      if (
        preparedRecord.sha256 !== journal.preparedSha256 ||
        prepared.nonce !== journal.nonce ||
        prepared.originId !== journal.originId ||
        prepared.checkpoint.id !== journal.checkpoint.id ||
        prepared.checkpoint.sha256 !== journal.checkpoint.sha256
      )
        throw invalid()
      const input: ComputerPreparationInput = {
        directory: this.directory,
        pointRoot: join(this.root, "points", journal.checkpoint.id),
        hostStage,
        sharedStage,
        originId: journal.originId,
        nonce: journal.nonce,
        owner: this.owner,
        signal: this.signal
      }
      if (receipt.state !== "completed") {
        if (stage !== hostStage || !(await physical(sharedStage, true))) throw invalid()
        const locations = new Map<ComputerSlotName, string>()
        for (const slot of prepared.slots) {
          const path = paths(input, prepared, slot.name),
            directory = slotIsDirectory(slot.name)
          if (slot.replacement.state === "established") {
            if (await stateMatches(path.next, slot.replacement, directory))
              locations.set(slot.name, path.next)
            else if (
              !(await present(path.next)) &&
              path.target &&
              (await stateMatches(path.target, slot.replacement, directory))
            )
              locations.set(slot.name, path.target)
            else throw invalid()
          } else if (await present(path.next)) throw invalid()
          // Original bytes can only be live, or displaced to this exact journal's old slot.
          if (slot.original.state === "established") {
            if (await present(path.old)) {
              if (!(await stateMatches(path.old, slot.original, directory))) throw invalid()
            } else if (
              !path.original ||
              !(await stateMatches(path.original, slot.original, directory))
            )
              throw invalid()
          } else if (await present(path.old)) throw invalid()
          const nextPresent = await present(path.next),
            oldPresent = await present(path.old)
          // Preflight every target before the first destructive rename. A third
          // tree cannot be adopted even when another component has not moved.
          if (
            path.original &&
            oldPresent &&
            path.original !== path.target &&
            (await present(path.original))
          )
            throw invalid()
          if (path.target && (await present(path.target))) {
            const originalStillLive =
              !oldPresent &&
              path.target === path.original &&
              slot.original.state === "established" &&
              (await stateMatches(path.target, slot.original, directory))
            const replacementAlreadyMoved =
              !nextPresent &&
              slot.replacement.state === "established" &&
              (await stateMatches(path.target, slot.replacement, directory))
            if (!originalStillLive && !replacementAlreadyMoved) throw invalid()
          }
        }
        await this.ports.verifyPrepared(input, prepared, locations)
        for (const slot of prepared.slots) {
          this.progress?.stage(
            "replace",
            slot.name === "shared" ? "shared" : slot.name === "browser" ? "browser" : "data"
          )
          const path = paths(input, prepared, slot.name),
            directory = slotIsDirectory(slot.name)
          if (slot.original.state === "established" && !(await present(path.old))) {
            if (!path.original || !(await stateMatches(path.original, slot.original, directory)))
              throw invalid()
            await guard()
            await rename(path.original, path.old)
            await syncDirectory(dirname(path.original))
            await syncDirectory(dirname(path.old))
            await this.afterStep?.(`slot.old:${slot.name}`)
          }
        }
        // Displace the complete original set before publishing any new DB.
        // Otherwise a crash can pair a new main DB with an old WAL/SHM/journal.
        for (const slot of prepared.slots) {
          this.progress?.stage(
            "replace",
            slot.name === "shared" ? "shared" : slot.name === "browser" ? "browser" : "data"
          )
          const path = paths(input, prepared, slot.name),
            directory = slotIsDirectory(slot.name)
          if (slot.replacement.state === "established" && (await present(path.next))) {
            if (
              !path.target ||
              (await present(path.target)) ||
              !(await stateMatches(path.next, slot.replacement, directory))
            )
              throw invalid()
            await guard()
            await rename(path.next, path.target)
            await syncDirectory(dirname(path.target))
            await syncDirectory(dirname(path.next))
            await this.afterStep?.(`slot.next:${slot.name}`)
          }
          if (path.target && !(await stateMatches(path.target, slot.replacement, directory)))
            throw invalid()
        }
        const currentLocations: ComponentLocations = new Map(
          prepared.slots
            .filter((s) => s.replacement.state === "established")
            .map((s) => [s.name, paths(input, prepared, s.name).target!])
        )
        await this.ports.verifyPrepared(input, prepared, currentLocations)
        await guard()
        await this.ports.publishShared(input, prepared)
        await guard()
        await this.ports.publishManaged(input, prepared)
        await this.ports.verifySharedRecord(input, prepared)
        await guard()
        receipts.completeOperation("computer", journal.nonce, initial.sha256)
        await this.afterStep?.("restore.completed")
      }
      await guard()
      receipts.publish("recovery", journal.nonce, "manual", initial.sha256)
      this.progress?.stage("cleanup", "control")
      // A durable completed receipt precedes journal removal. If cleanup was
      // interrupted, never reapply the restore or inspect mutable live files.
      await privateDirectory(join(this.root, "recovery"))
      if (await present(hostStage)) {
        if (await present(hostRecovery)) throw invalid()
        await guard()
        await rename(hostStage, hostRecovery)
        await syncDirectory(this.root)
        await syncDirectory(dirname(hostRecovery))
      }
      if (await present(sharedStage)) {
        if (await present(sharedRecovery)) throw invalid()
        await guard()
        await rename(sharedStage, sharedRecovery)
        await syncDirectory(`${this.directory}.workspace`)
      } else if (!(await physical(sharedRecovery, true))) throw invalid()
      // The original safety set is retained. Explicit retention applies only
      // to fully completed sets; no abandoned old tree is ever collected.
      await guard()
      await rm(pending)
      await syncDirectory(this.root)
    } finally {
      receipts.close()
    }
  }
}
