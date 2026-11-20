export interface HookCatalogIdentityInput {
  source: "global" | "workspace" | "plugin" | "skill"
  id: string
  pluginId?: string
  pluginName?: string
  pluginRoot?: string
  skillPath?: string
  skillName?: string
  hookPath?: string
  hookSourcePath?: string
}

function normalizeIdentityPath(value: string | undefined): string {
  return (value ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * Display-only identity for catalog rows. Runtime ids deliberately remain
 * untouched because they back once/persistence state and historical logs.
 */
export function getHookCatalogIdentity(hook: HookCatalogIdentityInput): string {
  const pluginOwner = hook.pluginId
    ? `id:${hook.pluginId}`
    : normalizeIdentityPath(hook.pluginRoot)
      ? `path:${normalizeIdentityPath(hook.pluginRoot)}`
      : hook.pluginName
        ? `name:${hook.pluginName}`
        : ""
  const skillPath = normalizeIdentityPath(hook.skillPath)
  const skillOwner = skillPath ? `path:${skillPath}` : hook.skillName ? `name:${hook.skillName}` : ""
  return JSON.stringify([
    hook.source,
    pluginOwner,
    skillOwner,
    normalizeIdentityPath(hook.hookPath ?? hook.hookSourcePath),
    hook.id
  ])
}
