import {
  validateFunctionDisplaySnapshotData,
  type FunctionDisplaySnapshotData
} from "../../../shared/mods/v2/display-snapshot"
import type { FunctionNativeContent } from "../../../shared/mods/v2/engine"
import type { ModObject } from "../../../shared/mods/types"
import {
  FUNCTION_PASSIVE_DISPLAY_SITES,
  FUNCTION_UI_SITES,
  type FunctionUiSite
} from "../../../shared/mods/v2/sites"
import type { FunctionPaneSnapshot, FunctionUiElement } from "../../../shared/mods/v2/ui"
import {
  functionSitePresentationBudget as budget,
  type PresentationBudgetRecord
} from "./function-site-presentation-budget"
import { presentationInputDigest } from "./presentation-input-digest"
import type { FunctionSiteGeometry } from "./function-site-geometry"
import { buildStreamingMarkdownPreview } from "../../../shared/streaming-markdown-preview"
import { checkedFunctionMessageViewport, type FunctionMessageViewport } from "./function-message-viewport"

const MAX_ENTRIES = 96
const MAX_ENTRY_BYTES = 128 * 1024
const MAX_AGE_MS = 120000
const RECORD_BYTES = 256
const SCOPE_BYTES = 4096
const MAX_MEASUREMENTS = 1536

interface Measurement extends PresentationBudgetRecord {
  component: FunctionUiSite
  hostKey?: string
  height: number
  layoutWidth: number
  expires: number
}

export interface FunctionSitePresentation {
  tree?: FunctionUiElement
  nativeContent?: FunctionNativeContent
  hostMessage?: ModObject
  hostMessagePreview?: { tail: string; omittedCharacters: number }
  messageViewport?: FunctionMessageViewport
  height: number
  width: number
}

interface Entry extends PresentationBudgetRecord {
  component: FunctionUiSite
  hostKey?: string
  presentation: FunctionSitePresentation
  bytes: number
  expires: number
  valid: boolean
  queryable: boolean
  leaseToken?: object
}

interface Admission extends PresentationBudgetRecord {
  component: FunctionUiSite
  valid: boolean
  captureIdentity?: object
}

interface ProjectionChange extends PresentationBudgetRecord {
  revision: number
}

export interface CachedFunctionSitePresentation {
  /** Private entry identity, never an execution or source authority. */
  readonly identity: object
  hostKey?: string
  presentation: FunctionSitePresentation
  expiresAt: number
  current(): boolean
}

export interface FunctionSiteProgressLease extends CachedFunctionSitePresentation {
  key: string
  release(): void
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
  return functionSitePresentationKeyAtWidth(functionSitePresentationIdentity(
    threadId, component, presentationId, inputKey), viewportWidth)
}

/** Plain cache identity only. It contains no source, permission or publication proof. */
export type FunctionSitePresentationIdentity = readonly [string, FunctionUiSite, string, string]

export function functionSitePresentationIdentity(threadId: string, component: FunctionUiSite,
  presentationId: string | undefined, inputKey: string): FunctionSitePresentationIdentity | null {
  if (
    !presentationId ||
    presentationId.length > 2048 ||
    !FUNCTION_PASSIVE_DISPLAY_SITES.includes(component)
  )
    return null
  return [
    threadId,
    component,
    presentationId,
    // Preserve exact UTF-16 identity even if a caller supplies an unpaired surrogate.
    "sha256:" + presentationInputDigest(JSON.stringify(inputKey))
  ]
}

export function functionSitePresentationKeyAtWidth(identity: FunctionSitePresentationIdentity | null,
  viewportWidth: number): string | null {
  return identity ? JSON.stringify([...identity, viewportWidth]) : null
}

/** Bound to one host capability decision, never an installation name or a restored owner token. */
export class FunctionSitePresentationCache {
  private entries = new Map<string, Entry>()
  // Neutral dimensions survive body LRU eviction. They never retain text, trees,
  // callbacks, owners or an authority ticket, and share the renderer byte budget.
  private measurements = new Map<string, Measurement>()
  private bytes = 0
  private metadata: PresentationBudgetRecord | undefined
  private revision = 0
  private admissionRevision = 0
  private admissions = new Map<string, Admission>()
  private components = new Map<string, number>()
  private listeners = new Set<{ notify(): void; key?: string | null }>()
  private notifying: Set<object> | undefined
  private projectionRevision = 0
  private projectionFloor = 0
  private projectionChanges = new Map<string, ProjectionChange>()

  constructor(private readonly authorized: () => boolean) {}

  subscribe(listener: () => void, key?: string | null): () => void {
    const subscription = { notify: listener, key }
    this.listeners.add(subscription)
    return () => {
      this.listeners.delete(subscription)
    }
  }

  /** Only host projections retain dependency proofs after their original owner is unmounted. */
  releaseView(): void {
    this.admissionRevision++
    for (const [identity, admission] of this.admissions) this.removeAdmission(identity, admission)
    const removed = new Set<string>()
    for (const [key, entry] of this.entries) {
      if (entry.hostKey) continue
      this.remove(key, entry)
      removed.add(key)
    }
    // Dimensions reveal no drawing data and may still prevent scroll position jumps.
    this.releaseEmptyMetadata()
    if (removed.size) this.notify(removed)
  }

  /** Close the first-read/event race without retaining an unbounded per-row event history. */
  captureProjectionRead(): (hostKey: string) => boolean {
    const revision = this.revision
    const start = this.projectionRevision
    return (hostKey) =>
      this.authorized() &&
      this.revision === revision &&
      start >= this.projectionFloor &&
      (this.projectionChanges.get(hostKey)?.revision ?? 0) <= start
  }

  matchesProjection(key: string | null, hostKey: string): boolean {
    const entry = key ? this.entries.get(key) : undefined
    return Boolean(this.authorized() && entry?.valid && entry.hostKey === hostKey)
  }

  invalidateProjection(hostKey: string): void {
    // Production host keys are SHA-256 row identities, never message text or callback handles.
    if (!hostKey || hostKey.length > 256) return
    const revision = ++this.projectionRevision
    const previous = this.projectionChanges.get(hostKey)
    if (previous) this.removeProjectionChange(hostKey, previous, false)
    while (this.projectionChanges.size >= MAX_ENTRIES) {
      const oldest = this.projectionChanges.entries().next().value!
      this.removeProjectionChange(oldest[0], oldest[1])
    }
    const change: ProjectionChange = {
      token: {},
      bytes: RECORD_BYTES + hostKey.length * 2,
      revision,
      evict: () => {
        this.removeProjectionChange(hostKey, change)
        this.releaseEmptyMetadata()
      }
    }
    this.projectionChanges.set(hostKey, change)
    if (!this.retain(change) || this.projectionChanges.get(hostKey) !== change) {
      // A refused log record loses coverage, never the invalidation it represents.
      this.projectionFloor = Math.max(this.projectionFloor, revision)
      this.removeProjectionChange(hostKey, change)
      this.releaseEmptyMetadata()
    }
    const changed = new Set<string>()
    for (const [key, measurement] of this.measurements)
      if (measurement.hostKey === hostKey) {
        changed.add(key)
        this.removeMeasurement(key, measurement)
      }
    for (const [key, entry] of this.entries)
      if (entry.hostKey === hostKey) {
        changed.add(key)
        this.remove(key, entry)
      }
    if (changed.size) this.notify(changed)
  }

  capture(component: FunctionUiSite, _key?: string | null, rowIdentity?: string): () => boolean {
    // Facts keys may contain whole messages. Retain only bounded stable row identities.
    void _key
    if (!budget.canRetain()) return () => false
    const revision = this.revision
    const admissionRevision = this.admissionRevision
    const generation = this.components.get(component)
    if (rowIdentity !== undefined && (!rowIdentity || rowIdentity.length > 2048)) return () => false
    let admission: Admission | undefined
    if (rowIdentity !== undefined) {
      admission = this.admissions.get(rowIdentity)
      if (admission && admission.component !== component) {
        this.removeAdmission(rowIdentity, admission)
        admission = undefined
      }
      this.admissions.delete(rowIdentity)
      if (!admission) {
        const created: Admission = {
          token: {},
          bytes: RECORD_BYTES + rowIdentity.length * 2,
          component,
          valid: true,
          evict: () => {
            this.removeAdmission(rowIdentity, created)
            this.releaseEmptyMetadata()
          }
        }
        admission = created
      }
      while (this.admissions.size >= MAX_ENTRIES) {
        const oldest = this.admissions.entries().next().value!
        this.removeAdmission(oldest[0], oldest[1])
      }
      this.admissions.set(rowIdentity, admission)
      // Cleanup identity only: reads in the current admission cohort retain the
      // same authorization semantics, while an old view cannot retire a later capture.
      admission.captureIdentity = {}
      if (!this.retain(admission) || this.admissions.get(rowIdentity) !== admission) {
        this.removeAdmission(rowIdentity, admission)
        this.releaseEmptyMetadata()
      }
    }
    return () =>
      this.authorized() &&
      this.revision === revision &&
      (admission ? admission.valid : this.admissionRevision === admissionRevision) &&
      this.components.get(component) === generation
  }

  /** React render may inspect a view, but cannot acquire leases, touch LRU or clean expired data. */
  peek(key: string | null): CachedFunctionSitePresentation | null {
    if (!key || !this.authorized()) return null
    const entry = this.entries.get(key)
    if (!entry?.valid || !entry.queryable || entry.expires <= Date.now()) return null
    return {
      identity: entry.token,
      ...(entry.hostKey ? { hostKey: entry.hostKey } : {}),
      presentation: entry.presentation,
      expiresAt: entry.expires,
      current: () => this.authorized() && this.entries.get(key) === entry && entry.valid &&
        entry.queryable && entry.expires > Date.now()
    }
  }

  /** Only a committed reader can promote the exact entry it actually displayed. */
  touch(key: string | null, cached: CachedFunctionSitePresentation): boolean {
    if (!key || !this.authorized() || !cached.current()) return false
    const entry = this.entries.get(key)
    if (!entry?.valid || !entry.queryable || entry.expires <= Date.now() ||
      entry.token !== cached.identity || entry.presentation !== cached.presentation) return false
    this.entries.delete(key)
    this.entries.set(key, entry)
    budget.touch(entry)
    if (this.metadata) budget.touch(this.metadata)
    return true
  }

  read(key: string | null): CachedFunctionSitePresentation | null {
    if (!key || !this.authorized()) return null
    const entry = this.entries.get(key)
    if (entry && (!entry.valid || entry.expires <= Date.now())) {
      this.remove(key, entry)
      this.releaseEmptyMetadata()
    }
    const cached = this.peek(key)
    if (cached) this.touch(key, cached)
    return cached
  }

  /** Consume a committed exact view for one mounted progress lineage, never a new read authority. */
  consumeProgress(
    key: string | null,
    cached: CachedFunctionSitePresentation,
    rowIdentity: string | undefined
  ): FunctionSiteProgressLease | null {
    if (!key || !rowIdentity || rowIdentity.length > 2048 || !this.authorized()) return null
    const entry = this.entries.get(key)
    if (!entry || !entry.valid || !entry.queryable || entry.leaseToken ||
      !["AssistantMessage", "ToolGroup"].includes(entry.component) ||
      entry.token !== cached.identity || entry.presentation !== cached.presentation || !cached.current() ||
      entry.expires <= Date.now()) return null
    // Revoke pending cache publication without releasing this still-valid display entry.
    this.admissionRevision++
    const admission = this.admissions.get(rowIdentity)
    if (admission) this.removeAdmission(rowIdentity, admission)
    const token = {}
    entry.queryable = false
    entry.leaseToken = token
    return {
      key,
      identity: entry.token,
      ...(entry.hostKey ? { hostKey: entry.hostKey } : {}),
      presentation: entry.presentation,
      expiresAt: entry.expires,
      current: () => this.authorized() && this.entries.get(key) === entry && entry.valid &&
        entry.leaseToken === token && entry.expires > Date.now(),
      release: () => {
        if (entry.leaseToken !== token) return
        entry.leaseToken = undefined
        this.remove(key, entry)
        this.releaseEmptyMetadata()
      }
    }
  }

  measure(
    key: string | null,
    component: FunctionUiSite,
    geometry: FunctionSiteGeometry,
    hostKey?: string
  ): void {
    if (!key || !budget.canRetain() || !this.authorized() ||
      !FUNCTION_PASSIVE_DISPLAY_SITES.includes(component) ||
      !Number.isFinite(geometry.height) || geometry.height <= 0 || geometry.height > 100000 ||
      !Number.isFinite(geometry.layoutWidth) || geometry.layoutWidth <= 0 || geometry.layoutWidth > 100000 ||
      (hostKey !== undefined && (!hostKey || hostKey.length > 256))) return
    const previous = this.measurements.get(key)
    if (previous && previous.component === component && previous.hostKey === hostKey &&
      previous.height === geometry.height && previous.layoutWidth === geometry.layoutWidth) {
      previous.expires = Date.now() + MAX_AGE_MS
      this.measurements.delete(key)
      this.measurements.set(key, previous)
      budget.touch(previous)
      return
    }
    if (previous) this.removeMeasurement(key, previous)
    while (this.measurements.size >= MAX_MEASUREMENTS) {
      const oldest = this.measurements.entries().next().value!
      this.removeMeasurement(oldest[0], oldest[1])
    }
    const measurement: Measurement = {
      token: {},
      component,
      ...(hostKey ? { hostKey } : {}),
      height: geometry.height,
      layoutWidth: geometry.layoutWidth,
      expires: Date.now() + MAX_AGE_MS,
      bytes: RECORD_BYTES + (key.length + (hostKey?.length ?? 0)) * 2,
      evict: () => {
        this.removeMeasurement(key, measurement)
        this.releaseEmptyMetadata()
      }
    }
    this.measurements.set(key, measurement)
    if (!this.retain(measurement) || this.measurements.get(key) !== measurement) {
      this.removeMeasurement(key, measurement)
      this.releaseEmptyMetadata()
    }
  }

  /** Neutral layout only: a new row may borrow recent geometry, never another row's text. */
  placeholderHeight(key: string | null, component: FunctionUiSite, layoutWidth: number): number | undefined {
    const exact = this.measuredHeight(key, layoutWidth)
    if (exact !== undefined) return exact
    if (!key || !Number.isFinite(layoutWidth) || layoutWidth <= 0 || !this.authorized() ||
      !["UserMessage", "AssistantMessage", "CommandOutput"].includes(component)) return
    const now = Date.now()
    const heights: number[] = []
    // Measurements already have a bounded lifetime and budget. Use a small recent sample
    // so cold placeholders do not collapse a long transcript into two-line rows during drag.
    for (const measurement of this.measurements.values()) {
      if (measurement.component !== component || measurement.expires <= now ||
        Math.abs(layoutWidth - measurement.layoutWidth) >= 1) continue
      heights.push(measurement.height)
      if (heights.length > 16) heights.shift()
    }
    if (heights.length < 3) return
    heights.sort((a, b) => a - b)
    // Keep the observed height: truncating tall placeholders makes the virtual scroll
    // position jump again as soon as their protected body arrives.
    return heights[Math.floor(heights.length / 2)]
  }

  measuredHeight(key: string | null, layoutWidth: number): number | undefined {
    if (!key || !Number.isFinite(layoutWidth) || layoutWidth <= 0 || !this.authorized()) return
    const measurement = this.measurements.get(key)
    if (!measurement) return
    if (measurement.expires <= Date.now()) {
      this.removeMeasurement(key, measurement)
      this.releaseEmptyMetadata()
      return
    }
    if (Math.abs(layoutWidth - measurement.layoutWidth) >= 1) return
    this.measurements.delete(key)
    this.measurements.set(key, measurement)
    budget.touch(measurement)
    return measurement.height
  }

  save(
    key: string | null,
    component: FunctionUiSite,
    snapshot: FunctionPaneSnapshot,
    height: number,
    current: () => boolean,
    width = 0
  ): void {
    if (!budget.canRetain() || !key || !current() || !this.authorized()) return
    const tree = staticTree(snapshot.tree)
    if (!tree) return
    this.store(key, component, tree, snapshot.nativeContent, height, current, width)
  }

  /** Protected passive data may outlive its DOM row, never its host capability decision. */
  saveData(
    key: string | null,
    data: FunctionDisplaySnapshotData,
    height: number,
    current: () => boolean,
    width = 0,
    hostKey?: string,
    messageViewport?: FunctionMessageViewport
  ): void {
    if (
      !budget.canRetain() ||
      !key ||
      !current() ||
      !this.authorized() ||
      (hostKey !== undefined && (!hostKey || hostKey.length > 256))
    )
      return
    validateFunctionDisplaySnapshotData(data)
    this.store(
      key,
      data.component,
      data.hostMessage ? undefined : (data.tree ?? { type: "engine", ref: 0 }),
      data.nativeContent,
      height,
      current,
      width,
      hostKey,
      data.hostMessage,
      messageViewport
    )
  }

  private store(
    key: string,
    component: FunctionUiSite,
    tree: FunctionUiElement | undefined,
    nativeContent: FunctionNativeContent | undefined,
    height: number,
    current: () => boolean,
    width: number,
    hostKey?: string,
    hostMessage?: ModObject,
    messageViewport?: FunctionMessageViewport
  ): void {
    if (!budget.canRetain() || !current() || !this.authorized()) return
    const preview = hostMessage && typeof hostMessage.text === "string"
      ? buildStreamingMarkdownPreview(hostMessage.text, 60 * 1024) : undefined
    const viewport = preview?.omittedCharacters && typeof hostMessage?.text === "string"
      ? checkedFunctionMessageViewport(messageViewport, hostMessage.text) : undefined
    const presentation: FunctionSitePresentation = {
      ...(tree ? { tree: structuredClone(tree) } : {}),
      ...(nativeContent ? { nativeContent: structuredClone(nativeContent) } : {}),
      ...(hostMessage ? { hostMessage: structuredClone(preview?.omittedCharacters
        ? { ...hostMessage, text: preview.head } : hostMessage) } : {}),
      ...(preview?.omittedCharacters ? { hostMessagePreview: {
        tail: preview.tail, omittedCharacters: preview.omittedCharacters
      } } : {}),
      ...(viewport ? { messageViewport: viewport } : {}),
      height: Number.isFinite(height) ? Math.max(0, Math.min(100000, height)) : 0,
      width: Number.isFinite(width) ? Math.max(0, Math.min(100000, width)) : 0
    }
    const measureBytes = () =>
      RECORD_BYTES + (key.length + (hostKey?.length ?? 0) + JSON.stringify(presentation).length) * 2
    let bytes = measureBytes()
    // Escaped code/control characters may exceed the byte cap below the character
    // threshold. Start with protected head/tail fragments, then use the same shrink loop.
    if (bytes > MAX_ENTRY_BYTES && !presentation.hostMessagePreview &&
      typeof presentation.hostMessage?.text === "string") {
      const text = presentation.hostMessage.text
      const split = Math.min(8192, Math.ceil(text.length / 2))
      presentation.hostMessage.text = text.slice(0, split)
      presentation.hostMessagePreview = { tail: text.slice(split), omittedCharacters: 0 }
      bytes = measureBytes()
    }
    // JSON escaping can make code/control-heavy text much larger than its character
    // count. Shorten only these already protected fragments until the original
    // record budget is met; never retain the omitted middle or raise that budget.
    while (bytes > MAX_ENTRY_BYTES && presentation.hostMessagePreview &&
      typeof presentation.hostMessage?.text === "string") {
      const message = presentation.hostMessage, retained = presentation.hostMessagePreview
      const head = message.text as string, tail = retained.tail
      if (head.length + tail.length <= 2) break
      const nextHead = head.slice(0, Math.ceil(head.length / 2))
      const nextTail = tail.slice(tail.length - Math.ceil(tail.length / 2))
      retained.omittedCharacters += head.length + tail.length - nextHead.length - nextTail.length
      message.text = nextHead
      retained.tail = nextTail
      bytes = measureBytes()
    }
    if (bytes > MAX_ENTRY_BYTES) return
    const previous = this.entries.get(key)
    if (previous) this.remove(key, previous)
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.remove(oldest[0], oldest[1])
      this.notify(new Set([oldest[0]]))
    }
    const entry: Entry = {
      token: {},
      component,
      ...(hostKey ? { hostKey } : {}),
      presentation,
      bytes,
      expires: Date.now() + MAX_AGE_MS,
      valid: true,
      queryable: true,
      evict: () => {
        this.remove(key, entry)
        this.releaseEmptyMetadata()
        this.notify(new Set([key]))
      }
    }
    this.entries.set(key, entry)
    this.bytes += bytes
    const retained = this.retain(entry)
    // Admission metadata may itself have been evicted while making room for the data.
    if (!retained || this.entries.get(key) !== entry || !current() || !this.authorized()) {
      this.remove(key, entry)
      this.releaseEmptyMetadata()
    }
  }

  invalidate(component?: string, notify = true): void {
    if (!component || component === "*") {
      this.revision++
      for (const [key, change] of this.projectionChanges) this.removeProjectionChange(key, change)
      this.projectionFloor = this.projectionRevision
      this.components.clear()
    } else if (FUNCTION_UI_SITES.some((site) => site === component)) {
      this.components.set(component, (this.components.get(component) ?? 0) + 1)
      if (!this.retainMetadata()) {
        this.revision++
        this.components.clear()
      }
    }
    for (const [key, entry] of this.entries)
      if (!component || component === "*" || entry.component === component) this.remove(key, entry)
    for (const [key, measurement] of this.measurements)
      if (!component || component === "*" || measurement.component === component)
        this.removeMeasurement(key, measurement)
    for (const [identity, admission] of this.admissions) {
      if (!component || component === "*" || admission.component === component) {
        this.removeAdmission(identity, admission)
      }
    }
    this.releaseEmptyMetadata()
    if (notify) this.notify()
  }

  invalidateKey(key: string | null, notify = true, rowIdentity?: string): void {
    if (!key) return
    // Revoke this row's pending reads, not every other row waiting to save its drawing.
    // Legacy callers without an identity remain conservative.
    this.admissionRevision++
    if (rowIdentity !== undefined) {
      const admission = this.admissions.get(rowIdentity)
      if (admission) this.removeAdmission(rowIdentity, admission)
    } else {
      for (const [identity, admission] of this.admissions) this.removeAdmission(identity, admission)
    }
    const entry = this.entries.get(key)
    if (entry) this.remove(key, entry)
    const measurement = this.measurements.get(key)
    if (measurement) this.removeMeasurement(key, measurement)
    this.releaseEmptyMetadata()
    if (notify) this.notify()
  }

  /** Capture exact records without changing admission. Abandoned renders never call the result.
   * A delayed retirement cannot delete a replacement entry, measurement or row admission.
   */
  planRetirement(key: string | null, rowIdentity: string | undefined): () => void {
    const entry = key ? this.entries.get(key) : undefined
    const measurement = key ? this.measurements.get(key) : undefined
    const admission = rowIdentity ? this.admissions.get(rowIdentity) : undefined
    const captureIdentity = admission?.captureIdentity
    return () => {
      if (key && entry && this.entries.get(key) === entry) this.remove(key, entry)
      if (key && measurement && this.measurements.get(key) === measurement)
        this.removeMeasurement(key, measurement)
      if (rowIdentity && admission && this.admissions.get(rowIdentity) === admission &&
        admission.captureIdentity === captureIdentity)
        this.removeAdmission(rowIdentity, admission)
      this.releaseEmptyMetadata()
    }
  }

  private remove(key: string, entry: Entry): void {
    entry.valid = false
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
      this.bytes -= entry.bytes
    }
    budget.release(entry.token)
  }

  private removeMeasurement(key: string, measurement: Measurement): void {
    if (this.measurements.get(key) === measurement) this.measurements.delete(key)
    budget.release(measurement.token)
  }

  private removeAdmission(identity: string, admission: Admission): void {
    admission.valid = false
    if (this.admissions.get(identity) === admission) this.admissions.delete(identity)
    budget.release(admission.token)
  }

  private removeProjectionChange(key: string, change: ProjectionChange, lostCoverage = true): void {
    if (this.projectionChanges.get(key) === change) {
      if (lostCoverage) this.projectionFloor = Math.max(this.projectionFloor, change.revision)
      this.projectionChanges.delete(key)
    }
    budget.release(change.token)
  }

  private retainMetadata(): boolean {
    if (!this.metadata) {
      const metadata: PresentationBudgetRecord = {
        token: {},
        bytes: SCOPE_BYTES,
        evict: () => {
          this.metadata = undefined
          this.invalidate()
        }
      }
      this.metadata = metadata
      if (!budget.retain(metadata) || this.metadata !== metadata) {
        budget.release(metadata.token)
        if (this.metadata === metadata) this.metadata = undefined
        return false
      }
    } else budget.touch(this.metadata)
    return true
  }

  private retain(record: PresentationBudgetRecord): boolean {
    if (!this.retainMetadata()) return false
    const retained = budget.retain(record)
    if (this.metadata) budget.touch(this.metadata)
    return retained
  }

  private releaseEmptyMetadata(): void {
    if (
      this.entries.size ||
      this.measurements.size ||
      this.admissions.size ||
      this.projectionChanges.size ||
      this.components.size
    )
      return
    if (this.metadata) budget.release(this.metadata.token)
    this.metadata = undefined
  }

  private notify(keys?: ReadonlySet<string>): void {
    const outer = !this.notifying
    const notified = this.notifying ?? new Set<object>()
    this.notifying = notified
    try {
      budget.observe(() => {
        for (const listener of this.listeners)
          if (!notified.has(listener) && (!keys || !listener.key || keys.has(listener.key))) {
            notified.add(listener)
            try {
              listener.notify()
            } catch {
              /* A subscriber cannot retain evicted passive data. */
            }
          }
      })
    } finally {
      if (outer) this.notifying = undefined
    }
  }
}
