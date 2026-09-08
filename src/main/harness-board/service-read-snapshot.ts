export interface HarnessConfigReadSnapshot<TConfig> {
  value: TConfig | null
  error: Error | null
}

export interface HarnessPluginReadSnapshot<TPlugin, TConfig> {
  plugins: readonly TPlugin[]
  configByPath: ReadonlyMap<string, HarnessConfigReadSnapshot<TConfig>>
  pluginByAdapterId: ReadonlyMap<string, TPlugin>
  pluginByName: ReadonlyMap<string, TPlugin>
}

interface CreateHarnessPluginReadSnapshotOptions<TPlugin, TConfig> {
  plugins: readonly TPlugin[]
  getPath: (plugin: TPlugin) => string
  getAdapterId: (plugin: TPlugin) => string
  getName: (plugin: TPlugin) => string
  hasBoardConfig: (plugin: TPlugin) => boolean
  readBoardConfig: (plugin: TPlugin) => TConfig | null
}

function setFirst<T>(map: Map<string, T>, key: string, value: T): void {
  if (key && !map.has(key)) map.set(key, value)
}

/**
 * Captures the installed plugin catalog and every board config once for one service request.
 * Project lookups then stay in-memory instead of re-reading plugins.json and board_config.json.
 */
export function createHarnessPluginReadSnapshot<TPlugin, TConfig>({
  plugins,
  getPath,
  getAdapterId,
  getName,
  hasBoardConfig,
  readBoardConfig
}: CreateHarnessPluginReadSnapshotOptions<TPlugin, TConfig>): HarnessPluginReadSnapshot<
  TPlugin,
  TConfig
> {
  const boardPlugins: TPlugin[] = []
  const configByPath = new Map<string, HarnessConfigReadSnapshot<TConfig>>()
  const pluginByAdapterId = new Map<string, TPlugin>()
  const pluginByName = new Map<string, TPlugin>()

  for (const plugin of plugins) {
    if (!hasBoardConfig(plugin)) continue
    boardPlugins.push(plugin)
    setFirst(pluginByAdapterId, getAdapterId(plugin), plugin)
    setFirst(pluginByName, getName(plugin), plugin)

    const path = getPath(plugin)
    if (configByPath.has(path)) continue
    try {
      configByPath.set(path, { value: readBoardConfig(plugin), error: null })
    } catch (error) {
      configByPath.set(path, {
        value: null,
        error: error instanceof Error ? error : new Error(String(error))
      })
    }
  }

  return {
    plugins: boardPlugins,
    configByPath,
    pluginByAdapterId,
    pluginByName
  }
}

export function findHarnessPluginInReadSnapshot<TPlugin, TConfig>(
  snapshot: HarnessPluginReadSnapshot<TPlugin, TConfig>,
  adapter: { id?: unknown; name?: unknown }
): TPlugin | null {
  const adapterId = typeof adapter.id === "string" ? adapter.id.trim() : ""
  if (adapterId) {
    const plugin = snapshot.pluginByAdapterId.get(adapterId)
    if (plugin) return plugin
  }

  const adapterName = typeof adapter.name === "string" ? adapter.name.trim() : ""
  return (adapterName && snapshot.pluginByName.get(adapterName)) || null
}
