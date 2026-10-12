import { join } from "node:path"
import { BotUtilityProcess, type BotUtilityLauncher } from "./utility-process"
import {
  botSkillCatalogSnapshot,
  botSkillCatalogSources,
  type BotSkillCatalogSources,
  type BotSkillCatalogSnapshot
} from "./skill-catalog-contract"

export class BotSkillCatalogProcess {
  private readonly process: BotUtilityProcess
  constructor(launcher: BotUtilityLauncher = { entry: join(__dirname, "bot-skill-catalog.js") }) {
    this.process = new BotUtilityProcess(launcher, "技能同步", 30_000)
  }
  read(source: BotSkillCatalogSources, signal: AbortSignal): Promise<BotSkillCatalogSnapshot> {
    return this.process.invoke(
      botSkillCatalogSources.parse(source),
      (value) => botSkillCatalogSnapshot.parse(value),
      signal
    )
  }
}
