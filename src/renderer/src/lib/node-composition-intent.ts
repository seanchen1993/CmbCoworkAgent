import { useSyncExternalStore } from "react"
import type { NativeNodePlan } from "../../../shared/node-composition"
import type { PluginDerivationScope } from "../../../shared/plugin-derivation"
import { useAppStore } from "./store"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

export interface NativeNodeIntent {
  id: string
  scope: PluginDerivationScope
  plan: NativeNodePlan
}
let pending: NativeNodeIntent | null = null
const listeners = new Set<() => void>()
export async function openNativeNodePlan(scope: PluginDerivationScope, plan: NativeNodePlan) {
  const source = useAppStore
    .getState()
    .threads.find((thread) => thread.thread_id === scope.threadId)
  if (
    !isSameWorkspacePath(
      typeof source?.metadata?.workspacePath === "string" ? source.metadata.workspacePath : null,
      scope.expectedWorkspace
    )
  )
    throw new Error("原聊天或项目目录已改变，请回到项目重新选择步骤。")
  // Opening the board clears currentThreadId. Restore the source only after that transition.
  useAppStore.getState().setShowCustomizeView(false)
  useAppStore.getState().setShowHarnessBoardView(true)
  await useAppStore.getState().selectThread(scope.threadId, { preserveView: true })
  const store = useAppStore.getState()
  const current = store.threads.find((thread) => thread.thread_id === scope.threadId)
  if (
    store.currentThreadId !== scope.threadId ||
    !isSameWorkspacePath(
      typeof current?.metadata?.workspacePath === "string" ? current.metadata.workspacePath : null,
      scope.expectedWorkspace
    )
  )
    throw new Error("聊天已改变，请重新打开项目步骤。")
  pending = { id: crypto.randomUUID(), scope, plan }
  listeners.forEach((listener) => listener())
}
export function dismissNativeNodePlan(id: string) {
  if (pending?.id !== id) return
  pending = null
  listeners.forEach((listener) => listener())
}
export const useNativeNodeIntent = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => pending
  )
