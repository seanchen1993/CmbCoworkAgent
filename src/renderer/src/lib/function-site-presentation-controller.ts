import type { ModObject } from "../../../shared/mods/types"
import type { FunctionUiSite } from "../../../shared/mods/v2/sites"
import type {
  CachedFunctionSitePresentation,
  FunctionSitePresentationCache,
  FunctionSiteProgressLease
} from "./function-site-presentation"
import { retainsFunctionSitePresentation } from "./function-site-transition"

/** Derive, never publish, a facts revision from the last committed input. */
export function planFunctionSiteInput(component: FunctionUiSite, input: ModObject, inputKey: string,
  previous: { key: string; revision: number; epoch: number }) {
  const changed = previous.key !== inputKey
  const append = changed && ["AssistantMessage", "ToolGroup"].includes(component) &&
    retainsFunctionSitePresentation(component, previous.key, input, inputKey)
  return { key: inputKey, revision: previous.revision + (changed ? 1 : 0),
    epoch: previous.epoch + (changed && !append ? 1 : 0) }
}

export interface FunctionSitePresentationInput<Renderer> {
  component: FunctionUiSite
  cache: FunctionSitePresentationCache | null
  key: string | null
  row: string | undefined
  input: ModObject
  inputKey: string
  epoch: number
  width: number
  renderer: Renderer
  canRetain: boolean
  current(): boolean
}

interface CommittedPresentation<Renderer> {
  cached: CachedFunctionSitePresentation
  input: FunctionSitePresentationInput<Renderer>
  retire(): void
}

export interface FunctionSitePresentationLease<Renderer> {
  lease: FunctionSiteProgressLease
  inputKey: string
  renderer: Renderer
  epoch: number
  width: number
  cache: FunctionSitePresentationCache
  row: string | undefined
  component: FunctionUiSite
}

interface PresentationSelection<Renderer> {
  kind: "exact" | "layout" | "progress" | "pending-progress"
  cached: CachedFunctionSitePresentation
  key: string | null
  renderer: Renderer
  width: number
}

export interface FunctionSitePresentationPlan<Renderer> {
  readonly owner: object
  readonly revision: number
  readonly input: FunctionSitePresentationInput<Renderer>
  readonly authorized: boolean
  readonly selection: PresentationSelection<Renderer> | null
  readonly retire: readonly (() => void)[]
}

export type FunctionSitePresentationCommit =
  | { kind: "accepted"; redraw: boolean }
  | { kind: "stale"; redraw: true }
  | { kind: "duplicate"; redraw: false }

/** View continuity only. Source/authority revocation remains synchronous in the cache/host. */
export class FunctionSitePresentationController<Renderer> {
  private readonly owner = {}
  private revision = 0
  private previous: { input: FunctionSitePresentationInput<Renderer>; retire(): void } | undefined
  private committed: CommittedPresentation<Renderer> | undefined
  private progress: FunctionSitePresentationLease<Renderer> | undefined
  private lastCommit: FunctionSitePresentationPlan<Renderer> | undefined

  lease(): FunctionSitePresentationLease<Renderer> | undefined {
    return this.progress
  }

  isCommitted(plan: FunctionSitePresentationPlan<Renderer> | null): boolean {
    return plan !== null && this.lastCommit === plan
  }

  private sameView(
    before: FunctionSitePresentationInput<Renderer>,
    after: FunctionSitePresentationInput<Renderer>
  ): boolean {
    return before.cache === after.cache && before.row === after.row &&
      before.component === after.component && before.epoch === after.epoch
  }

  private retainsLease(input: FunctionSitePresentationInput<Renderer>): boolean {
    const progress = this.progress
    return Boolean(progress && input.current() && progress.lease.current() &&
      progress.cache === input.cache && progress.row === input.row &&
      progress.component === input.component && progress.epoch === input.epoch &&
      input.canRetain && retainsFunctionSitePresentation(
        input.component, progress.inputKey, input.input, input.inputKey))
  }

  /** No leases, admission changes, LRU touches or expiration cleanup during React render. */
  plan(input: FunctionSitePresentationInput<Renderer>): FunctionSitePresentationPlan<Renderer> {
    const authorized = input.current()
    let selection: PresentationSelection<Renderer> | null = null
    const progress = this.progress
    if (progress && this.retainsLease(input)) {
      selection = { kind: "progress", cached: progress.lease, key: progress.lease.key,
        renderer: progress.renderer, width: progress.width }
    } else if (input.current()) {
      const committed = this.committed
      const previous = this.previous?.input
      const append = previous && this.sameView(previous, input) && input.canRetain &&
        previous.inputKey !== input.inputKey &&
        ["AssistantMessage", "ToolGroup"].includes(input.component) &&
        retainsFunctionSitePresentation(
          input.component, previous.inputKey, input.input, input.inputKey)
      if (append && committed && this.sameView(committed.input, input) &&
        committed.input.inputKey === previous.inputKey && committed.cached.current()) {
        selection = { kind: "pending-progress", cached: committed.cached,
          key: committed.input.key, renderer: committed.input.renderer, width: committed.input.width }
      } else {
        const exact = input.cache?.peek(input.key)
        if (exact) selection = { kind: "exact", cached: exact, key: input.key,
          renderer: input.renderer, width: input.width }
        else if (committed && this.sameView(committed.input, input) &&
          committed.input.inputKey === input.inputKey && committed.input.width !== input.width &&
          committed.cached.current()) {
          selection = { kind: "layout", cached: committed.cached, key: committed.input.key,
            renderer: committed.input.renderer, width: committed.input.width }
        }
      }
    }
    const retire: Array<() => void> = []
    if (this.previous && this.previous.input.inputKey !== input.inputKey) {
      retire.push(this.previous.retire)
      if (this.committed && this.committed.input.key !== this.previous.input.key)
        retire.push(this.committed.retire)
    }
    return { owner: this.owner, revision: this.revision, input, authorized, selection, retire }
  }

  /** Commit one actual DOM choice. A speculative or superseded plan cannot consume a cache entry. */
  commit(plan: FunctionSitePresentationPlan<Renderer>, cachedCommitted: boolean): FunctionSitePresentationCommit {
    // StrictMode repeats the same committed plan, after its revision has advanced.
    if (this.lastCommit === plan) return { kind: "duplicate", redraw: false }
    if (plan.owner !== this.owner || plan.revision !== this.revision ||
      (plan.authorized && !plan.input.current()) ||
      (cachedCommitted && plan.selection && !plan.selection.cached.current()))
      return { kind: "stale", redraw: true }
    const { input, selection } = plan
    const committed = this.committed
    let renderAgain = false
    if (this.progress && !this.retainsLease(input)) {
      this.progress.lease.release()
      this.progress = undefined
      renderAgain = true
    }
    const stillCurrent = input.current() && (!selection || selection.cached.current())
    if (selection?.kind === "pending-progress" && cachedCommitted && stillCurrent &&
      committed && this.sameView(committed.input, input) &&
      committed.cached.identity === selection.cached.identity && committed.cached.current()) {
      const lease = input.cache?.consumeProgress(selection.key, selection.cached, input.row)
      if (lease && input.cache) this.progress = { lease, inputKey: committed.input.inputKey,
        renderer: committed.input.renderer, epoch: committed.input.epoch,
        width: committed.input.width, cache: input.cache, row: input.row, component: input.component }
      renderAgain = true
    }
    // A consumed entry remains valid for this view; only retire its prior admission.
    // consumeProgress already did that. Other captures compare each exact record.
    if (!this.progress) for (const retire of plan.retire) retire()
    // Bind cleanup to the records owned at this actual commit. Looking up an old
    // key in a later render could capture another view's newly installed records.
    const retire = input.cache?.planRetirement(input.key, input.row) ?? (() => {})
    this.previous = { input, retire }
    if (cachedCommitted && stillCurrent && !this.progress && selection) {
      if (selection.kind === "exact") {
        this.committed = { cached: selection.cached, input, retire }
        input.cache?.touch(input.key, selection.cached)
      } else if (selection.kind === "layout") this.committed = committed
      else this.committed = undefined
    } else this.committed = undefined
    if (selection && !stillCurrent) renderAgain = true
    this.lastCommit = plan
    this.revision++
    return { kind: "accepted", redraw: renderAgain }
  }

  /** Owner replacement, explicit retry and real unmount end view continuity immediately. */
  reset(): void {
    this.progress?.lease.release()
    this.progress = undefined
    this.committed = undefined
    this.previous = undefined
    this.revision++
    this.lastCommit = undefined
  }
}
