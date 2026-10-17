import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { join } from "node:path"
import { rm } from "node:fs/promises"
import { MemoryStore } from "../memory/store"
import { buildFrontmatter, parseFrontmatter } from "../memory/manifest"
import { botDirectory } from "./paths"
import { BotError, type BotMemory, type WriteBotMemoryInput } from "../../shared/bots/contracts"
import { botIdentifier } from "../../shared/bots/validation"
import type { MemoryOperation } from "../memory/summarizer"

const MAX_FILE_BYTES = 48_000
const digest = (text: string) => createHash("sha256").update(text).digest("hex")

/** Reuses the existing memory index; file identities stay relative to this Bot. */
export class BotMemoryService {
  private readonly indexes = new Map<string, Promise<MemoryStore>>()
  private readonly users = new Map<string, number>()
  private stopping = false
  private readonly retiredBots = new Set<string>()
  private readonly edits = new Map<string, number>()
  constructor(
    private readonly root: string,
    private readonly onChanged: (botId: string) => void = () => {}
  ) {}

  private changed(botId: string): void {
    try {
      this.onChanged(botId)
    } catch (error) {
      // A failed observer must not turn an already committed write into a failed tool call.
      console.warn("[Bots] Failed to notify a memory change:", error)
    }
  }

  private directory(botId: string): string {
    if (this.retiredBots.has(botId)) throw new BotError("NOT_FOUND", "Bot 已删除")
    return botDirectory(this.root, "memories", botId)
  }
  private file(botId: string, id: string): string {
    return join(this.directory(botId), `${botIdentifier(id)}.md`)
  }
  private readFile(path: string): string {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES)
      throw new BotError("INVALID_INPUT", "记忆文件格式或大小不受支持")
    return readFileSync(path, "utf8")
  }
  list(botId: string): BotMemory[] {
    const directory = this.directory(botId)
    const files = readdirSync(directory).filter((name) => name.endsWith(".md"))
    if (files.length > 201) throw new BotError("CONFLICT", "记忆数量已达上限，请先整理")
    // The reused index scans every Markdown file, including the manifest.
    for (const name of files) {
      if (!/^[a-zA-Z0-9_-]+\.md$/.test(name)) throw new BotError("INVALID_INPUT", "记忆文件名无效")
      this.readFile(join(directory, name))
    }
    const index = join(directory, "index.sqlite")
    if (
      existsSync(index) &&
      (lstatSync(index).isSymbolicLink() || lstatSync(index).size > 32 * 1024 * 1024)
    )
      throw new BotError("INVALID_INPUT", "记忆索引无效")
    return files
      .filter((name) => name !== "MEMORY.md")
      .map((name) => {
        const text = this.readFile(join(directory, name)),
          parsed = parseFrontmatter(text)
        return {
          id: name.slice(0, -3),
          name: parsed.frontmatter.name ?? name,
          content: parsed.body,
          version: digest(text)
        }
      })
  }
  /** Fresh per-run snapshot, newest first like the original memory manifest. No second cache. */
  forPrompt(botId: string): BotMemory[] {
    const directory = this.directory(botId)
    return this.list(botId)
      .map((entry) => ({ entry, modified: lstatSync(join(directory, `${entry.id}.md`)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified || a.entry.id.localeCompare(b.entry.id))
      .map(({ entry }) => entry)
  }
  write(botId: string, input: WriteBotMemoryInput): BotMemory {
    const result = this.persist(botId, input)
    this.edits.set(botId, this.editVersion(botId) + 1)
    this.changed(botId)
    return result
  }

  editVersion(botId: string): number {
    return this.edits.get(botId) ?? 0
  }
  summaryDirectory(botId: string): string {
    this.list(botId)
    return this.directory(botId)
  }

  /** Synchronous commit: a user edit/delete while the model was working invalidates the summary. */
  applySummary(
    botId: string,
    expectedEditVersion: number,
    operations: readonly MemoryOperation[]
  ): void {
    if (
      this.stopping ||
      this.retiredBots.has(botId) ||
      this.editVersion(botId) !== expectedEditVersion
    )
      return
    const before = this.list(botId),
      known = new Map(before.map((item) => [`${item.id}.md`, item]))
    let committed = false
    try {
      for (const operation of operations.slice(0, 24)) {
        if (operation.action === "skip") continue
        const prior = operation.action === "update" ? known.get(operation.filename) : undefined
        if (operation.action === "update" && !prior) continue
        const name = (operation.name || prior?.name || "记忆").slice(0, 120),
          content = operation.content.slice(0, 12_000)
        if (
          operation.action === "create" &&
          this.list(botId).some((item) => item.content === content)
        )
          continue
        const saved = this.persist(botId, {
          ...(prior ? { id: prior.id, expectedVersion: prior.version } : {}),
          name,
          content
        })
        known.set(`${saved.id}.md`, saved)
        committed = true
      }
    } finally {
      if (committed) this.changed(botId)
    }
  }

  private persist(botId: string, input: WriteBotMemoryInput): BotMemory {
    if (this.stopping) throw new BotError("STOPPING", "记忆服务正在退出")
    const id = input.id ?? randomUUID(),
      file = this.file(botId, id)
    if (input.id) {
      if (digest(this.readFile(file)) !== input.expectedVersion)
        throw new BotError("CONFLICT", "记忆已被更新，请刷新后修改")
    } else if (this.list(botId).length >= 200)
      throw new BotError("CONFLICT", "记忆数量已达上限，请先整理")
    const name = input.name.trim(),
      content = input.content.trim()
    if (
      !name ||
      name.length > 120 ||
      !content ||
      content.length > 12_000 ||
      /\0/.test(name + content)
    )
      throw new BotError("INVALID_INPUT", "记忆名称或内容无效")
    const text = buildFrontmatter({ name, description: name, type: "reference" }) + content + "\n"
    if (Buffer.byteLength(text) > MAX_FILE_BYTES)
      throw new BotError("INVALID_INPUT", "记忆内容过长")
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, text, { flag: "wx", mode: 0o600 })
      renameSync(temporary, file)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        /* Atomic rename already removed it. */
      }
    }
    return { id, name, content, version: digest(text) }
  }
  remove(botId: string, id: string, expectedVersion: string): void {
    const file = this.file(botId, id)
    if (digest(this.readFile(file)) !== expectedVersion)
      throw new BotError("CONFLICT", "记忆已被更新，请刷新后删除")
    unlinkSync(file)
    this.edits.set(botId, this.editVersion(botId) + 1)
    this.changed(botId)
  }
  share(botId: string, id: string, expectedVersion: string, targetBotId: string): BotMemory {
    if (botId === targetBotId) throw new BotError("INVALID_INPUT", "请选择其他 Bot")
    const entry = this.list(botId).find((item) => item.id === botIdentifier(id))
    if (!entry) throw new BotError("NOT_FOUND", "记忆已不存在，请刷新")
    if (entry.version !== expectedVersion)
      throw new BotError("CONFLICT", "记忆已更新，请刷新后分享")
    return this.write(targetBotId, { name: entry.name, content: entry.content })
  }
  async search(botId: string, query: string): Promise<Array<{ id: string; text: string }>> {
    if (this.stopping) throw new BotError("STOPPING", "记忆服务正在退出")
    if (!query.trim() || query.length > 1000) throw new BotError("INVALID_INPUT", "搜索内容无效")
    // Validate the directory contents before the reused index follows any file paths.
    this.list(botId)
    let pending = this.indexes.get(botId)
    if (!pending) {
      if (this.indexes.size >= 8) throw new BotError("CONFLICT", "记忆服务繁忙，请稍后重试")
      const store = new MemoryStore(this.directory(botId))
      pending = store
        .init()
        .then(() => store)
        .catch(async (error) => {
          await store.close()
          this.indexes.delete(botId)
          throw error
        })
      this.indexes.set(botId, pending)
    }
    this.users.set(botId, (this.users.get(botId) ?? 0) + 1)
    try {
      const store = await pending
      store.syncMemoryFiles()
      const directory = this.directory(botId)
      return store.search(query, 5).map((result) => {
        // Never return an absolute host path as a remotely meaningful identity.
        const name = result.path.startsWith(directory + "/")
          ? result.path.slice(directory.length + 1)
          : result.path.split(/[\\/]/).at(-1)!
        return { id: name.replace(/\.md$/, ""), text: result.text.slice(0, 1500) }
      })
    } finally {
      this.users.set(botId, Math.max(0, (this.users.get(botId) ?? 1) - 1))
      await this.evict()
    }
  }
  private async evict(): Promise<void> {
    for (const [id, store] of this.indexes) {
      if (this.indexes.size < 4) break
      if (this.users.get(id)) continue
      this.indexes.delete(id)
      this.users.delete(id)
      await (await store).close()
    }
  }
  async removeBot(botId: string): Promise<void> {
    // Resolve the host-owned path before retirement, including on a cleanup retry.
    const directory = botDirectory(this.root, "memories", botId)
    this.retiredBots.add(botId)
    this.edits.set(botId, this.editVersion(botId) + 1)
    const index = this.indexes.get(botId)
    if (index) {
      await (await index).close()
      this.indexes.delete(botId)
      this.users.delete(botId)
    }
    await rm(directory, { recursive: true, force: true })
  }
  async close(): Promise<void> {
    this.stopping = true
    await Promise.all([...this.indexes.values()].map(async (store) => (await store).close()))
    this.indexes.clear()
    this.users.clear()
    this.edits.clear()
  }
}
