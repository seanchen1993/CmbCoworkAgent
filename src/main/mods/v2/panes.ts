import { createHash, randomUUID } from "node:crypto"
import type { ModJson, ModObject, ModUiChangeScope } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { normalizeFunctionLinks } from "../../../shared/mods/v2/link-fallback"
import {
  ModFunctionError,
  isModObject,
  type FunctionInvocation
} from "../../../shared/mods/v2/contracts"
import {
  validateFunctionTree,
  validatePaneArgs,
  validateFunctionUiActionLink,
  type FunctionUiAction,
  type FunctionUiElement,
  type FunctionUiNode,
  type FunctionFocusResult,
  type FunctionPaneSnapshot
} from "../../../shared/mods/v2/ui"
import { FunctionScrollRequests } from "./ui-scroll"
import type { FunctionScrollArgs, FunctionScrollOutcome } from "../../../shared/mods/v2/ui-scroll"
import { FunctionFocusRequests } from "./ui-focus"
import type { FunctionFocusAddress, FunctionFocusOutcome } from "../../../shared/mods/v2/ui-focus"
import { functionFocusHandle, functionFocusTargets } from "../../../shared/mods/v2/focus"
import type { FunctionPlugin } from "./dispatcher"
import type { FunctionPaneDrawing, FunctionPaneInfo } from "../../../shared/mods/v2/desktop-actions"
import { functionEngineRefs, validateFunctionAskTree } from "../../../shared/mods/v2/engine"
import { FunctionNativeDrawing } from "./native-engine"
import type { FunctionClientReconcilePlan } from "./clients"
import { FunctionUiResolveDrawing } from "./ui-resolve-drawing"
import { nativeMarkdownLeaves, type FunctionMarkdownLinkRegistry,
  type FunctionMarkdownPublicationPlan } from "./markdown-link-registry"
import { captureFunctionMarkdownDisplay } from "./markdown-display-scope"
import { platformFormValues } from "../../../shared/mods/v2/platform-surfaces-widgets"

export interface FunctionUiDispatch {
  onlyPlugin?: string
  origin?: import("../../../shared/mods/v2/contracts").ModOrigin
  signal?: AbortSignal
  generation?: string
  operation?: boolean
  core?(input: ModObject, signal: AbortSignal): Promise<ModJson>
}
interface Pane extends FunctionPaneSnapshot {
  pendingGeneration?: string
  dirty: boolean
  actionsInvalidated?: boolean
  focused: boolean
  /** Root focus survives ordinary redraws, but never a revoked drawing lifecycle. */
  focusEpoch: object
  /** Constant-space identity for lifecycle state sampled by an asynchronous drawing. */
  stateEpoch: object
  visibleTree?: FunctionUiElement
  visibleEpoch?: object
  callbackTree?: FunctionUiElement
  markdownEpoch?: { frame: object; fault: object; identity: object }
  nativeDrawing?: FunctionNativeDrawing
  constructorDrawing?: FunctionUiResolveDrawing
  pendingConstructorDrawing?: FunctionUiResolveDrawing
  retryDrawing?: boolean
  faultEpoch: object
  faultRedrawQueued?: boolean
  faultGeneration?: string
  faultNotices?: Set<AbortController>
}
export interface PaneHost {
  /** Fixed by the native slot registry, never by a rendered node. */
  component?: import("../../../shared/mods/v2/sites").FunctionUiSite
  localNotificationsOnly?: boolean
  releaseState?(generation: string): void
  beginState?(generation: string): void
  clients?: import("./clients").FunctionClients
  markdownLinks?: FunctionMarkdownLinkRegistry
  markdownSiteOwner?: string
  plugins: readonly FunctionPlugin[]
  assertLive(): void
  changed(scope?: ModUiChangeScope): void
  publish(value: ModJson): Promise<ModJson>
  /** Native slot identity after this caller's complete synchronous lifecycle fence. */
  assertSiteCurrent?(pane: FunctionPaneSnapshot): void
  site?(pane: FunctionPaneSnapshot): { component: string; props: ModObject; requestId?: string }
  renderCore?(input: ModObject): Promise<ModJson>
  validateTree?(tree: unknown): void
  assertNativeCurrent?(pane: FunctionPaneSnapshot): void
  captureNativeIntent?(pane: FunctionPaneSnapshot): () => void
  withNativeIntent?<T>(assertCurrent: () => void, run: () => Promise<T>): Promise<T>
  withUiResolveDrawing?<T>(drawing: FunctionUiResolveDrawing, run: () => Promise<T>): Promise<T>
  dispatch(event: string, input: ModObject, options: FunctionUiDispatch): Promise<ModJson>
  callback(
    plugin: FunctionPlugin,
    event: string,
    input: ModObject,
    binding: NonNullable<FunctionInvocation["callback"]>,
    signal: AbortSignal
  ): Promise<void>
}

/** Owns drawings and person intents. An IPC retry never invokes a closure for a second time. */
export class FunctionPanes {
  private readonly panes = new Map<string, Pane>()
  private readonly intents = new Map<
    string,
    { input: string; result: Promise<void | FunctionFocusResult> }
  >()
  private serial: Promise<unknown> = Promise.resolve()
  private actions: Promise<unknown> = Promise.resolve()
  private readonly active = new Map<AbortController, string>()
  private readonly retained = new Map<string, number>()
  private readonly retired = new Set<string>()
  private notification?: ReturnType<typeof setTimeout>
  private notificationDeadline = 0
  private notificationScope?: ModUiChangeScope
  private closed = false
  private readonly markdownActions = new WeakSet<FunctionUiAction>()

  readonly scroll: FunctionScrollRequests
  readonly focus: FunctionFocusRequests
  constructor(private readonly host: PaneHost) {
    this.scroll = new FunctionScrollRequests({
      applied: (address, id, followEnd) => {
        const pane = this.panes.get(address.pane)!
        pane.scrollFollowToken = followEnd ? id : undefined
      },
      assertLive: (address) => {
        this.host.assertLive()
        const pane = this.panes.get(address.pane)
        if (
          !pane ||
          pane.dirty ||
          pane.generation !== address.generation ||
          pane.plugin !== address.plugin ||
          pane.id !== address.requestId
        )
          throw new ModFunctionError("MODS_UI_SCROLL_STALE")
      },
      changed: () => this.paneDataChanged(0)
    })
    this.focus = new FunctionFocusRequests({
      assertLive: (target) => {
        this.host.assertLive()
        const pane = this.panes.get(target.pane)
        if (
          !pane ||
          pane.generation !== target.generation ||
          pane.plugin !== target.plugin ||
          !functionFocusTargets({
            tree: pane.visibleTree ?? pane.tree,
            clients: pane.clients
          }).some(
            ({ target: drawn }) =>
              drawn.plugin === target.plugin &&
              drawn.element === target.element &&
              drawn.client === target.client
          )
        )
          throw new ModFunctionError("MODS_UI_FOCUS_STALE")
        if (target.client) {
          if (!this.host.clients) throw new ModFunctionError("MODS_UI_FOCUS_STALE")
          this.host.clients.assertFocus(target)
        }
      },
      changed: () => this.paneDataChanged(0)
    })
  }

  async requestFocus(
    plugin: string,
    args: { requestId: string; key: string },
    signal: AbortSignal,
    operation: (
      input: ModObject,
      core: (input: ModObject) => Promise<ModJson>,
      signal: AbortSignal
    ) => Promise<FunctionFocusOutcome>
  ): Promise<FunctionFocusOutcome> {
    this.host.assertLive()
    const pane = this.panes.get(`${plugin}:${args.requestId}`)
    if (!pane || pane.dirty || this.host.site) return { deny: "No current owned Pane drawing" }
    const targets = functionFocusTargets({
      tree: pane.visibleTree ?? pane.tree,
      clients: pane.clients
    })
    const drawn = targets.find(
      ({ target }) => target.plugin === plugin && target.element === args.key
    )?.target
    if (!drawn) return { deny: "Element is not drawn by this plugin" }
    const pin = (target: (typeof targets)[number]["target"]): FunctionFocusAddress => ({
      ...target,
      pane: pane.key,
      generation: pane.generation,
      ...(target.client
        ? {
            clientHandle: functionFocusHandle(
              pane.clients?.find((client) => client.id === target.client)?.tree,
              target
            )
          }
        : {})
    })
    const address = pin(drawn)
    return this.focus.run(address, signal, (apply, focusSignal) =>
      operation(
        {
          surface: "desktop",
          component: "Pane",
          requestId: pane.id,
          plugin,
          element: drawn.element,
          focused: true,
          origin: { kind: "plugin", name: plugin }
        },
        async (input) => {
          const selected = targets.find(
            ({ target }) => target.plugin === plugin && target.element === input.element
          )?.target
          if (!selected) return { deny: "Element is not drawn by this plugin" }
          return {
            ...(await apply(pin(selected)))
          }
        },
        focusSignal
      )
    )
  }

  async requestScroll(
    plugin: string,
    args: FunctionScrollArgs,
    signal: AbortSignal,
    operation: (
      input: ModObject,
      core: (input: ModObject) => Promise<ModJson>,
      signal: AbortSignal
    ) => Promise<FunctionScrollOutcome>
  ): Promise<FunctionScrollOutcome> {
    this.host.assertLive()
    if (this.host.site || (typeof args.to === "object" && "requestId" in args.to))
      return { deny: "Only owned desktop Pane targets are supported" }
    const target = typeof args.to === "object" ? args.to.key : undefined
    const candidates = [...this.panes.values()].filter((pane) => {
      if (pane.plugin !== plugin || pane.dirty || (args.in !== undefined && pane.id !== args.in))
        return false
      return (
        target === undefined ||
        functionFocusTargets({ tree: pane.visibleTree ?? pane.tree, clients: pane.clients }).some(
          ({ target: drawn }) =>
            !drawn.client && drawn.plugin === plugin && drawn.element === target
        )
      )
    })
    if (candidates.length !== 1) return { deny: "No unique current owned Pane target" }
    const pane = candidates[0]
    return this.scroll.run(
      { pane: pane.key, generation: pane.generation, plugin, requestId: pane.id },
      args,
      signal,
      (input, select, scrollSignal) =>
        operation(
          input,
          async (rewritten) => {
            if (typeof rewritten.offset !== "number")
              throw new ModFunctionError("MODS_UI_SCROLL_OFFSET")
            return { ...(await select(rewritten.offset)) }
          },
          scrollSignal
        )
    )
  }

  private changed(delay = 100, scope?: ModUiChangeScope): void {
    if (this.closed) return
    // Suppress native prop/open changes before coalescing, so they cannot swallow
    // a Client frame or its fault fallback notification in the same frame window.
    if (this.host.localNotificationsOnly && scope === undefined) return
    // Merge before the deadline fast path: an earlier Client frame must never hide
    // an explicit global invalidation, in either arrival order.
    if (!this.notification) this.notificationScope = scope
    else if (scope === undefined) this.notificationScope = undefined
    const deadline = performance.now() + delay
    if (this.notification && this.notificationDeadline <= deadline) return
    clearTimeout(this.notification)
    this.notificationDeadline = deadline
    this.notification = setTimeout(() => {
      const scope = this.notificationScope
      this.notification = undefined
      this.notificationScope = undefined
      if (!this.closed) this.host.changed(scope)
    }, delay)
    this.notification.unref()
  }

  private paneDataChanged(delay = 100): void {
    // Native sites own their publication notification. Opening or updating their
    // internal pane must not schedule another native draw.
    if (!this.host.localNotificationsOnly) this.changed(delay, "panes")
  }

  notify(): void {
    // Client frames are already bounded by their host scheduler. Batch them for one
    // frame without delaying interactive feedback behind ordinary pane invalidations.
    this.changed(16, "panes")
  }

  open(plugin: string, input: ModObject): void {
    this.host.assertLive()
    validatePaneArgs(input)
    const key = `${plugin}:${input.id}`
    const prior = this.panes.get(key)
    if (prior) {
      this.host.markdownLinks?.retire(prior)
      prior.constructorDrawing?.close()
      prior.pendingConstructorDrawing?.close()
      this.cancelClientFaults(prior)
      this.focus.cancel(key)
      this.scroll.cancel(key)
    }
    if (!prior && this.panes.size >= 8) throw new ModFunctionError("MODS_UI_PANE_LIMIT")
    this.panes.set(key, {
      key,
      openRequestId: randomUUID(),
      id: input.id as string,
      plugin,
      title: (input.title ?? input.id) as string,
      generation: prior?.generation ?? randomUUID(),
      tree: prior?.tree ?? { type: "Box", props: {}, children: [] },
      closeOnEscape: input.closeOnEscape === true,
      holdToasts: input.holdToasts === true,
      rows: typeof input.rows === "number" ? Math.min(50, input.rows) : 12,
      dirty: true,
      faultEpoch: {},
      focused: prior?.focused ?? false,
      focusEpoch: {},
      stateEpoch: {},
      ...(input.focus === true ? { focusRequest: { id: randomUUID(), pending: true } } : {})
    })
    this.paneDataChanged()
  }

  async closePane(plugin: string, id: string, cancelActions = true): Promise<void> {
    this.host.assertLive()
    const pane = this.panes.get(`${plugin}:${id}`)
    if (!pane) return
    this.cancelClientFaults(pane)
    this.focus.cancel(pane.key)
    this.scroll.cancel(pane.key)
    this.panes.delete(pane.key)
    this.host.markdownLinks?.retire(pane)
    pane.constructorDrawing?.close()
    pane.pendingConstructorDrawing?.close()
    this.host.clients?.closePane(pane.key)
    for (const [controller, key] of this.active)
      if (cancelActions && key === pane.key)
        controller.abort(new ModFunctionError("MODS_UI_PANE_CLOSED"))
    await this.release(pane.generation)
    this.paneDataChanged()
  }

  invalidate(scope?: ModUiChangeScope, revokeActions = false): void {
    this.host.assertLive()
    for (const pane of this.panes.values()) {
      this.host.markdownLinks?.retire(pane)
      this.cancelClientFaults(pane)
      this.focus.cancel(pane.key)
      this.scroll.cancel(pane.key)
      pane.dirty = true
      if (revokeActions) {
        pane.actionsInvalidated = true
        pane.focusEpoch = {}
      }
      pane.constructorDrawing?.close()
      pane.pendingConstructorDrawing?.close()
      pane.faultEpoch = {}
      pane.faultRedrawQueued = false
    }
    this.changed(100, scope)
  }

  invalidateGeneration(generation: string): boolean {
    let changed = false
    for (const pane of this.panes.values()) {
      if (pane.generation !== generation && pane.pendingGeneration !== generation) continue
      pane.focusEpoch = {}
      this.host.markdownLinks?.retire(pane)
      this.cancelClientFaults(pane)
      pane.dirty = true
      pane.constructorDrawing?.close()
      pane.pendingConstructorDrawing?.close()
      pane.faultEpoch = {}
      pane.faultRedrawQueued = false
      changed = true
      this.focus.cancel(pane.key)
      this.scroll.cancel(pane.key)
      this.changed()
    }
    return changed
  }

  captureClientFault(key: string, generation: string): import("./clients").FunctionClientFaultReceipt | undefined {
    this.host.assertLive()
    const pane = this.panes.get(key)
    if (!pane || pane.generation !== generation || pane.dirty || pane.pendingGeneration) return undefined
    this.host.assertNativeCurrent?.(pane)
    const epoch = pane.faultEpoch
    const controller = new AbortController()
    const notices = (pane.faultNotices ??= new Set())
    notices.add(controller)
    const assertCurrent = (): void => {
      controller.signal.throwIfAborted()
      if (this.closed || pane.dirty || pane.pendingGeneration || this.panes.get(key) !== pane || pane.generation !== generation ||
        pane.faultEpoch !== epoch) throw new ModFunctionError("MODS_UI_FAULT_STALE")
      this.host.assertNativeCurrent?.(pane)
    }
    return {
      component: this.host.component ?? "Pane",
      assertCurrent,
      signal: controller.signal,
      release: () => { pane.faultNotices?.delete(controller) },
      redraw: async () => {
        this.host.assertLive()
        assertCurrent()
        if (pane.dirty || pane.faultRedrawQueued) return
        pane.faultRedrawQueued = true
        pane.dirty = true
        this.focus.cancel(key)
        this.scroll.cancel(key)
        this.changed(0, "panes")
        await this.snapshot(
          (plugin, id) =>
            this.panes.get(key) === pane &&
            pane.generation === generation &&
            pane.faultEpoch === epoch &&
            !controller.signal.aborted &&
            plugin === pane.plugin &&
            id === pane.id
        )
      }
    }
  }

  private cancelClientFaults(pane: Pane): void {
    for (const controller of pane.faultNotices ?? [])
      controller.abort(new ModFunctionError("MODS_UI_FAULT_STALE"))
    pane.faultNotices?.clear()
  }

  captureClientDrawing(key: string, generation: string): import("./clients").FunctionClientDrawingReceipt | undefined {
    return this.captureClientFault(key, generation)
  }

  private async release(generation: string): Promise<void> {
    this.host.releaseState?.(generation)
    if (this.retained.has(generation)) {
      this.retired.add(generation)
      return
    }
    this.retired.delete(generation)
    await Promise.allSettled(
      this.host.plugins.map((plugin) =>
        Promise.resolve().then(() => plugin.guest.releaseUi(generation))
      )
    )
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.then(() => {
      this.host.assertLive()
      return fn()
    })
    this.serial = task.catch(() => {})
    return task
  }

  /** Each native read freezes its starting inventory before drawing or retiring any callback. */
  snapshot(select?: (plugin: string, id: string) => boolean): Promise<FunctionPaneSnapshot[]> {
    return this.enqueue(async () => {
      type Candidate = {
        pane: Pane
        epoch: object
        stateEpoch: object
        generation: string
        previousGeneration: string
        drawing: FunctionNativeDrawing
        constructorDrawing?: FunctionUiResolveDrawing
        tree: FunctionUiElement
        faultRedraw: boolean
        fresh: boolean
        plan?: FunctionClientReconcilePlan
        visible?: FunctionPaneSnapshot
        callbackTree?: FunctionUiElement
        markdownPlan?: FunctionMarkdownPublicationPlan
        markdownEpoch?: Pane["markdownEpoch"]
      }
      const candidates: Candidate[] = []
      let committed = false
      const assertCurrent = (candidate: Candidate): void => {
        this.host.assertLive()
        if (this.closed || this.panes.get(candidate.pane.key) !== candidate.pane ||
          candidate.pane.faultEpoch !== candidate.epoch ||
          (!candidate.fresh && candidate.pane.generation !== candidate.generation) ||
          (candidate.fresh && candidate.pane.pendingGeneration !== candidate.generation &&
            candidate.pane.generation !== candidate.generation))
          throw new ModFunctionError("MODS_UI_DRAWING_STALE")
        // Native request identity is checked by the slot registry on every async boundary.
        if (this.host.assertSiteCurrent) this.host.assertSiteCurrent(candidate.pane)
        else this.host.site?.(candidate.pane)
      }
      const checkedTree = (tree: unknown, component: string, legacy = false): FunctionUiElement => {
        validateFunctionTree(tree)
        this.host.validateTree?.(tree)
        let normalized = normalizeFunctionLinks(tree)
        if (component === "AskUserQuestion") {
          if (legacy && functionEngineRefs(normalized).length === 0)
            normalized = { type: "Box", props: {}, children: [normalized, { type: "engine", ref: 0 }] }
          validateFunctionAskTree(normalized)
        }
        return normalized
      }
      try {
        const selected = [...this.panes.values()].filter(
          (pane) => !select || select(pane.plugin, pane.id)
        )
        for (const pane of selected) {
          const fresh = pane.dirty || pane.retryDrawing === true || !pane.nativeDrawing
          const candidate = {
            pane, epoch: pane.faultEpoch, stateEpoch: pane.stateEpoch,
            generation: fresh ? randomUUID() : pane.generation,
            previousGeneration: pane.generation,
            tree: pane.tree, faultRedraw: pane.faultRedrawQueued === true, fresh
          } as Candidate
          candidates.push(candidate)
          if (fresh) {
            pane.pendingGeneration = candidate.generation
            this.host.beginState?.(candidate.generation)
            // The last healthy drawing remains authoritative until the synchronous commit.
            pane.dirty = false
            const site = this.host.site?.(pane)
            const input: ModObject = {
              surface: "desktop", component: site?.component ?? "Pane", requestId: pane.id,
              props: site?.props ?? {
                title: pane.title, isFocused: pane.focused, placement: "inline", bodyColumns: 80
              }
            }
            candidate.drawing = new FunctionNativeDrawing(input, () => assertCurrent(candidate),
              site?.requestId)
            const render = () => this.host.dispatch("ui.render", input, {
              generation: candidate.generation,
              core: async (received) => candidate.drawing.keep(received)
            })
            let tree: ModJson
            if (this.host.withUiResolveDrawing) {
              const drawing = new FunctionUiResolveDrawing(
                (this.host.component ?? "Pane"), candidate.generation, pane.id,
                () => assertCurrent(candidate)
              )
              candidate.constructorDrawing = drawing
              pane.pendingConstructorDrawing = drawing
              tree = await this.host.withUiResolveDrawing(drawing, render)
            } else tree = await render()
            assertCurrent(candidate)
            candidate.tree = checkedTree(tree, input.component as string, true)
            candidate.callbackTree = candidate.tree
          } else candidate.drawing = pane.nativeDrawing!
          candidate.callbackTree ??= pane.callbackTree ?? candidate.tree
          candidate.drawing.beginPublication()
          // Protect actual input even when the guest never called next or uses an unknown ref.
          await candidate.drawing.protect(candidate.tree, (value) => this.host.publish(value))
          assertCurrent(candidate)
        }
        const snapshots = candidates.map(({ pane, generation, tree, fresh }) =>
          parseModJson(encodeModJson({
            key: pane.key, id: pane.id, plugin: pane.plugin, title: pane.title, generation, tree,
            closeOnEscape: pane.closeOnEscape, ...(pane.holdToasts ? { holdToasts: true } : {}),
            rows: pane.rows,
            ...(pane.openRequestId ? { openRequestId: pane.openRequestId } : {}),
            ...(pane.focusRequest ? { focusRequest: pane.focusRequest } : {}),
            ...(pane.scrollFollowToken ? { scrollFollowToken: pane.scrollFollowToken } : {}),
            ...(!fresh && this.focus.current(pane.key) ? { imperativeFocus: this.focus.current(pane.key) } : {}),
            ...(!fresh && this.scroll.current(pane.key) ? { imperativeScroll: this.scroll.current(pane.key) } : {})
          })) as unknown as FunctionPaneSnapshot
        )
        const published = await this.host.publish(snapshots as unknown as ModJson)
        this.host.assertLive()
        if (!Array.isArray(published) || published.length !== snapshots.length)
          throw new ModFunctionError("MODS_UI_PUBLICATION")
        for (let index = 0; index < candidates.length; index++) {
          const candidate = candidates[index]
          assertCurrent(candidate)
          const result = published[index]
          const original = snapshots[index] as unknown as ModObject
          if (!isModObject(result) || typeof result.title !== "string" ||
            Object.keys(result).some((key) => !Object.hasOwn(original, key)) ||
            Object.keys(original).some((key) => !["title", "tree"].includes(key) &&
              encodeModJson({ value: result[key] }) !== encodeModJson({ value: original[key] })))
            throw new ModFunctionError("MODS_UI_PUBLICATION")
          const safeTree = checkedTree(result.tree, this.host.component ?? "Pane")
          const nativeContent = await candidate.drawing.protect(safeTree,
            (value) => this.host.publish(value))
          assertCurrent(candidate)
          candidate.tree = safeTree
          candidate.visible = { ...result, tree: safeTree, nativeContent } as unknown as FunctionPaneSnapshot
          const display = captureFunctionMarkdownDisplay()
          if (this.host.markdownLinks && display) {
            const pane = candidate.pane
            candidate.markdownEpoch = pane.markdownEpoch?.frame === display.epoch &&
              pane.markdownEpoch.fault === candidate.epoch ? pane.markdownEpoch :
              { frame: display.epoch, fault: candidate.epoch, identity: {} }
            const origins = new Map<string, Extract<FunctionUiElement, { type: "Markdown" }>>()
            const callbackKey = (node: Extract<FunctionUiElement, { type: "Markdown" }>) =>
              JSON.stringify([node.props.key, node.press?.plugin, node.press?.handle])
            nativeMarkdownLeaves(candidate.callbackTree!, node => {
              if (node.press) origins.set(callbackKey(node), node)
              return undefined
            })
            const leaves = nativeMarkdownLeaves(safeTree, node => {
              if (!node.press) return undefined
              const original = origins.get(callbackKey(node))
              if (!original?.press || original.press.kind !== "onLinkPress")
                throw new ModFunctionError("MODS_UI_PUBLICATION")
              const press = original.press
              const nativeIntent = this.host.captureNativeIntent?.(pane)
              const assertIntent = () => {
                if (this.closed || this.panes.get(pane.key) !== pane)
                  throw new ModFunctionError("MODS_UI_STALE_ACTION")
                nativeIntent?.()
              }
              return { identity: original, run: async (href, intentId) => {
                const action: FunctionUiAction = { pane: pane.key,
                  generation: candidate.generation, intentId, plugin: press.plugin,
                  handle: press.handle, kind: "press", link: { href } }
                this.markdownActions.add(action)
                assertIntent()
                const run = () => this.act(action)
                await (this.host.withNativeIntent
                  ? this.host.withNativeIntent(assertIntent, run) : run())
                assertIntent()
              } }
            })
            candidate.markdownPlan = this.host.markdownLinks.prepare({ owner: pane,
              epoch: candidate.markdownEpoch.identity,
              contentFingerprint: createHash("sha256").update(encodeModJson({
                title: candidate.visible.title, tree: safeTree, nativeContent
              })).digest("hex"),
              address: this.host.markdownSiteOwner
                ? { kind: "site", owner: this.host.markdownSiteOwner, pane: pane.key,
                    generation: candidate.generation }
                : { kind: "pane", pane: pane.key, generation: candidate.generation },
              assertCurrent: () => { display.assertCurrent(); assertCurrent(candidate) }
            }, leaves)
            candidate.visible.markdownLinks = candidate.markdownPlan.markdownLinks
          }
          if (this.host.clients)
            candidate.plan = this.host.clients.prepareReconcile(candidate.pane.key,
              candidate.pane.id, candidate.generation, safeTree, candidate.faultRedraw,
              this.host.component ?? "Pane", () => assertCurrent(candidate))
        }
        // No await here: every private owner/descriptor/capacity preflight precedes parent adoption.
        const markdownPlans = candidates.flatMap(candidate => candidate.markdownPlan
          ? [candidate.markdownPlan] : [])
        const markdownBatch = this.host.markdownLinks?.assertPrepared(markdownPlans)
        for (const candidate of candidates) {
          assertCurrent(candidate)
          if (candidate.plan) this.host.clients!.assertReconcileCurrent(candidate.plan)
        }
        for (const candidate of candidates)
          if (candidate.plan) this.host.clients!.commitReconcile(candidate.plan)
        for (const candidate of candidates) {
          const pane = candidate.pane
          if (candidate.fresh) {
            this.cancelClientFaults(pane)
            this.focus.cancel(pane.key)
            this.scroll.cancel(pane.key)
          }
          pane.generation = candidate.generation
          if (candidate.fresh) {
            pane.constructorDrawing?.close()
            pane.constructorDrawing = candidate.constructorDrawing
            pane.pendingConstructorDrawing = undefined
          }
          pane.pendingGeneration = undefined
          pane.tree = candidate.tree
          pane.visibleTree = candidate.tree
          pane.visibleEpoch = candidate.epoch
          pane.callbackTree = candidate.callbackTree
          pane.markdownEpoch = candidate.markdownEpoch
          pane.nativeDrawing = candidate.drawing
          pane.nativeContent = candidate.visible!.nativeContent
          pane.faultGeneration = candidate.faultRedraw ? candidate.generation : undefined
          pane.faultRedrawQueued = false
          // Client adoption needs the committed drawing to be clean. The finally fence below
          // restores any newer state update after adoption, even if reconciliation rejects.
          pane.dirty = false
          pane.retryDrawing = false
          pane.actionsInvalidated = false
        }
        committed = true
        if (markdownBatch) this.host.markdownLinks!.commitPrepared(markdownBatch)
        for (const candidate of candidates)
          if (!candidate.markdownPlan) this.host.markdownLinks?.retire(candidate.pane)
        // Only now retire callbacks and redraw Clients. A VM's state is never rolled back.
        for (const candidate of candidates)
          if (candidate.fresh) await this.release(candidate.previousGeneration)
        const visible: FunctionPaneSnapshot[] = []
        for (const candidate of candidates) {
          if (candidate.plan)
            candidate.visible!.clients = await this.host.clients!.reconcilePrepared(candidate.plan)
          assertCurrent(candidate)
          candidate.pane.clients = candidate.visible!.clients
          visible.push(candidate.visible!)
        }
        return visible
      } finally {
        for (const candidate of candidates) {
          if (candidate.markdownPlan) this.host.markdownLinks?.discard(candidate.markdownPlan)
          if (candidate.plan) this.host.clients!.discardReconcile(candidate.plan)
          if (!committed && candidate.fresh) {
            candidate.constructorDrawing?.close()
            if (this.panes.get(candidate.pane.key) === candidate.pane &&
              candidate.pane.faultEpoch === candidate.epoch) {
              const healthy = candidate.pane.visibleTree !== undefined &&
                candidate.pane.visibleEpoch === candidate.epoch
              candidate.pane.dirty = !healthy || candidate.pane.stateEpoch !== candidate.stateEpoch
              candidate.pane.retryDrawing = true
            }
            await this.release(candidate.generation)
          }
          if (candidate.pane.pendingGeneration === candidate.generation)
            candidate.pane.pendingGeneration = undefined
          if (candidate.pane.pendingConstructorDrawing === candidate.constructorDrawing)
            candidate.pane.pendingConstructorDrawing = undefined
          if (
            committed &&
            this.panes.get(candidate.pane.key) === candidate.pane &&
            candidate.pane.stateEpoch !== candidate.stateEpoch
          ) {
            // A completed lifecycle event cannot be erased by a drawing that sampled older state.
            // Request one normal redraw; the next candidate captures the current constant-space epoch.
            candidate.pane.dirty = true
            this.paneDataChanged()
          }
        }
      }
    })
  }

  /** Metadata query only: never calls render, snapshot, or a retained UI closure. */
  holdsToasts(drawings: FunctionPaneDrawing[]): boolean {
    this.host.assertLive()
    return drawings.some(drawing => {
      const pane = this.panes.get(drawing.key)
      return drawing.isShown && pane?.holdToasts === true && !pane.dirty &&
        pane.generation === drawing.generation && pane.visibleTree !== undefined
    })
  }

  /** Metadata query only: never calls render, snapshot, or a retained UI closure. */
  metadata(plugin: string, drawings: FunctionPaneDrawing[]): FunctionPaneInfo[] {
    this.host.assertLive()
    return [...this.panes.values()].filter(pane => pane.plugin === plugin).map(pane => {
      const drawing = pane.dirty ? undefined : drawings.find(row => row.key === pane.key && row.generation === pane.generation)
      return { id: pane.id, title: pane.title, isPlaced: Boolean(drawing?.isPlaced),
        isShown: Boolean(drawing?.isShown), isFocused: Boolean(drawing?.isFocused) }
    }).sort((left, right) => Number(right.isPlaced) - Number(left.isPlaced))
  }

  act(action: FunctionUiAction): Promise<void | FunctionFocusResult> {
    this.host.assertLive()
    if (isModObject(action) && Object.hasOwn(action, "link") && !this.markdownActions.has(action))
      return Promise.reject(new ModFunctionError("MODS_UI_MARKDOWN_ACTION_INVALID"))
    if (
      !isModObject(action) ||
      typeof action.intentId !== "string" ||
      !/^[\w-]{16,100}$/.test(action.intentId) ||
      typeof action.pane !== "string" ||
      action.pane.length > 200 ||
      typeof action.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(action.generation) ||
      typeof action.plugin !== "string" ||
      action.plugin.length > 100 ||
      !(action.kind === "focus" || action.kind === "scroll"
        ? action.handle === undefined || action.handle === 0
        : Number.isSafeInteger(action.handle) && action.handle >= 0) ||
      !["press", "change", "submit", "select", "close", "focus", "scroll"].includes(action.kind) ||
      (action.kind === "focus" || action.kind === "scroll"
        ? !isModObject(action.value)
        : action.value !== undefined &&
          (typeof action.value !== "string" || action.value.length > 10000))
    )
      return Promise.reject(new ModFunctionError("MODS_UI_ACTION_INVALID"))
    const input = createHash("sha256").update(encodeModJson(action)).digest("hex")
    const prior = this.intents.get(action.intentId)
    if (prior)
      return prior.input === input
        ? prior.result
        : Promise.reject(new ModFunctionError("MODS_UI_INTENT_CONFLICT"))
    const admissionPane = this.panes.get(action.pane)
    if (!admissionPane || admissionPane.generation !== action.generation ||
      admissionPane.actionsInvalidated)
      return Promise.reject(new ModFunctionError("MODS_UI_STALE_ACTION"))
    // Keep settled IDs for the life of the session: evicting one could replay its action.
    if (this.intents.size >= 4096)
      return Promise.reject(new ModFunctionError("MODS_UI_INTENT_LIMIT"))
    const perform = async (): Promise<void | FunctionFocusResult> => {
      this.host.assertLive()
      const pane = this.panes.get(action.pane)
      // Reopening the same id can retain its generation until redraw, but replaces its owner object.
      if (
        !pane || pane !== admissionPane ||
        pane.generation !== action.generation || pane.actionsInvalidated
      )
        throw new ModFunctionError("MODS_UI_STALE_ACTION")
      if (action.kind === "close") {
        validateFunctionUiActionLink(action, false)
        await this.host.dispatch(
          "ui.close",
          { id: pane.id, origin: { kind: "person" } },
          {
            operation: true,
            core: async () => {
              if (this.panes.get(pane.key) !== pane)
                throw new ModFunctionError("MODS_UI_STALE_ACTION")
              await this.closePane(pane.plugin, pane.id)
              return {}
            }
          }
        )
        return
      }
      if (action.kind === "focus" || action.kind === "scroll") {
        validateFunctionUiActionLink(action, false)
        if (action.plugin !== pane.plugin || (action.handle !== undefined && action.handle !== 0))
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        const value = action.value
        if (!isModObject(value)) throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (
          action.kind === "focus" &&
          (typeof value.focused !== "boolean" ||
            (value.request !== undefined && typeof value.request !== "string") ||
            Object.keys(value).some((key) => !["focused", "request"].includes(key)))
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (
          action.kind === "scroll" &&
          (Object.keys(value).some((key) => !["deltaX", "deltaY", "top", "left"].includes(key)) ||
            ![value.deltaX, value.deltaY, value.top, value.left].every(
              (number) =>
                typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 100000
            ))
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (action.kind === "focus" && value.request !== undefined) {
          if (pane.focusRequest?.id !== value.request || !pane.focusRequest.pending)
            throw new ModFunctionError("MODS_UI_STALE_FOCUS")
          pane.focusRequest.pending = false
          if (!value.focused) return { focused: false }
        }
        const targets = functionFocusTargets({
          tree: pane.visibleTree ?? pane.tree,
          clients: pane.clients
        })
        const target =
          action.kind === "focus" && value.focused
            ? targets.find((row) => row.autoFocus)?.target
            : undefined
        let focusResult: FunctionFocusResult = { focused: false }
        let focusApplied = false
        const controller = new AbortController()
        const focusEpoch = pane.focusEpoch
        const assertLifecycleCurrent = () => {
          this.host.assertLive()
          controller.signal.throwIfAborted()
          // The already admitted root focus event records Pane state, not an old control action.
          // Control/Client focus and scroll remain pinned to their exact drawing generation.
          const rootFocus = action.kind === "focus" && !target && !focusResult.target
          if (
            this.panes.get(pane.key) !== pane ||
            pane.focusEpoch !== focusEpoch ||
            pane.actionsInvalidated ||
            (!rootFocus && pane.generation !== action.generation)
          )
            throw new ModFunctionError("MODS_UI_STALE_ACTION")
        }
        this.active.set(controller, pane.key)
        this.retained.set(action.generation, (this.retained.get(action.generation) ?? 0) + 1)
        try {
          const outcome = await this.host.dispatch(
            action.kind === "focus" ? "ui.focus" : "ui.scroll",
            {
              surface: "desktop",
              component: this.host.site?.(pane).component ?? "Pane",
              requestId: pane.id,
              plugin: target?.plugin ?? pane.plugin,
              element: target?.element ?? pane.id,
              ...(action.kind === "focus"
                ? {
                    focused: value.focused,
                    origin: target
                      ? { kind: "plugin", name: target.plugin }
                      : value.request === undefined
                        ? { kind: "person" }
                        : { kind: "plugin", name: pane.plugin }
                  }
                : { value })
            },
            {
              signal: controller.signal,
              generation: action.generation,
              core: async (input): Promise<ModJson> => {
                assertLifecycleCurrent()
                if (action.kind === "focus") {
                  const selected = targets.find(
                    (row) =>
                      row.target.plugin === input.plugin &&
                      row.target.element === input.element &&
                      row.target.client === target?.client
                  )?.target
                  if (input.element !== pane.id && !selected)
                    return { deny: "Element is not drawn" }
                  controller.signal.throwIfAborted()
                  focusResult = {
                    focused: input.focused as boolean,
                    ...(selected ? { target: selected } : {})
                  }
                  focusApplied = true
                }
                return {
                  element: pane.id,
                  value: action.kind === "focus" ? { focused: input.focused } : input.value
                }
              }
            }
          )
          assertLifecycleCurrent()
          if (action.kind === "focus") {
            if (isModObject(outcome) && typeof outcome.deny === "string") {
              focusResult = { focused: false }
              focusApplied = false
            }
            if (focusResult.focused && focusResult.target?.client && this.host.clients)
              await this.host.clients.focusFromPane(
                pane.key,
                focusResult.target.client,
                focusResult.target.element,
                true
              )
            assertLifecycleCurrent()
            if (focusApplied) pane.focused = focusResult.focused
          }
          this.cancelClientFaults(pane)
          pane.stateEpoch = {}
          pane.dirty = true
          this.paneDataChanged()
        } finally {
          this.active.delete(controller)
          const count = this.retained.get(action.generation)! - 1
          if (count) this.retained.set(action.generation, count)
          else {
            this.retained.delete(action.generation)
            if (this.retired.has(action.generation)) await this.release(action.generation)
          }
        }
        return action.kind === "focus" ? focusResult : undefined
      }
      const find = (node: FunctionUiElement | string):
        FunctionUiNode | Extract<FunctionUiElement, { type: "Markdown" }> | undefined => {
        if (typeof node === "string" || node.type === "engine") return undefined
        if (
          node.type !== "fragment" &&
          node.press?.plugin === action.plugin && node.press?.handle === action.handle
        ) return node
        for (const child of node.children ?? []) {
          const found = find(child)
          if (found) return found
        }
        return undefined
      }
      const node = find(pane.visibleTree ?? pane.tree)
      const plugin = this.host.plugins.find((plugin) => plugin.name === action.plugin)
      if (!node || !plugin) throw new ModFunctionError("MODS_UI_STALE_ACTION")
      validateFunctionUiActionLink(action, node.type === "Markdown")
      const kind =
        node.type === "Markdown" ? "onLinkPress" : action.kind === "press"
          ? "onPress"
          : action.kind === "select"
            ? "onSelect"
            : action.kind === "submit"
              ? "onSubmit"
              : "onInput"
      if (
        node.type !== "Markdown" && !(node.type === "Form" && action.kind === "submit") && node.type !==
        (action.kind === "press" ? "Button" : action.kind === "select" ? "Select" : "Input")
      )
        throw new ModFunctionError("MODS_UI_ACTION_INVALID")
      const event =
        action.kind === "press" ? "ui.press" : action.kind === "select" ? "ui.select" : "ui.input"
      const elementKey = node.props.key
      if (typeof elementKey !== "string" || !elementKey)
        throw new ModFunctionError("MODS_UI_ACTION_INVALID")
      const e: ModObject = {
        plugin: plugin.name,
        element: elementKey,
        component: this.host.site?.(pane).component ?? "Pane",
        requestId: pane.id,
        surface: "desktop",
        ...(event !== "ui.press" ? { value: action.value ?? "" } : {}),
        ...(node.type === "Markdown" ? { link: { href: action.link!.href } } : {}),
        ...(event === "ui.input" ? { kind: action.kind } : {})
      }
      const controller = new AbortController()
      this.active.set(controller, pane.key)
      this.retained.set(action.generation, (this.retained.get(action.generation) ?? 0) + 1)
      try {
        await this.host.dispatch(event, e, {
          signal: controller.signal,
          core: async (input, signal): Promise<ModJson> => {
            signal.throwIfAborted()
            if (node.type === "Form") platformFormValues(node.props, String(input.value ?? ""))
            if (
              node.type === "Select" &&
              !(node.props.options as ModObject[]).some((option) => option.value === input.value)
            )
              throw new ModFunctionError("MODS_UI_ACTION_INVALID")
            await this.host.callback(
              plugin,
              event,
              input,
              { handle: action.handle, generation: action.generation, kind },
              signal
            )
            return event === "ui.press"
              ? { element: input.element }
              : { element: input.element, value: input.value }
          }
        })
        this.host.assertLive()
      } finally {
        this.active.delete(controller)
        const count = this.retained.get(action.generation)! - 1
        if (count) this.retained.set(action.generation, count)
        else {
          this.retained.delete(action.generation)
          if (this.retired.has(action.generation)) await this.release(action.generation)
        }
      }
    }
    // Rendering and closing remain responsive while a callback waits for a queued command.
    // Mutating callbacks stay serial so read/modify/write closures do not lose updates.
    const result = action.kind === "close" ? perform() : this.actions.then(perform)
    if (action.kind !== "close") this.actions = result.catch(() => {})
    this.intents.set(action.intentId, { input, result })
    return result
  }

  close(): void {
    this.closed = true
    for (const pane of this.panes.values()) {
      this.host.markdownLinks?.retire(pane)
      pane.constructorDrawing?.close()
      pane.pendingConstructorDrawing?.close()
      this.host.clients?.closePane(pane.key)
      void this.release(pane.generation)
      if (pane.pendingGeneration) void this.release(pane.pendingGeneration)
    }
    this.focus.close()
    this.scroll.close()
    clearTimeout(this.notification)
    for (const controller of this.active.keys()) controller.abort()
    this.active.clear()
    for (const pane of this.panes.values()) this.cancelClientFaults(pane)
    this.panes.clear()
    this.intents.clear()
  }
}
