import type { FunctionNativeContent } from "../../../shared/mods/v2/engine"
import type { FunctionUiSite } from "../../../shared/mods/v2/sites"
import type { FunctionPaneSnapshot, FunctionUiElement } from "../../../shared/mods/v2/ui"

const MAX_ENTRIES = 96
const MAX_BYTES = 2 * 1024 * 1024
const MAX_ENTRY_BYTES = 128 * 1024
const MAX_AGE_MS = 120000

export interface FunctionSitePresentation {
  tree: FunctionUiElement
  nativeContent?: FunctionNativeContent
  height: number
  width: number
}

interface Entry {
  component: FunctionUiSite
  presentation: FunctionSitePresentation
  bytes: number
  expires: number
  valid: boolean
}

export interface CachedFunctionSitePresentation {
  presentation: FunctionSitePresentation
  expiresAt: number
  current(): boolean
}

/** Drawing data only. Owners, generations, callback handles and Client instances never survive. */
function staticTree(node: FunctionUiElement): FunctionUiElement | null {
  if (node.type === "Client") return null
  if (node.type === "engine") return { type: "engine", ref: node.ref }
  if (node.type === "Markdown") {
    return { type: "Markdown", props: structuredClone(node.props) }
  }
  const children: (FunctionUiElement | string)[] = []
  for (const child of node.children ?? []) {
    const copy = typeof child === "string" ? child : staticTree(child)
    if (copy === null) return null
    children.push(copy)
  }
  if (node.type === "fragment") return { type: "fragment", children }
  if (node.type === "Link")
    return {
      type: "Text",
      props: {},
      children: children.length ? children : [String(node.props.label ?? node.props.href ?? "")]
    }
  return { type: node.type, props: structuredClone(node.props), children }
}

export function functionSitePresentationKey(
  threadId: string,
  component: FunctionUiSite,
  presentationId: string | undefined,
  inputKey: string,
  viewportWidth: number
): string | null {
  if (!presentationId || !["UserMessage", "AssistantMessage", "CommandOutput"].includes(component))
    return null
  return JSON.stringify([threadId, component, presentationId, inputKey, viewportWidth])
}

/** Bound to one host capability decision, never an installation name or a restored owner token. */
export class FunctionSitePresentationCache {
  private entries = new Map<string, Entry>()
  private bytes = 0
  private revision = 0
  private admissionRevision = 0
  private admissions = new Map<string, { component: FunctionUiSite; valid: boolean }>()
  private components = new Map<string, number>()
  private listeners = new Set<() => void>()

  constructor(private readonly authorized: () => boolean) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  capture(component: FunctionUiSite, _key?: string | null, rowIdentity?: string): () => boolean {
    // Facts keys may contain whole messages. Retain only bounded stable row identities.
    void _key
    const revision = this.revision
    const admissionRevision = this.admissionRevision
    const generation = this.components.get(component)
    if (rowIdentity !== undefined && (!rowIdentity || rowIdentity.length > 2048)) return () => false
    let admission: { component: FunctionUiSite; valid: boolean } | undefined
    if (rowIdentity !== undefined) {
      admission = this.admissions.get(rowIdentity)
      if (admission && admission.component !== component) {
        admission.valid = false
        admission = undefined
      }
      this.admissions.delete(rowIdentity)
      if (!admission) admission = { component, valid: true }
      while (this.admissions.size >= MAX_ENTRIES) {
        const oldest = this.admissions.entries().next().value!
        oldest[1].valid = false
        this.admissions.delete(oldest[0])
      }
      this.admissions.set(rowIdentity, admission)
    }
    return () =>
      this.authorized() &&
      this.revision === revision &&
      (admission ? admission.valid : this.admissionRevision === admissionRevision) &&
      this.components.get(component) === generation
  }

  read(key: string | null): CachedFunctionSitePresentation | null {
    if (!key || !this.authorized()) return null
    const entry = this.entries.get(key)
    if (!entry) return null
    if (!entry.valid || entry.expires <= Date.now()) {
      this.remove(key, entry)
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return {
      presentation: entry.presentation,
      expiresAt: entry.expires,
      current: () => this.authorized() && entry.valid && entry.expires > Date.now()
    }
  }

  save(
    key: string | null,
    component: FunctionUiSite,
    snapshot: FunctionPaneSnapshot,
    height: number,
    current: () => boolean,
    width = 0
  ): void {
    if (!key || !current() || !this.authorized()) return
    const tree = staticTree(snapshot.tree)
    if (!tree) return
    const presentation: FunctionSitePresentation = {
      tree,
      ...(snapshot.nativeContent ? { nativeContent: structuredClone(snapshot.nativeContent) } : {}),
      height: Number.isFinite(height) ? Math.max(0, Math.min(100000, height)) : 0,
      width: Number.isFinite(width) ? Math.max(0, Math.min(100000, width)) : 0
    }
    const bytes = (key.length + JSON.stringify(presentation).length) * 2
    if (bytes > MAX_ENTRY_BYTES) return
    const previous = this.entries.get(key)
    if (previous) this.remove(key, previous)
    while (this.entries.size >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.remove(oldest[0], oldest[1])
    }
    this.entries.set(key, {
      component,
      presentation,
      bytes,
      expires: Date.now() + MAX_AGE_MS,
      valid: true
    })
    this.bytes += bytes
  }

  invalidate(component?: string, notify = true): void {
    if (!component || component === "*") this.revision++
    else this.components.set(component, (this.components.get(component) ?? 0) + 1)
    for (const [key, entry] of this.entries)
      if (!component || component === "*" || entry.component === component) this.remove(key, entry)
    for (const [identity, admission] of this.admissions) {
      if (!component || component === "*" || admission.component === component) {
        admission.valid = false
        this.admissions.delete(identity)
      }
    }
    if (notify) for (const listener of this.listeners) listener()
  }

  invalidateKey(key: string | null, notify = true, rowIdentity?: string): void {
    if (!key) return
    // Revoke this row's pending reads, not every other row waiting to save its drawing.
    // Legacy callers without an identity remain conservative.
    this.admissionRevision++
    if (rowIdentity !== undefined) {
      const admission = this.admissions.get(rowIdentity)
      if (admission) admission.valid = false
      this.admissions.delete(rowIdentity)
    } else {
      for (const admission of this.admissions.values()) admission.valid = false
      this.admissions.clear()
    }
    const entry = this.entries.get(key)
    if (entry) this.remove(key, entry)
    if (notify) for (const listener of this.listeners) listener()
  }

  private remove(key: string, entry: Entry): void {
    entry.valid = false
    this.entries.delete(key)
    this.bytes -= entry.bytes
  }
}
