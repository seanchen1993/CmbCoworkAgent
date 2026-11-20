import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCommand } from "../../../shared/mods/v2/commands"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"

export const SESSION_CAPABILITIES = [
  "command.register",
  "command.list",
  "command.run",
  "session.id",
  "session.cwd",
  "session.surface",
  "session.surfaces",
  "clock.now",
  "clock.sleep"
] as const

/** SDK positional arguments become the same structured input a hook receives in Claude. */
export function basicSdkInput(method: string, args: ModJson[]): ModObject {
  if (method === "clock.sleep") return { ms: args[0] }
  if (method === "command.register") {
    if (!isModObject(args[0])) throw new ModFunctionError("MODS_COMMAND_SPEC")
    return args[0]
  }
  return {}
}

export function validateBasicInput(name: string, value: ModObject): void {
  if (name === "clock.sleep") {
    if (
      typeof value.ms !== "number" ||
      !Number.isFinite(value.ms) ||
      value.ms < 0 ||
      value.ms > 120000
    )
      throw new ModFunctionError("MODS_CLOCK_ARGUMENT")
  }
  if (name === "command.register") {
    if (
      typeof value.name !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(value.name) ||
      typeof value.description !== "string" ||
      value.description.length > 4096 ||
      (value.argumentHint !== undefined &&
        (typeof value.argumentHint !== "string" || value.argumentHint.length > 4096)) ||
      (value.immediate !== undefined && value.immediate !== true)
    )
      throw new ModFunctionError("MODS_COMMAND_SPEC")
  }
}

export function validateBasicResult(name: string, value: ModJson | undefined): void {
  if (
    ((name === "session.id" || name === "session.cwd") && typeof value !== "string") ||
    (name === "session.surface" && value !== "desktop") ||
    (name === "session.surfaces" &&
      (!Array.isArray(value) || value.some((surface) => surface !== "desktop"))) ||
    (name === "clock.now" && (typeof value !== "number" || !Number.isFinite(value))) ||
    (name === "clock.sleep" && value !== undefined) ||
    (name === "command.register" && (!isModObject(value) || typeof value.command !== "string")) ||
    (name === "command.list" &&
      (!Array.isArray(value) ||
        value.some(
          (entry) =>
            !isModObject(entry) ||
            typeof entry.name !== "string" ||
            typeof entry.description !== "string" ||
            !["builtin", "plugin", "user", "mcp"].includes(String(entry.source))
        )))
  )
    throw new ModFunctionError("MODS_SDK_RESULT", `MODS_SDK_RESULT: ${name}`)
}

export async function runBasicSdk(
  method: string,
  input: ModObject,
  context: {
    threadId: string
    workspace: string
    plugin: string
    registry: Map<string, FunctionCommand>
    signal: AbortSignal
  }
): Promise<ModJson | undefined> {
  const { registry, signal } = context
  signal.throwIfAborted()
  validateBasicInput(method, input)
  if (method === "session.id") return context.threadId
  if (method === "session.cwd") return context.workspace
  if (method === "session.surface") return "desktop"
  if (method === "session.surfaces") return ["desktop"]
  if (method === "clock.now") return Date.now()
  if (method === "clock.sleep") {
    await new Promise<void>((resolve, reject) => {
      const stop = (): void => {
        clearTimeout(timer)
        signal.removeEventListener("abort", stop)
        reject(new ModFunctionError("MODS_CANCELLED"))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop)
        resolve()
      }, input.ms as number)
      signal.addEventListener("abort", stop, { once: true })
      if (signal.aborted) stop()
    })
    return undefined
  }
  if (method === "command.register") {
    const name = input.name as string
    if (["goal", "browser", "mod"].includes(name.toLowerCase()))
      throw new ModFunctionError("MODS_COMMAND_RESERVED")
    if (registry.size >= 128 && !registry.has(name))
      throw new ModFunctionError("MODS_COMMAND_LIMIT")
    if (registry.has(name) && registry.get(name)!.plugin !== context.plugin)
      throw new ModFunctionError("MODS_COMMAND_CONFLICT")
    registry.set(name, {
      name,
      description: input.description as string,
      plugin: context.plugin,
      ...(typeof input.argumentHint === "string" ? { argumentHint: input.argumentHint } : {}),
      ...(input.immediate === true ? { immediate: true } : {})
    })
    return { command: name }
  }
  if (method === "command.list")
    return [...registry.values()].map((command) => ({
      name: command.name,
      description: command.description,
      source: "plugin",
      plugin: command.plugin
    }))
  throw new ModFunctionError("MODS_CAPABILITY_UNAVAILABLE")
}
