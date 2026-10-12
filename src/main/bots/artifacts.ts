import { isBotRasterImage } from "./image-contract"
import type { BotPeerImageSource } from "../../shared/bot-peer-images"
import type { BotPeerFileSource } from "../../shared/bot-peer-files"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  openStableFileHandle,
  readStableFileHandleBounded,
  StableBoundedReadError,
  type StableFileHandle
} from "../services/stable-file-handle"
import { BotDomainError, type BotArtifact, type BotRunLease } from "../../shared/bot-types"
import type { BotArtifactNotice, BotStore } from "./store"
import * as v from "./validation"
import {
  BOT_FILE_BYTES,
  BOT_FILE_CHUNK_BYTES,
  botFileByteLimit,
  type BotFileChunk
} from "../../shared/bot-files"
import { BotArtifactTransfers } from "./artifact-transfer"
import { validateBotFileName } from "./artifact-validation"
import { BotFilePreviews } from "./file-preview"
import type { BotDocumentReader } from "./document-reader"
import {
  botFileDeleteInput,
  type BotFileDeleted,
  type BotFileOrigin
} from "../../shared/bot-file-lifecycle"

const LEGACY_UPLOAD_BYTES = 5 * 1024 * 1024
const ARTIFACT_INTEGRITY_MESSAGE = "文件内容丢失或完整性校验失败，请重新上传"

const artifactCorrupt = () => new BotDomainError("artifact_corrupt", ARTIFACT_INTEGRITY_MESSAGE)

/**
 * An artifact row names one immutable object. Missing or structurally invalid
 * object paths are data loss/tampering, rather than a caller or transport
 * failure. Keep actual storage availability errors (for example EACCES/EIO)
 * intact so operations staff can distinguish them from damaged content.
 */
function normalizeArtifactObjectReadError(error: unknown): unknown {
  if (error instanceof BotDomainError) return error
  if (error instanceof StableBoundedReadError) return artifactCorrupt()
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code ?? "")) return artifactCorrupt()
  if (
    error instanceof Error &&
    (error.message === "Cannot preview a directory" ||
      error.message === "File changed while the preview capability was active" ||
      error.message.startsWith("Access denied: file"))
  )
    return artifactCorrupt()
  return error
}

/** A file fsync does not make its post-rename directory entry durable on POSIX. */
async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support POSIX directory fsync. The object file itself is
  // still flushed before rename and NTFS handles directory persistence.
  if (process.platform === "win32") return
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function assertStableContents(file: StableFileHandle, message: string): Promise<void> {
  const after = await file.handle.stat({ bigint: true })
  if (
    !after.isFile() ||
    after.dev !== file.identity.device ||
    after.ino !== file.identity.inode ||
    after.size !== file.identity.size ||
    after.mtimeNs !== file.identity.modifiedNs ||
    after.ctimeNs !== file.identity.changedNs
  )
    throw new Error(message)
  try {
    await file.assertPathIdentity()
  } catch {
    throw new Error(message)
  }
}
type PublicationInput = {
  id: string
  conversationId: string
  runId: string | null
  name: string
  mime: string
  origin?: BotFileOrigin
}
type LegacyUploadInput = {
  nonce: string
  conversationId: string
  name: string
  mime: string
  base64: string
}
export class BotArtifacts {
  readonly transfers: BotArtifactTransfers
  readonly previews: BotFilePreviews
  private initialization?: Promise<void>
  private readonly mutations = new Map<string, Promise<unknown>>()
  private readonly orphaned = new Set<string>()
  private readonly operations = new Set<Promise<unknown>>()
  private cleanup?: Promise<void>
  private cleanupTimer?: ReturnType<typeof setInterval>
  private closed = false
  private closing?: Promise<void>
  constructor(
    private readonly directory: string,
    private readonly store: BotStore,
    previewReader?: BotDocumentReader
  ) {
    this.transfers = new BotArtifactTransfers(
      join(directory, "uploads"),
      // Only the transfer queue may finish an already admitted upload while we
      // drain. New callers still pass the public service's admission fence.
      (...args) => this.track(() => this.publishFile(...args)),
      store
    )
    this.previews = new BotFilePreviews(this, store, previewReader)
  }

  private ready(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      // The Host calls recover before opening RPC. Every publisher also awaits
      // ready, so this inventory cannot discover an in-flight rename as an orphan.
      // Only our flat regular objects are candidates; staging has its own owner.
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (/^pending-[a-f0-9-]{36}$/.test(entry.name))
          await unlink(join(this.directory, entry.name))
        else if (
          entry.isFile() &&
          /^[a-f0-9]{64}$/.test(entry.name) &&
          !this.store.artifactContentReferenced(entry.name)
        )
          this.orphaned.add(entry.name)
      }
    })()
    return this.initialization
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = undefined
    this.closing = this.drain()
    return this.closing
  }

  private async drain(): Promise<void> {
    // A child failure must not let the Host close SQLite while another child or
    // an accepted file operation still owns resources. A queued transfer may
    // enter its private publisher until the transfer queue has fully drained.
    const children = await Promise.allSettled([this.transfers.close(), this.previews.close()])
    while (this.operations.size) await Promise.allSettled([...this.operations])
    await this.cleanup?.catch(() => {})
    await Promise.allSettled([...this.mutations.values()])
    for (const child of children) if (child.status === "rejected") throw child.reason
  }

  private operate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("文件服务正在关闭"))
    return this.track(operation)
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    // Register before the first asynchronous preparation, not only after an
    // object reaches the per-hash mutation queue. Closing drains file handles,
    // temporary bytes and database work together, including failed operations.
    const task = Promise.resolve().then(operation)
    this.operations.add(task)
    void task.then(
      () => this.operations.delete(task),
      () => this.operations.delete(task)
    )
    return task
  }

  private async mutate<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    const execution = (this.mutations.get(hash) ?? Promise.resolve())
      .catch(() => {})
      .then(operation)
    this.mutations.set(hash, execution)
    try {
      return await execution
    } finally {
      if (this.mutations.get(hash) === execution) this.mutations.delete(hash)
    }
  }

  private assertPublishable(id: string): void {
    try {
      this.store.getArtifact(id)
    } catch (error) {
      if (!(error instanceof BotDomainError && error.code === "not_found")) throw error
    }
  }

  private async publishObject(
    id: string,
    hash: string,
    temporary: string,
    commit: () => BotArtifact
  ): Promise<BotArtifact> {
    let renamed = false
    try {
      return await this.mutate(hash, async () => {
        this.assertPublishable(id)
        await rename(temporary, join(this.directory, hash))
        renamed = true
        try {
          // SQLite's ready record may only commit after the hash directory entry
          // itself is durable. A file sync alone cannot survive a power loss
          // between rename and the database transaction on POSIX filesystems.
          await syncDirectory(this.directory)
          const artifact = commit()
          this.orphaned.delete(hash)
          return artifact
        } catch (error) {
          // The startup inventory has already run. Track the renamed object if
          // its database publication fails; a shared/live hash is still protected
          // by the same per-hash queue and reference check as ordinary cleanup.
          this.orphaned.add(hash)
          throw error
        }
      })
    } catch (error) {
      // Cleanup must run after releasing this hash's mutation queue. Failure
      // retains the candidate for maintenance and preserves the original error.
      if (renamed) await this.collectDeleted().catch(() => {})
      throw error
    }
  }

  recover(): Promise<void> {
    return this.operate(() => this.recoverResources())
  }

  private async recoverResources(): Promise<void> {
    await this.ready()
    await this.collectDeleted()
    if (!this.closed && !this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        void this.collectDeleted().catch(() => {
          console.warn("[BotFiles] 文件清理未完成，将在下次维护时重试")
        })
      }, 60_000)
      this.cleanupTimer.unref()
    }
  }

  /** Tombstones take effect before disk cleanup. A shared hash is only unlinked
   * after its final live reference disappears. Failed Windows unlinks remain
   * eligible on the next cleanup; they never restore the deleted reference. */
  collectDeleted(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.cleanup) return this.cleanup
    const task = this.collectDeletedObjects()
    this.cleanup = task
    void task
      .finally(() => {
        if (this.cleanup === task) this.cleanup = undefined
      })
      .catch(() => {})
    return task
  }

  private async collectDeletedObjects(): Promise<void> {
    const candidates = new Set([...this.store.artifactGarbage(), ...this.orphaned])
    for (const hash of [...candidates].slice(0, 128)) {
      if (!/^[a-f0-9]{64}$/.test(hash)) continue
      await this.mutate(hash, async () => {
        if (this.store.artifactContentReferenced(hash)) {
          this.orphaned.delete(hash)
          return
        }
        try {
          await unlink(join(this.directory, hash))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return
        }
        this.store.artifactContentPurged(hash)
        this.orphaned.delete(hash)
      })
    }
  }

  remove(input: unknown): Promise<BotFileDeleted> {
    return this.operate(() => this.removeFile(input))
  }

  private async removeFile(input: unknown): Promise<BotFileDeleted> {
    const value = botFileDeleteInput.parse(input)
    await this.ready()
    const result = await this.mutate(value.sha256, async () => this.store.deleteArtifact(value))
    await this.collectDeleted()
    return result
  }

  upload(input: LegacyUploadInput): Promise<BotArtifact> {
    return this.operate(() => this.uploadBytes(input))
  }

  private async uploadBytes(input: LegacyUploadInput): Promise<BotArtifact> {
    v.record(input)
    v.identifier(input.nonce)
    const raw = v.text(input.base64, "文件内容", Math.ceil(LEGACY_UPLOAD_BYTES / 3) * 4, true)
    if (
      raw.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) ||
      Buffer.from(raw, "base64").toString("base64") !== raw
    )
      throw new BotDomainError("invalid_input", "文件编码不正确")
    return this.publishBytes({ ...input, id: input.nonce, runId: null }, Buffer.from(raw, "base64"))
  }

  publish(
    input: PublicationInput,
    bytes: Buffer,
    lease?: BotRunLease,
    beforeCommit?: () => void,
    notice?: BotArtifactNotice
  ): Promise<BotArtifact> {
    return this.operate(() => this.publishBytes(input, bytes, lease, beforeCommit, notice))
  }

  private async publishBytes(
    input: PublicationInput,
    bytes: Buffer,
    lease?: BotRunLease,
    beforeCommit?: () => void,
    notice?: BotArtifactNotice
  ): Promise<BotArtifact> {
    v.identifier(input.id)
    this.store.getConversation(input.conversationId)
    const name = validateBotFileName(input.name),
      mime = v.text(input.mime || "application/octet-stream", "文件类型", 100)
    if (bytes.length > botFileByteLimit(name, mime))
      throw new BotDomainError("file_too_large", "普通文件最大 25 MiB，视频最大 200 MiB")
    this.validateVideo(bytes.subarray(0, 16), bytes.length)
    if (lease) this.store.assertLease(lease)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    await this.ready()
    const temp = join(this.directory, `pending-${randomUUID()}`)
    const handle = await open(temp, "wx", 0o600)
    try {
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return await this.publishObject(input.id, sha256, temp, () => {
        // A ready record is published only after the immutable content is on disk.
        beforeCommit?.()
        return this.store.publishArtifact(
          { ...input, name, mime, size: bytes.length, sha256 },
          lease,
          notice
        )
      })
    } finally {
      await unlink(temp).catch(() => {})
    }
  }

  private validateVideo(header: Buffer, size: number): void {
    if (size <= BOT_FILE_BYTES) return
    const recognized =
      header.subarray(4, 8).toString() === "ftyp" ||
      header.subarray(0, 4).toString("hex") === "1a45dfa3" ||
      (header.subarray(0, 4).toString() === "RIFF" &&
        header.subarray(8, 12).toString() === "AVI ") ||
      header.subarray(0, 4).toString() === "OggS"
    if (!recognized)
      throw new BotDomainError("invalid_video", "超过 25 MiB 的附件必须是受支持的视频文件")
  }

  /** Streaming publication from private staging. No caller-supplied path crosses RPC. */
  publishFromFile(
    input: Omit<PublicationInput, "origin">,
    source: string,
    size: number,
    expectedHash: string
  ): Promise<BotArtifact> {
    return this.operate(() => this.publishFile(input, source, size, expectedHash))
  }

  private async publishFile(
    input: Omit<PublicationInput, "origin">,
    source: string,
    size: number,
    expectedHash: string
  ): Promise<BotArtifact> {
    await this.ready()
    v.identifier(input.id)
    this.store.getConversation(input.conversationId)
    const name = validateBotFileName(input.name),
      mime = v.text(input.mime, "文件类型", 100)
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > botFileByteLimit(name, mime) ||
      !/^[a-f0-9]{64}$/.test(expectedHash)
    )
      throw new Error("文件大小或摘要无效")
    const sourceFile = await openStableFileHandle(this.directory, source)
    const temporary = join(this.directory, `pending-${randomUUID()}`)
    try {
      if (sourceFile.size !== size) throw new Error("文件尚未完整上传")
      const output = await open(temporary, "wx", 0o600)
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(BOT_FILE_CHUNK_BYTES)
      try {
        for (let offset = 0; offset < size; ) {
          const { bytesRead } = await sourceFile.handle.read(
            buffer,
            0,
            Math.min(buffer.length, size - offset),
            offset
          )
          if (!bytesRead) throw new Error("上传数据被截断")
          if (offset === 0) this.validateVideo(buffer.subarray(0, Math.min(bytesRead, 16)), size)
          hash.update(buffer.subarray(0, bytesRead))
          let written = 0
          while (written < bytesRead) {
            const result = await output.write(
              buffer,
              written,
              bytesRead - written,
              offset + written
            )
            if (!result.bytesWritten) throw new Error("文件保存失败")
            written += result.bytesWritten
          }
          offset += bytesRead
        }
        if (hash.digest("hex") !== expectedHash) throw new Error("文件完整性校验失败，请重新上传")
        await assertStableContents(sourceFile, "文件在保存期间发生变化")
        await output.sync()
      } finally {
        await output.close()
      }
      this.store.getConversation(input.conversationId)
      return await this.publishObject(input.id, expectedHash, temporary, () => {
        return this.store.publishArtifact({ ...input, name, mime, size, sha256: expectedHash })
      })
    } finally {
      await sourceFile.handle.close()
      await unlink(temporary).catch(() => {})
    }
  }

  chunk(input: { id: string; offset: number }): Promise<BotFileChunk> {
    return this.operate(() => this.readChunk(input))
  }

  private async readChunk(input: { id: string; offset: number }): Promise<BotFileChunk> {
    v.record(input)
    const artifact = this.store.getArtifact(input.id)
    this.store.getConversation(artifact.conversationId)
    const offset = v.integer(input.offset, "分块位置", 0, artifact.size)
    if (
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      artifact.size > botFileByteLimit(artifact.name, artifact.mime)
    )
      throw new Error("文件索引损坏")
    let file: StableFileHandle
    try {
      file = await openStableFileHandle(this.directory, join(this.directory, artifact.sha256))
    } catch (error) {
      throw normalizeArtifactObjectReadError(error)
    }
    try {
      if (file.size !== artifact.size) throw artifactCorrupt()
      const bytes = Buffer.alloc(Math.min(BOT_FILE_CHUNK_BYTES, artifact.size - offset))
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await file.handle.read(
          bytes,
          read,
          bytes.length - read,
          offset + read
        )
        if (!bytesRead) throw artifactCorrupt()
        read += bytesRead
      }
      try {
        await assertStableContents(file, "文件在读取期间发生变化")
      } catch {
        throw artifactCorrupt()
      }
      this.store.getArtifact(artifact.id)
      return { artifact, offset, base64: bytes.toString("base64") }
    } finally {
      await file.handle.close()
    }
  }

  /** Short-lived existing object locks cover verification and one synchronous
   * domain commit. Never call this around a human approval or model request. */
  withPeerImages<T>(
    lease: BotRunLease,
    images: BotPeerImageSource[],
    check: () => void,
    commit: () => T | Promise<T>,
    inspect?: (bytes: Buffer) => Promise<void>
  ): Promise<T> {
    return this.withPeerAttachments(lease, [], images, check, commit, inspect)
  }

  withPeerFiles<T>(
    lease: BotRunLease,
    files: BotPeerFileSource[],
    check: () => void,
    commit: () => T | Promise<T>,
    images: BotPeerImageSource[] = [],
    inspect?: (bytes: Buffer) => Promise<void>
  ): Promise<T> {
    return this.withPeerAttachments(lease, files, images, check, commit, inspect)
  }

  private withPeerAttachments<T>(
    lease: BotRunLease,
    files: BotPeerFileSource[],
    images: BotPeerImageSource[],
    check: () => void,
    commit: () => T | Promise<T>,
    inspect?: (bytes: Buffer) => Promise<void>
  ): Promise<T> {
    return this.operate(async () => {
      await this.ready()
      check()
      this.store.assertPeerImageSources(lease, images)
      this.store.assertPeerFileSources(lease, files)
      const hashes = [...new Set([...images, ...files].map((file) => file.sha256))].sort()
      const locked = async (index: number): Promise<T> => {
        if (index < hashes.length) return this.mutate(hashes[index], () => locked(index + 1))
        for (const file of files) await this.verifyPeerFile(file, check)
        for (const image of images) {
          check()
          const { bytes } = await this.readObject(image.sourceId)
          if (!isBotRasterImage(bytes))
            throw new BotDomainError("peer_image_format", "协作附件不是受支持的图片")
          await inspect?.(bytes)
        }
        check()
        this.store.assertPeerImageSources(lease, images)
        this.store.assertPeerFileSources(lease, files)
        return commit()
      }
      return locked(0)
    })
  }

  /** Handoff verifies original bytes without allocating each complete document. */
  private async verifyPeerFile(source: BotPeerFileSource, check: () => void): Promise<void> {
    check()
    const artifact = this.store.getArtifact(source.sourceId)
    let file: StableFileHandle
    try {
      file = await openStableFileHandle(this.directory, join(this.directory, artifact.sha256))
    } catch (error) {
      throw normalizeArtifactObjectReadError(error)
    }
    try {
      if (file.size !== source.size) throw artifactCorrupt()
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(Math.min(BOT_FILE_CHUNK_BYTES, source.size))
      for (let offset = 0; offset < source.size; ) {
        check()
        const { bytesRead } = await file.handle.read(
          buffer,
          0,
          Math.min(buffer.length, source.size - offset),
          offset
        )
        if (!bytesRead) throw artifactCorrupt()
        hash.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      await assertStableContents(file, "协作文件在校验期间发生变化")
      if (hash.digest("hex") !== source.sha256) throw artifactCorrupt()
      check()
    } catch (error) {
      throw normalizeArtifactObjectReadError(error)
    } finally {
      await file.handle.close()
    }
  }

  read(id: string): Promise<{ artifact: BotArtifact; bytes: Buffer }> {
    return this.operate(() => this.readObject(id))
  }

  private async readObject(id: string): Promise<{ artifact: BotArtifact; bytes: Buffer }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.readObjectOnce(id)
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof StableBoundedReadError &&
          error.failure === "changed"
        ) {
          // A completed atomic publication can be observed with stale metadata
          // on a just-opened descriptor. Reopen once; the immutable SHA-256
          // binding below still rejects altered bytes and a second change fails.
          await delay(0)
          continue
        }
        throw normalizeArtifactObjectReadError(error)
      }
    }
    throw new Error("Unreachable artifact read state")
  }

  private async readObjectOnce(id: string): Promise<{ artifact: BotArtifact; bytes: Buffer }> {
    const artifact = this.store.getArtifact(id)
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256))
      throw new BotDomainError("artifact_corrupt", "文件索引损坏")
    const handle = await openStableFileHandle(this.directory, join(this.directory, artifact.sha256))
    try {
      // Match the existing chunk reader: immutable metadata bounds allocation,
      // including a small video whose damaged object exceeds its recorded size.
      if (handle.size !== artifact.size) throw artifactCorrupt()
      const bytes = await readStableFileHandleBounded(
        handle,
        botFileByteLimit(artifact.name, artifact.mime)
      )
      if (
        bytes.length !== artifact.size ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      )
        throw artifactCorrupt()
      this.store.getArtifact(artifact.id)
      return { artifact, bytes }
    } finally {
      await handle.handle.close()
    }
  }
}
