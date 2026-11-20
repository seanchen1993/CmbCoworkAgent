import { randomUUID } from "node:crypto"
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
  type FunctionPaneSnapshot
} from "../../../shared/mods/v2/ui"
import type { FunctionPlugin } from "./dispatcher"

export interface FunctionUiDispatch {
  generation?: string
  operation?: boolean
  core?(input: ModObject, signal: AbortSignal): Promise<ModJson>
}
interface Pane extends FunctionPaneSnapshot {
  dirty: boolean
}
interface PaneHost {
  plugins: readonly FunctionPlugin[]
  assertLive(): void
  changed(): void
  publish(value: ModJson): Promise<ModJson>
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
  private readonly intents = new Map<string, { input: string; result: Promise<void> }>()
  private serial: Promise<unknown> = Promise.resolve()
  private notification?: ReturnType<typeof setTimeout>
  private closed = false

  constructor(private readonly host: PaneHost) {}

  private changed(): void {
    if (this.closed || this.notification) return
    this.notification = setTimeout(() => {
      this.notification = undefined
      if (!this.closed) this.host.changed()
    }, 100)
    this.notification.unref()
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
      dirty: true
    })
    this.changed()
  }

  async closePane(plugin: string, id: string): Promise<void> {
    this.host.assertLive()
    const pane = this.panes.get(`${plugin}:${id}`)
    if (!pane) return
    this.panes.delete(pane.key)
    await this.release(pane.generation)
    this.changed()
  }

  invalidate(): void {
    this.host.assertLive()
    for (const pane of this.panes.values()) pane.dirty = true
    this.changed()
  }

  private async release(generation: string): Promise<void> {
    await Promise.allSettled(this.host.plugins.map((plugin) => plugin.guest.releaseUi(generation)))
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
          const tree = await this.host.dispatch(
            "ui.render",
            {
              surface: "desktop",
              component: "Pane",
              requestId: pane.id,
              props: { title: pane.title, isFocused: false, placement: "inline", bodyColumns: 80 }
            },
            { generation, core: async () => ({ type: "Box", props: {}, children: [] }) }
          )
          this.host.assertLive()
          validateFunctionTree(tree)
          if (this.panes.get(pane.key) !== pane) {
            await this.release(generation)
            continue
          }
          await this.release(pane.generation)
          pane.generation = generation
          pane.tree = tree
        } catch (error) {
          await this.release(generation)
          throw error
        }
      }
      this.host.assertLive()
      const snapshots = [...this.panes.values()].map(
        ({ key, id, plugin, title, generation, tree, closeOnEscape, rows }) =>
          parseModJson(
            encodeModJson({ key, id, plugin, title, generation, tree, closeOnEscape, rows })
          ) as unknown as FunctionPaneSnapshot
      )
      const published = await this.host.publish(snapshots as unknown as ModJson)
      this.host.assertLive()
      if (!Array.isArray(published) || published.length !== snapshots.length)
        throw new ModFunctionError("MODS_UI_PUBLICATION")
      for (let index = 0; index < snapshots.length; index++) {
        const result = published[index]
        const original = snapshots[index] as unknown as ModObject
        if (
          !isModObject(result) ||
          typeof result.title !== "string" ||
          ["key", "id", "plugin", "generation", "closeOnEscape", "rows"].some(
            (key) => result[key] !== original[key]
          )
        )
          throw new ModFunctionError("MODS_UI_PUBLICATION")
        validateFunctionTree(result.tree)
      }
      return published as unknown as FunctionPaneSnapshot[]
    })
  }

  act(action: FunctionUiAction): Promise<void> {
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
      !Number.isSafeInteger(action.handle) ||
      action.handle < 0 ||
      !["press", "change", "submit", "select", "close"].includes(action.kind) ||
      (action.value !== undefined &&
        (typeof action.value !== "string" || action.value.length > 10000))
    )
      return Promise.reject(new ModFunctionError("MODS_UI_ACTION_INVALID"))
    const input = encodeModJson(action)
    const prior = this.intents.get(action.intentId)
    if (prior)
      return prior.input === input
        ? prior.result
        : Promise.reject(new ModFunctionError("MODS_UI_INTENT_CONFLICT"))
    // Keep settled IDs for the life of the session: evicting one could replay its action.
    if (this.intents.size >= 4096)
      return Promise.reject(new ModFunctionError("MODS_UI_INTENT_LIMIT"))
    const result = this.enqueue(async () => {
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
              await this.closePane(pane.plugin, pane.id)
              return {}
            }
          }
        )
        return
      }
      let element: FunctionUiElement | undefined
      const find = (node: FunctionUiElement | string): void => {
        if (typeof node === "string") return
        if (node.press?.plugin === action.plugin && node.press?.handle === action.handle)
          element = node
        node.children?.forEach(find)
      }
      find(pane.tree)
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
        component: "Pane",
        requestId: pane.id,
        surface: "desktop",
        ...(event !== "ui.press" ? { value: action.value ?? "" } : {}),
        ...(event === "ui.input" ? { kind: action.kind } : {})
      }
      await this.host.dispatch(event, e, {
        core: async (input, signal): Promise<ModJson> => {
          if (
            node.type === "Select" &&
            !(node.props.options as ModObject[]).some((option) => option.value === input.value)
          )
            throw new ModFunctionError("MODS_UI_ACTION_INVALID")
          await this.host.callback(
            plugin,
            event,
            input,
            { handle: action.handle, generation: pane.generation, kind },
            signal
          )
          return event === "ui.press"
            ? { element: input.element }
            : { element: input.element, value: input.value }
        }
      })
      this.host.assertLive()
    })
    this.intents.set(action.intentId, { input, result })
    return result
  }

  close(): void {
    this.closed = true
    clearTimeout(this.notification)
    this.panes.clear()
    this.intents.clear()
  }
}
