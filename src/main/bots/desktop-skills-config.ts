import { join } from "node:path"
import { getCatalogSourcePaths } from "../catalog-source-paths"
import { getHookCatalogGlobalRevision } from "../hook-catalog/revision"
import { getDisabledSkillStoreRevision } from "../skills/disabled-store-revision"
import { waitForSkillCatalogTopologyIdle } from "../skill-plugin-catalog/topology-mutation-gate"
import type { BotSkillCatalogSources } from "./skill-catalog-contract"

export async function desktopBotSkillSources(): Promise<BotSkillCatalogSources> {
  const paths = await getCatalogSourcePaths()
  await waitForSkillCatalogTopologyIdle()
  return {
    builtinSkillsDir: paths.builtinSkillsDir,
    customSkillsDir: paths.customSkillsDir,
    pluginsStorePath: join(paths.openworkDir, "plugins.json"),
    disabledSkillsPath: join(paths.openworkDir, "disabled-skills.json"),
    disabledSkillsRevision: getDisabledSkillStoreRevision(),
    globalRevision: getHookCatalogGlobalRevision()
  }
}
