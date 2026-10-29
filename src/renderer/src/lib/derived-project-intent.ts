import { useSyncExternalStore } from "react"
import { useAppStore } from "./store"
import type { PluginDerivationScope } from "../../../shared/plugin-derivation"
import type { HarnessProjectListItem } from "../../../shared/harness-board-types"
import { configurationTargetValid, isConfigurationScopeCurrent } from "./configuration-target"

export interface DerivedProjectIntent {
  id: string
  accountRevision: number
  pluginId: string
  name: string
  scope?: PluginDerivationScope
  projectId?: string
}
let pending: DerivedProjectIntent | null = null
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
  const store = useAppStore.getState()
  pending = {
    id: crypto.randomUUID(),
    accountRevision: store.accountRevision,
    pluginId,
    name,
    ...(scope ? { scope: { ...scope } } : {})
  }
  store.setShowCustomizeView(false)
  store.setShowHarnessBoardView(true)
  for (const listener of listeners) listener()
}
/** Navigate to one existing project; the board rechecks both project and plugin identities. */
export function openExistingPluginProject(
  project: HarnessProjectListItem,
  scope: PluginDerivationScope
): void {
  if (
    !isConfigurationScopeCurrent({ threadId: scope.threadId, workspace: scope.expectedWorkspace })
  )
    throw Error("原聊天或项目目录已改变，请回到项目重新打开。")
  if (!project.projectId || project.harnessAdapter?.type !== "plugin" || !project.harnessAdapter.id)
    throw Error("项目的插件归属未确认，请刷新项目列表。")
  const store = useAppStore.getState()
  pending = {
    id: crypto.randomUUID(),
    pluginId: project.harnessAdapter.id,
    accountRevision: store.accountRevision,
    name: project.name,
    scope: { ...scope },
    projectId: project.projectId
  }
  store.setShowCustomizeView(false)
  store.setShowHarnessBoardView(true)
  for (const listener of listeners) listener()
}
export function dismissDerivedProject(id: string): void {
  if (pending?.id !== id) return
  pending = null
  for (const listener of listeners) listener()
}

/** A consumed source stays checkable while its form is open; pending identity is checked separately. */
export function derivedProjectIntentCurrent(intent: DerivedProjectIntent): boolean {
  const store = useAppStore.getState()
  return (
    store.accountRevision === intent.accountRevision &&
    (!intent.scope ||
      configurationTargetValid(
        { threadId: intent.scope.threadId, workspace: intent.scope.expectedWorkspace },
        store.threads
      ))
  )
}

/** Claim once before opening a form; neither rerenders nor a late result can replay this request. */
export function consumeDerivedProjectIntent(
  intent: DerivedProjectIntent
): DerivedProjectIntent | null {
  if (pending?.id !== intent.id) return null
  const current = derivedProjectIntentCurrent(pending) ? pending : null
  dismissDerivedProject(intent.id)
  return current
}

export const readDerivedProjectIntent = () => pending
export const useDerivedProjectIntent = () =>
  useSyncExternalStore(subscribe, readDerivedProjectIntent)
