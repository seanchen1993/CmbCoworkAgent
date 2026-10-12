import { BotHarnessContextProvider } from "./harness-context-provider"
import { existsSync, statSync } from "node:fs"
import { readBotModelSnapshot } from "./model-config"
import { BotSkillCatalogProcess } from "./skill-catalog-process"
import { assertSkillResources } from "./skill-resource-files"
import {
  botSkillCatalogSources,
  type BotSkillCatalogSources,
  type BotExternalSkill
} from "./skill-catalog-contract"
import type { BotStore } from "./store"

function stamp(path: string): string {
  try {
    const s = statSync(path, { bigint: true })
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
    throw error
  }
}

/** Serial catalog refresh. Config/disable changes fence reads immediately; individual
 * entry changes invalidate an active run before its next privileged action.
 * The old SQLite cache never becomes authoritative merely because a scan failed.
 */
export class BotSkillCatalogSync {
  private inFlight?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private readonly cancellation = new AbortController()
  private source?: BotSkillCatalogSources
  private applied = ""
  private scannedAt = 0
  private readonly harness: BotHarnessContextProvider
  constructor(
    private readonly store: BotStore,
    private readonly modelFile: string,
    private readonly worker = new BotSkillCatalogProcess(),
    harness?: BotHarnessContextProvider
  ) {
    this.harness = harness ?? new BotHarnessContextProvider(modelFile)
    store.externalSkills.bindGuard((skill) => this.assertCurrent(skill))
  }
  private signature(source = this.source): string {
    return JSON.stringify([
      existsSync(`${this.modelFile}.pending`),
      stamp(this.modelFile),
      source ? stamp(source.pluginsStorePath) : null,
      source ? stamp(source.disabledSkillsPath) : null
    ])
  }
  private assertCurrent(skill?: BotExternalSkill): void {
    if (this.cancellation.signal.aborted) throw new Error("技能同步已停止")
    let resourcesChanged = false
    if (skill) {
      try {
        assertSkillResources(skill)
      } catch {
        resourcesChanged = true
      }
    }
    if (
      resourcesChanged ||
      this.signature() !== this.applied ||
      (skill && stamp(skill.filePath) !== skill.fileStamp)
    ) {
      this.store.externalSkills.suspend("技能来源已变化，正在同步；请重新确认所选版本")
      this.scannedAt = 0
      void this.ensure().catch(() => {})
      throw new Error("技能来源已变化，请重新确认所选版本")
    }
  }
  start(): void {
    if (this.timer) return
    void this.ensure().catch(() => {})
    this.timer = setInterval(() => {
      void this.ensure(30_000).catch(() => {})
    }, 2000)
    this.timer.unref()
  }
  async ensure(maxAge = 2000): Promise<void> {
    this.cancellation.signal.throwIfAborted()
    if (this.inFlight) return this.inFlight
    if (
      this.store.externalSkills.status().ready &&
      Date.now() - this.scannedAt < maxAge &&
      this.signature() === this.applied
    )
      return
    const scan = this.refresh()
    this.inFlight = scan.finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }
  private async refresh(): Promise<void> {
    try {
      const modelStamp = stamp(this.modelFile)
      const snapshot = await readBotModelSnapshot(this.modelFile)
      const source = snapshot.skillSources
        ? botSkillCatalogSources.parse(snapshot.skillSources)
        : undefined
      const before = this.signature(source)
      if (modelStamp !== stamp(this.modelFile)) throw new Error("配置在同步期间变化")
      if (before !== this.applied) this.store.externalSkills.suspend("插件技能正在同步")
      const result = source
        ? await this.worker.read(source, this.cancellation.signal)
        : { skills: [], warnings: [], truncated: false }
      this.cancellation.signal.throwIfAborted()
      if (before !== this.signature(source) || existsSync(`${this.modelFile}.pending`))
        throw new Error("配置在同步期间变化")
      this.source = source
      this.applied = before
      await this.harness.refreshSkillScopes(this.store, snapshot, this.cancellation.signal)
      if (before !== this.signature(source)) throw new Error("配置在同步期间变化")
      this.store.externalSkills.apply(result)
      this.scannedAt = Date.now()
    } catch (error) {
      this.store.externalSkills.suspend("插件技能同步失败，已停止使用旧目录；请检查技能设置后重试")
      throw error
    }
  }
  async close(): Promise<void> {
    clearInterval(this.timer)
    this.cancellation.abort(new Error("技能同步已停止"))
    await this.inFlight?.catch(() => {})
  }
}
