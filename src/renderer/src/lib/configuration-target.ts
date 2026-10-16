import { useEffect, useState, useSyncExternalStore } from "react"
import { isOrdinaryFlowMetadata } from "../../../shared/mods/flows/scope"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import { useAppStore } from "@/lib/store"

export type ConfigurationScope = { threadId: string | null; workspace: string | null }
export type ConfigurationThread = { thread_id: string; title?: string | null; metadata?: unknown }
type Target = ConfigurationScope & { session: number; generation: number }
let target: Target | null = null
let sequence = 0
const listeners = new Set<() => void>()
const drafts = new Map<symbol, { scope: ConfigurationScope; dirty: boolean; busy: boolean }>()
const notify = () => { for (const listener of listeners) listener() }
export function configurationWorkspace(thread: ConfigurationThread | undefined): string | null {
  const metadata = thread?.metadata as { workspacePath?: unknown } | undefined
  return typeof metadata?.workspacePath === "string" && metadata.workspacePath.trim()
    ? metadata.workspacePath : null
}
export function supportsConfiguration(thread: ConfigurationThread): boolean {
  return !!configurationWorkspace(thread) && isOrdinaryFlowMetadata(thread.metadata)
}
export function sameConfigurationScope(a: ConfigurationScope, b: ConfigurationScope): boolean {
  return a.threadId === b.threadId &&
    normalizeWorkspacePathKey(a.workspace) === normalizeWorkspacePathKey(b.workspace)
}
export function configurationTargetValid(scope: ConfigurationScope, threads: ConfigurationThread[]) {
  const row = threads.find((item) => item.thread_id === scope.threadId)
  return !!row && supportsConfiguration(row) &&
    sameConfigurationScope(scope, { threadId: row.thread_id, workspace: configurationWorkspace(row) })
}
export function beginConfigurationTarget(scope: ConfigurationScope): () => void {
  const session = ++sequence
  target = { ...scope, session, generation: 0 }
  notify()
  return () => {
    if (target?.session === session) { target = null; notify() }
  }
}
export function readConfigurationTarget() { return target }
export function useConfigurationTarget() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, readConfigurationTarget)
}
export function chooseConfigurationTarget(scope: ConfigurationScope): string | null {
  if (!target) return "配置页面已关闭，请重新打开。"
  if (sameConfigurationScope(target, scope)) return null
  if (!configurationTargetValid(scope, useAppStore.getState().threads))
    return "这段聊天已不可用，请重新选择。"
  const currentDrafts = [...drafts.values()].filter((item) => sameConfigurationScope(item.scope, target!))
  if (currentDrafts.some((item) => item.busy)) return "当前操作尚未结束，请稍后切换配置聊天。"
  if (currentDrafts.some((item) => item.dirty) &&
      !window.confirm("当前配置有未保存的改动。切换聊天会丢弃这些草稿，是否继续？")) return ""
  target = { ...target, ...scope, generation: target.generation + 1 }
  notify()
  return null
}
/** Register actual local edits, including editors retained behind another tab. */
export function useConfigurationDraft(scope: ConfigurationScope, dirty: boolean, busy = false) {
  const [owner] = useState(() => Symbol("configuration-draft"))
  useEffect(() => {
    drafts.set(owner, { scope, dirty, busy })
    return () => { drafts.delete(owner) }
  }, [owner, scope.threadId, scope.workspace, dirty, busy])
}
export function isConfigurationScopeCurrent(scope: ConfigurationScope): boolean {
  const store = useAppStore.getState()
  if (target && store.showCustomizeView) {
    return sameConfigurationScope(target, scope) && configurationTargetValid(scope, store.threads)
  }
  const row = store.threads.find((item) => item.thread_id === store.currentThreadId)
  return sameConfigurationScope(scope, {
    threadId: store.currentThreadId, workspace: configurationWorkspace(row)
  })
}
export function captureConfigurationScope(scope: ConfigurationScope): () => boolean {
  const captured = target
  return () => (captured === null ||
    (target?.session === captured.session && target.generation === captured.generation)) &&
    isConfigurationScopeCurrent(scope)
}
/** User-requested navigation only; selectThread updates its target synchronously. */
export function goToConfigurationThread(
  scope: ConfigurationScope,
  after?: () => void,
  destinationId = scope.threadId
): boolean {
  if (!destinationId || !isConfigurationScopeCurrent(scope)) return false
  const store = useAppStore.getState()
  const destination = store.threads.find((item) => item.thread_id === destinationId)
  if (target && (!destination || !supportsConfiguration(destination))) return false
  if (store.currentThreadId !== destinationId) void store.selectThread(destinationId)
  else store.setShowCustomizeView(false)
  after?.()
  return true
}
