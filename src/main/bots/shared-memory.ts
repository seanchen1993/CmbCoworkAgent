import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { z } from "zod"
import {
  BOT_SHARED_MEMORY_LIMIT,
  botSharedMemoryAddress,
  botSharedMemoryDelete,
  botSharedMemorySave,
  type BotSharedMemoryAddress
} from "../../shared/bot-memory"
import { BotDomainError, type BotMemory } from "../../shared/bot-types"
import type { BotStore } from "./store"

const row = z.object({
  id: z.string(),
  scope: z.enum(["user", "project"]),
  project_path: z.string(),
  text: z.string(),
  revision: z.number().int().positive(),
  updated_at: z.number(),
  deleted_at: z.number().nullable()
})
type Receipt = <T>(nonce: string, request: unknown, operation: () => T) => T
type Scope = { address: BotSharedMemoryAddress; path: string; configuredPath: string | null }

/** One local user's authenticated Host owns this store. No request can supply a user
 * identity or arbitrary project path. Future tenant Hosts must retain separate roots.
 * Shared entries are user-authored; private synthesis never reads/writes this table.
 */
export class BotSharedMemories {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: Receipt,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  private async scope(raw: unknown): Promise<Scope> {
    const address = botSharedMemoryAddress.parse(raw),
      bot = this.store.getBot(address.botId)
    if (bot.revision !== address.botRevision) this.changed()
    let path = ""
    if (address.scope === "project") {
      if (!bot.workspacePath || !isAbsolute(bot.workspacePath))
        throw new BotDomainError("memory_project_required", "请先为 Bot 配置项目目录")
      try {
        path = await realpath(bot.workspacePath)
        if (!(await stat(path)).isDirectory()) throw new Error("not a directory")
        if (process.platform === "win32") path = path.toLowerCase()
      } catch {
        throw new BotDomainError(
          "memory_project_unavailable",
          "项目目录无法访问，未读取或修改项目记忆"
        )
      }
    }
    const scope = { address, path, configuredPath: bot.workspacePath }
    this.assertCurrent(scope)
    return scope
  }
  private changed(): never {
    throw new BotDomainError("revision_conflict", "Bot 设置或项目已变化，请刷新后重试")
  }
  private assertCurrent(scope: Scope) {
    const current = this.store.getBot(scope.address.botId)
    if (
      current.revision !== scope.address.botRevision ||
      current.workspacePath !== scope.configuredPath
    )
      this.changed()
  }
  private rows(scope: Scope): BotMemory[] {
    const result = this.store.db.exec(
      "SELECT * FROM bot_shared_memories WHERE scope=? AND project_path=? AND deleted_at IS NULL ORDER BY updated_at,id",
      [scope.address.scope, scope.path]
    )[0]
    return (result?.values ?? []).map((values) => {
      const item = row.parse(
        Object.fromEntries(result!.columns.map((column, i) => [column, values[i]]))
      )
      return {
        id: item.id,
        botId: scope.address.botId,
        scope: item.scope,
        ...(item.scope === "project" ? { projectPath: item.project_path } : {}),
        text: item.text,
        revision: item.revision,
        updatedAt: item.updated_at,
        sourceMessageId: null,
        deletedAt: null,
        origin: "explicit",
        kind: "profile",
        evidence: []
      }
    })
  }
  async list(raw: unknown): Promise<BotMemory[]> {
    const scope = await this.scope(raw)
    this.assertCurrent(scope)
    return this.rows(scope)
  }
  /** Resolve only the current Bot's configured project. Do not inherit a parent
   * Git repository's authority or follow a model-supplied path into another project.
   */
  async visible(botId: string, expectedWorkspace?: string | null): Promise<BotMemory[]> {
    return (await this.reader(botId, expectedWorkspace))()
  }
  async reader(
    botId: string,
    expectedWorkspace?: string | null
  ): Promise<() => Promise<BotMemory[]>> {
    const bot = this.store.getBot(botId)
    if (expectedWorkspace !== undefined && bot.workspacePath !== expectedWorkspace) this.changed()
    const userAddress = { botId, botRevision: bot.revision, scope: "user" as const }
    let project: Scope | undefined
    if (bot.workspacePath) {
      try {
        project = await this.scope({ ...userAddress, scope: "project" })
      } catch (error) {
        // An offline project does not block independent private/user memory work.
        if (!(error instanceof BotDomainError) || error.code !== "memory_project_unavailable")
          throw error
      }
    }
    if (this.store.getBot(botId).revision !== bot.revision) this.changed()
    return async () => {
      const user = await this.scope(userAddress)
      let shared = this.rows(user)
      if (project) {
        const current = await this.scope(project.address)
        // A junction/symlink retarget cannot silently switch an existing run's scope.
        if (current.path !== project.path) this.changed()
        this.assertCurrent(user)
        shared = [...shared, ...this.rows(current)]
      }
      return [
        ...this.store.memories(botId).map((memory) => ({ ...memory, scope: "bot" as const })),
        ...shared
      ]
    }
  }
  async save(raw: unknown): Promise<BotMemory> {
    const input = botSharedMemorySave.parse(raw)
    const scope = await this.scope({
      botId: input.botId,
      botRevision: input.botRevision,
      scope: input.scope
    })
    return this.store.transaction(() => {
      this.assertCurrent(scope)
      return this.receipt(
        input.nonce,
        { op: "shared-memory.save", ...input, projectPath: scope.path },
        () => {
          this.store.assertMutationEpoch(input.expectedDataEpoch)
          const existing = this.rows(scope)
          const old = input.id ? existing.find((item) => item.id === input.id) : undefined
          if (input.id && (!old || old.revision !== input.revision))
            throw new BotDomainError("revision_conflict", "记忆已修改、删除或不属于当前范围")
          if (!old && existing.length >= BOT_SHARED_MEMORY_LIMIT)
            throw new BotDomainError(
              "memory_capacity",
              `此范围最多保存 ${BOT_SHARED_MEMORY_LIMIT} 条共享记忆`
            )
          const id = old?.id ?? randomUUID()
          if (old) {
            this.store.db.run(
              "UPDATE bot_shared_memories SET text=?,revision=revision+1,updated_at=? WHERE id=?",
              [input.text, this.store.now(), id]
            )
            this.store.memory.sharedCorrection(old.text)
          } else {
            this.store.db.run("INSERT INTO bot_shared_memories VALUES(?,?,?, ?,1,?,NULL)", [
              id,
              input.scope,
              scope.path,
              input.text,
              this.store.now()
            ])
          }
          this.event("memory.shared_updated", id, { scope: input.scope })
          return this.rows(scope).find((item) => item.id === id)!
        }
      )
    })
  }
  async remove(raw: unknown): Promise<{ id: string }> {
    const input = botSharedMemoryDelete.parse(raw)
    const scope = await this.scope({
      botId: input.botId,
      botRevision: input.botRevision,
      scope: input.scope
    })
    return this.store.transaction(() => {
      this.assertCurrent(scope)
      return this.receipt(
        input.nonce,
        { op: "shared-memory.delete", ...input, projectPath: scope.path },
        () => {
          this.store.assertMutationEpoch(input.expectedDataEpoch)
          const old = this.rows(scope).find((item) => item.id === input.id)
          if (!old || old.revision !== input.revision)
            throw new BotDomainError("revision_conflict", "记忆已修改、删除或不属于当前范围")
          this.store.db.run(
            "UPDATE bot_shared_memories SET deleted_at=?,revision=revision+1 WHERE id=?",
            [this.store.now(), input.id]
          )
          this.store.memory.sharedCorrection(old.text)
          this.event("memory.shared_deleted", input.id, { scope: input.scope })
          return { id: input.id }
        }
      )
    })
  }
}
