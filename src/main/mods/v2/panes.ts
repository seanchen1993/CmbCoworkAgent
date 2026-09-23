import { createHash, randomUUID } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import {
  ModFunctionError,
  isModObject,
  type FunctionInvocation
} from "../../../shared/mods/v2/contracts"
import {
  validateFunctionTree,
  validatePaneArgs,
  type FunctionUiAction,
  type FunctionUiElement,
  type FunctionFocusResult,
  type FunctionPaneSnapshot
} from "../../../shared/mods/v2/ui"
import { functionFocusTargets } from "../../../shared/mods/v2/focus"
import type { FunctionPlugin } from "./dispatcher"

export interface FunctionUiDispatch {
  onlyPlugin?: string
  origin?: import("../../../shared/mods/v2/contracts").ModOrigin
  signal?: AbortSignal
  generation?: string
  operation?: boolean
  core?(input: ModObject, signal: AbortSignal): Promise<ModJson>
}
interface Pane extends FunctionPaneSnapshot {
  dirty: boolean
  focused: boolean
  visibleTree?: FunctionUiElement
}
export interface PaneHost {
  clients?: import("./clients").FunctionClients
  plugins: readonly FunctionPlugin[]
  assertLive(): void
  changed(): void
  publish(value: ModJson): Promise<ModJson>
  site?(pane: FunctionPaneSnapshot): { component: string; props: ModObject }
  renderCore?(input: ModObject): Promise<ModJson>
  validateTree?(tree: unknown): void
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
  private closed = false

  constructor(private readonly host: PaneHost) {}

  private changed(delay = 100): void {
    if (this.closed) return
    const deadline = performance.now() + delay
    if (this.notification && this.notificationDeadline <= deadline) return
    clearTimeout(this.notification)
    this.notificationDeadline = deadline
    this.notification = setTimeout(() => {
      this.notification = undefined
      if (!this.closed) this.host.changed()
    }, delay)
    this.notification.unref()
  }

  notify(): void {
    // Client frames are already bounded by their host scheduler. Batch them for one
    // frame without delaying interactive feedback behind ordinary pane invalidations.
    this.changed(16)
  }

  open(plugin: string, input: ModObject): void {
    this.host.assertLive()
    validatePaneArgs(input)
    const key = `${plugin}:${input.id}`
    const prior = this.panes.get(key)
    if (!prior && this.panes.size >= 8) throw new ModFunctionError("MODS_UI_PANE_LIMIT")
    this.panes.set(key, {
      key,
      id: input.id as string,
      plugin,
      title: (input.title ?? input.id) as string,
      generation: prior?.generation ?? randomUUID(),
      tree: prior?.tree ?? { type: "Box", props: {}, children: [] },
      closeOnEscape: input.closeOnEscape === true,
      rows: typeof input.rows === "number" ? Math.min(50, input.rows) : 12,
      dirty: true,
      focused: prior?.focused ?? false,
      ...(input.focus === true ? { focusRequest: { id: randomUUID(), pending: true } } : {})
    })
    this.changed()
  }

  async closePane(plugin: string, id: string, cancelActions = true): Promise<void> {
    this.host.assertLive()
    const pane = this.panes.get(`${plugin}:${id}`)
    if (!pane) return
    this.panes.delete(pane.key)
    this.host.clients?.closePane(pane.key)
    for (const [controller, key] of this.active)
      if (cancelActions && key === pane.key)
        controller.abort(new ModFunctionError("MODS_UI_PANE_CLOSED"))
    await this.release(pane.generation)
    this.changed()
  }

  invalidate(): void {
    this.host.assertLive()
    for (const pane of this.panes.values()) pane.dirty = true
    this.changed()
  }

  private async release(generation: string): Promise<void> {
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

  snapshot(): Promise<FunctionPaneSnapshot[]> {
    return this.enqueue(async () => {
      for (const pane of this.panes.values()) {
        if (!pane.dirty) continue
        const generation = randomUUID()
        pane.dirty = false
        try {
          const site = this.host.site?.(pane)
          const tree = await this.host.dispatch(
            "ui.render",
            {
              surface: "desktop",
              component: site?.component ?? "Pane",
              requestId: pane.id,
              props: site?.props ?? {
                title: pane.title,
                isFocused: pane.focused,
                placement: "inline",
                bodyColumns: 80
              }
            },
            {
              generation,
              core: this.host.renderCore ?? (async () => ({ type: "Box", props: {}, children: [] }))
            }
          )
          this.host.assertLive()
          validateFunctionTree(tree)
          this.host.validateTree?.(tree)
          if (this.panes.get(pane.key) !== pane) {
            await this.release(generation)
            continue
          }
          await this.release(pane.generation)
          pane.generation = generation
          pane.tree = tree
        } catch (error) {
          pane.dirty = true
          await this.release(generation)
          throw error
        }
      }
      this.host.assertLive()
      const originals = new Map(this.panes)
      const snapshots = [...this.panes.values()].map(
        ({ key, id, plugin, title, generation, tree, closeOnEscape, rows, focusRequest }) =>
          parseModJson(
            encodeModJson({
              key,
              id,
              plugin,
              title,
              generation,
              tree,
              closeOnEscape,
              rows,
              ...(focusRequest ? { focusRequest } : {})
            })
          ) as unknown as FunctionPaneSnapshot
      )
      const published = await this.host.publish(snapshots as unknown as ModJson)
      this.host.assertLive()
      if (!Array.isArray(published) || published.length !== snapshots.length)
        throw new ModFunctionError("MODS_UI_PUBLICATION")
      const visible: ModJson[] = []
      for (let index = 0; index < snapshots.length; index++) {
        const result = published[index]
        const original = snapshots[index] as unknown as ModObject
        if (
          !isModObject(result) ||
          typeof result.title !== "string" ||
          JSON.stringify(result.focusRequest) !== JSON.stringify(original.focusRequest) ||
          ["key", "id", "plugin", "generation", "closeOnEscape", "rows"].some(
            (key) => result[key] !== original[key]
          )
        )
          throw new ModFunctionError("MODS_UI_PUBLICATION")
        validateFunctionTree(result.tree)
        this.host.validateTree?.(result.tree)
        const current = () =>
          this.panes.get(result.key as string) === originals.get(result.key as string)
        if (!current()) continue
        if (this.host.clients)
          result.clients = (await this.host.clients.reconcile(
            result.key as string,
            result.id as string,
            result.generation as string,
            result.tree
          )) as unknown as ModJson
        if (!current()) {
          this.host.clients?.closePane(result.key as string)
          continue
        }
        const pane = this.panes.get(result.key as string)!
        pane.visibleTree = result.tree
        pane.clients = result.clients as unknown as FunctionPaneSnapshot["clients"]
        visible.push(result)
      }
      return visible as unknown as FunctionPaneSnapshot[]
    })
  }

  act(action: FunctionUiAction): Promise<void | FunctionFocusResult> {
    this.host.assertLive()
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
    if (this.panes.get(action.pane)?.generation !== action.generation)
      return Promise.reject(new ModFunctionError("MODS_UI_STALE_ACTION"))
    // Keep settled IDs for the life of the session: evicting one could replay its action.
    if (this.intents.size >= 4096)
      return Promise.reject(new ModFunctionError("MODS_UI_INTENT_LIMIT"))
    const perform = async (): Promise<void | FunctionFocusResult> => {
      this.host.assertLive()
      const pane = this.panes.get(action.pane)
      if (!pane || pane.generation !== action.generation)
        throw new ModFunctionError("MODS_UI_STALE_ACTION")
      if (action.kind === "close") {
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
                if (this.panes.get(pane.key) !== pane)
                  throw new ModFunctionError("MODS_UI_STALE_ACTION")
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
                pane.dirty = true
                return {
                  element: pane.id,
                  value: action.kind === "focus" ? { focused: input.focused } : input.value
                }
              }
            }
          )
          this.host.assertLive()
          controller.signal.throwIfAborted()
          if (this.panes.get(pane.key) !== pane || pane.generation !== action.generation)
            throw new ModFunctionError("MODS_UI_STALE_ACTION")
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
            this.host.assertLive()
            controller.signal.throwIfAborted()
            if (this.panes.get(pane.key) !== pane || pane.generation !== action.generation)
              throw new ModFunctionError("MODS_UI_STALE_ACTION")
            if (focusApplied) pane.focused = focusResult.focused
          }
          this.changed()
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
      let element: FunctionUiElement | undefined
      const find = (node: FunctionUiElement | string): void => {
        if (typeof node === "string") return
        if (node.press?.plugin === action.plugin && node.press?.handle === action.handle)
          element = node
        node.children?.forEach(find)
      }
      find(pane.visibleTree ?? pane.tree)
      const node = element as FunctionUiElement | undefined
      const plugin = this.host.plugins.find((plugin) => plugin.name === action.plugin)
      if (!node || !plugin) throw new ModFunctionError("MODS_UI_STALE_ACTION")
      const kind =
        action.kind === "press"
          ? "onPress"
          : action.kind === "select"
            ? "onSelect"
            : action.kind === "submit"
              ? "onSubmit"
              : "onInput"
      if (
        node.type !==
        (action.kind === "press" ? "Button" : action.kind === "select" ? "Select" : "Input")
      )
        throw new ModFunctionError("MODS_UI_ACTION_INVALID")
      const event =
        action.kind === "press" ? "ui.press" : action.kind === "select" ? "ui.select" : "ui.input"
      const e: ModObject = {
        plugin: plugin.name,
        element: node.props.key,
        component: this.host.site?.(pane).component ?? "Pane",
        requestId: pane.id,
        surface: "desktop",
        ...(event !== "ui.press" ? { value: action.value ?? "" } : {}),
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
    clearTimeout(this.notification)
    for (const controller of this.active.keys()) controller.abort()
    this.active.clear()
    this.panes.clear()
    this.intents.clear()
  }
}
