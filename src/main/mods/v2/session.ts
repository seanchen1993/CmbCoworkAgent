import { ModFunctionError, isModObject } from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCommand } from "../../../shared/mods/v2/commands"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { FunctionDispatcher, type FunctionPlugin } from "./dispatcher"
import {
  basicSdkInput,
  runBasicSdk,
  SESSION_CAPABILITIES as BASIC_CAPABILITIES,
  validateBasicInput,
  validateBasicResult
} from "./basic-sdk"
import {
  FUNCTION_UI_CAPABILITIES,
  validateFunctionTree,
  validatePaneArgs
} from "../../../shared/mods/v2/ui"
import { FunctionPanes, type FunctionUiDispatch } from "./panes"
export const SESSION_CAPABILITIES = [
  ...BASIC_CAPABILITIES,
  ...FUNCTION_UI_CAPABILITIES,
  "tool.call",
  "model.complete"
]
import type { FunctionStateAccess } from "./state-store"
import { FILE_CAPABILITIES, type FunctionFileAccess } from "./file-access"
import { resolve } from "node:path"
import { FunctionClients } from "./clients"
import type { FunctionGuest } from "../../../shared/mods/v2/contracts"
import { randomUUID } from "node:crypto"
import { functionToolTarget, validateFunctionToolResult, validateModelToolInput } from "./tool-sdk"
import { functionModelRequest, validateFunctionModelText } from "./model-sdk"

export interface FunctionSessionHost {
  threadId: string
  workspace: string
  assertLive(plugin?: FunctionPlugin): void
  uiChanged?(): void
  loadClient?(plugin: string, module: string): Promise<FunctionGuest>
  callTool?(plugin: FunctionPlugin, input: ModObject, signal: AbortSignal): Promise<ModObject>
  completeModel?(plugin: FunctionPlugin, input: ModObject, signal: AbortSignal): Promise<string>
  scheduleCommand?(
    command: FunctionCommand,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<ModObject>
  ): Promise<ModObject>
  publish(value: ModJson, signal: AbortSignal): Promise<ModJson>
  state?(plugin: FunctionPlugin): FunctionStateAccess
  files?(plugin: FunctionPlugin): FunctionFileAccess
  capability?(
    plugin: FunctionPlugin,
    method: string,
    args: ModJson[],
    signal: AbortSignal
  ): Promise<ModJson | undefined>
}

/** A session keeps registration state and VMs across turns; every call still has its own frame. */
export class FunctionSession {
  readonly panes: FunctionPanes
  readonly clients: FunctionClients
  private readonly controller = new AbortController()
  private readonly registry = new Map<string, FunctionCommand>()
  private readonly dispatcher: FunctionDispatcher
  private starting?: Promise<void>

  constructor(
    readonly plugins: readonly FunctionPlugin[],
    private readonly host: FunctionSessionHost
  ) {
    this.dispatcher = new FunctionDispatcher(plugins)
    this.clients = new FunctionClients({
      assertLive: () => this.assertLive(),
      changed: () => this.panes.notify(),
      publish: (value) => this.host.publish(value, this.controller.signal),
      load: (plugin, module) => {
        if (!this.host.loadClient) throw new ModFunctionError("MODS_CLIENT_UNAVAILABLE")
        return this.host.loadClient(plugin, module)
      },
      message: (plugin, input, signal) =>
        this.dispatch("ui.message", input, signal, undefined, 0, undefined, undefined, {
          onlyPlugin: plugin,
          origin: { plugin: "client", tier: "core" },
          core: async () => ({})
        }),
      control: (event, input, core, signal) =>
        this.dispatch(event, input, signal, undefined, 0, undefined, undefined, { core })
    })
    this.panes = new FunctionPanes({
      clients: this.clients,
      plugins,
      assertLive: () => this.assertLive(),
      changed: () => this.host.uiChanged?.(),
      publish: (value) => this.host.publish(value, this.controller.signal),
      dispatch: (event, input, presentation) =>
        this.dispatch(
          event,
          input,
          presentation.signal,
          undefined,
          0,
          undefined,
          undefined,
          presentation
        ),
      callback: async (plugin, event, input, callback, signal) => {
        this.assertLive(plugin)
        await plugin.guest.invoke(
          "callback",
          input,
          async (method, args, callSignal) => {
            if (!plugin.capabilities.includes(method))
              throw new ModFunctionError("MODS_CAPABILITY_DENIED")
            const value = await this.capability(
              plugin,
              method,
              args,
              callSignal,
              { event, registration: "callback" },
              0,
              undefined
            )
            return value === undefined ? {} : { value }
          },
          {
            event,
            timeoutMs: 120000,
            callback,
            signal,
            origin: { plugin: "engine", tier: "core" },
            capabilities: plugin.capabilities,
            plugin: { name: plugin.name, root: plugin.root }
          }
        )
        this.assertLive(plugin)
      }
    })
  }

  start(): Promise<void> {
    this.starting ??= this.dispatch("session.start", {
      cwd: this.host.workspace,
      surface: "desktop",
      isInteractive: true
    }).then(() => {})
    return this.starting
  }

  private assertLive(plugin?: FunctionPlugin): void {
    this.controller.signal.throwIfAborted()
    this.host.assertLive(plugin)
    if (plugin?.guest.stats.disposed) throw new ModFunctionError("MODS_UNLOADED")
  }

  async commands(signal?: AbortSignal, includeHidden = false): Promise<FunctionCommand[]> {
    await this.start()
    const commands: FunctionCommand[] = []
    for (const registered of this.registry.values()) {
      const result = await this.dispatch(
        "command.describe",
        {
          command: registered.name,
          description: registered.description,
          isHidden: false,
          immediate: registered.immediate === true,
          provider: { plugin: registered.plugin, tier: "user" },
          ...(registered.argumentHint ? { argumentHint: registered.argumentHint } : {})
        },
        signal
      )
      if (
        !isModObject(result) ||
        typeof result.description !== "string" ||
        typeof result.isHidden !== "boolean"
      )
        throw new ModFunctionError("MODS_COMMAND_DESCRIPTION")
      if (result.isHidden && !includeHidden) continue
      commands.push({
        ...registered,
        ...(result.isHidden ? { isHidden: true } : {}),
        description: result.description,
        ...(typeof result.argumentHint === "string" ? { argumentHint: result.argumentHint } : {})
      })
    }
    return commands
  }

  async run(command: string, args: string, signal?: AbortSignal): Promise<ModObject> {
    await this.start()
    this.assertLive()
    if (!this.registry.has(command)) throw new ModFunctionError("MODS_COMMAND_MISSING")
    if (typeof args !== "string" || args.length > 32000)
      throw new ModFunctionError("MODS_COMMAND_ARGS")
    const value = await this.dispatch(
      "command.run",
      {
        command,
        args,
        origin: { kind: "composer" },
        presentation: { isFullscreen: false, columns: 80 }
      },
      signal
    )
    if (!isModObject(value) || (value.text !== undefined && typeof value.text !== "string"))
      throw new ModFunctionError("MODS_COMMAND_RESULT")
    return value
  }

  async interceptTool(
    input: ModObject,
    signal: AbortSignal | undefined,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
  ): Promise<ModObject> {
    await this.start()
    return (await this.dispatch("tool.call", input, signal, undefined, 0, undefined, "tool.call", {
      core,
      modelTool: true
    })) as ModObject
  }

  private async dispatch(
    event: string,
    input: ModObject,
    signal?: AbortSignal,
    skip?: { plugin: string; registration: string },
    depth = 0,
    operation?: {
      plugin: FunctionPlugin
      core(input: ModObject, signal: AbortSignal): Promise<ModJson | undefined>
    },
    held?: string,
    presentation?: FunctionUiDispatch & { modelTool?: boolean }
  ): Promise<ModJson> {
    if (depth > 16) throw new ModFunctionError("MODS_DISPATCH_DEPTH")
    this.assertLive()
    const turnHeld = held ?? (event === "command.run" ? "command.run" : undefined)
    const isOperation = !!operation || presentation?.operation === true
    const scopedSignal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal
    const result = await this.dispatcher.dispatch(event, input, {
      skip,
      onlyPlugin: presentation?.onlyPlugin,
      signal: scopedSignal,
      operation: isOperation,
      ...(event === "command.run" ||
      event === "tool.call" ||
      event === "model.complete" ||
      ["ui.press", "ui.input", "ui.select", "ui.message"].includes(event)
        ? { timeoutMs: 120000 }
        : {}),
      ...(presentation?.generation ? { uiGeneration: presentation.generation } : {}),
      normalizeInput: (name, value) =>
        FILE_CAPABILITIES.some((method) => method === name) &&
        typeof value.path === "string" &&
        value.path !== ""
          ? { ...value, path: resolve(this.host.workspace, value.path) }
          : value,
      validateInput: (name, value) => {
        validateBasicInput(name, value)
        if (name === "tool.call") {
          if (presentation?.modelTool) validateModelToolInput(value)
          else functionToolTarget(value)
        }
        if (name === "model.complete") functionModelRequest(value)
        if (name === "ui.open") validatePaneArgs(value)
        if (
          (name === "ui.input" || name === "ui.select") &&
          (typeof value.value !== "string" || value.value.length > 10000)
        )
          throw new ModFunctionError("MODS_UI_ACTION_INVALID")
        if (name === "command.run" && (typeof value.args !== "string" || value.args.length > 32000))
          throw new ModFunctionError("MODS_COMMAND_ARGS")
      },
      validateResult: (name, value) => {
        if (name === "tool.call") return validateFunctionToolResult(value)
        if (name === "ui.render") return validateFunctionTree(value)
        if (isOperation) {
          if (!isModObject(value)) throw new ModFunctionError("MODS_OPERATION_RESULT")
          if (typeof value.deny === "string") return
          if (name === "model.complete") return validateFunctionModelText(value.value)
          return validateBasicResult(name, value.value)
        }
        if (!isModObject(value)) throw new ModFunctionError("MODS_EVENT_RESULT")
        if (
          ["ui.press", "ui.input", "ui.select"].includes(name) &&
          (typeof value.element !== "string" ||
            (name !== "ui.press" && typeof value.value !== "string"))
        )
          throw new ModFunctionError("MODS_UI_ACTION_RESULT")
        if (name === "command.run" && value.text !== undefined && typeof value.text !== "string")
          throw new ModFunctionError("MODS_COMMAND_RESULT")
        if (
          name === "command.describe" &&
          (typeof value.description !== "string" || typeof value.isHidden !== "boolean")
        )
          throw new ModFunctionError("MODS_COMMAND_DESCRIPTION")
        if (name === "session.start" && typeof value.cwd !== "string")
          throw new ModFunctionError("MODS_SESSION_START_RESULT")
      },
      origin:
        presentation?.origin ??
        (skip ? { plugin: skip.plugin, tier: "user" } : { plugin: "engine", tier: "core" }),
      core: async (_, e): Promise<ModJson> => {
        this.assertLive(operation?.plugin)
        if (presentation?.core) return presentation.core(e, scopedSignal)
        if (operation) {
          const value = await operation.core(e, scopedSignal)
          // Only the wire omits the undefined field; the guest restores { value: undefined }.
          return value === undefined ? {} : { value }
        }
        if (event === "session.start") return { cwd: this.host.workspace }
        if (event === "command.run") return {}
        if (event === "command.describe")
          return {
            description: e.description,
            isHidden: e.isHidden,
            ...(e.argumentHint === undefined ? {} : { argumentHint: e.argumentHint })
          }
        throw new ModFunctionError("MODS_EVENT_UNAVAILABLE")
      },
      capability: (plugin, method, raw, callSignal, source) =>
        this.capability(plugin, method, raw, callSignal, source, depth, turnHeld)
    })
    this.assertLive()
    // Policy sees short-circuit results as well as results that passed through core.
    const published = await this.host.publish(result.value, scopedSignal)
    this.assertLive()
    return parseModJson(encodeModJson(published)) as ModJson
  }

  private async capability(
    plugin: FunctionPlugin,
    method: string,
    raw: ModJson,
    callSignal: AbortSignal,
    source: { event: string; registration: string },
    depth = 0,
    turnHeld?: string
  ): Promise<ModJson | undefined> {
    this.assertLive(plugin)
    if (!Array.isArray(raw)) throw new ModFunctionError("MODS_SDK_ARGUMENTS")
    const args = raw
    if (method === "model.complete") {
      if (args.length !== 1 || !isModObject(args[0]))
        throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
      functionModelRequest(args[0])
      const result = await this.dispatch(
        method,
        args[0],
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: (input, signal) => {
            this.assertLive(plugin)
            if (!this.host.completeModel) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
            return this.host.completeModel(plugin, input, signal)
          }
        },
        turnHeld
      )
      if (!isModObject(result)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof result.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", result.deny)
      validateFunctionModelText(result.value)
      return result.value
    }
    if (method === "tool.call") {
      if (!isModObject(args[0]) || args.length !== 1)
        throw new ModFunctionError("MODS_TOOL_ARGUMENTS")
      const input = { ...args[0] }
      delete input.tool_use_id
      delete input.agentId
      functionToolTarget(input)
      const result = await this.dispatch(
        "tool.call",
        { ...input, tool_use_id: randomUUID() },
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        undefined,
        turnHeld ?? "tool.call",
        {
          core: (e, signal) => {
            this.assertLive(plugin)
            if (!this.host.callTool) throw new ModFunctionError("MODS_TOOL_UNAVAILABLE")
            return this.host.callTool(plugin, e, signal)
          }
        }
      )
      return result
    }
    if (method === "ui.invalidate") {
      if (args[0] !== "ui.render") throw new ModFunctionError("MODS_UI_INVALIDATE_UNAVAILABLE")
      this.panes.invalidate()
      return undefined
    }
    if (method === "ui.open" || method === "ui.close") {
      if (!isModObject(args[0])) throw new ModFunctionError("MODS_UI_PANE_ARGUMENTS")
      validatePaneArgs(args[0])
      const input =
        method === "ui.close"
          ? { id: args[0].id, origin: { kind: "plugin", name: plugin.name } }
          : args[0]
      const answer = await this.dispatch(
        method,
        input,
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: async (e) => {
            this.assertLive(plugin)
            if (method === "ui.open") this.panes.open(plugin.name, e)
            else await this.panes.closePane(plugin.name, e.id as string, false)
            return undefined
          }
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method !== "command.run" && BASIC_CAPABILITIES.some((name) => name === method)) {
      const answer = await this.dispatch(
        method,
        basicSdkInput(method, args),
        callSignal,
        { plugin: plugin.name, registration: source.registration },
        depth + 1,
        {
          plugin,
          core: (input, signal) =>
            runBasicSdk(method, input, {
              ...this.host,
              plugin: plugin.name,
              registry: this.registry,
              state: this.host.state?.(plugin),
              files: this.host.files?.(plugin),
              signal
            })
        },
        turnHeld
      )
      if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
      if (typeof answer.deny === "string")
        throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
      return answer.value
    }
    if (method === "command.run") {
      if (turnHeld)
        throw new ModFunctionError(
          "MODS_COMMAND_TURN_HELD",
          `MODS_COMMAND_TURN_HELD: $.command.run cannot wait inside ${turnHeld}`,
          true
        )
      const command = args[0]
      if (
        !isModObject(command) ||
        typeof command.command !== "string" ||
        !this.registry.has(command.command) ||
        (command.args !== undefined && typeof command.args !== "string")
      )
        throw new ModFunctionError("MODS_COMMAND_ARGS")
      const run = async (signal: AbortSignal): Promise<ModObject> => {
        this.assertLive(plugin)
        signal.throwIfAborted()
        return (await this.dispatch(
          "command.run",
          {
            command: command.command,
            args: command.args ?? "",
            origin: { kind: "plugin", name: plugin.name },
            presentation: { isFullscreen: false, columns: 80 }
          },
          signal,
          { plugin: plugin.name, registration: source.registration },
          depth + 1
        )) as ModObject
      }
      return this.host.scheduleCommand
        ? this.host.scheduleCommand(this.registry.get(command.command)!, callSignal, run)
        : run(callSignal)
    }
    if (!this.host.capability) throw new ModFunctionError("MODS_CAPABILITY_UNAVAILABLE")
    const value = await this.host.capability(plugin, method, args, callSignal)
    this.assertLive(plugin)
    return value
  }

  async close(): Promise<void> {
    this.controller.abort(new ModFunctionError("MODS_SESSION_CLOSED"))
    this.panes.close()
    this.clients.close()
    this.registry.clear()
    await Promise.allSettled(this.plugins.map((plugin) => plugin.guest.dispose()))
  }
}
