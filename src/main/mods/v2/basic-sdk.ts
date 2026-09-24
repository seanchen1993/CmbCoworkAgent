import type {
  FunctionSessionReadMethod,
  FunctionSessionUsageArgs
} from "../../../shared/mods/v2/session"
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
  "session.repo",
  "session.model",
  "session.messages",
  "session.turns",
  "session.usage",
  "session.compact",
  "session.authorize",
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
  if (method === "session.compact") {
    if (args[0] === undefined) return {}
    if (!isModObject(args[0])) throw new ModFunctionError("MODS_CONTEXT_COMPACTION_INSTRUCTIONS")
    return args[0]
  }
  if (method === "session.usage") {
    if (args[0] === undefined) return {}
    if (!isModObject(args[0])) throw new ModFunctionError("MODS_SESSION_USAGE_ARGUMENT")
    return args[0]
  }
  if (method === "fs.stat") {
    const options = args[1]
    if (
      args.length > 2 ||
      (options !== undefined &&
        (!isModObject(options) ||
          Object.keys(options).some((key) => key !== "resolve") ||
          (options.resolve !== undefined && typeof options.resolve !== "boolean")))
    )
      throw new ModFunctionError("MODS_FS_OPTIONS")
    return { path: args[0], resolve: isModObject(options) && options.resolve === true }
  }
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
    name === "session.compact" &&
    (value.instructions !== undefined &&
      (typeof value.instructions !== "string" || value.instructions.length > 32000))
  )
    throw new ModFunctionError("MODS_CONTEXT_COMPACTION_INSTRUCTIONS")
  if (
    name === "session.usage" &&
    ((value.breakdown !== undefined &&
      value.breakdown !== "summary" &&
      value.breakdown !== "full") ||
      (value.columns !== undefined &&
        (typeof value.columns !== "number" ||
          !Number.isSafeInteger(value.columns) ||
          value.columns <= 0)))
  )
    throw new ModFunctionError("MODS_SESSION_USAGE_ARGUMENT")
  if (
    FILE_CAPABILITIES.some((method) => name === method) &&
    (typeof value.path !== "string" || value.path.length === 0)
  )
    throw new ModFunctionError("MODS_FS_PATH")
  if (name === "fs.stat" && value.resolve !== undefined && typeof value.resolve !== "boolean")
    throw new ModFunctionError("MODS_FS_OPTIONS")
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
  if (name === "session.compact") {
    const count = (candidate: unknown): candidate is number =>
      typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
    const messagesValid = (candidate: unknown): boolean =>
      Array.isArray(candidate) &&
      candidate.length > 0 &&
      candidate.length <= 4096 &&
      candidate.every(
        (entry) =>
          isModObject(entry) &&
          (entry.role === "user" || entry.role === "assistant") &&
          typeof entry.text === "string" &&
          Array.isArray(entry.toolUses) &&
          entry.toolUses.every(
            (call) =>
              isModObject(call) &&
              typeof call.tool_use_id === "string" &&
              typeof call.tool === "string" &&
              isModObject(call.input) &&
              (call.text === undefined || typeof call.text === "string") &&
              (call.isError === undefined || call.isError === true)
          ) &&
          (entry.toolResults === undefined ||
            (entry.role === "user" &&
              Array.isArray(entry.toolResults) &&
              entry.toolResults.every(
                (result) =>
                  isModObject(result) &&
                  typeof result.tool_use_id === "string" &&
                  typeof result.text === "string" &&
                  typeof result.isError === "boolean"
              )))
      )
    if (
      !isModObject(value) ||
      (value.skip !== undefined
        ? typeof value.skip !== "string" || value.skip.length === 0 || value.messages !== undefined
        : !messagesValid(value.messages)) ||
      (value.tokensBefore !== undefined && !count(value.tokensBefore)) ||
      (value.tokensAfter !== undefined && !count(value.tokensAfter)) ||
      Object.hasOwn(value, "filePath")
    )
      throw new ModFunctionError("MODS_SDK_RESULT", `MODS_SDK_RESULT: ${name}`)
    return
  }
  if (name === "session.usage") {
    const count = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    const breakdownValid = (candidate: unknown): boolean => {
      if (!isModObject(candidate)) return false
      const categoryValid = (row: unknown): boolean =>
        isModObject(row) &&
        typeof row.name === "string" &&
        count(row.tokens) &&
        typeof row.color === "string" &&
        typeof row.isDeferred === "boolean" &&
        typeof row.estimated === "boolean" &&
        ["used", "free", "buffer", "deferred"].includes(String(row.kind))
      const squareValid = (square: unknown): boolean =>
        isModObject(square) &&
        typeof square.color === "string" &&
        typeof square.isFilled === "boolean" &&
        typeof square.categoryName === "string" &&
        count(square.tokens) &&
        typeof square.percentage === "number" &&
        Number.isFinite(square.percentage) &&
        square.percentage >= 0 &&
        typeof square.squareFullness === "number" &&
        Number.isFinite(square.squareFullness) &&
        square.squareFullness >= 0 &&
        square.squareFullness <= 1
      const messageBreakdown = isModObject(candidate.messageBreakdown)
        ? candidate.messageBreakdown
        : undefined
      const apiUsage =
        candidate.apiUsage === null ||
        (isModObject(candidate.apiUsage) &&
          count(candidate.apiUsage.input_tokens) &&
          count(candidate.apiUsage.output_tokens) &&
          count(candidate.apiUsage.cache_creation_input_tokens) &&
          count(candidate.apiUsage.cache_read_input_tokens))
      return (
        Array.isArray(candidate.categories) &&
        candidate.categories.every(categoryValid) &&
        count(candidate.totalTokens) &&
        count(candidate.maxTokens) &&
        candidate.maxTokens > 0 &&
        count(candidate.rawMaxTokens) &&
        candidate.rawMaxTokens > 0 &&
        candidate.autocompactSource === "auto" &&
        typeof candidate.percentage === "number" &&
        Number.isFinite(candidate.percentage) &&
        candidate.percentage >= 0 &&
        Array.isArray(candidate.gridRows) &&
        candidate.gridRows.every((row) => Array.isArray(row) && row.every(squareValid)) &&
        typeof candidate.model === "string" &&
        typeof candidate.estimated === "boolean" &&
        messageBreakdown !== undefined &&
        [
          "toolCallTokens",
          "toolResultTokens",
          "attachmentTokens",
          "assistantMessageTokens",
          "userMessageTokens",
          "redirectedContextTokens",
          "unattributedTokens"
        ].every((key) => count(messageBreakdown[key])) &&
        Array.isArray(messageBreakdown.toolCallsByType) &&
        messageBreakdown.toolCallsByType.every(
          (entry) =>
            isModObject(entry) &&
            typeof entry.name === "string" &&
            count(entry.callTokens) &&
            count(entry.resultTokens)
        ) &&
        Array.isArray(messageBreakdown.attachmentsByType) &&
        messageBreakdown.attachmentsByType.every(
          (entry) => isModObject(entry) && typeof entry.name === "string" && count(entry.tokens)
        ) &&
        apiUsage
      )
    }
    if (
      !isModObject(value) ||
      !isModObject(value.context) ||
      !count(value.context.window) ||
      value.context.window === 0 ||
      (value.context.tokens !== undefined && !count(value.context.tokens)) ||
      (value.context.percent !== undefined &&
        (!count(value.context.percent) || value.context.percent > 100)) ||
      (value.context.breakdown !== undefined && !breakdownValid(value.context.breakdown)) ||
      !Array.isArray(value.rateLimits) ||
      value.rateLimits.some(
        (limit) =>
          !isModObject(limit) ||
          typeof limit.kind !== "string" ||
          typeof limit.percentUsed !== "number" ||
          !Number.isFinite(limit.percentUsed) ||
          limit.percentUsed < 0 ||
          (limit.resetsAt !== undefined &&
            (typeof limit.resetsAt !== "string" || !Number.isFinite(Date.parse(limit.resetsAt))))
      ) ||
      (value.cost !== undefined &&
        (!isModObject(value.cost) ||
          typeof value.cost.usd !== "number" ||
          !Number.isFinite(value.cost.usd) ||
          value.cost.usd < 0))
    )
      throw new ModFunctionError("MODS_SDK_RESULT", `MODS_SDK_RESULT: ${name}`)
    return
  }
  const toolUse = (call: ModJson): boolean =>
    isModObject(call) &&
    typeof call.tool_use_id === "string" &&
    typeof call.tool === "string" &&
    isModObject(call.input) &&
    (call.text === undefined || typeof call.text === "string") &&
    (call.isError === undefined || call.isError === true)
  const toolResult = (answer: ModJson): boolean =>
    isModObject(answer) &&
    typeof answer.tool_use_id === "string" &&
    typeof answer.text === "string" &&
    typeof answer.isError === "boolean"
  const fileStat = (entry: ModJson | undefined): boolean =>
    isModObject(entry) &&
    ["file", "dir", "other"].includes(String(entry.kind)) &&
    typeof entry.size === "number" &&
    Number.isSafeInteger(entry.size) &&
    entry.size >= 0 &&
    (entry.isLink === undefined || typeof entry.isLink === "boolean")
  if (
    (name === "fs.read" && typeof value !== "string") ||
    (name === "fs.exists" && typeof value !== "boolean") ||
    (name === "fs.stat" &&
      (!fileStat(value) ||
        !isModObject(value) ||
        typeof value.mtimeMs !== "number" ||
        !Number.isFinite(value.mtimeMs) ||
        (value.realPath !== undefined &&
          (typeof value.realPath !== "string" || value.realPath.length === 0)))) ||
    (name === "fs.list" &&
      (!Array.isArray(value) ||
        value.some(
          (entry) => !fileStat(entry) || !isModObject(entry) || typeof entry.name !== "string"
        ))) ||
    (name === "session.authorize" &&
      value !== null &&
      (!isModObject(value) ||
        typeof value.handle !== "string" ||
        !["bearer", "api-key"].includes(String(value.kind)))) ||
    (name === "session.repo" &&
      value !== null &&
      (!isModObject(value) ||
        typeof value.root !== "string" ||
        (value.remote !== null && typeof value.remote !== "string") ||
        typeof value.internal !== "boolean" ||
        (value.name !== null && typeof value.name !== "string"))) ||
    ((name === "session.id" || name === "session.cwd" || name === "session.model") &&
      typeof value !== "string") ||
    (name === "session.turns" &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) ||
    (name === "session.messages" &&
      (!Array.isArray(value) ||
        value.length > 4096 ||
        value.some(
          (entry) =>
            !isModObject(entry) ||
            !["user", "assistant"].includes(String(entry.role)) ||
            typeof entry.text !== "string" ||
            !Array.isArray(entry.toolUses) ||
            entry.toolUses.some((call) => !toolUse(call)) ||
            (entry.toolResults !== undefined &&
              (entry.role !== "user" ||
                !Array.isArray(entry.toolResults) ||
                entry.toolResults.some((answer) => !toolResult(answer))))
        ))) ||
    (name === "session.surface" && value !== "desktop") ||
    (name === "session.surfaces" &&
      (!Array.isArray(value) || value.some((surface) => surface !== "desktop"))) ||
    (name === "clock.now" && (typeof value !== "number" || !Number.isFinite(value))) ||
    (["clock.sleep", "ui.open", "ui.close", "fs.write"].includes(name) && value !== undefined) ||
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
    readSession?(
      method: FunctionSessionReadMethod,
      signal: AbortSignal,
      usageArgs?: FunctionSessionUsageArgs
    ): Promise<ModJson>
    compactSession?(instructions: string, signal: AbortSignal): Promise<ModJson>
    files?: FunctionFileAccess
  }
): Promise<ModJson | undefined> {
  const { registry, signal } = context
  signal.throwIfAborted()
  validateBasicInput(method, input)
  if (FILE_CAPABILITIES.some((name) => name === method)) {
    if (!context.files) throw new ModFunctionError("MODS_CAPABILITY_UNAVAILABLE")
    return context.files.run(
      method as FunctionFileMethod,
      input.path as string,
      signal,
      method === "fs.stat" ? { resolve: input.resolve === true } : undefined
    )
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
  if (method === "session.authorize") return null
  if (
    method === "session.repo" ||
    method === "session.model" ||
    method === "session.messages" ||
    method === "session.turns" ||
    method === "session.usage"
  ) {
    if (!context.readSession) throw new ModFunctionError("MODS_SESSION_UNAVAILABLE")
    return method === "session.usage"
      ? context.readSession(method, signal, input as FunctionSessionUsageArgs)
      : context.readSession(method, signal)
  }
  if (method === "session.compact") {
    if (!context.compactSession) throw new ModFunctionError("MODS_SESSION_UNAVAILABLE")
    return context.compactSession(
      typeof input.instructions === "string" ? input.instructions : "",
      signal
    )
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
