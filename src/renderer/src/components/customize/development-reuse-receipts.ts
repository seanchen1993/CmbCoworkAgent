import type { Dispatch, SetStateAction } from "react"
import { useCallback, useSyncExternalStore } from "react"
import type { AuthoringDocument } from "../../../../shared/mods/authoring"
import type {
  AuthoringInstalledReceipt,
  AuthoringPreparedInstallation
} from "../../../../shared/mods/authoring-install"
import type { ClawProfile, ClawView } from "../../../../shared/mods/claw"

export interface ReuseOrigin {
  id: string
  revision: number
  digest: string
}
export interface ReuseSelection {
  document: AuthoringDocument
  origin: ReuseOrigin
}
/** Installation facts carry no executable preparation handle or permission. */
export type ReuseInstalledVersion = AuthoringInstalledReceipt
export function installationFacts(value: AuthoringInstalledReceipt): AuthoringInstalledReceipt {
  const { installationId, versionId, name, sourceDigest, compiledDigest } = value
  return { installationId, versionId, name, sourceDigest, compiledDigest }
}
interface ReceiptData {
  stopped: boolean
  installed: ReuseInstalledVersion | null
  prepared: AuthoringPreparedInstallation | null
  authorizationPending: boolean
  claw: ClawView | null
  applied: ClawProfile | null
  savedProfile: { profile: ClawProfile; revision: number; bindingRevision: number } | null
  created: string | null
  createdBinding: { id: string; revision: number; bindingRevision: number } | null
  busy: boolean
}
const receipts = new Map<string, ReuseReceipt>()
const selections = new Map<string, ReuseSelection>()
const selectionListeners = new Map<string, Set<() => void>>()
export function subscribeReuseSelection(scope: string, listener: () => void): () => void {
  const listeners = selectionListeners.get(scope) ?? new Set<() => void>()
  listeners.add(listener)
  selectionListeners.set(scope, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) selectionListeners.delete(scope)
  }
}
const limit = 16
/** Process-local observations, never persisted execution permission or consent. */
export class ReuseReceipt {
  data: ReceiptData = {
    stopped: false,
    installed: null,
    prepared: null,
    authorizationPending: false,
    claw: null,
    applied: null,
    savedProfile: null,
    created: null,
    createdBinding: null,
    busy: false
  }
  private listeners = new Set<() => void>()
  get observed(): boolean {
    return this.listeners.size > 0
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  set<K extends keyof ReceiptData>(key: K, action: SetStateAction<ReceiptData[K]>): void {
    const value =
      typeof action === "function"
        ? (action as (old: ReceiptData[K]) => ReceiptData[K])(this.data[key])
        : action
    this.data = { ...this.data, [key]: value }
    for (const listener of this.listeners) listener()
  }
}
export function reuseReceiptKey(threadId: string, selection: ReuseSelection): string {
  const { document, origin } = selection
  return JSON.stringify([
    threadId,
    document.workspace,
    document.id,
    document.currentRevision,
    document.source.digest,
    origin.id,
    origin.revision,
    origin.digest
  ])
}
export function getReuseReceipt(key: string): ReuseReceipt | null {
  const found = receipts.get(key)
  if (found) return found
  while (receipts.size >= limit) {
    const oldest = [...receipts].find(([, value]) => !value.data.busy && !value.observed)
    if (!oldest) return null
    receipts.delete(oldest[0])
  }
  const receipt = new ReuseReceipt()
  receipts.set(key, receipt)
  return receipt
}
export function useReceiptField<K extends keyof ReceiptData>(
  receipt: ReuseReceipt,
  key: K
): [ReceiptData[K], Dispatch<SetStateAction<ReceiptData[K]>>] {
  return [
    useSyncExternalStore(receipt.subscribe, () => receipt.data[key]),
    useCallback((value) => receipt.set(key, value), [receipt, key])
  ]
}
export function readReuseSelection(scope: string): ReuseSelection | null {
  const value = selections.get(scope)
  return value ? structuredClone(value) : null
}
export function rememberReuseSelection(scope: string, value: ReuseSelection | null): void {
  selections.delete(scope)
  if (!value) {
    for (const listener of selectionListeners.get(scope) ?? []) listener()
    return
  }
  // Each authoring source is already bounded to 256 KiB; cap this UI cache as well.
  const copy = structuredClone(value)
  if (JSON.stringify(copy).length > 320 * 1024) return
  while (selections.size >= limit) selections.delete(selections.keys().next().value!)
  selections.set(scope, copy)
  for (const listener of selectionListeners.get(scope) ?? []) listener()
}
