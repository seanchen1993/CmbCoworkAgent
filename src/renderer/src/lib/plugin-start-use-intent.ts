import { useSyncExternalStore } from "react"
import type { PluginStartUseInput, PluginStartUseReport } from "../../../shared/plugin-start-use"
import { useAppStore } from "./store"
import { configurationTargetValid, goToConfigurationThread } from "./configuration-target"
import { openDerivedProject } from "./derived-project-intent"

export interface HostPluginStartUseIntent {
  id: string
  accountRevision: number
  input: PluginStartUseInput
  report: PluginStartUseReport
}
let pending: HostPluginStartUseIntent | null = null
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

export function hostPluginStartUseCurrent(intent: HostPluginStartUseIntent): boolean {
  const store = useAppStore.getState()
  return (
    store.accountRevision === intent.accountRevision &&
    configurationTargetValid(
      {
        threadId: intent.input.threadId,
        workspace: intent.input.expectedWorkspace
      },
      store.threads
    )
  )
}

/** Navigation is explicit; creating, approving and running remain in the original native form. */
export function openPluginStartUse(input: PluginStartUseInput, report: PluginStartUseReport): void {
  if (
    !report.canOpen ||
    report.identity.pluginId !== input.pluginId ||
    report.identity.name !== input.expected.name ||
    report.identity.version !== input.expected.version ||
    (input.expected.digest && input.expected.digest !== report.identity.digest)
  )
    throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
  const scope = { threadId: input.threadId, workspace: input.expectedWorkspace }
  if (!goToConfigurationThread(scope)) throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
  if (report.kind === "plugin-project") {
    openDerivedProject(report.identity.pluginId, report.identity.name, input)
    return
  }
  if (report.kind === "host-project") {
    pending = {
      id: crypto.randomUUID(),
      accountRevision: useAppStore.getState().accountRevision,
      input: structuredClone({
        ...input,
        expected: {
          name: report.identity.name,
          version: report.identity.version,
          digest: report.identity.digest
        }
      }),
      report: structuredClone(report)
    }
    useAppStore.getState().setShowHarnessBoardView(true)
    notify()
  }
}

export function dismissHostPluginStartUse(id: string): void {
  if (pending?.id !== id) return
  pending = null
  notify()
}
export const readHostPluginStartUseIntent = () => pending
export function useHostPluginStartUseIntent() {
  return useSyncExternalStore(subscribe, readHostPluginStartUseIntent)
}
