import { createHash, randomUUID } from "node:crypto"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import {
  isModObject,
  ModFunctionError,
  type FunctionGuest
} from "../../../shared/mods/v2/contracts"
import { encodeModJson } from "../../../shared/mods/validation"
import {
  validateFunctionTree,
  type FunctionClientAction,
  type FunctionClientSnapshot,
  type FunctionUiElement
} from "../../../shared/mods/v2/ui"

interface ClientHost {
  assertLive(): void
  background<T>(run: () => Promise<T>): Promise<T>
  load(plugin: string, module: string): Promise<FunctionGuest>
  changed(): void
  publish(value: ModJson): Promise<ModJson>
  message(plugin: string, input: ModObject, signal: AbortSignal): Promise<ModJson>
  control(
    event: string,
    input: ModObject,
    core: (input: ModObject) => Promise<ModJson>,
    signal: AbortSignal
  ): Promise<ModJson>
}
interface Instance {
  key: string
  pane: string
  requestId: string
  snapshot: FunctionClientSnapshot
  sourceProps: string
  rawTree?: string
  parentGeneration: string
  props: ModJson | undefined
  columns: number
  rows: number
  serial: Promise<unknown>
  loading: Promise<FunctionGuest>
  guest?: FunctionGuest
  stopped: boolean
  controller: AbortController
  pending: number
  backgroundRunning: boolean
  backgroundEvents: Map<string, ModObject>
  frame?: ReturnType<typeof setTimeout>
  timers: Map<string, { ms: number; timer: ReturnType<typeof setInterval> }>
}
function visit(tree: FunctionUiElement, fn: (node: FunctionUiElement) => void): void {
  fn(tree)
  for (const child of tree.children ?? []) if (typeof child !== "string") visit(child, fn)
}

/** Mounted Client identity survives parent redraws; only approved surface code enters its VM. */
export class FunctionClients {
  private readonly instances = new Map<string, Instance>()
  private readonly intents = new Map<string, { input: string; result: Promise<void> }>()
  private closed = false
  constructor(private readonly host: ClientHost) {}

  private assert(instance?: Instance): void {
    this.host.assertLive()
    if (
      this.closed ||
      (instance && (instance.stopped || this.instances.get(instance.key) !== instance))
    )
      throw new ModFunctionError("MODS_CLIENT_UNMOUNTED")
  }

  private stop(instance: Instance): void {
    instance.stopped = true
    instance.controller.abort(new ModFunctionError("MODS_CLIENT_UNMOUNTED"))
    clearTimeout(instance.frame)
    for (const { timer } of instance.timers.values()) clearInterval(timer)
    instance.timers.clear()
    instance.backgroundEvents.clear()
    void instance.loading.then((guest) => guest.dispose()).catch(() => {})
  }

  closePane(pane: string): void {
    for (const [key, instance] of this.instances)
      if (instance.pane === pane) {
        this.instances.delete(key)
        this.stop(instance)
      }
  }

  close(): void {
    this.closed = true
    for (const instance of this.instances.values()) this.stop(instance)
    this.instances.clear()
    this.intents.clear()
  }

  private enqueue<T>(instance: Instance, run: () => Promise<T>): Promise<T> {
    if (instance.pending >= 64) return Promise.reject(new ModFunctionError("MODS_CLIENT_BUSY"))
    instance.pending++
    const task = instance.serial
      .then(() => {
        this.assert(instance)
        return run()
      })
      .finally(() => {
        instance.pending--
      })
    instance.serial = task.catch(() => {})
    return task
  }

  private fail(instance: Instance): void {
    this.stop(instance)
    instance.snapshot = {
      ...instance.snapshot,
      error: "MODS_CLIENT_FAILED",
      tree: {
        type: "Text",
        props: {},
        children: [`${instance.snapshot.plugin}/${instance.snapshot.module}：组件已停止`]
      }
    }
    if (!this.closed) this.host.changed()
  }

  private background(instance: Instance, input: ModObject): void {
    if (instance.stopped || this.closed) return
    // A slow frame coalesces timer ticks instead of accumulating unbounded pending work.
    instance.backgroundEvents.set(`${input.kind}:${input.handle ?? ""}`, input)
    if (instance.frame || instance.backgroundRunning) return
    instance.frame = setTimeout(() => {
      instance.frame = undefined
      instance.backgroundRunning = true
      void this.host
        .background(() =>
          this.enqueue(instance, async () => {
            const events = [...instance.backgroundEvents.values()]
            instance.backgroundEvents.clear()
            for (const event of events) await this.update(instance, event)
          })
        )
        .catch(() => this.fail(instance))
        .finally(() => {
          instance.backgroundRunning = false
          const pending = instance.backgroundEvents.values().next().value
          if (pending) this.background(instance, pending)
        })
    }, 16)
    instance.frame.unref()
  }

  private async update(instance: Instance, input: ModObject): Promise<void> {
    try {
      await this.render(instance, input)
    } catch (error) {
      this.fail(instance)
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
    const guest = (instance.guest ??= await instance.loading)
    this.assert(instance)
    const result = await guest.invoke(
      "0",
      input,
      async () => {
        throw new ModFunctionError("MODS_CLIENT_CAPABILITY_DENIED")
      },
      {
        event: "surface.update",
        signal: instance.controller.signal,
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: instance.snapshot.plugin, root: "" }
      }
    )
    this.assert(instance)
    const value = result.value
    if (
      !isModObject(value) ||
      typeof value.dirty !== "boolean" ||
      !Array.isArray(value.timers) ||
      value.timers.length > 16
    )
      throw new ModFunctionError("MODS_CLIENT_RESULT")
    validateFunctionTree(value.tree)
    const rawTree = encodeModJson(value.tree)
    const tree =
      rawTree === instance.rawTree ? instance.snapshot.tree : await this.host.publish(value.tree)
    this.assert(instance)
    validateFunctionTree(tree)
    visit(tree, (node) => {
      if (node.type === "Client" || (node.press && node.press.plugin !== instance.snapshot.plugin))
        throw new ModFunctionError("MODS_CLIENT_RESULT")
    })
    const changed = encodeModJson(instance.snapshot.tree) !== encodeModJson(tree)
    instance.rawTree = rawTree
    instance.snapshot = { ...instance.snapshot, tree }
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
    if (Object.hasOwn(value, "message")) {
      const answer = await this.host.message(
        instance.snapshot.plugin,
        {
          surface: "desktop",
          component: "Pane",
          requestId: instance.requestId,
          element: instance.snapshot.element,
          module: instance.snapshot.module,
          data: await this.host.publish(value.message)
        },
        instance.controller.signal
      )
      this.assert(instance)
      if (!isModObject(answer)) throw new ModFunctionError("MODS_CLIENT_MESSAGE_RESULT")
      if (Object.hasOwn(answer, "props")) {
        instance.props = answer.props
        this.background(instance, {
          kind: "render"
        })
      }
    }
    if (value.dirty) this.background(instance, { kind: "frame" })
    if (changed) this.host.changed()
  }

  async reconcile(
    pane: string,
    requestId: string,
    parentGeneration: string,
    tree: FunctionUiElement
  ): Promise<FunctionClientSnapshot[]> {
    this.assert()
    const wanted = new Set<string>()
    const nodes: FunctionUiElement[] = []
    visit(tree, (node) => {
      if (node.type === "Client") nodes.push(node)
    })
    if (nodes.length > 8) throw new ModFunctionError("MODS_CLIENT_LIMIT")
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
        const atCapacity = [...this.instances.values()].filter((i) => !i.stopped).length >= 8
        const loading = Promise.resolve().then(() => {
          this.assert()
          if (atCapacity) throw new ModFunctionError("MODS_CLIENT_LIMIT")
          return this.host.load(plugin, module)
        })
        void loading.catch(() => {})
        instance = {
          key,
          pane,
          requestId,
          sourceProps,
          parentGeneration,
          props,
          columns: 0,
          rows: 0,
          serial: Promise.resolve(),
          pending: 0,
          backgroundRunning: false,
          backgroundEvents: new Map(),
          loading,
          stopped: false,
          controller: new AbortController(),
          timers: new Map(),
          snapshot: {
            id: randomUUID(),
            plugin,
            element,
            module,
            tree: { type: "Box", props: {}, children: [] }
          }
        }
        this.instances.set(key, instance)
        const current = instance
        await this.enqueue(current, () => this.update(current, { kind: "render" })).catch(() =>
          this.fail(current)
        )
      } else if (
        !instance.stopped &&
        (instance.sourceProps !== sourceProps || instance.parentGeneration !== parentGeneration)
      ) {
        instance.sourceProps = sourceProps
        instance.props = props
        instance.parentGeneration = parentGeneration
        const current = instance
        await this.enqueue(current, () =>
          this.update(current, {
            kind: "render"
          })
        ).catch(() => this.fail(current))
      }
    }
    for (const [key, instance] of this.instances)
      if (instance.pane === pane && !wanted.has(key)) {
        this.instances.delete(key)
        this.stop(instance)
      }
    this.assert()
    const snapshots = [...this.instances.values()]
      .filter((i) => i.pane === pane)
      .map((i) => i.snapshot)
    if (!snapshots.length) return []
    const published = await this.host.publish(snapshots as unknown as ModJson)
    this.assert()
    if (!Array.isArray(published) || published.length !== snapshots.length)
      throw new ModFunctionError("MODS_CLIENT_PUBLICATION")
    published.forEach((item, index) => {
      if (
        !isModObject(item) ||
        ["id", "plugin", "element", "module", "error"].some(
          (key) => item[key] !== (snapshots[index] as unknown as ModObject)[key]
        )
      )
        throw new ModFunctionError("MODS_CLIENT_PUBLICATION")
      validateFunctionTree(item.tree)
    })
    return published as unknown as FunctionClientSnapshot[]
  }

  act(action: FunctionClientAction): Promise<void> {
    this.assert()
    if (
      !isModObject(action) ||
      typeof action.pane !== "string" ||
      action.pane.length > 200 ||
      typeof action.instance !== "string" ||
      !/^[a-f0-9-]{36}$/.test(action.instance) ||
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
      let control: FunctionUiElement | undefined
      visit(instance.snapshot.tree, (node) => {
        if (node.press?.handle === action.handle) control = node
      })
      const node = control as FunctionUiElement | undefined
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
        component: "Pane",
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
