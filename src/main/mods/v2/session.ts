import { ModFunctionError, isModObject } from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCommand } from "../../../shared/mods/v2/commands"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { FunctionDispatcher, type FunctionPlugin } from "./dispatcher"
import {
  basicSdkInput,
  runBasicSdk,
  SESSION_CAPABILITIES,
  validateBasicInput,
  validateBasicResult
} from "./basic-sdk"
export { SESSION_CAPABILITIES } from "./basic-sdk"

export interface FunctionSessionHost {
  threadId: string
  workspace: string
  assertLive(plugin?: FunctionPlugin): void
  publish(value: ModJson, signal: AbortSignal): Promise<ModJson>
  capability?(
    plugin: FunctionPlugin,
    method: string,
    args: ModJson[],
    signal: AbortSignal
  ): Promise<ModJson | undefined>
}

/** A session keeps registration state and VMs across turns; every call still has its own frame. */
export class FunctionSession {
  private readonly controller = new AbortController()
  private readonly registry = new Map<string, FunctionCommand>()
  private readonly dispatcher: FunctionDispatcher
  private starting?: Promise<void>

  constructor(
    readonly plugins: readonly FunctionPlugin[],
    private readonly host: FunctionSessionHost
  ) {
    this.dispatcher = new FunctionDispatcher(plugins)
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

  private async dispatch(
    event: string,
    input: ModObject,
    signal?: AbortSignal,
    skip?: { plugin: string; registration: string },
    depth = 0,
    operation?: {
      plugin: FunctionPlugin
      core(input: ModObject, signal: AbortSignal): Promise<ModJson | undefined>
    }
  ): Promise<ModJson> {
    if (depth > 16) throw new ModFunctionError("MODS_DISPATCH_DEPTH")
    this.assertLive()
    const scopedSignal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal
    const result = await this.dispatcher.dispatch(event, input, {
      skip,
      signal: scopedSignal,
      operation: !!operation,
      validateInput: (name, value) => {
        validateBasicInput(name, value)
        if (name === "command.run" && (typeof value.args !== "string" || value.args.length > 32000))
          throw new ModFunctionError("MODS_COMMAND_ARGS")
      },
      validateResult: (name, value) => {
        if (operation) {
          if (!isModObject(value)) throw new ModFunctionError("MODS_OPERATION_RESULT")
          if (typeof value.deny === "string") return
          return validateBasicResult(name, value.value)
        }
        if (!isModObject(value)) throw new ModFunctionError("MODS_EVENT_RESULT")
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
      origin: skip ? { plugin: skip.plugin, tier: "user" } : { plugin: "engine", tier: "core" },
      core: async (_, e): Promise<ModJson> => {
        this.assertLive(operation?.plugin)
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
      capability: async (plugin, method, raw, callSignal, source) => {
        this.assertLive(plugin)
        if (!Array.isArray(raw)) throw new ModFunctionError("MODS_SDK_ARGUMENTS")
        const args = raw
        if (method !== "command.run" && SESSION_CAPABILITIES.some((name) => name === method)) {
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
                  signal
                })
            }
          )
          if (!isModObject(answer)) throw new ModFunctionError("MODS_OPERATION_RESULT")
          if (typeof answer.deny === "string")
            throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
          return answer.value
        }
        if (method === "command.run") {
          const command = args[0]
          if (
            !isModObject(command) ||
            typeof command.command !== "string" ||
            !this.registry.has(command.command) ||
            (command.args !== undefined && typeof command.args !== "string")
          )
            throw new ModFunctionError("MODS_COMMAND_ARGS")
          return this.dispatch(
            "command.run",
            {
              command: command.command,
              args: command.args ?? "",
              origin: { kind: "plugin", name: plugin.name },
              presentation: { isFullscreen: false, columns: 80 }
            },
            callSignal,
            { plugin: plugin.name, registration: source.registration },
            depth + 1
          )
        }
        if (!this.host.capability) throw new ModFunctionError("MODS_CAPABILITY_UNAVAILABLE")
        const value = await this.host.capability(plugin, method, args, callSignal)
        this.assertLive(plugin)
        return value
      }
    })
    this.assertLive()
    // Policy sees short-circuit results as well as results that passed through core.
    const published = await this.host.publish(result.value, scopedSignal)
    this.assertLive()
    return parseModJson(encodeModJson(published)) as ModJson
  }

  async close(): Promise<void> {
    this.controller.abort(new ModFunctionError("MODS_SESSION_CLOSED"))
    this.registry.clear()
    await Promise.allSettled(this.plugins.map((plugin) => plugin.guest.dispose()))
  }
}
