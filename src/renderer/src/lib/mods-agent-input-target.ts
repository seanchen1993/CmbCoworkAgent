import { useSyncExternalStore } from "react"
import type { AgentViewIntent } from "../../../shared/mods/v2/agent-tasks"

type Target = { intent: AgentViewIntent; account: number; phase: "waiting" | "active" }
let active: Target | undefined
const listeners = new Set<() => void>()
const preparations = new Map<string, Set<object>>()
const preparationKey = (threadId: string, account: number) => JSON.stringify([threadId, account])
const isPreparing = (threadId: string, account: number) =>
  !!preparations.get(preparationKey(threadId, account))?.size
const drafts = new Map<string, { text: string; version: number }>()
const draftListeners = new Set<() => void>()
let draftVersion = 0
const key = (intent: AgentViewIntent, account: number) =>
  JSON.stringify([
    account,
    intent.threadId,
    intent.workspace.toLowerCase(),
    intent.parentIncarnation,
    intent.sourceDigest,
    intent.agentId
  ])
const notify = () => {
  for (const listener of listeners) listener()
}

/** Protects an already claimed parent payload until its synchronous transport handoff. */
export function beginParentInputPreparation(threadId: string, account: number) {
  if (modsAgentInputActive(threadId, account)) return undefined
  const id = preparationKey(threadId, account),
    token = {}
  let tokens = preparations.get(id)
  if (!tokens) preparations.set(id, (tokens = new Set()))
  tokens.add(token)
  let live = true
  return {
    release() {
      if (!live) return
      live = false
      tokens.delete(token)
      if (!tokens.size) preparations.delete(id)
      notify()
    }
  }
}

/** Reserves new parent input immediately, then waits only for previously claimed payloads. */
export function reserveModsAgentInput(intent: AgentViewIntent, account: number) {
  active = { intent, account, phase: "waiting" }
  const reservation = active
  let committed: Target | undefined
  notify()
  return {
    ready(signal: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(check)
          signal.removeEventListener("abort", check)
        }
        const check = () => {
          if (signal.aborted || active !== reservation) {
            cleanup()
            reject(Error("MODS_AGENT_INPUT_TARGET_CHANGED"))
          } else if (!isPreparing(intent.threadId, account)) {
            cleanup()
            resolve()
          }
        }
        listeners.add(check)
        signal.addEventListener("abort", check, { once: true })
        check()
      })
    },
    activate(): boolean {
      if (active !== reservation || isPreparing(intent.threadId, account)) return false
      active = committed = { ...reservation, phase: "active" }
      notify()
      return true
    },
    release() {
      if (active === reservation || (committed && active === committed))
        releaseModsAgentInput(intent.id)
    }
  }
}
export function activateModsAgentInput(intent: AgentViewIntent, account: number): boolean {
  if (isPreparing(intent.threadId, account)) return false
  active = { intent, account, phase: "active" }
  notify()
  return true
}
export function releaseModsAgentInput(id: string): void {
  if (active?.intent.id !== id) return
  active = undefined
  notify()
}
export function modsAgentInputActive(threadId: string, account: number): boolean {
  return active?.intent.threadId === threadId && active.account === account
}
export function useModsAgentInputTarget(threadId: string, account: number) {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    () => (active?.intent.threadId === threadId && active.account === account ? active : undefined),
    () => undefined
  )
}
export function readModsAgentDraft(intent: AgentViewIntent, account: number): string {
  return drafts.get(key(intent, account))?.text ?? ""
}
export function useModsAgentDraft(intent: AgentViewIntent, account: number): string {
  return useSyncExternalStore(
    (callback) => {
      draftListeners.add(callback)
      return () => draftListeners.delete(callback)
    },
    () => readModsAgentDraft(intent, account),
    () => ""
  )
}
export function captureModsAgentDraft(intent: AgentViewIntent, account: number) {
  return drafts.get(key(intent, account)) ?? { text: "", version: 0 }
}
export function settleModsAgentDraft(intent: AgentViewIntent, account: number, version: number) {
  if (drafts.get(key(intent, account))?.version === version) saveModsAgentDraft(intent, account, "")
}
export function saveModsAgentDraft(intent: AgentViewIntent, account: number, text: string): void {
  const id = key(intent, account)
  if (!text) drafts.delete(id)
  else {
    if (!drafts.has(id) && drafts.size >= 50) drafts.delete(drafts.keys().next().value!)
    drafts.set(id, { text, version: ++draftVersion })
  }
  for (const listener of draftListeners) listener()
}
