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
import { botIdentifier, parseBotMemoryScope } from "../../shared/bots/validation"
import type { MemoryOperation } from "../memory/summarizer"

import {
  botMemoryVisible,
  type BotMemoryContext,
  type BotMemoryScope
} from "../../shared/bots/memory-scope"

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
  list(botId: string, context?: BotMemoryContext): BotMemory[] {
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
          version: digest(text),
          scope: this.scopeFromFile(parsed.frontmatter)
        }
      })
      .filter((entry) => !context || botMemoryVisible(entry, context))
  }
  private scopeFromFile(header: Record<string, string>): BotMemoryScope {
    if (!header.bot_scope) return { kind: "private" }
    return parseBotMemoryScope({ kind: header.bot_scope, groupId: header.bot_group_id })
  }
  /** Fresh per-run snapshot, newest first like the original memory manifest. No second cache. */
  forPrompt(botId: string, context: BotMemoryContext = {}): BotMemory[] {
    const directory = this.directory(botId)
    return this.list(botId, context)
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

  writeInContext(botId: string, input: WriteBotMemoryInput, context: BotMemoryContext): BotMemory {
    const prior = input.id
      ? this.list(botId, context).find((entry) => entry.id === input.id)
      : undefined
    if (input.id && !prior) throw new BotError("NOT_FOUND", "当前会话没有这条记忆")
    const scope =
      input.scope ??
      prior?.scope ??
      (context.groupId
        ? { kind: "group" as const, groupId: context.groupId }
        : { kind: "private" as const })
    if (
      context.groupId &&
      (scope.kind !== "group" ||
        scope.groupId !== context.groupId ||
        prior?.scope?.kind === "shared")
    )
      throw new BotError("CONFLICT", "群聊只能修改本群记忆；Bot 共享记忆请在记忆面板中管理")
    if (!context.groupId && scope.kind === "group")
      throw new BotError("CONFLICT", "请在对应群聊中保存群内记忆")
    return this.write(botId, { ...input, scope })
  }
  removeInContext(botId: string, id: string, version: string, context: BotMemoryContext): void {
    const entry = this.list(botId, context).find((entry) => entry.id === id)
    if (!entry) throw new BotError("NOT_FOUND", "当前会话没有这条记忆")
    if (context.groupId && entry.scope?.kind === "shared")
      throw new BotError("CONFLICT", "请在记忆面板中管理 Bot 共享记忆")
    this.remove(botId, id, version)
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
    const before = this.list(botId).filter(
        (entry) => (entry.scope?.kind ?? "private") === "private"
      ),
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
          [...known.values()].some((item) => item.content.trim() === content.trim())
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
    const priorScope = input.id
      ? this.scopeFromFile(parseFrontmatter(this.readFile(file)).frontmatter)
      : undefined
    const scope = parseBotMemoryScope(input.scope ?? priorScope ?? { kind: "private" })
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
    const header = buildFrontmatter({ name, description: name, type: "reference" })
    const text =
      header.replace(
        "\n---\n\n",
        `\nbot_scope: ${scope.kind}\n${scope.kind === "group" ? `bot_group_id: ${scope.groupId}\n` : ""}---\n\n`
      ) +
      content +
      "\n"
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
    return { id, name, content, version: digest(text), scope }
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
  async search(
    botId: string,
    query: string,
    context: BotMemoryContext = {}
  ): Promise<Array<{ id: string; text: string }>> {
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
      const visible = this.list(botId, context)
      return store
        .search(query, 5, {
          allowedPaths: visible.map((entry) => join(directory, `${entry.id}.md`))
        })
        .map((result) => {
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
