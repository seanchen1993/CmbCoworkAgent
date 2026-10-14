import { createHash, randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import {
  isModObject,
  ModFunctionError,
  type FunctionGuest
} from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { validateFunctionClientTree } from "../../../shared/mods/v2/engine"
import { normalizeFunctionLinks } from "../../../shared/mods/v2/link-fallback"
import { functionFocusHandle } from "../../../shared/mods/v2/focus"
import type { FunctionFocusAddress } from "../../../shared/mods/v2/ui-focus"
import { functionUiFaultReason, type FunctionUiFaultPhase } from "../../../shared/mods/v2/ui-fault"
import { nativeMarkdownLeaves, type FunctionMarkdownLinkRegistry } from "./markdown-link-registry"
import { captureFunctionMarkdownDisplay, type FunctionMarkdownDisplayScope } from "./markdown-display-scope"
import { isFunctionGuestLoadFailure } from "./client-load-failure"
import { isFunctionGuestInvokeFailure } from "./guest-invoke-failure"
import {
  validateFunctionTree,
  type FunctionClientAction,
  type FunctionClientSnapshot,
  type FunctionUiElement,
  type FunctionUiNode
} from "../../../shared/mods/v2/ui"

interface ClientHost {
  markdownLinks?: FunctionMarkdownLinkRegistry
  assertLive(plugin?: string): void
  background<T>(run: () => Promise<T>): Promise<T>
  load(plugin: string, module: string): Promise<FunctionGuest>
  checkModule?(plugin: string, module: string): void
  changed(pane: string): void
  publish(value: ModJson): Promise<ModJson>
  message(plugin: string, input: ModObject, signal: AbortSignal): Promise<ModJson>
  captureFault?(pane: string, generation: string): FunctionClientFaultReceipt | undefined
  captureDrawing?(pane: string, generation: string): FunctionClientDrawingReceipt | undefined
  withDrawing?<T>(receipt: FunctionClientDrawingReceipt, run: () => Promise<T>): Promise<T>
  fault?(plugin: string, input: ModObject, signal: AbortSignal, assertLive: () => void): Promise<void>
  control(
    event: string,
    input: ModObject,
    core: (input: ModObject) => Promise<ModJson>,
    signal: AbortSignal
  ): Promise<ModJson>
}
export interface FunctionClientDrawingReceipt {
  component?: string
  assertCurrent(): void
  signal: AbortSignal
  release(): void
}
export interface FunctionClientFaultReceipt extends FunctionClientDrawingReceipt {
  redraw(): Promise<void>
}
interface Instance {
  key: string
  pane: string
  requestId: string
  component: string
  snapshot: FunctionClientSnapshot
  markdownDisplay?: FunctionMarkdownDisplayScope
  markdownEpoch?: { frame: object; parent: string; identity: object }
  markdownTreeEpoch?: object
  sourceProps: string
  rawTree?: string
  parentGeneration: string
  props: ModJson | undefined
  propsEpoch: object
  columns: number
  rows: number
  serial: Promise<unknown>
  loading: Promise<FunctionGuest>
  guest?: FunctionGuest
  stopped: boolean
  faultBorn: boolean
  faultController?: AbortController
  needsDraw?: boolean
  controller: AbortController
  pending: number
  backgroundRunning: boolean
  backgroundEvents: Map<string, { input: ModObject; generation: string }>
  renderStreak: number
  pendingMessage?: { data: ModJson; generation: string }
  pendingDrawResult?: { dirty: boolean; message?: { data: ModJson; generation: string } }
  frame?: ReturnType<typeof setTimeout>
  timers: Map<string, { ms: number; timer: ReturnType<typeof setInterval> }>
}
function visit(tree: FunctionUiElement, fn: (node: FunctionUiNode) => void): void {
  if (tree.type === "engine" || tree.type === "Markdown") return
  if (tree.type !== "fragment") fn(tree)
  for (const child of tree.children ?? []) if (typeof child !== "string") visit(child, fn)
}

declare const clientReconcilePlan: unique symbol
/** Host-only receipt. A cloned/serialized object is never an admitted plan. */
export interface FunctionClientReconcilePlan {
  readonly [clientReconcilePlan]: true
}
interface PreparedReconcile {
  pane: string
  requestId: string
  generation: string
  component: string
  faultRedraw: boolean
  nodes: readonly FunctionUiNode[]
  expected: Map<string, {
    instance: Instance; generation: string; sourceProps: string; props: string;
    propsEpoch: object; stopped: boolean
  }>
  epoch: object
  assertPreparation?: () => void
  reserved: number
  phase: "prepared" | "committed" | "adopting" | "done" | "discarded"
}

/** Mounted Client identity survives parent redraws; only approved surface code enters its VM. */
export class FunctionClients {
  private readonly instances = new Map<string, Instance>()
  private readonly intents = new Map<string, { input: string; result: Promise<void> }>()
  private readonly faults = new Map<Instance, Promise<void>>()
  private readonly refusals = new WeakSet<Error>()
  private readonly drawings = new AsyncLocalStorage<FunctionClientDrawingReceipt | undefined>()
  private readonly plans = new WeakMap<FunctionClientReconcilePlan, PreparedReconcile>()
  private readonly reservations = new Set<PreparedReconcile>()
  private readonly paneEpochs = new Map<string, object>()
  // A stopped VM still occupies its slot until its real disposal has settled successfully.
  private readonly occupied = new Set<Instance>()
  private closed = false
  constructor(private readonly host: ClientHost) {}

  private assert(instance?: Instance): void {
    try { this.drawings.getStore()?.assertCurrent() }
    catch (error) {
      if (error instanceof Error) this.refusals.add(error)
      throw error
    }
    this.host.assertLive(instance?.snapshot.plugin)
    if (
      this.closed ||
      (instance && (instance.stopped || this.instances.get(instance.key) !== instance))
    )
      throw new ModFunctionError("MODS_CLIENT_UNMOUNTED")
  }

  private stop(instance: Instance): void {
    this.host.markdownLinks?.retire(instance)
    instance.faultController?.abort(new ModFunctionError("MODS_CLIENT_UNMOUNTED"))
    instance.stopped = true
    instance.controller.abort(new ModFunctionError("MODS_CLIENT_UNMOUNTED"))
    clearTimeout(instance.frame)
    for (const { timer } of instance.timers.values()) clearInterval(timer)
    instance.timers.clear()
    instance.backgroundEvents.clear()
    instance.pendingMessage = undefined
    instance.pendingDrawResult = undefined
    void instance.loading.then(async (guest) => {
      await guest.dispose()
      this.occupied.delete(instance)
    }, () => { this.occupied.delete(instance) }).catch(() => {})
  }

  closePane(pane: string): void {
    this.paneEpochs.set(pane, {})
    for (const plan of this.reservations)
      if (plan.pane === pane) this.discardPrepared(plan)
    for (const [key, instance] of this.instances)
      if (instance.pane === pane) {
        this.instances.delete(key)
        this.stop(instance)
      }
  }

  /** Read the live instance directly: a published Pane snapshot can lag a Client redraw. */
  assertFocus(target: FunctionFocusAddress): void {
    this.assert()
    const instance = [...this.instances.values()].find(
      (row) => row.pane === target.pane && row.snapshot.id === target.client
    )
    if (
      !instance ||
      instance.snapshot.plugin !== target.plugin ||
      target.clientHandle === undefined ||
      functionFocusHandle(instance.snapshot.tree, target) !== target.clientHandle
    )
      throw new ModFunctionError("MODS_UI_FOCUS_STALE")
    this.assert(instance)
  }

  /** Pane core already ran ui.focus. Deliver its decision to the live isolated surface once. */
  async focusFromPane(
    pane: string,
    client: string,
    element: string,
    focused: boolean
  ): Promise<void> {
    this.assert()
    const instance = [...this.instances.values()].find(
      (row) => row.pane === pane && row.snapshot.id === client
    )
    if (!instance) throw new ModFunctionError("MODS_CLIENT_UNMOUNTED")
    await this.enqueue(instance, async () => {
      this.assert(instance)
      let found = false
      visit(instance.snapshot.tree, (node) => {
        if (node.press?.plugin === instance.snapshot.plugin && node.props.key === element)
          found = true
      })
      if (!found) throw new ModFunctionError("MODS_UI_STALE_FOCUS")
      await this.update(instance, { kind: "focus", value: { focused } })
      this.assert(instance)
    })
  }

  close(): void {
    this.closed = true
    for (const plan of this.reservations) this.discardPrepared(plan)
    for (const instance of this.instances.values()) this.stop(instance)
    this.instances.clear()
    this.intents.clear()
  }

  private enqueue<T>(instance: Instance, run: () => Promise<T>): Promise<T> {
    if (instance.pending >= 64) return Promise.reject(new ModFunctionError("MODS_CLIENT_BUSY"))
    let receipt: FunctionClientDrawingReceipt | undefined
    try {
      this.assert(instance)
      receipt = this.host.captureDrawing?.(instance.pane, instance.parentGeneration)
      if (this.host.captureDrawing && !receipt) throw new ModFunctionError("MODS_UI_FAULT_STALE")
      if (receipt) {
        const parent = receipt
        const signal = AbortSignal.any([parent.signal, instance.controller.signal])
        receipt = {
          component: parent.component,
          signal,
          release: () => parent.release(),
          assertCurrent: () => {
            signal.throwIfAborted()
            parent.assertCurrent()
            if (this.instances.get(instance.key) !== instance || instance.stopped)
              throw new ModFunctionError("MODS_CLIENT_UNMOUNTED")
          }
        }
      }
    } catch (error) {
      if (error instanceof Error) this.refusals.add(error)
      return Promise.reject(error)
    }
    instance.pending++
    const task = instance.serial
      .then(() => {
        const enter = async () => {
          this.assert(instance)
          let value: T
          try { value = await run() }
          catch (error) {
            // Dispatcher cancellation can reject before its caller's post-await guard.
            // Classify a retired parent as native refusal, preserving the retained VM.
            this.assert(instance)
            throw error
          }
          this.assert(instance)
          return value
        }
        return receipt
          ? this.drawings.run(receipt, () => this.host.withDrawing
            ? this.host.withDrawing(receipt, enter) : enter())
          : enter()
      })
      .finally(() => {
        receipt?.release()
        instance.pending--
      })
    instance.serial = task.catch(() => {})
    return task
  }

  private fail(instance: Instance, error?: unknown, phase?: FunctionUiFaultPhase): void {
    if (error instanceof Error && this.refusals.has(error)) return
    if (instance.stopped) return
    let receipt: FunctionClientFaultReceipt | undefined
    if (phase && this.host.fault && this.faults.size < 16) {
      // Capture before stopping: the active drawing scope also guards this exact instance.
      try { receipt = this.host.captureFault?.(instance.pane, instance.parentGeneration) }
      catch { /* A native retirement cannot produce a module notification. */ }
    }
    this.stop(instance)
    instance.snapshot = {
      ...instance.snapshot,
      error:
        error instanceof ModFunctionError && error.code === "MODS_CLIENT_RENDER_LOOP"
          ? error.code
          : "MODS_CLIENT_FAILED",
      tree: {
        type: "Text",
        props: {},
        children: [`${instance.snapshot.plugin}/${instance.snapshot.module}：组件已停止`]
      }
    }
    if (!this.closed) this.host.changed(instance.pane)
    if (!phase || !this.host.fault || this.faults.size >= 16) return
    if (!receipt) return
    const controller = (instance.faultController = new AbortController())
    const signal = AbortSignal.any([controller.signal, receipt.signal])
    const assertCurrent = (): void => {
      signal.throwIfAborted()
      if (this.closed || this.instances.get(instance.key) !== instance)
        throw new ModFunctionError("MODS_CLIENT_UNMOUNTED")
      receipt!.assertCurrent()
    }
    const input: ModObject = {
      surface: "desktop", component: receipt.component ?? instance.component, requestId: instance.requestId,
      element: instance.snapshot.element, module: instance.snapshot.module, phase,
      reason: functionUiFaultReason(error instanceof Error ? error.message : undefined)
    }
    // This task is never awaited from the failing Client or its parent snapshot.
    const task = Promise.resolve().then(() => this.host.background(async () => {
      this.host.assertLive(instance.snapshot.plugin)
      assertCurrent()
      await this.host.fault!(instance.snapshot.plugin, input, signal, assertCurrent)
      this.host.assertLive(instance.snapshot.plugin)
      assertCurrent()
      if (!instance.faultBorn) await receipt!.redraw()
    })).catch(() => {}).finally(() => {
      receipt!.release()
      this.faults.delete(instance)
    })
    this.faults.set(instance, task)
  }

  private background(instance: Instance, input: ModObject): void {
    if (instance.stopped || this.closed) return
    // A slow frame coalesces timer ticks instead of accumulating unbounded pending work.
    instance.backgroundEvents.set(`${input.kind}:${input.handle ?? ""}`, {
      input, generation: instance.parentGeneration
    })
    if (instance.frame || instance.backgroundRunning) return
    instance.frame = setTimeout(() => {
      instance.frame = undefined
      instance.backgroundRunning = true
      void this.host
        .background(() => this.drawings.run(undefined, () =>
          this.enqueue(instance, async () => {
            const events = [...instance.backgroundEvents.values()]
            instance.backgroundEvents.clear()
            for (const event of events)
              if (event.generation === instance.parentGeneration && event.input.kind !== "post")
                await this.update(instance, event.input)
            await this.flushMessage(instance)
          })
        ))
        .catch((error) => this.fail(instance, error))
        .finally(() => {
          instance.backgroundRunning = false
          const pending = instance.backgroundEvents.values().next().value
          if (pending?.generation === instance.parentGeneration) this.background(instance, pending.input)
        })
    }, 16)
    instance.frame.unref()
  }

  private async update(instance: Instance, input: ModObject): Promise<void> {
    try {
      await this.render(instance, input)
    } catch (error) {
      if (!(error instanceof Error && this.refusals.has(error))) this.fail(instance, error)
      throw error
    }
  }

  private async render(instance: Instance, input: ModObject): Promise<void> {
    this.assert(instance)
    if (input.kind === "render")
      input = {
        kind: "render",
        ...(instance.props === undefined ? {} : { props: instance.props }),
        columns: instance.columns,
        rows: instance.rows
      }
    let guest: FunctionGuest
    try { guest = (instance.guest ??= await instance.loading) }
    catch (error) {
      this.assert(instance)
      if (isFunctionGuestLoadFailure(error)) this.fail(instance, error, "load")
      throw error
    }
    this.assert(instance)
    const invoke = (registration: string, event: string, value: ModObject) => guest.invoke(
      registration,
      value,
      async () => {
        throw new ModFunctionError("MODS_CLIENT_CAPABILITY_DENIED")
      },
      {
        event,
        signal: instance.controller.signal,
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: instance.snapshot.plugin, root: "" }
      }
    )
    if (!["render", "frame"].includes(String(input.kind))) {
      let ran = false
      try {
        const value = (await invoke("0", "surface.update", input)).value
        ran = true
        this.assert(instance)
        if (!isModObject(value) || typeof value.dirty !== "boolean")
          throw new ModFunctionError("MODS_CLIENT_RESULT")
        instance.pendingDrawResult = {
          dirty: value.dirty || instance.pendingDrawResult?.dirty === true,
          ...(Object.hasOwn(value, "message") ? { message: { data: value.message, generation: instance.parentGeneration } }
            : instance.pendingDrawResult?.message ? { message: instance.pendingDrawResult.message } : {})
        }
      }
      catch (error) {
        this.assert(instance)
        if (ran || isFunctionGuestInvokeFailure(error)) this.fail(instance, error, "run")
        else if (error instanceof Error && !guest.stats.disposed) {
          this.refusals.add(error)
          instance.needsDraw = true
        }
        throw error
      }
      this.assert(instance)
    }
    let value: ModJson | undefined
    let drawn = false
    try {
      value = (await invoke("1", "surface.draw", input)).value
      drawn = true
      this.assert(instance)
      if (!isModObject(value) || typeof value.dirty !== "boolean" ||
        typeof value.renderSetState !== "boolean" || !Array.isArray(value.timers) ||
        value.timers.length > 16) throw new ModFunctionError("MODS_CLIENT_RESULT")
      validateFunctionClientTree(value.tree)
      visit(value.tree, (node) => {
        if (node.type === "Client" || (node.press && node.press.plugin !== instance.snapshot.plugin))
          throw new ModFunctionError("MODS_CLIENT_RESULT")
      })
      const timerIds = new Set<string>()
      for (const timer of value.timers) {
        if (!isModObject(timer) || typeof timer.id !== "string" || typeof timer.ms !== "number" ||
          !Number.isFinite(timer.ms) || timer.ms < 0 || timer.ms > 2147483647 || timerIds.has(timer.id))
          throw new ModFunctionError("MODS_CLIENT_TIMER")
        timerIds.add(timer.id)
      }
    } catch (error) {
      this.assert(instance)
      if (drawn || isFunctionGuestInvokeFailure(error)) this.fail(instance, error, "render")
      else if (error instanceof Error && !guest.stats.disposed) {
        this.refusals.add(error)
        instance.needsDraw = true
      }
      throw error
    }
    this.assert(instance)
    if (
      !isModObject(value) ||
      typeof value.dirty !== "boolean" ||
      typeof value.renderSetState !== "boolean" ||
      !Array.isArray(value.timers) ||
      value.timers.length > 16
    )
      throw new ModFunctionError("MODS_CLIENT_RESULT")
    if (input.kind !== "frame") instance.renderStreak = 0
    instance.renderStreak = value.renderSetState ? instance.renderStreak + 1 : 0
    if (instance.renderStreak >= 3) {
      const error = new ModFunctionError("MODS_CLIENT_RENDER_LOOP")
      this.fail(instance, error, "run")
      throw error
    }
    validateFunctionClientTree(value.tree)
    const rawTree = encodeModJson(value.tree)
    const protectedTree =
      rawTree === instance.rawTree ? instance.snapshot.tree : await this.host.publish(value.tree)
    this.assert(instance)
    validateFunctionClientTree(protectedTree)
    const tree = normalizeFunctionLinks(protectedTree)
    visit(tree, (node) => {
      if (node.type === "Client" || (node.press && node.press.plugin !== instance.snapshot.plugin))
        throw new ModFunctionError("MODS_CLIENT_RESULT")
    })
    const changed = encodeModJson(instance.snapshot.tree) !== encodeModJson(tree)
    if (changed) instance.markdownTreeEpoch = {}
    instance.rawTree = rawTree
    instance.snapshot = { ...instance.snapshot, tree }
    instance.needsDraw = false
    const timers = new Set<string>()
    for (const entry of value.timers) {
      if (
        !isModObject(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.ms !== "number" ||
        !Number.isFinite(entry.ms) ||
        entry.ms < 0 ||
        entry.ms > 2147483647 ||
        timers.has(entry.id)
      )
        throw new ModFunctionError("MODS_CLIENT_TIMER")
      timers.add(entry.id)
      const previous = instance.timers.get(entry.id)
      if (previous?.ms === entry.ms) continue
      if (previous) clearInterval(previous.timer)
      const timer = setInterval(
        () => this.background(instance, { kind: "tick", handle: entry.id }),
        Math.max(16, entry.ms)
      )
      timer.unref()
      instance.timers.set(entry.id, { ms: entry.ms, timer })
    }
    for (const [id, entry] of instance.timers)
      if (!timers.has(id)) {
        clearInterval(entry.timer)
        instance.timers.delete(id)
      }
    const message = Object.hasOwn(value, "message") ? { data: value.message, generation: instance.parentGeneration }
      : instance.pendingDrawResult?.message
    if (message) {
      instance.pendingMessage = message
      this.background(instance, { kind: "post" })
    }
    if (value.dirty || instance.pendingDrawResult?.dirty) this.background(instance, { kind: "frame" })
    instance.pendingDrawResult = undefined
    if (changed) this.host.changed(instance.pane)
  }

  private async flushMessage(instance: Instance): Promise<void> {
    this.assert(instance)
    const pending = instance.pendingMessage
    if (!pending) return
    instance.pendingMessage = undefined
    instance.backgroundEvents.delete("post:")
    if (pending.generation !== instance.parentGeneration) return
    const data = await this.host.publish(pending.data)
    this.assert(instance)
    const answer = await this.host.message(
      instance.snapshot.plugin,
      {
        surface: "desktop",
        component: instance.component,
        requestId: instance.requestId,
        element: instance.snapshot.element,
        module: instance.snapshot.module,
        data
      },
      instance.controller.signal
    )
    this.assert(instance)
    if (!isModObject(answer)) throw new ModFunctionError("MODS_CLIENT_MESSAGE_RESULT")
    if (Object.hasOwn(answer, "props")) {
      instance.props = answer.props
      instance.propsEpoch = {}
      this.background(instance, { kind: "render" })
    }
  }

  private planRecord(plan: FunctionClientReconcilePlan): PreparedReconcile {
    const record = this.plans.get(plan)
    if (!record) throw new ModFunctionError("MODS_CLIENT_PLAN_INVALID")
    return record
  }

  private reservedCount(): number {
    let count = 0
    for (const plan of this.reservations) count += plan.reserved
    return count
  }

  private assertPrepared(record: PreparedReconcile): void {
    this.host.assertLive()
    if (this.closed || !["prepared", "committed"].includes(record.phase) ||
      this.paneEpochs.get(record.pane) !== record.epoch)
      throw new ModFunctionError("MODS_CLIENT_PLAN_STALE")
    if (record.phase === "prepared") record.assertPreparation?.()
    const current = [...this.instances.values()].filter((instance) => instance.pane === record.pane)
    if (current.length !== record.expected.size) throw new ModFunctionError("MODS_CLIENT_PLAN_STALE")
    for (const instance of current) {
      const expected = record.expected.get(instance.key)
      if (!expected || expected.instance !== instance || expected.generation !== instance.parentGeneration ||
        expected.sourceProps !== instance.sourceProps || expected.stopped !== instance.stopped ||
        expected.propsEpoch !== instance.propsEpoch ||
        expected.props !== encodeModJson(instance.props === undefined ? {} : { props: instance.props }))
        throw new ModFunctionError("MODS_CLIENT_PLAN_STALE")
    }
    for (const node of record.nodes) {
      const plugin = node.client!.plugin
      this.host.assertLive(plugin)
      this.host.checkModule?.(plugin, node.props.module as string)
    }
    if (this.occupied.size + this.reservedCount() > 8)
      throw new ModFunctionError("MODS_CLIENT_LIMIT")
  }

  /** Pure preflight: no VM execution, instance mutation or retirement before parent commit. */
  prepareReconcile(
    pane: string,
    requestId: string,
    parentGeneration: string,
    tree: FunctionUiElement,
    faultRedraw = false,
    component = "Pane",
    assertPreparation?: () => void
  ): FunctionClientReconcilePlan {
    this.host.assertLive()
    if (this.closed) throw new ModFunctionError("MODS_CLIENT_UNMOUNTED")
    assertPreparation?.()
    validateFunctionTree(tree)
    // The final protected descriptor must not remain a caller-mutable object across an await.
    const copy = parseModJson(encodeModJson(tree)) as FunctionUiElement
    const nodes: FunctionUiNode[] = []
    visit(copy, (node) => { if (node.type === "Client") nodes.push(node) })
    if (nodes.length > 8) throw new ModFunctionError("MODS_CLIENT_LIMIT")
    const expected: PreparedReconcile["expected"] = new Map()
    for (const [key, instance] of this.instances)
      if (instance.pane === pane) expected.set(key, {
        instance, generation: instance.parentGeneration, sourceProps: instance.sourceProps,
        props: encodeModJson(instance.props === undefined ? {} : { props: instance.props }),
        propsEpoch: instance.propsEpoch,
        stopped: instance.stopped
      })
    let reserved = 0
    for (const node of nodes) {
      const plugin = node.client!.plugin
      this.host.assertLive(plugin)
      this.host.checkModule?.(plugin, node.props.module as string)
      const prior = this.instances.get(JSON.stringify([pane, plugin, node.props.key]))
      if (!prior || prior.snapshot.module !== node.props.module) reserved++
    }
    if (this.occupied.size + this.reservedCount() + reserved > 8)
      throw new ModFunctionError("MODS_CLIENT_LIMIT")
    const epoch = this.paneEpochs.get(pane) ?? {}
    this.paneEpochs.set(pane, epoch)
    const record: PreparedReconcile = {
      pane, requestId, generation: parentGeneration, component, faultRedraw,
      nodes, expected, epoch, assertPreparation, reserved, phase: "prepared"
    }
    const plan = Object.freeze({}) as FunctionClientReconcilePlan
    this.plans.set(plan, record)
    this.reservations.add(record)
    return plan
  }

  assertReconcileCurrent(plan: FunctionClientReconcilePlan): void {
    const record = this.planRecord(plan)
    if (record.phase !== "prepared") throw new ModFunctionError("MODS_CLIENT_PLAN_STALE")
    this.assertPrepared(record)
  }

  /** Called in the host's synchronous parent commit. Still does not touch any live Client VM. */
  commitReconcile(plan: FunctionClientReconcilePlan): void {
    this.assertReconcileCurrent(plan)
    const record = this.planRecord(plan)
    const epoch = {}
    this.paneEpochs.set(record.pane, epoch)
    record.epoch = epoch
    record.phase = "committed"
  }

  private discardPrepared(record: PreparedReconcile): void {
    this.reservations.delete(record)
    record.reserved = 0
    if (record.phase !== "done") record.phase = "discarded"
  }

  discardReconcile(plan: FunctionClientReconcilePlan): void {
    this.discardPrepared(this.planRecord(plan))
  }

  async reconcilePrepared(plan: FunctionClientReconcilePlan): Promise<FunctionClientSnapshot[]> {
    const record = this.planRecord(plan)
    if (record.phase !== "committed") throw new ModFunctionError("MODS_CLIENT_PLAN_STALE")
    let receipt: FunctionClientDrawingReceipt | undefined
    const enter = () => this.adoptPrepared(record)
    try {
      this.assertPrepared(record)
      receipt = this.host.captureDrawing?.(record.pane, record.generation)
      if (this.host.captureDrawing && !receipt) throw new ModFunctionError("MODS_UI_FAULT_STALE")
      const activeReceipt = receipt
      return await (activeReceipt
        ? this.drawings.run(activeReceipt, () => this.host.withDrawing
          ? this.host.withDrawing(activeReceipt, enter) : enter())
        : enter())
    } finally {
      receipt?.release()
      this.reservations.delete(record)
      record.reserved = 0
      // Adoption or an external discard can update this property across the awaited work.
      if ((record.phase as PreparedReconcile["phase"]) !== "discarded") record.phase = "done"
    }
  }

  private adoptPrepared(record: PreparedReconcile): Promise<FunctionClientSnapshot[]> {
    this.assert()
    this.assertPrepared(record)
    record.phase = "adopting"
    return this.reconcileDrawing(record)
  }

  async reconcile(
    pane: string,
    requestId: string,
    parentGeneration: string,
    tree: FunctionUiElement,
    faultRedraw = false,
    component = "Pane"
  ): Promise<FunctionClientSnapshot[]> {
    const receipt = this.host.captureDrawing?.(pane, parentGeneration)
    if (this.host.captureDrawing && !receipt) throw new ModFunctionError("MODS_UI_FAULT_STALE")
    let plan: FunctionClientReconcilePlan | undefined
    try {
      plan = this.prepareReconcile(pane, requestId, parentGeneration, tree, faultRedraw, component,
        receipt ? () => receipt.assertCurrent() : undefined)
      this.commitReconcile(plan)
      const record = this.planRecord(plan)
      const enter = () => this.adoptPrepared(record)
      // Preserve the original committed adapter's single receipt and async return boundary.
      return await (receipt
        ? this.drawings.run(receipt, () => this.host.withDrawing
          ? this.host.withDrawing(receipt, enter) : enter())
        : enter())
    } finally {
      receipt?.release()
      if (plan) {
        const record = this.planRecord(plan)
        if (record.phase === "adopting") record.phase = "done"
        this.discardReconcile(plan)
      }
    }
  }

  private async reconcileDrawing(
    plan: PreparedReconcile
  ): Promise<FunctionClientSnapshot[]> {
    this.assert()
    const { pane, requestId, generation: parentGeneration, faultRedraw, component, nodes } = plan
    const markdownDisplay = captureFunctionMarkdownDisplay()
    const wanted = new Set<string>()
    const renders: Instance[] = []
    for (const node of nodes)
      wanted.add(JSON.stringify([pane, node.client!.plugin, node.props.key]))
    for (const [key, instance] of this.instances)
      if (instance.pane === pane && !wanted.has(key)) {
        this.instances.delete(key)
        this.stop(instance)
      }
    for (const node of nodes) {
      const plugin = node.client!.plugin,
        element = node.props.key as string,
        module = node.props.module as string
      const key = JSON.stringify([pane, plugin, element])
      wanted.add(key)
      let instance = this.instances.get(key)
      if (instance && instance.snapshot.module !== module) {
        this.stop(instance)
        this.instances.delete(key)
        instance = undefined
      }
      const props = node.props.props
      const sourceProps = encodeModJson(props === undefined ? {} : { props })
      if (!instance) {
        const loading = Promise.resolve().then(() => {
          this.assert(instance)
          return this.host.load(plugin, module)
        })
        void loading.catch(() => {})
        instance = {
          key,
          pane,
          requestId,
          component,
          sourceProps,
          parentGeneration,
          props,
          propsEpoch: {},
          columns: 0,
          rows: 0,
          serial: Promise.resolve(),
          pending: 0,
          backgroundRunning: false,
          backgroundEvents: new Map(),
          renderStreak: 0,
          loading,
          stopped: false,
          faultBorn: faultRedraw,
          controller: new AbortController(),
          timers: new Map(),
          snapshot: {
            id: randomUUID(),
            generation: parentGeneration,
            plugin,
            element,
            module,
            tree: { type: "Box", props: {}, children: [] }
          }
        }
        if (plan.reserved < 1) throw new ModFunctionError("MODS_CLIENT_PLAN_STALE")
        plan.reserved--
        this.occupied.add(instance)
        this.instances.set(key, instance)
        instance.markdownDisplay = markdownDisplay
        renders.push(instance)
      } else if (
        !instance.stopped &&
        (instance.needsDraw || instance.sourceProps !== sourceProps || instance.parentGeneration !== parentGeneration)
      ) {
        if (instance.sourceProps !== sourceProps) {
          instance.sourceProps = sourceProps
          instance.props = props
          instance.propsEpoch = {}
        }
        if (instance.parentGeneration !== parentGeneration) {
          instance.pendingMessage = undefined
          instance.pendingDrawResult = undefined
          instance.backgroundEvents.clear()
        }
        instance.parentGeneration = parentGeneration
        instance.snapshot = { ...instance.snapshot, generation: parentGeneration }
        renders.push(instance)
      }
    }
    if (markdownDisplay)
      for (const instance of this.instances.values())
        if (instance.pane === pane) instance.markdownDisplay = markdownDisplay
    // All parent identities are adopted synchronously before the first async render.
    for (const current of renders) {
      await this.enqueue(current, () => this.update(current, { kind: "render" })).catch((error) =>
        this.fail(current, error)
      )
    }
    for (const [key, instance] of this.instances)
      if (instance.pane === pane && !wanted.has(key)) {
        this.instances.delete(key)
        this.stop(instance)
      }
    this.assert()
    const snapshots = [...this.instances.values()]
      .filter((i) => i.pane === pane)
      .map((i) => {
        const snapshot = { ...i.snapshot }
        delete snapshot.markdownLinks
        return snapshot
      })
    if (!snapshots.length) return []
    const published = await this.host.publish(snapshots as unknown as ModJson)
    this.assert()
    if (!Array.isArray(published) || published.length !== snapshots.length)
      throw new ModFunctionError("MODS_CLIENT_PUBLICATION")
    published.forEach((item, index) => {
      if (
        !isModObject(item) ||
        Object.keys(item).some(key =>
          !["id", "generation", "plugin", "element", "module", "tree", "error"].includes(key)) ||
        ["id", "generation", "plugin", "element", "module", "error"].some(
          (key) => item[key] !== (snapshots[index] as unknown as ModObject)[key]
        )
      )
        throw new ModFunctionError("MODS_CLIENT_PUBLICATION")
      validateFunctionClientTree(item.tree)
    })
    const visible = published.map((item) => ({
      ...(item as ModObject),
      tree: normalizeFunctionLinks((item as ModObject).tree as unknown as FunctionUiElement)
    })) as unknown as FunctionClientSnapshot[]
    if (this.host.markdownLinks) {
      const plans: import("./markdown-link-registry").FunctionMarkdownPublicationPlan[] = []
      try {
        for (const snapshot of visible) {
          const instance = [...this.instances.values()].find(row => row.pane === pane &&
            row.snapshot.id === snapshot.id)
          const display = instance?.markdownDisplay
          if (!instance || !display || instance.stopped) continue
          display.assertCurrent()
          const parent = this.host.captureDrawing?.(pane, instance.parentGeneration)
          if (this.host.captureDrawing && !parent)
            throw new ModFunctionError("MODS_UI_DRAWING_STALE")
          try {
            const parentGeneration = instance.parentGeneration
            const propsEpoch = instance.propsEpoch
            const treeEpoch = instance.markdownTreeEpoch
            const epoch = instance.markdownEpoch?.frame === display.epoch &&
              instance.markdownEpoch.parent === parentGeneration ? instance.markdownEpoch :
              { frame: display.epoch, parent: parentGeneration, identity: {} }
            const publication = this.host.markdownLinks.prepare({ owner: instance,
              epoch: epoch.identity,
              contentFingerprint: createHash("sha256").update(encodeModJson(snapshot.tree)).digest("hex"),
              address: { kind: "client", pane, instance: snapshot.id,
                generation: snapshot.generation },
              assertCurrent: () => {
                display.assertCurrent()
                this.host.assertLive(instance.snapshot.plugin)
                parent?.assertCurrent()
                if (this.closed || instance.stopped || this.instances.get(instance.key) !== instance ||
                  instance.parentGeneration !== parentGeneration || instance.propsEpoch !== propsEpoch ||
                  instance.markdownTreeEpoch !== treeEpoch)
                  throw new ModFunctionError("MODS_UI_MARKDOWN_STALE")
              }
            }, nativeMarkdownLeaves(snapshot.tree))
            plans.push(publication)
            snapshot.markdownLinks = publication.markdownLinks
            instance.markdownEpoch = epoch
          } finally { parent?.release() }
        }
        this.host.markdownLinks.commit(plans)
      } finally {
        for (const publication of plans) this.host.markdownLinks.discard(publication)
      }
    }
    return visible
  }

  act(action: FunctionClientAction): Promise<void> {
    this.assert()
    if (
      !isModObject(action) ||
      typeof action.pane !== "string" ||
      action.pane.length > 200 ||
      typeof action.instance !== "string" ||
      !/^[a-f0-9-]{36}$/.test(action.instance) ||
      typeof action.generation !== "string" ||
      !/^[a-f0-9-]{36}$/.test(action.generation) ||
      typeof action.intentId !== "string" ||
      !/^[\w-]{16,100}$/.test(action.intentId) ||
      ![
        "press",
        "change",
        "submit",
        "select",
        "key",
        "pointer",
        "resize",
        "focus",
        "scroll"
      ].includes(action.kind)
    )
      return Promise.reject(new ModFunctionError("MODS_CLIENT_ACTION"))
    const instance = [...this.instances.values()].find(
      (i) => i.pane === action.pane && i.snapshot.id === action.instance
    )
    if (!instance || instance.stopped)
      return Promise.reject(new ModFunctionError("MODS_CLIENT_UNMOUNTED"))
    if (action.generation !== instance.parentGeneration)
      return Promise.reject(new ModFunctionError("MODS_UI_STALE_ACTION"))
    const encoded = encodeModJson(action)
    if (encoded.length > 20000) return Promise.reject(new ModFunctionError("MODS_CLIENT_ACTION"))
    const input = createHash("sha256").update(encoded).digest("hex")
    const discrete = ["press", "submit", "select"].includes(action.kind)
    if (discrete) {
      const prior = this.intents.get(action.intentId)
      if (prior)
        return prior.input === input
          ? prior.result
          : Promise.reject(new ModFunctionError("MODS_UI_INTENT_CONFLICT"))
      if (this.intents.size >= 4096)
        return Promise.reject(new ModFunctionError("MODS_UI_INTENT_LIMIT"))
    }
    const result = this.enqueue(instance, async () => {
      if (action.kind === "resize") {
        const value = action.value
        if (
          !isModObject(value) ||
          ![value.columns, value.rows].every(
            (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 10000
          )
        )
          throw new ModFunctionError("MODS_CLIENT_ACTION")
        if (instance.columns === value.columns && instance.rows === value.rows) return
        instance.columns = value.columns as number
        instance.rows = value.rows as number
        await this.update(instance, {
          kind: "render"
        })
        return
      }
      if (action.kind === "focus" || action.kind === "scroll") {
        const value = action.value
        if (!isModObject(value)) throw new ModFunctionError("MODS_CLIENT_ACTION")
        if (action.kind === "focus") {
          if (
            typeof value.focused !== "boolean" ||
            Object.keys(value).some((key) => key !== "focused")
          )
            throw new ModFunctionError("MODS_CLIENT_ACTION")
        } else if (
          ![value.deltaX, value.deltaY, value.top, value.left].every(
            (number) =>
              typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 100000
          ) ||
          Object.keys(value).some((key) => !["deltaX", "deltaY", "top", "left"].includes(key))
        )
          throw new ModFunctionError("MODS_CLIENT_ACTION")
        const event = action.kind === "focus" ? "ui.focus" : "ui.scroll"
        await this.host.control(
          event,
          {
            surface: "desktop",
            component: "Client",
            requestId: instance.requestId,
            plugin: instance.snapshot.plugin,
            element: instance.snapshot.element,
            ...(action.kind === "focus" ? { focused: value.focused } : { value })
          },
          async (input) => {
            this.assert(instance)
            const nextValue = action.kind === "focus" ? { focused: input.focused } : input.value
            await this.update(instance, { kind: action.kind, value: nextValue })
            return { element: instance.snapshot.element, value: nextValue }
          },
          instance.controller.signal
        )
        return
      }
      if (action.kind === "key" || action.kind === "pointer") {
        const value = action.value
        if (!isModObject(value)) throw new ModFunctionError("MODS_CLIENT_ACTION")
        if (action.kind === "key") {
          if (
            typeof value.key !== "string" ||
            value.key.length > 32 ||
            Object.keys(value).some((k) => !["key", "ctrl", "shift", "meta"].includes(k))
          )
            throw new ModFunctionError("MODS_CLIENT_ACTION")
          if (value.key === "escape") return
        } else if (
          !["down", "move", "up", "enter", "leave"].includes(String(value.type)) ||
          ![value.x, value.y].every(
            (n) => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 10000
          ) ||
          (value.button !== undefined &&
            !["left", "middle", "right"].includes(String(value.button))) ||
          Object.keys(value).some(
            (k) => !["type", "x", "y", "button", "shift", "alt", "ctrl"].includes(k)
          )
        )
          throw new ModFunctionError("MODS_CLIENT_ACTION")
        for (const key of ["ctrl", "shift", "meta", "alt"])
          if (value[key] !== undefined && value[key] !== true)
            throw new ModFunctionError("MODS_CLIENT_ACTION")
        await this.update(instance, { kind: action.kind, value })
        return
      }
      let control: FunctionUiNode | undefined
      visit(instance.snapshot.tree, (node) => {
        if (node.press?.handle === action.handle) control = node
      })
      const node = control as FunctionUiNode | undefined
      if (
        !node ||
        node.type !==
          (action.kind === "press" ? "Button" : action.kind === "select" ? "Select" : "Input")
      )
        throw new ModFunctionError("MODS_UI_STALE_ACTION")
      if (
        action.value !== undefined &&
        (typeof action.value !== "string" || action.value.length > 10000)
      )
        throw new ModFunctionError("MODS_CLIENT_ACTION")
      const event =
        action.kind === "press" ? "ui.press" : action.kind === "select" ? "ui.select" : "ui.input"
      const value: ModObject = {
        surface: "desktop",
        component: instance.component,
        requestId: instance.requestId,
        plugin: instance.snapshot.plugin,
        element: node.props.key,
        ...(event !== "ui.press" ? { value: action.value ?? "" } : {}),
        ...(event === "ui.input" ? { kind: action.kind } : {})
      }
      await this.host.control(
        event,
        value,
        async (e): Promise<ModJson> => {
          this.assert(instance)
          if (
            node.type === "Select" &&
            !(node.props.options as ModObject[]).some((o) => o.value === e.value)
          )
            throw new ModFunctionError("MODS_CLIENT_ACTION")
          await this.update(instance, {
            kind: "control",
            handle: action.handle!,
            event: e,
            callback:
              action.kind === "press"
                ? "onPress"
                : action.kind === "select"
                  ? "onSelect"
                  : action.kind === "submit"
                    ? "onSubmit"
                    : "onInput"
          })
          return event === "ui.press"
            ? { element: e.element }
            : { element: e.element, value: e.value }
        },
        instance.controller.signal
      )
    })
    if (discrete) this.intents.set(action.intentId, { input, result })
    return result
  }
}
