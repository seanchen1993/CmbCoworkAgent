import { useSyncExternalStore } from "react"
import { useAppStore } from "./store"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import { goToConfigurationThread } from "./configuration-target"
import type {
  PlatformSurfaceCatalog,
  PlatformSurfaceEntry
} from "../../../shared/mods/v2/platform-surfaces"

export interface SurfaceNavigationScope {
  threadId: string
  workspace: string
  accountRevision: number
  birth: string
}
export interface PlatformSurfaceIntent extends SurfaceNavigationScope {
  id: string
  provider: string
  compiledDigest: string
  surfaceId: string
  entryKey: string
  developmentComponentId?: string
  developmentRevision?: number
}
let pending: PlatformSurfaceIntent | null = null
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function captureSurfaceNavigationScope(
  threadId: string,
  workspace: string
): SurfaceNavigationScope | null {
  const state = useAppStore.getState()
  const thread = state.threads.find((row) => row.thread_id === threadId)
  const metadata = thread?.metadata as Record<string, unknown> | undefined
  if (
    !thread ||
    typeof metadata?.workspacePath !== "string" ||
    !isSameWorkspacePath(metadata.workspacePath, workspace)
  )
    return null
  return {
    threadId,
    workspace,
    accountRevision: state.accountRevision,
    birth: JSON.stringify([thread.created_at, metadata.cmb_thread_incarnation ?? null])
  }
}
export function surfaceNavigationScopeCurrent(scope: SurfaceNavigationScope): boolean {
  const actual = captureSurfaceNavigationScope(scope.threadId, scope.workspace)
  return (
    !!actual && actual.accountRevision === scope.accountRevision && actual.birth === scope.birth
  )
}
export function exactSurfaceEntries(
  catalog: PlatformSurfaceCatalog,
  source: { provider?: string; compiledDigest: string }
): PlatformSurfaceEntry[] {
  const matches = catalog.entries.filter(
    (entry) =>
      entry.enabled &&
      entry.source.digest === source.compiledDigest &&
      entry.source.provider === entry.ref.provider &&
      (!source.provider || entry.ref.provider === source.provider)
  )
  if (new Set(matches.map((entry) => entry.ref.provider)).size > 1)
    throw Error("界面来源不唯一，请重新核对当前插件。")
  return matches
}
export async function assertSurfaceDevelopmentCurrent(
  scope: SurfaceNavigationScope,
  componentId: string,
  digest: string,
  revision?: number
): Promise<number> {
  if (!surfaceNavigationScopeCurrent(scope)) throw Error("聊天或工作目录已变化，请重新打开。")
  const status = await window.api.mods.development.status({ threadId: scope.threadId })
  const trial = status.trials.find((row) => row.componentId === componentId)
  if (
    !surfaceNavigationScopeCurrent(scope) ||
    status.threadId !== scope.threadId ||
    !isSameWorkspacePath(status.workspace, scope.workspace) ||
    !status.enabled ||
    trial?.phase !== "active" ||
    trial.activeDigest !== digest ||
    trial.compiledDigest !== digest ||
    trial.activeRevision !== trial.revision ||
    (revision !== undefined && trial.revision !== revision)
  )
    throw Error("当前试用版本已变化，请回创作工作区重新核对。")
  return trial.revision
}
export function requestPlatformSurface(input: Omit<PlatformSurfaceIntent, "id">): void {
  if (
    !surfaceNavigationScopeCurrent(input) ||
    !goToConfigurationThread({
      threadId: input.threadId,
      workspace: input.workspace
    })
  )
    throw Error("聊天或工作目录已变化，请重新打开。")
  pending = { ...input, id: crypto.randomUUID() }
  notify()
}
export function dismissPlatformSurfaceIntent(id: string): void {
  if (pending?.id !== id) return
  pending = null
  notify()
}
export const readPlatformSurfaceIntent = () => pending
export const usePlatformSurfaceIntent = () =>
  useSyncExternalStore(subscribe, readPlatformSurfaceIntent)
