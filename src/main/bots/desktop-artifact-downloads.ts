import { createHash } from "node:crypto"
import { canonicalBotFileBase64Bytes } from "../../shared/bot-file-base64"
import { validateBotFileName } from "./artifact-validation"
import { lstat } from "node:fs/promises"
import type { BotArtifact } from "../../shared/bot-types"
import { BotDomainError } from "../../shared/bot-types"
import { BOT_FILE_CHUNK_BYTES, botFileByteLimit, type BotFileChunk } from "../../shared/bot-files"
import {
  BOT_ARTIFACT_DOWNLOAD_CONCURRENCY,
  BOT_ARTIFACT_DOWNLOAD_PENDING,
  BOT_ARTIFACT_DOWNLOAD_RETAINED_BYTES,
  BOT_ARTIFACT_DOWNLOAD_PAGE,
  botArtifactDownloadStartSchema,
  botArtifactDownloadMutationSchema,
  botArtifactDownloadPageInputSchema,
  type BotArtifactDownloadSource,
  type BotArtifactDownloadJob,
  type BotArtifactDownloadPage,
  type BotArtifactDownloadsAPI
} from "../../shared/bot-artifact-downloads"
import {
  DesktopArtifactDownloadLedger,
  artifactDownloadSourceKey,
  type DownloadRecord
} from "./desktop-artifact-download-ledger"
import {
  captureDownloadTarget,
  createDownloadStage,
  openDownloadStage,
  downloadIdentity,
  hashDownloadFile,
  publishDownload,
  cleanupDownloadStage,
  assertDownloadParent,
  sameDownloadInode
} from "./desktop-artifact-download-io"

export interface DesktopArtifactDownloadProvider {
  /** Explicitly drain/close this signal-owned authenticated file connection. Idempotent. */
  release(signal: AbortSignal): Promise<void>
  describe(
    source: BotArtifactDownloadSource,
    signal: AbortSignal
  ): Promise<{ dataEpoch: string; artifact: BotArtifact }>
  /** Each authenticated read must compare epoch before AND after Host request. */
  read(
    source: BotArtifactDownloadSource,
    offset: number,
    signal: AbortSignal
  ): Promise<{ dataEpoch: string; chunk: BotFileChunk }>
}
export interface DesktopArtifactDownloadDependencies {
  source: DesktopArtifactDownloadProvider
  choose(name: string, signal: AbortSignal): Promise<string | undefined>
  reveal(path: string): Promise<void>
  /** Main lifetime ownership; throws after shutdown or replacement. */
  assertOwnership(): void
  /** Shared desktop-maintenance barrier + latest authenticated source identity. */
  withPublication<T>(
    source: BotArtifactDownloadSource,
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T>
}
const terminal = (state: BotArtifactDownloadJob["state"]) =>
  ["completed", "cancelled", "failed"].includes(state)
const zeroHash = createHash("sha256").digest("hex")
const copyJob = (job: BotArtifactDownloadJob): BotArtifactDownloadJob => structuredClone(job)
const failure = (code: string, message: string) => new BotDomainError(code, message)
const failureMessages: Record<string, string> = {
  download_source_changed: "成果或授权已变化，请选择当前成果另存",
  download_part_changed: "临时文件发生变化，请另存为新文件",
  download_destination_changed: "保存目录或目标发生变化，请另存为新文件",
  download_destination_exists: "已有同名文件，请另存为新文件",
  download_publish_unavailable: "该文件系统不支持安全发布，请换用本地保存目录",
  download_publish_unknown: "保存结果尚不能确认，请核对本机文件",
  download_hash_mismatch: "成果完整性校验失败，请重新选择成果",
  download_interrupted: "保存已暂停，可稍后继续"
}
const failureMessage = (code: string) => failureMessages[code] ?? "保存未完成，请核对后重试"
const safeFailureCode = (error: unknown): string =>
  error instanceof BotDomainError && Object.hasOwn(failureMessages, error.code)
    ? error.code
    : "download_interrupted"

/** Native paths and SQLite ledger never enter Host/model or renderer packets. */
export class DesktopArtifactDownloads implements BotArtifactDownloadsAPI {
  private readonly ledger: DesktopArtifactDownloadLedger
  private readonly active = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >()
  private readonly preparations = new Map<
    string,
    { controller: AbortController; completion: Promise<BotArtifactDownloadJob> }
  >()
  private readonly operations = new Set<Promise<unknown>>()
  private closePromise: Promise<void> | undefined
  private readonly initialized: Promise<void>
  private maintenance = false
  private closing = false
  private closed = false
  private pumpQueued = false
  constructor(
    path: string,
    private readonly dependencies: DesktopArtifactDownloadDependencies
  ) {
    dependencies.assertOwnership()
    this.ledger = new DesktopArtifactDownloadLedger(path)
    this.initialized = this.recover()
    void this.initialized.catch(() => undefined) // methods retain the original initialization failure
  }
  /** Register before the first await; shutdown drains every accepted public operation. */
  private operation<T>(execute: () => Promise<T>, readOnly = false): Promise<T> {
    if (this.closing || this.closed || (this.maintenance && !readOnly))
      return Promise.reject(failure("download_request_rejected", "保存服务已关闭"))
    try {
      this.dependencies.assertOwnership()
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.operations.size >= 64)
      return Promise.reject(failure("download_capacity", "保存操作已达上限，请稍后再试"))
    const completion = Promise.resolve().then(execute)
    this.operations.add(completion)
    void completion.then(
      () => this.operations.delete(completion),
      () => this.operations.delete(completion)
    )
    return completion
  }
  private sourceScope<T>(controller: AbortController, execute: () => Promise<T>): Promise<T> {
    let released: Promise<void> | undefined
    const release = () =>
      (released ??= Promise.resolve().then(() =>
        this.dependencies.source.release(controller.signal)
      ))
    const aborted = () => {
      void release().catch(() => undefined)
    }
    controller.signal.addEventListener("abort", aborted, { once: true })
    return Promise.resolve()
      .then(execute)
      .finally(async () => {
        controller.signal.removeEventListener("abort", aborted)
        await release()
      })
  }
  private prepare(
    id: string,
    execute: (controller: AbortController) => Promise<BotArtifactDownloadJob>
  ): Promise<BotArtifactDownloadJob> {
    const existing = this.preparations.get(id)
    if (existing) return existing.completion
    const controller = new AbortController()
    const completion = this.sourceScope(controller, () => execute(controller)).finally(() => {
      if (this.preparations.get(id)?.completion === completion) this.preparations.delete(id)
    })
    const entry = { controller, completion }
    this.preparations.set(id, entry)
    return entry.completion
  }
  private async choose(name: string, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
    })
    try {
      return await Promise.race([this.dependencies.choose(name, signal), cancelled])
    } finally {
      if (abort) signal.removeEventListener("abort", abort)
    }
  }
  private assertAvailable(): void {
    this.dependencies.assertOwnership()
    if (this.closing || this.closed || this.maintenance)
      throw failure("download_request_rejected", "保存服务正在维护，请稍后再试")
  }
  private transition(
    record: DownloadRecord,
    state: BotArtifactDownloadJob["state"],
    code?: string
  ): DownloadRecord {
    const next: DownloadRecord = {
      ...record,
      job: {
        ...record.job,
        revision: record.job.revision + 1,
        state,
        updatedAt: Date.now(),
        error: undefined,
        diagnostic: undefined
      }
    }
    if (code) {
      next.job.error = failureMessage(code)
      next.job.diagnostic = { code }
    }
    this.ledger.put(next, record.job.revision)
    return next
  }
  private exact(input: { id: string; revision: number }): DownloadRecord {
    const record = this.ledger.get(input.id)
    if (!record || record.job.revision !== input.revision)
      throw failure("download_revision_conflict", "保存任务已变化，请刷新后操作")
    return record
  }
  private assertSource(
    source: BotArtifactDownloadSource,
    value: { dataEpoch: string; artifact: BotArtifact }
  ): void {
    const artifact = value.artifact
    try {
      validateBotFileName(artifact.name)
    } catch {
      throw failure("download_source_changed", failureMessage("download_source_changed"))
    }
    if (
      value.dataEpoch !== source.dataEpoch ||
      artifact.id !== source.artifactId ||
      artifact.conversationId !== source.conversationId ||
      artifact.size !== source.size ||
      artifact.sha256 !== source.sha256 ||
      artifact.size > botFileByteLimit(artifact.name, artifact.mime)
    )
      throw failure("download_source_changed", failureMessage("download_source_changed"))
  }
  start(input: Parameters<BotArtifactDownloadsAPI["start"]>[0]): Promise<BotArtifactDownloadJob> {
    return this.operation(() => this.startImpl(input))
  }
  private async startImpl(
    input: Parameters<BotArtifactDownloadsAPI["start"]>[0]
  ): Promise<BotArtifactDownloadJob> {
    const parsed = botArtifactDownloadStartSchema.safeParse(input)
    if (!parsed.success) throw failure("download_request_rejected", "保存请求无效")
    input = parsed.data
    await this.initialized
    this.assertAvailable()
    const receipt = this.ledger.receipt(input.nonce)
    if (receipt) {
      if (receipt.sourceKey !== artifactDownloadSourceKey(input.source))
        throw failure("download_nonce_conflict", "保存请求已用于其他成果")
      const existing = this.ledger.get(input.nonce)
      if (!existing) throw failure("download_archived", "该保存请求已归档，请创建新请求")
      return copyJob(existing.job)
    }
    const all = this.ledger.list()
    if (
      all.filter((record) => !terminal(record.job.state)).length >= BOT_ARTIFACT_DOWNLOAD_PENDING ||
      all.length >= 216 ||
      all.reduce(
        (bytes, record) =>
          bytes + (record.stage || !terminal(record.job.state) ? record.job.total : 0),
        0
      ) +
        input.source.size >
        BOT_ARTIFACT_DOWNLOAD_RETAINED_BYTES
    )
      throw failure("download_capacity", "未完成保存已达上限，请先处理已有任务")
    const now = Date.now(),
      record: DownloadRecord = {
        job: {
          id: input.nonce,
          revision: 1,
          source: input.source,
          name: "成果文件",
          mime: "application/octet-stream",
          state: "choosing",
          bytes: 0,
          total: input.source.size,
          createdAt: now,
          updatedAt: now
        },
        prefixHash: zeroHash
      }
    try {
      this.ledger.admit(record)
    } catch (error) {
      if (error instanceof BotDomainError) throw error
      throw failure("download_request_rejected", "无法保存请求记录，请稍后重试")
    }
    return this.prepare(record.job.id, async (controller) => {
      try {
        const description = await this.dependencies.source.describe(input.source, controller.signal)
        this.assertSource(input.source, description)
        controller.signal.throwIfAborted()
        this.assertAvailable()
        const named: DownloadRecord = {
          ...record,
          job: {
            ...record.job,
            name: description.artifact.name,
            mime: description.artifact.mime
          }
        }
        this.ledger.put(named, record.job.revision)
        const destination = await this.choose(named.job.name, controller.signal)
        const current = this.ledger.get(record.job.id)!
        if (
          this.closing ||
          this.closed ||
          controller.signal.aborted ||
          current.job.state !== "choosing"
        )
          return copyJob(current.job)
        if (!destination) return copyJob(this.transition(current, "cancelled").job)
        const target = await captureDownloadTarget(destination)
        const confirmed = await this.dependencies.source.describe(input.source, controller.signal)
        this.assertSource(input.source, confirmed)
        controller.signal.throwIfAborted()
        this.assertAvailable()
        const latest = this.ledger.get(record.job.id)!
        if (latest.job.state !== "choosing") return copyJob(latest.job)
        const queued = this.transition({ ...latest, target }, "queued")
        this.schedulePump()
        return copyJob(queued.job)
      } catch (error) {
        if (this.closed) return { ...record.job, state: "cancelled" }
        const current = this.ledger.get(record.job.id)!
        if (current.job.state !== "choosing") return copyJob(current.job)
        const code = safeFailureCode(error)
        const state = controller.signal.aborted ? "cancelled" : "failed"
        return copyJob(this.transition(current, state, code).job)
      }
    })
  }
  page(input: Parameters<BotArtifactDownloadsAPI["page"]>[0]): Promise<BotArtifactDownloadPage> {
    return this.operation(() => this.pageImpl(input), true)
  }
  private async pageImpl(
    input: Parameters<BotArtifactDownloadsAPI["page"]>[0]
  ): Promise<BotArtifactDownloadPage> {
    input = botArtifactDownloadPageInputSchema.parse(input)
    await this.initialized
    this.dependencies.assertOwnership()
    let records = this.ledger
      .list()
      .filter(
        (record) =>
          !input.conversationId || record.job.source.conversationId === input.conversationId
      )
    const total = records.length
    if (input.before) {
      let cursor: { time: number; id: string }
      try {
        const parsed: unknown = JSON.parse(Buffer.from(input.before, "base64url").toString())
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !("time" in parsed) ||
          !("id" in parsed) ||
          typeof parsed.time !== "number" ||
          !Number.isSafeInteger(parsed.time) ||
          typeof parsed.id !== "string"
        )
          throw new Error("cursor")
        cursor = { time: parsed.time, id: parsed.id }
      } catch {
        throw failure("download_request_rejected", "保存列表游标无效")
      }
      records = records.filter(
        (record) =>
          record.job.createdAt < cursor.time ||
          (record.job.createdAt === cursor.time && record.job.id < cursor.id)
      )
    }
    const selected = records.slice(0, input.limit ?? BOT_ARTIFACT_DOWNLOAD_PAGE),
      last = selected.at(-1)
    return {
      items: selected.map((record) => copyJob(record.job)),
      total,
      nextCursor:
        records.length > selected.length && last
          ? Buffer.from(JSON.stringify({ time: last.job.createdAt, id: last.job.id })).toString(
              "base64url"
            )
          : null
    }
  }
  resume(input: Parameters<BotArtifactDownloadsAPI["resume"]>[0]): Promise<BotArtifactDownloadJob> {
    return this.operation(() => this.resumeImpl(input))
  }
  private async resumeImpl(
    input: Parameters<BotArtifactDownloadsAPI["resume"]>[0]
  ): Promise<BotArtifactDownloadJob> {
    input = botArtifactDownloadMutationSchema.parse(input)
    await this.initialized
    this.assertAvailable()
    const record = this.exact(input)
    if (record.job.state !== "paused" || !record.target)
      throw failure("download_invalid_state", "该任务不能继续，请另存为新文件")
    return this.prepare(record.job.id, async (controller) => {
      try {
        const description = await this.dependencies.source.describe(
          record.job.source,
          controller.signal
        )
        this.assertSource(record.job.source, description)
        controller.signal.throwIfAborted()
        await assertDownloadParent(record.target!)
        controller.signal.throwIfAborted()
        this.assertAvailable()
        const queued = this.transition(this.exact(input), "queued")
        this.schedulePump()
        return copyJob(queued.job)
      } catch (error) {
        const current = this.ledger.get(input.id)!
        if (current.job.revision !== input.revision || current.job.state !== "paused") {
          if (terminal(current.job.state) || controller.signal.aborted) return copyJob(current.job)
          throw failure("download_revision_conflict", "保存任务已变化，请刷新后操作")
        }
        if (controller.signal.aborted || this.closing || this.maintenance)
          return copyJob(current.job)
        const code = safeFailureCode(error)
        return copyJob(
          this.transition(current, code === "download_interrupted" ? "paused" : "failed", code).job
        )
      }
    })
  }
  pause(input: Parameters<BotArtifactDownloadsAPI["pause"]>[0]): Promise<BotArtifactDownloadJob> {
    return this.operation(() => this.pauseImpl(input))
  }
  private async pauseImpl(
    input: Parameters<BotArtifactDownloadsAPI["pause"]>[0]
  ): Promise<BotArtifactDownloadJob> {
    input = botArtifactDownloadMutationSchema.parse(input)
    await this.initialized
    const record = this.exact(input)
    if (record.job.state === "publishing") {
      await this.active.get(input.id)?.completion
      return copyJob(this.ledger.get(input.id)!.job)
    }
    if (!["queued", "downloading", "verifying"].includes(record.job.state))
      throw failure("download_invalid_state", "该任务不能暂停")
    this.transition(record, "paused")
    const active = this.active.get(input.id)
    active?.controller.abort()
    await active?.completion
    return copyJob(this.ledger.get(input.id)!.job)
  }
  cancel(input: Parameters<BotArtifactDownloadsAPI["cancel"]>[0]): Promise<BotArtifactDownloadJob> {
    return this.operation(() => this.cancelImpl(input))
  }
  private async cancelImpl(
    input: Parameters<BotArtifactDownloadsAPI["cancel"]>[0]
  ): Promise<BotArtifactDownloadJob> {
    input = botArtifactDownloadMutationSchema.parse(input)
    await this.initialized
    const record = this.exact(input)
    if (record.job.state === "completed") return copyJob(record.job)
    if (record.job.state === "publishing") {
      await this.active.get(input.id)?.completion
      return copyJob(this.ledger.get(input.id)!.job)
    }
    if (record.job.state !== "cancelled") this.transition(record, "cancelled")
    this.preparations.get(input.id)?.controller.abort()
    const active = this.active.get(input.id)
    active?.controller.abort()
    await Promise.allSettled([active?.completion, this.preparations.get(input.id)?.completion])
    let cleaned = false
    try {
      cleaned = await cleanupDownloadStage(this.ledger.get(input.id)!)
    } catch {
      throw failure("download_cleanup_required", "临时保存无法确认清理，请核对本机文件")
    }
    if (cleaned) {
      const current = this.ledger.get(input.id)!,
        { stage: _stage, intent: _intent, ...clean } = current
      void _stage
      void _intent
      this.ledger.put(clean, current.job.revision)
    }
    return copyJob(this.ledger.get(input.id)!.job)
  }
  reveal(input: Parameters<BotArtifactDownloadsAPI["reveal"]>[0]): Promise<void> {
    return this.operation(() => this.revealImpl(input))
  }
  private async revealImpl(input: Parameters<BotArtifactDownloadsAPI["reveal"]>[0]): Promise<void> {
    input = botArtifactDownloadMutationSchema.parse(input)
    await this.initialized
    const record = this.exact(input)
    if (record.job.state !== "completed" || !record.target || !record.published)
      throw failure("download_invalid_state", "文件尚未保存完成")
    await assertDownloadParent(record.target)
    const current = await lstat(record.target.path, { bigint: true }).catch(() => {
      throw failure("download_destination_changed", "保存文件已移动或被替换")
    })
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameDownloadInode(current, record.published)
    )
      throw failure("download_destination_changed", "保存文件已移动或被替换")
    try {
      await this.dependencies.reveal(record.target.path)
    } catch {
      throw failure("download_destination_changed", "无法打开保存文件所在目录")
    }
  }
  forget(input: Parameters<BotArtifactDownloadsAPI["forget"]>[0]): Promise<void> {
    return this.operation(() => this.forgetImpl(input))
  }
  private async forgetImpl(input: Parameters<BotArtifactDownloadsAPI["forget"]>[0]): Promise<void> {
    input = botArtifactDownloadMutationSchema.parse(input)
    await this.initialized
    const record = this.exact(input)
    if (terminal(record.job.state) && record.stage) {
      let cleaned = false
      try {
        cleaned = await cleanupDownloadStage(record)
      } catch {
        /* no raw native path may enter renderer */
      }
      if (!cleaned)
        throw failure("download_cleanup_required", "临时保存无法确认清理，请核对本机文件")
      const { stage: _stage, intent: _intent, ...clean } = record
      void _stage
      void _intent
      this.ledger.put(clean, record.job.revision)
    }
    this.ledger.forget(input.id, input.revision)
  }
  private schedulePump(): void {
    if (this.pumpQueued || this.maintenance || this.closing || this.closed) return
    this.pumpQueued = true
    queueMicrotask(() => {
      this.pumpQueued = false
      this.pump()
    })
  }
  private pump(): void {
    if (this.maintenance || this.closing || this.closed) return
    for (const record of this.ledger.list().filter((record) => record.job.state === "queued")) {
      if (this.active.size >= BOT_ARTIFACT_DOWNLOAD_CONCURRENCY) break
      if (this.active.has(record.job.id)) continue
      const controller = new AbortController(),
        active = { controller, completion: Promise.resolve() }
      this.active.set(record.job.id, active)
      active.completion = this.sourceScope(controller, () =>
        this.stream(record.job.id, controller.signal)
      )
        .catch(() => {
          /* stream persists safe outcome */
        })
        .finally(() => {
          if (this.active.get(record.job.id) === active) this.active.delete(record.job.id)
          this.schedulePump()
        })
    }
  }
  private async stream(id: string, signal: AbortSignal): Promise<void> {
    let opened: Awaited<ReturnType<typeof openDownloadStage>> | undefined
    const current = () => {
      signal.throwIfAborted()
      this.dependencies.assertOwnership()
      const record = this.ledger.get(id)!
      if (!["downloading", "verifying", "publishing"].includes(record.job.state))
        throw failure("download_interrupted", "保存已暂停")
      return record
    }
    try {
      signal.throwIfAborted()
      this.dependencies.assertOwnership()
      const queued = this.ledger.get(id)!
      if (queued.job.state !== "queued") return
      let record = this.transition(queued, "downloading")
      if (!record.target) throw failure("download_invalid_state", "未选择保存位置")
      if (!record.stage) {
        const stage = await createDownloadStage(record)
        // Capture ownership even if pause/cancel won while create was in flight.
        // Its caller drains this stream before touching the owned stage.
        const latest = this.ledger.get(id)!
        record = { ...latest, stage }
        this.ledger.put(record, latest.job.revision)
        current()
      }
      opened = await openDownloadStage(record, signal)
      while (record.job.bytes < record.job.total) {
        current()
        const value = await this.dependencies.source.read(
          record.job.source,
          record.job.bytes,
          signal
        )
        this.assertSource(record.job.source, {
          dataEpoch: value.dataEpoch,
          artifact: value.chunk.artifact
        })
        current()
        if (value.chunk.base64.length > Math.ceil(BOT_FILE_CHUNK_BYTES / 3) * 4)
          throw failure("download_source_changed", "成果分块超过限制")
        const byteLength = canonicalBotFileBase64Bytes(value.chunk.base64, BOT_FILE_CHUNK_BYTES)
        if (byteLength === null) throw failure("download_source_changed", "成果分块编码无效")
        const bytes = Buffer.from(value.chunk.base64, "base64")
        if (
          value.chunk.offset !== record.job.bytes ||
          bytes.length === 0 ||
          bytes.length > BOT_FILE_CHUNK_BYTES ||
          bytes.length > record.job.total - record.job.bytes ||
          bytes.length !== byteLength
        )
          throw failure("download_source_changed", "成果分块无效")
        await opened.assertIdentity()
        current()
        for (let written = 0; written < bytes.length; ) {
          const result = await opened.handle.write(
            bytes,
            written,
            bytes.length - written,
            record.job.bytes + written
          )
          if (!result.bytesWritten) throw failure("download_interrupted", "本机文件写入未完成")
          written += result.bytesWritten
        }
        await opened.handle.sync()
        current()
        await opened.assertIdentity()
        opened.hash.update(bytes)
        record = {
          ...record,
          stage: {
            ...record.stage!,
            identity: downloadIdentity(await opened.handle.stat({ bigint: true }))
          },
          prefixHash: opened.hash.copy().digest("hex"),
          job: {
            ...record.job,
            bytes: record.job.bytes + bytes.length,
            updatedAt: Date.now()
          }
        }
        this.ledger.put(record, record.job.revision)
      }
      if (opened.hash.copy().digest("hex") !== record.job.source.sha256)
        throw failure("download_hash_mismatch", "成果校验失败")
      await opened.handle.close()
      opened = undefined
      record = this.transition(record, "verifying")
      const target = record.target
      if (!target) throw failure("download_invalid_state", "未选择保存位置")
      const digest = await hashDownloadFile(
        record.stage!.path,
        target,
        record.stage!.identity,
        record.job.total,
        signal
      )
      if (digest !== record.job.source.sha256)
        throw failure("download_hash_mismatch", "成果校验失败")
      current()
      await this.dependencies.withPublication(record.job.source, signal, async () => {
        const description = await this.dependencies.source.describe(record.job.source, signal)
        this.assertSource(record.job.source, description)
        current()
        // Once native publication is accepted, pause/cancel must await this exact
        // operation, rather than abort between link and the durable receipt.
        const pinned = this.ledger.get(id)!
        record = this.transition(
          {
            ...pinned,
            intent: { identity: pinned.stage!.identity, sha256: digest }
          },
          "publishing"
        )
        const publicationSignal = new AbortController().signal
        const published = await publishDownload(record, publicationSignal)
        record = this.transition({ ...record, published }, "completed")
        if (await cleanupDownloadStage(record)) {
          const { stage: _stage, intent: _intent, ...clean } = record
          void _stage
          void _intent
          this.ledger.put(clean, record.job.revision)
        }
      })
    } catch (error) {
      if (this.closed) return
      const record = this.ledger.get(id)
      if (!record || ["paused", "cancelled", "completed", "failed"].includes(record.job.state))
        return
      const code = safeFailureCode(error)
      const resumable = code === "download_interrupted" || code === "download_publish_unavailable"
      if (record.job.state === "publishing" && code === "download_interrupted") {
        // Native link may have committed. Preserve intent for reconciliation;
        // never resume by overwriting/replaying a potentially published file.
        this.transition(record, "failed", "download_publish_unknown")
      } else this.transition(record, resumable ? "paused" : "failed", code)
    } finally {
      await opened?.handle.close()
    }
  }
  private async recover(): Promise<void> {
    for (const record of this.ledger.list()) {
      if (record.job.state === "choosing") {
        this.transition(record, "cancelled")
        continue
      }
      if (record.intent && record.target) {
        try {
          const info = await lstat(record.target.path, { bigint: true })
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            !sameDownloadInode(info, record.intent.identity) ||
            info.size !== BigInt(record.job.total)
          )
            throw failure("download_publish_unknown", "保存目标身份发生变化，请核对")
          const stage = record.stage
            ? await lstat(record.stage.path, { bigint: true }).catch(() => undefined)
            : undefined
          const knownSecondLink = Boolean(stage && sameDownloadInode(stage, record.intent.identity))
          const digest = await hashDownloadFile(
            record.target.path,
            record.target,
            record.intent.identity,
            record.job.total,
            new AbortController().signal,
            knownSecondLink
          )
          if (digest !== record.intent.sha256)
            throw failure("download_publish_unknown", "保存文件校验失败")
          const completed = this.transition(
            { ...record, published: downloadIdentity(info) },
            "completed"
          )
          if (await cleanupDownloadStage(completed)) {
            const { stage: _stage, intent: _intent, ...clean } = completed
            void _stage
            void _intent
            this.ledger.put(clean, completed.job.revision)
          }
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            this.transition(record, "failed", "download_publish_unknown")
            continue
          }
        }
      }
      if (["queued", "downloading", "verifying", "publishing"].includes(record.job.state))
        this.transition(record, "paused", "download_interrupted")
      else if (
        record.job.state === "completed" &&
        record.stage &&
        (await cleanupDownloadStage(record))
      ) {
        const { stage: _stage, intent: _intent, ...clean } = record
        void _stage
        void _intent
        this.ledger.put(clean, record.job.revision)
      }
    }
  }
  async pauseForMaintenance(): Promise<void> {
    this.maintenance = true
    await this.initialized
    for (const record of this.ledger.list()) {
      if (record.job.state === "choosing") {
        this.transition(record, "cancelled")
        this.preparations.get(record.job.id)?.controller.abort()
      } else if (["queued", "downloading", "verifying"].includes(record.job.state)) {
        this.transition(record, "paused", "download_interrupted")
        this.active.get(record.job.id)?.controller.abort()
      }
    }
  }
  async drainForMaintenance(): Promise<void> {
    await this.pauseForMaintenance()
    for (const entry of this.preparations.values()) entry.controller.abort()
    await Promise.allSettled([
      ...[...this.active.values()].map((entry) => entry.completion),
      ...[...this.preparations.values()].map((entry) => entry.completion),
      ...this.operations
    ])
  }
  endMaintenance(): void {
    if (!this.closing && !this.closed) this.maintenance = false
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      try {
        await this.drainForMaintenance()
      } finally {
        this.closed = true
        this.ledger.close()
      }
    })()
    return this.closePromise
  }
}
