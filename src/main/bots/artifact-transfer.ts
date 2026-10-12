import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
  openStableFileHandle,
  openStableWritableFileHandle,
  readStableFileHandleBounded
} from "../services/stable-file-handle"
import {
  BOT_FILE_CHUNK_BYTES,
  BOT_VIDEO_BYTES,
  botFileByteLimit,
  type BotUploadRequest,
  type BotUploadProgress
} from "../../shared/bot-files"
import { BotDomainError, type BotArtifact } from "../../shared/bot-types"
import type { BotArtifacts } from "./artifacts"
import type { BotStore } from "./store"
import { validateBotFileName } from "./artifact-validation"
import * as v from "./validation"

const manifestSchema = z.object({
  nonce: z.string(),
  conversationId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().min(0).max(BOT_VIDEO_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative()
})
type Manifest = z.infer<typeof manifestSchema>
const lifetime = 24 * 60 * 60 * 1000
const digest = (id: string) => createHash("sha256").update(id).digest("hex")

/** Resumable uploads use private staging files; only a verified immutable object is
 * visible in conversations. One Host owns this service and serializes mutations. */
export class BotArtifactTransfers {
  private tail: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private initialization?: Promise<void>
  private closed = false
  constructor(
    private readonly root: string,
    private readonly publish: BotArtifacts["publishFromFile"],
    private readonly store: BotStore
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("文件服务正在关闭"))
    if (this.waiting >= 32) return Promise.reject(new Error("文件传输繁忙，请稍后重试"))
    this.waiting++
    const result = this.tail.then(async () => {
      await this.initialize()
      return operation()
    })
    this.tail = result.catch(() => {})
    return result.finally(() => {
      this.waiting--
    })
  }
  private initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const names = new Set(await readdir(this.root))
      for (const name of names) {
        if (
          /^[a-f0-9-]{36}\.pending$/.test(name) ||
          (/^[a-f0-9]{64}\.part$/.test(name) && !names.has(name.replace(/\.part$/, ".json")))
        )
          await unlink(join(this.root, name))
      }
    })()
    return this.initialization
  }
  async close(): Promise<void> {
    this.closed = true
    await this.tail
  }
  private path(id: string, extension: string): string {
    return join(this.root, `${digest(v.identifier(id))}.${extension}`)
  }
  private existing(id: string): BotArtifact | null {
    try {
      return this.store.getArtifact(id)
    } catch (error) {
      if (error instanceof BotDomainError && error.code === "not_found") return null
      throw error
    }
  }
  private validate(input: BotUploadRequest): Omit<Manifest, "createdAt"> {
    v.record(input)
    const value = manifestSchema.omit({ createdAt: true }).parse({
      ...input,
      nonce: v.identifier(input.nonce),
      conversationId: v.identifier(input.conversationId),
      name: validateBotFileName(input.name),
      mime: v.text(input.mime, "文件类型", 100)
    })
    this.store.getConversation(value.conversationId)
    if (value.size > botFileByteLimit(value.name, value.mime))
      throw new Error("普通文件最大 25 MiB，视频最大 200 MiB")
    return value
  }
  private async read(id: string): Promise<Manifest> {
    const file = await openStableFileHandle(this.root, this.path(id, "json"))
    let value: Manifest
    try {
      value = manifestSchema.parse(
        JSON.parse((await readStableFileHandleBounded(file, 8192)).toString())
      )
    } finally {
      await file.handle.close()
    }
    if (value.nonce !== id) throw new Error("上传身份不一致")
    this.validate(value)
    if (value.createdAt + lifetime <= this.store.now())
      throw new Error("上传已过期，请重新选择文件")
    return value
  }
  private async remove(id: string): Promise<void> {
    for (const extension of ["part", "json"])
      await unlink(this.path(id, extension)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
  }
  private matches(artifact: BotArtifact, input: BotUploadRequest): boolean {
    return (
      artifact.conversationId === input.conversationId &&
      artifact.name === input.name &&
      artifact.mime === input.mime &&
      artifact.size === input.size &&
      artifact.sha256 === input.sha256 &&
      artifact.runId === null
    )
  }
  begin(input: BotUploadRequest): Promise<BotUploadProgress> {
    return this.serial(async () => {
      const data = this.validate(input),
        artifact = this.existing(data.nonce)
      if (artifact) {
        if (!this.matches(artifact, data)) throw new Error("文件请求标识已用于不同内容")
        return { id: data.nonce, offset: artifact.size, artifact }
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      let previous: Manifest | undefined
      try {
        previous = await this.read(data.nonce)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (previous) {
        const saved = manifestSchema.omit({ createdAt: true }).parse(previous)
        if (v.canonicalJson(saved) !== v.canonicalJson(data))
          throw new Error("文件请求标识已用于不同内容")
        const file = await openStableFileHandle(this.root, this.path(data.nonce, "part"))
        try {
          if (file.size > data.size) throw new Error("上传暂存数据损坏")
          return { id: data.nonce, offset: file.size, artifact: null }
        } finally {
          await file.handle.close()
        }
      }
      // Reserve declared bytes before accepting another upload. Expired staging is
      // removed, but published objects are never touched by upload cleanup.
      let count = 0,
        reserved = 0
      for (const name of await readdir(this.root)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const file = await openStableFileHandle(this.root, join(this.root, name))
        let saved: Manifest
        try {
          saved = manifestSchema.parse(
            JSON.parse((await readStableFileHandleBounded(file, 8192)).toString())
          )
        } finally {
          await file.handle.close()
        }
        if (`${digest(saved.nonce)}.json` !== name) throw new Error("上传清单损坏")
        if (saved.createdAt + lifetime <= this.store.now() || this.existing(saved.nonce))
          await this.remove(saved.nonce)
        else {
          count++
          reserved += saved.size
        }
      }
      if (count >= 16 || reserved + data.size > 2 * BOT_VIDEO_BYTES)
        throw new Error("未完成的上传过多，请完成或取消后再试")
      // A crash before publishing the manifest can leave this nonce's empty file.
      await unlink(this.path(data.nonce, "part")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      const part = await open(this.path(data.nonce, "part"), "wx", 0o600)
      await part.close()
      const pending = join(this.root, `${randomUUID()}.pending`)
      const metadata = await open(pending, "wx", 0o600)
      try {
        await metadata.writeFile(JSON.stringify({ ...data, createdAt: this.store.now() }))
        await metadata.sync()
      } finally {
        await metadata.close()
      }
      try {
        await rename(pending, this.path(data.nonce, "json"))
      } finally {
        await unlink(pending).catch(() => {})
      }
      return { id: data.nonce, offset: 0, artifact: null }
    })
  }
  chunk(input: { id: string; offset: number; base64: string }): Promise<BotUploadProgress> {
    v.record(input)
    v.text(input.base64, "文件分块", Math.ceil(BOT_FILE_CHUNK_BYTES / 3) * 4)
    return this.serial(async () => {
      v.record(input)
      const offset = v.integer(input.offset, "分块位置", 0, BOT_VIDEO_BYTES)
      const raw = v.text(input.base64, "文件分块", Math.ceil(BOT_FILE_CHUNK_BYTES / 3) * 4)
      const bytes = Buffer.from(raw, "base64")
      if (!bytes.length || bytes.length > BOT_FILE_CHUNK_BYTES || bytes.toString("base64") !== raw)
        throw new Error("文件分块编码无效")
      const manifest = await this.read(input.id)
      if (offset + bytes.length > manifest.size) throw new Error("文件分块超出声明大小")
      const file = await openStableWritableFileHandle(this.root, this.path(input.id, "part"))
      try {
        if (offset < file.size) {
          if (offset + bytes.length > file.size) throw new Error("分块位置冲突")
          const saved = Buffer.alloc(bytes.length)
          const { bytesRead } = await file.handle.read(saved, 0, saved.length, offset)
          if (bytesRead !== saved.length || !saved.equals(bytes))
            throw new Error("重复分块内容不一致")
        } else {
          if (offset !== file.size) throw new Error("分块位置不连续")
          await file.assertPathIdentity()
          let written = 0
          while (written < bytes.length) {
            const result = await file.handle.write(
              bytes,
              written,
              bytes.length - written,
              offset + written
            )
            if (!result.bytesWritten) throw new Error("文件分块写入失败")
            written += result.bytesWritten
          }
          await file.handle.sync()
        }
        return { id: input.id, offset: Math.max(file.size, offset + bytes.length), artifact: null }
      } finally {
        await file.handle.close()
      }
    })
  }
  finish(id: string): Promise<BotArtifact> {
    return this.serial(async () => {
      const previous = this.existing(v.identifier(id))
      if (previous) return previous
      const manifest = await this.read(id)
      const artifact = await this.publish(
        {
          id,
          conversationId: manifest.conversationId,
          runId: null,
          name: manifest.name,
          mime: manifest.mime
        },
        this.path(id, "part"),
        manifest.size,
        manifest.sha256
      )
      await this.remove(id)
      return artifact
    })
  }
  cancel(id: string): Promise<void> {
    return this.serial(() => this.remove(v.identifier(id)))
  }
}
