import { createHash } from "node:crypto"
import { BotDomainError, type BotSkill, type BotSkillSummary } from "../../shared/bot-types"
import {
  botExternalSkill,
  botSkillCatalogSnapshot,
  type BotExternalSkill,
  type BotSkillCatalogSnapshot
} from "./skill-catalog-contract"
import type { BotStore } from "./store"
import {
  isSkillVisibleForProjectMode,
  type ProjectModeSkillScope
} from "../../shared/skill-visibility"
import { botHarnessSkillScopeSchema } from "./harness-context-contract"
import { assertBotHarnessContext } from "./harness-context-provider"

/** Read-only cache of the installed Cmb catalog. Only the Host synchronizer writes it;
 * renderer/model mutations still target private skills or the explicit user library.
 */
export class BotExternalSkills {
  private available = false
  private guard: ((skill?: BotExternalSkill) => void) | undefined
  private warning = "插件技能尚未同步"
  constructor(private readonly store: BotStore) {}

  bindGuard(guard: (skill?: BotExternalSkill) => void): void {
    this.guard = guard
  }
  suspend(reason: string): void {
    this.available = false
    this.warning = reason
  }
  status(): { ready: boolean; warning: string | null } {
    return { ready: this.available, warning: this.warning || null }
  }

  apply(raw: BotSkillCatalogSnapshot): void {
    const snapshot = botSkillCatalogSnapshot.parse(raw)
    this.store.transaction(() => {
      const existing = new Map(
        (
          this.store.db.exec("SELECT id,digest,version,enabled FROM bot_external_skills")[0]
            ?.values ?? []
        ).map((row) => [String(row[0]), row])
      )
      const retained = new Set<string>()
      for (const skill of snapshot.skills) {
        if (retained.has(skill.id)) throw new Error("技能目录包含重复身份")
        retained.add(skill.id)
        const payload = JSON.stringify(skill),
          digest = createHash("sha256").update(payload).digest("hex"),
          old = existing.get(skill.id)
        const version = old ? Number(old[2]) + Number(old[1] !== digest || !old[3]) : 1
        this.store.db.run(
          `INSERT INTO bot_external_skills VALUES(?,?,?,?,1,?,?)
          ON CONFLICT(id) DO UPDATE SET digest=excluded.digest,version=excluded.version,payload=excluded.payload,enabled=1,name=excluded.name,source_name=excluded.source_name`,
          [skill.id, digest, version, payload, skill.name, skill.pluginName ?? "CMBDevClaw 技能"]
        )
        this.store.db.run(
          "INSERT INTO bot_external_skill_visibility VALUES(?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET plugin_id=excluded.plugin_id,plugin_name=excluded.plugin_name,is_project_mode=excluded.is_project_mode",
          [
            skill.id,
            skill.pluginId,
            skill.pluginName,
            Number(skill.isProjectModePlugin ?? Boolean(skill.pluginId))
          ]
        )
      }
      for (const [id, row] of existing)
        if (!retained.has(id) && row[3])
          this.store.db.run(
            "UPDATE bot_external_skills SET enabled=0,version=version+1,payload='' WHERE id=?",
            [id]
          )
    })
    this.available = true
    this.warning = snapshot.warnings.join("\n")
  }

  private check(skill?: BotExternalSkill): void {
    if (!this.available)
      throw new BotDomainError("skill_catalog_unavailable", this.warning || "插件技能正在同步")
    try {
      this.guard?.(skill)
    } catch (error) {
      if (error instanceof BotDomainError) throw error
      throw new BotDomainError(
        "skill_catalog_unavailable",
        error instanceof Error ? error.message : "技能目录暂不可用"
      )
    }
  }
  private scope(botId: string): ProjectModeSkillScope {
    const bot = this.store.getBot(botId)
    if (!bot.harnessBinding) return { projectMode: false }
    const row = this.store.db.exec("SELECT scope FROM bot_harness_skill_scopes WHERE bot_id=?", [
      botId
    ])[0]?.values[0]
    if (row) {
      try {
        const saved = botHarnessSkillScopeSchema.parse(JSON.parse(String(row[0])))
        assertBotHarnessContext(saved)
        if (
          JSON.stringify(saved.binding) === JSON.stringify(bot.harnessBinding) &&
          saved.workspacePath === bot.workspacePath
        )
          return {
            projectMode: true,
            boundPluginId: saved.pluginId,
            boundPluginName: saved.pluginName
          }
      } catch {
        /* No project-mode skill grant from stale or incomplete preparation. */
      }
    }
    return { projectMode: true }
  }
  list(botId: string): BotSkillSummary[] {
    this.store.getBot(botId)
    try {
      this.check()
    } catch {
      return []
    }
    const verified = this.store.skillLibrary.verifiedVersions(botId)
    const scope = this.scope(botId)
    return (
      this.store.db.exec(
        "SELECT s.id,s.name,s.version,s.source_name,v.plugin_id,v.plugin_name,v.is_project_mode FROM bot_external_skills s LEFT JOIN bot_external_skill_visibility v ON v.skill_id=s.id WHERE s.enabled=1 ORDER BY s.id"
      )[0]?.values ?? []
    )
      .filter((row) =>
        isSkillVisibleForProjectMode(
          {
            pluginId: row[4] == null ? null : String(row[4]),
            pluginName: row[5] == null ? null : String(row[5]),
            isProjectModePlugin: row[6] == null ? Boolean(row[4]) : Boolean(row[6])
          },
          scope
        )
      )
      .map(([id, name, version, sourceName]) => ({
        id: String(id),
        botId,
        name: String(name),
        version: Number(version),
        sourceName: String(sourceName),
        enabled: true,
        verified: verified.has(`${id}@${version}`),
        createdAt: 0,
        scope: "desktop"
      }))
  }
  current(botId: string, id: string, version?: number): BotSkill {
    const { item, revision } = this.resolve(botId, id, version)
    return this.project(botId, item, revision)
  }
  /** Host-only source capability. Never expose absolute source paths over RPC. */
  source(botId: string, id: string, version: number): BotExternalSkill {
    return this.resolve(botId, id, version).item
  }
  private resolve(
    botId: string,
    id: string,
    version?: number
  ): { item: BotExternalSkill; revision: number } {
    this.store.getBot(botId)
    this.check()
    const row = this.store.db.exec(
      "SELECT payload,version FROM bot_external_skills WHERE id=? AND enabled=1",
      [id]
    )[0]?.values[0]
    if (!row) throw new BotDomainError("skill_unavailable", "插件技能已停用、卸载或不可用")
    const item = botExternalSkill.parse(JSON.parse(String(row[0])))
    if (
      !isSkillVisibleForProjectMode(
        { ...item, isProjectModePlugin: item.isProjectModePlugin ?? Boolean(item.pluginId) },
        this.scope(botId)
      )
    )
      throw new BotDomainError("skill_scope", "此项目未绑定该项目插件，不能使用此技能")
    this.check(item)
    if (version !== undefined && Number(row[1]) !== version)
      throw new BotDomainError("skill_changed", "插件技能已有新版本，请确认后重新选择")
    return { item, revision: Number(row[1]) }
  }
  private project(botId: string, item: BotExternalSkill, version: number): BotSkill {
    return {
      id: item.id,
      botId,
      name: item.name,
      instructions: item.instructions,
      version,
      enabled: true,
      verified: this.store.skillLibrary.verified(botId, item.id, version),
      createdAt: 0,
      scope: "desktop",
      resourceCount: item.resources.filter(
        (entry) => entry.kind === "file" && entry.path !== "SKILL.md"
      ).length,
      compatibility: item.compatibility,
      sourceName: item.pluginName ?? "CMBDevClaw 技能"
    }
  }
}
