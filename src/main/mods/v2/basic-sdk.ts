import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCommand } from "../../../shared/mods/v2/commands"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionStateAccess } from "./state-store"
import { FILE_CAPABILITIES, type FunctionFileAccess, type FunctionFileMethod } from "./file-access"

export const SESSION_CAPABILITIES = [
  "command.register",
  "command.list",
  "command.run",
  "session.id",
  "session.cwd",
  "session.surface",
  "session.surfaces",
  "clock.now",
  "clock.sleep",
  "store.get",
  "store.set",
  "store.delete",
  "store.keys",
  ...FILE_CAPABILITIES
] as const

/** SDK positional arguments become the same structured input a hook receives in Claude. */
export function basicSdkInput(method: string, args: ModJson[]): ModObject {
  if (FILE_CAPABILITIES.some((name) => name === method))
    return { path: method === "fs.list" && args[0] === undefined ? "." : args[0] }
  if (method === "clock.sleep") return { ms: args[0] }
  if (method === "store.get" || method === "store.delete") return { key: args[0] }
  if (method === "store.set") return { key: args[0], value: args[1] }
  if (method === "command.register") {
    if (!isModObject(args[0])) throw new ModFunctionError("MODS_COMMAND_SPEC")
    return args[0]
  }
  return {}
}

export function validateBasicInput(name: string, value: ModObject): void {
  if (
    FILE_CAPABILITIES.some((method) => name === method) &&
    (typeof value.path !== "string" || value.path.length === 0)
  )
    throw new ModFunctionError("MODS_FS_PATH")
  if (name.startsWith("store.") && name !== "store.keys" && typeof value.key !== "string")
    throw new ModFunctionError("MODS_STORE_KEY")
  if (name === "store.set" && !Object.hasOwn(value, "value"))
    throw new ModFunctionError("MODS_STORE_VALUE")
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
  const fileStat = (entry: ModJson | undefined): boolean =>
    isModObject(entry) &&
    ["file", "dir", "other"].includes(String(entry.kind)) &&
    typeof entry.size === "number" &&
    Number.isSafeInteger(entry.size) &&
    entry.size >= 0
  if (
    (name === "fs.read" && typeof value !== "string") ||
    (name === "fs.exists" && typeof value !== "boolean") ||
    (name === "fs.stat" &&
      (!fileStat(value) ||
        !isModObject(value) ||
        typeof value.mtimeMs !== "number" ||
        !Number.isFinite(value.mtimeMs))) ||
    (name === "fs.list" &&
      (!Array.isArray(value) ||
        value.some(
          (entry) => !fileStat(entry) || !isModObject(entry) || typeof entry.name !== "string"
        ))) ||
    ((name === "session.id" || name === "session.cwd") && typeof value !== "string") ||
    (name === "session.surface" && value !== "desktop") ||
    (name === "session.surfaces" &&
      (!Array.isArray(value) || value.some((surface) => surface !== "desktop"))) ||
    (name === "clock.now" && (typeof value !== "number" || !Number.isFinite(value))) ||
    (["clock.sleep", "ui.open", "ui.close"].includes(name) && value !== undefined) ||
    ((name === "store.set" || name === "store.delete") && value !== undefined) ||
    (name === "store.keys" &&
      (!Array.isArray(value) || value.some((key) => typeof key !== "string"))) ||
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
    state?: FunctionStateAccess
    files?: FunctionFileAccess
  }
): Promise<ModJson | undefined> {
  const { registry, signal } = context
  signal.throwIfAborted()
  validateBasicInput(method, input)
  if (FILE_CAPABILITIES.some((name) => name === method)) {
    if (!context.files) throw new ModFunctionError("MODS_CAPABILITY_UNAVAILABLE")
    return context.files.run(method as FunctionFileMethod, input.path as string, signal)
  }
  if (method.startsWith("store.")) {
    if (!context.state) throw new ModFunctionError("MODS_CAPABILITY_UNAVAILABLE")
    if (method === "store.get") return context.state.get(input.key as string, signal)
    if (method === "store.set") {
      await context.state.set(input.key as string, input.value, signal)
      return undefined
    }
    if (method === "store.delete") {
      context.state.delete(input.key as string)
      return undefined
    }
    if (method === "store.keys") return context.state.keys(signal)
  }
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
