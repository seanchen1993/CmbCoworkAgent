import { join } from "node:path"
import {
  getOpenworkDir,
  getPlugins,
  getPluginsDir,
  invalidateEnabledSkillsCache
} from "../../storage"
import { listLocalThreadRunLeases } from "../../agent/thread-run-lease"
import type { ModsManager } from "../manager"
import type { FunctionModsManager } from "../v2/manager"
import { compileFunctionPlugin } from "../v2/loader"
import { assertFunctionSourcesCurrent } from "../v2/source-adoption-fence"
import { PluginCatalogIndex } from "../../plugins/catalog-index"
import { AuthoringDraftStore } from "./authoring-store"
import { AuthoringVersionRepository } from "./authoring-version-repository"
import { AuthoringInstallService } from "./authoring-install-service"

export function createAuthoringInstallService(
  manager: ModsManager,
  functions: FunctionModsManager
) {
  const versionsRoot = join(getPluginsDir(), ".creator-revisions")
  return new AuthoringInstallService({
    settings: manager.store,
    drafts: new AuthoringDraftStore(manager.store),
    versions: new AuthoringVersionRepository(
      versionsRoot,
      join(__dirname, "mods-authoring-preflight.js")
    ),
    versionsRoot,
    isVersionReferenced: (directory) => functions.referencesSourceDirectory(directory),
    index: new PluginCatalogIndex(join(getOpenworkDir(), "plugins.json")),
    assertIdle: () => {
      if (listLocalThreadRunLeases().length) throw Error("PLUGIN_CATALOG_BUSY")
      manager.assertCatalogIdle()
      functions.assertCatalogIdle()
    },
    changed: () => {
      // Creator packages contain no Skills, shell hooks or MCP declarations.
      invalidateEnabledSkillsCache()
      manager.pluginsChanged()
      functions.invalidateAll()
    },
    inspectNames: async () => {
      const compiled = await Promise.all(
        getPlugins().map(async (plugin) => {
          try {
            return { plugin, compiled: await compileFunctionPlugin(plugin.path) }
          } catch {
            return undefined
          } // Ordinary non-Function plugins retain their existing loader.
        })
      )
      const valid = compiled.filter((item) => item !== undefined)
      return {
        names: valid.map((item) => ({ id: item.plugin.id, name: item.compiled.name })),
        assertCurrent: () => {
          for (const item of valid) assertFunctionSourcesCurrent(item.compiled)
        }
      }
    }
  })
}
