import { useSyncExternalStore } from "react"
import { useAppStore } from "./store"
import type { PluginDerivationScope } from "../../../shared/plugin-derivation"
import type { HarnessProjectListItem } from "../../../shared/harness-board-types"
import { isConfigurationScopeCurrent } from "./configuration-target"

type Intent = { id: string; pluginId: string; name: string; scope?: PluginDerivationScope; projectId?: string }
let pending: Intent | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function openDerivedProject(
  pluginId: string,
  name: string,
  scope?: PluginDerivationScope
): void {
  pending = { id: crypto.randomUUID(), pluginId, name, scope }
  const store = useAppStore.getState()
  store.setShowCustomizeView(false)
  store.setShowHarnessBoardView(true)
  for (const listener of listeners) listener()
}
/** Navigate to one existing project; the board rechecks both project and plugin identities. */
export function openExistingPluginProject(
  project: HarnessProjectListItem,
  scope: PluginDerivationScope
): void {
  if (!isConfigurationScopeCurrent({ threadId: scope.threadId, workspace: scope.expectedWorkspace }))
    throw Error("原聊天或项目目录已改变，请回到项目重新打开。")
  if (!project.projectId || project.harnessAdapter?.type !== "plugin" || !project.harnessAdapter.id)
    throw Error("项目的插件归属未确认，请刷新项目列表。")
  pending = {
    id: crypto.randomUUID(), pluginId: project.harnessAdapter.id,
    name: project.name, scope, projectId: project.projectId
  }
  const store = useAppStore.getState()
  store.setShowCustomizeView(false)
  store.setShowHarnessBoardView(true)
  for (const listener of listeners) listener()
}
export function dismissDerivedProject(id: string): void {
  if (pending?.id !== id) return
  pending = null
  for (const listener of listeners) listener()
}
export const useDerivedProjectIntent = () => useSyncExternalStore(subscribe, () => pending)
