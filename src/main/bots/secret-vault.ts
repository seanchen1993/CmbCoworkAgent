import { randomUUID } from "node:crypto"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import type {
  BotSecretCatalog,
  BotSecretMetadata,
  BotSecretSaveInput
} from "../../shared/bot-secrets"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import type { BotStore } from "./store"
import { protectWindows } from "./credential-protection"

/** Future service deployments inject their own envelope/KMS provider at the Host boundary. */
export interface BotSecretProtection {
  readonly kind?: "windows-dpapi" | "macos-keychain" | "external"
  protect(bytes: Buffer): Promise<Buffer>
  unprotect(bytes: Buffer): Promise<Buffer>
  close?(): void
}
const identifier = z.string().min(1).max(200)
const secretMetadata = z.object({
  id: identifier,
  botId: identifier,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(400),
  origin: z.string().max(8192),
  revision: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative()
})
const storedSecret = secretMetadata.extend({ value: z.string().min(1).max(16_000) })
type StoredSecret = z.infer<typeof storedSecret>
const persistedSecrets = z.object({ version: z.literal(1), items: z.array(storedSecret).max(100) })
const mutation = z.object({
  botId: identifier,
  id: identifier,
  revision: z.number().int().positive()
})

export function botSecretOrigin(input: string): string {
  const url = new URL(input)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new Error("请填写 HTTPS 网站地址，不包含路径、查询参数或账号")
  return url.origin
}

function metadata(value: StoredSecret): BotSecretMetadata {
  // Explicit projection: no future private field can accidentally enter a catalog or model prompt.
  return {
    id: value.id,
    botId: value.botId,
    name: value.name,
    description: value.description,
    origin: value.origin,
    revision: value.revision,
    updatedAt: value.updatedAt
  }
}

/** Encrypted, versioned per-Bot credentials; hosts without a provider are memory-only. */
export class BotSecretVault {
  private items: StoredSecret[] = []
  private loading?: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private closed = false
  private readonly protection?: BotSecretProtection
  constructor(
    private readonly path: string | undefined,
    private readonly store: BotStore,
    protection?: BotSecretProtection
  ) {
    this.protection =
      protection ??
      (path && process.platform === "win32"
        ? {
            kind: "windows-dpapi",
            protect: (bytes) => protectWindows(bytes, false),
            unprotect: (bytes) => protectWindows(bytes, true)
          }
        : undefined)
    if (this.protection && !path) throw new Error("加密凭据存储必须指定私有路径")
  }
  get persistent(): boolean {
    return Boolean(this.protection)
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      if (!this.protection) return
      const file = await openStableFileHandle(dirname(this.path!), this.path!).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw new Error("无法读取 Bot 凭据存储")
        }
      )
      if (!file) return
      try {
        const cipher = await readStableFileHandleBounded(file, 2 * 1024 * 1024)
        const plain = await this.protection.unprotect(cipher)
        let data: z.infer<typeof persistedSecrets>
        try {
          if (plain.length > 1024 * 1024) throw new Error("limit")
          data = persistedSecrets.parse(JSON.parse(plain.toString("utf8")))
        } finally {
          plain.fill(0)
        }
        await file.assertPathIdentity()
        const ids = new Set<string>()
        for (const item of data.items) {
          if (ids.has(item.id) || botSecretOrigin(item.origin) !== item.origin)
            throw new Error("invalid")
          ids.add(item.id)
        }
        const live = new Set(this.store.listBots().map((bot) => bot.id))
        const retained = data.items.filter((item) => live.has(item.botId))
        // Recover cleanup if the process exited between Bot deletion and vault persistence.
        if (retained.length !== data.items.length) await this.persist(retained)
        this.items = retained
      } catch {
        throw new Error("Bot 凭据存储无法解密或已损坏，未载入任何凭据")
      } finally {
        await file.handle.close()
      }
    })().catch((error) => {
      // Keychain denial/locking can be temporary. Retry a fresh read, never treat
      // a failed decrypt as an empty store or overwrite the existing ciphertext.
      this.loading = undefined
      throw error
    })
    return this.loading
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("凭据服务正在关闭"))
    if (this.queued >= 32) return Promise.reject(new Error("凭据服务繁忙，请稍后重试"))
    this.queued++
    const next = this.tail
      .then(async () => {
        if (this.closed) throw new Error("凭据服务正在关闭")
        await this.load()
        return operation()
      })
      .finally(() => {
        this.queued--
      })
    this.tail = next.catch(() => {})
    return next
  }

  list(botId: string): Promise<BotSecretCatalog> {
    identifier.parse(botId)
    return this.enqueue(async () => {
      this.store.getBot(botId)
      return {
        persistent: this.persistent,
        protection: this.protection ? (this.protection.kind ?? "external") : "memory",
        items: this.items.filter((item) => item.botId === botId).map(metadata)
      }
    })
  }

  save(input: BotSecretSaveInput): Promise<BotSecretMetadata> {
    const value = z
      .object({
        botId: identifier,
        id: identifier.optional(),
        revision: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(120),
        description: z.string().max(400),
        origin: z.string().max(8192),
        value: z.string().min(1).max(16_000)
      })
      .parse(input)
    const origin = botSecretOrigin(value.origin)
    return this.enqueue(async () => {
      this.store.getBot(value.botId)
      const old = value.id ? this.find(value.botId, value.id, value.revision ?? 0) : undefined
      if (!old && this.items.length >= 100) throw new Error("最多保存 100 项 Bot 凭据")
      if (!old && value.revision !== undefined) throw new Error("新增凭据不应指定旧版本")
      if (
        this.items.some(
          (item) =>
            item.botId === value.botId &&
            item.id !== old?.id &&
            item.name.toLowerCase() === value.name.toLowerCase()
        )
      )
        throw new Error("此 Bot 已有同名凭据，请替换原项或使用不同名称")
      const record: StoredSecret = {
        id: old?.id ?? randomUUID(),
        botId: value.botId,
        name: value.name,
        description: value.description,
        origin,
        value: value.value,
        revision: (old?.revision ?? 0) + 1,
        updatedAt: this.store.now()
      }
      const next = [...this.items.filter((item) => item.id !== record.id), record]
      await this.persist(next)
      this.items = next
      return metadata(record)
    })
  }

  remove(input: { botId: string; id: string; revision: number }): Promise<void> {
    const value = mutation.parse(input)
    return this.enqueue(async () => {
      this.store.getBot(value.botId)
      this.find(value.botId, value.id, value.revision)
      const next = this.items.filter((item) => item.id !== value.id)
      await this.persist(next)
      this.items = next
    })
  }

  forgetBot(botId: string): Promise<void> {
    identifier.parse(botId)
    return this.enqueue(async () => {
      const next = this.items.filter((item) => item.botId !== botId)
      if (next.length === this.items.length) return
      await this.persist(next)
      this.items = next
    })
  }

  /** Only trusted Host code can consume a value; RPC exposes list/save/remove, never this callback. */
  async use<T>(
    input: { botId: string; id: string; revision: number; origin: string },
    consume: (value: string, assertCurrent: () => void) => Promise<T>
  ): Promise<T> {
    const value = mutation.extend({ origin: z.string().max(8192) }).parse(input)
    const secret = await this.enqueue(async () => {
      const record = this.find(value.botId, value.id, value.revision)
      if (record.origin !== value.origin) throw new Error("凭据不允许用于此网站")
      return record.value
    })
    const check = () => {
      if (this.closed) throw new Error("凭据服务正在关闭")
      this.find(value.botId, value.id, value.revision)
    }
    check()
    return consume(secret, check)
  }

  private find(botId: string, id: string, revision: number): StoredSecret {
    this.store.getBot(botId)
    const item = this.items.find((value) => value.id === id && value.botId === botId)
    if (!item || item.revision !== revision)
      throw new Error("凭据已替换、删除或不属于此 Bot，请刷新后重试")
    return item
  }

  private async persist(items: StoredSecret[]): Promise<void> {
    if (!this.protection) return
    const plain = Buffer.from(JSON.stringify({ version: 1, items }))
    if (plain.length > 1024 * 1024) throw new Error("凭据存储超过 1 MiB 限额")
    let bytes: Buffer
    try {
      bytes = await this.protection.protect(plain)
    } catch {
      throw new Error("凭据加密失败，原有记录未修改")
    } finally {
      plain.fill(0)
    }
    if (!bytes.length || bytes.length > 2 * 1024 * 1024)
      throw new Error("凭据加密结果无效，原有记录未修改")
    await mkdir(dirname(this.path!), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.path!)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.protection?.close?.()
    await this.tail
    this.items = []
  }
}
