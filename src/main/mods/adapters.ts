import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { ModObject } from "../../shared/mods/types"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"
import { getModCallContext, modCallContext } from "./context"
import { getModsManager, type ModThreadBinding } from "./manager"
import { filterModData, filterModResult } from "./publication"
import { ModError } from "./errors"
import type { McpCapabilityTool, McpInvocationResult } from "../mcp/capability-types"
import { encodeModJson } from "../../shared/mods/validation"
import { FunctionToolResults } from "./v2/tool-result"
import type { ToolMessage } from "@langchain/core/messages"
import { ModFunctionError } from "../../shared/mods/v2/contracts"

const nativeNames = new Set([
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "execute"
])
const backendOperation = new AsyncLocalStorage<boolean>()

interface ToolRequest {
  toolCall?: { id?: string; name?: string; args?: Record<string, unknown> }
}

export function withModToolCall<T, R extends ToolRequest>(
  binding: ModThreadBinding,
  request: R,
  delegatedNames: ReadonlySet<string>,
  handler: (request: R) => Promise<T>
): Promise<T | ToolMessage> {
  const manager = getModsManager()
  if (!manager || !manager.isActive(binding.workspace) || !request.toolCall?.name)
    return handler(request)
  const tool = request.toolCall
  const agentId = getHookAgentIdFromRequest(request) ?? binding.agentId ?? "main"
  const callId = tool.id ?? randomUUID()
  const identity = {
    callId: `${binding.threadId}:${binding.turnId}:${agentId}:${callId}`,
    toolCallId: callId,
    threadId: binding.threadId,
    turnId: binding.turnId,
    agentId,
    workspace: manager.workspaceKey(binding.workspace),
    origin: "model" as const,
    grantEpoch: 0
  }
  let executions = 0
  const execute = (args: Record<string, unknown>, signal = binding.signal): Promise<T> => {
    const currentIdentity =
      executions++ === 0
        ? identity
        : {
            ...identity,
            callId: randomUUID(),
            parentCallId: identity.callId
          }
    const currentBinding = { ...binding, agentId, signal }
    const context = {
      identity: currentIdentity,
      toolId: `host:${tool.name}`,
      routeClaimed: false,
      protectedOutput: manager.protects(binding.workspace),
      readOnly: binding.readOnly ?? false,
      signal,
      protectData: manager.protects(binding.workspace)
        ? <V>(value: V): V => manager.policy.observer(value)
        : undefined,
      publish: manager.protects(binding.workspace)
        ? <V>(value: V): Promise<V> => manager.publish(binding.workspace, value, callId, signal)
        : undefined
    }
    return modCallContext.run(context, async () => {
      const delegated =
        nativeNames.has(tool.name!) ||
        (delegatedNames.has(tool.name!) && tool.name !== "task_output")
      const value = delegated
        ? await handler({ ...request, toolCall: { ...tool, args } })
        : await manager.dispatch(currentBinding, `host:${tool.name}`, args, (args) =>
            handler({ ...request, toolCall: { ...tool, args } })
          )
      return manager.publish(binding.workspace, value, callId, signal)
    })
  }
  const intercept = manager.getFunctionToolHandler(binding.workspace)
  if (!intercept) return execute(tool.args ?? {})
  const results = new FunctionToolResults<T>(tool.name!, callId)
  const input = { ...(filterModData(tool.args ?? {}, false) as ModObject) }
  delete input.agentId
  return intercept(
    { ...binding, agentId, workspace: identity.workspace },
    {
      ...input,
      tool: tool.name!,
      tool_use_id: callId,
      ...(agentId !== "main" ? { agentId } : {})
    },
    async (input, signal) => {
      signal.throwIfAborted()
      const args: Record<string, unknown> = { ...input }
      // Event identities are host-owned; colliding native arguments must still reach the tool.
      for (const key of ["tool", "tool_use_id", "agentId"]) {
        if (tool.args && Object.hasOwn(tool.args, key)) args[key] = tool.args[key]
        else delete args[key]
      }
      return results.add(await execute(args, signal))
    }
  )
    .catch((error: unknown) => {
      // These failures belong to dynamic guest tools and occur outside LangChain's native tool
      // error middleware. Let the model correct arguments without swallowing cancellation.
      if (
        !binding.signal?.aborted &&
        (error instanceof ModFunctionError || error instanceof ModError) &&
        [
          "MODS_REGISTERED_TOOL_INPUT",
          "MODS_REGISTERED_TOOL_UNHANDLED",
          "MODS_TOOL_INPUT_LIMIT",
          "MODS_TOOL_VALIDATION_LIMIT",
          "MODS_TOOL_AGENT_UNAVAILABLE",
          "MODS_TOOL_PERMISSION_DENIED"
        ].includes(error.code)
      )
        return {
          result: error.code === "MODS_TOOL_PERMISSION_DENIED" ? error.message : error.code,
          isError: true
        }
      throw error
    })
    .then((answer) =>
      manager.publish(binding.workspace, results.resolve(answer), callId, binding.signal)
    )
}

interface MethodSpec {
  tool: string
  names: string[]
}
const backendMethods: Record<string, MethodSpec> = {
  read: { tool: "read_file", names: ["file_path", "offset", "limit"] },
  write: { tool: "write_file", names: ["file_path", "content"] },
  edit: { tool: "edit_file", names: ["file_path", "old_string", "new_string", "replace_all"] },
  lsInfo: { tool: "ls", names: ["path"] },
  globInfo: { tool: "glob", names: ["pattern", "path"] },
  grepRaw: { tool: "grep", names: ["pattern", "path", "glob"] },
  execute: { tool: "execute", names: ["command", "cwd"] },
  executeBackground: { tool: "execute", names: ["command", "cwd"] }
}

/** Only host-owned backend methods receive this wrapper; guests never get the instance. */
export function attachModBackend(instance: object, binding: () => ModThreadBinding): () => void {
  const record = instance as Record<string, unknown>
  const originalMethods = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  for (const [name, spec] of Object.entries(backendMethods)) {
    const method = record[name]
    if (typeof method !== "function") continue
    if (!originalMethods.has(spec.tool)) {
      originalMethods.set(spec.tool, (...args) =>
        Reflect.apply(record[name] as (...args: unknown[]) => Promise<unknown>, instance, args)
      )
    }
    Object.defineProperty(instance, name, {
      configurable: true,
      writable: true,
      value: function (...values: unknown[]) {
        const manager = getModsManager()
        const scope = binding()
        if (!manager || !manager.isActive(scope.workspace) || backendOperation.getStore()) {
          return Reflect.apply(method, instance, values)
        }
        const args: Record<string, unknown> = {}
        spec.names.forEach((key, index) => {
          if (values[index] !== undefined) args[key] = values[index]
        })
        if (name === "executeBackground") args.run_in_background = true
        return manager
          .dispatch(scope, `host:${spec.tool}`, args, async (effective) => {
            const actual = [...values]
            spec.names.forEach((key, index) => {
              if (effective[key] !== undefined) actual[index] = effective[key]
            })
            for (const key of [
              "command",
              "file_path",
              "content",
              "pattern",
              "old_string",
              "new_string"
            ]) {
              if (args[key] !== undefined && typeof effective[key] !== "string")
                throw new ModError("MODS_TOOL_ARGUMENT_TYPE")
            }
            return backendOperation.run(true, async () => {
              const result = await Reflect.apply(method, instance, actual)
              return name === "executeBackground" ? { task_id: result } : result
            })
          })
          .then((result) =>
            name === "executeBackground" ? (result as { task_id: string }).task_id : result
          )
      }
    })
  }
  const scope = binding()
  return (
    getModsManager()?.bindThread({
      ...scope,
      ...(typeof record.queryToolPermission === "function"
        ? {
            queryTool: (tool: string, input: Record<string, unknown>) =>
              Reflect.apply(
                record.queryToolPermission as (
                  ...args: unknown[]
                ) => Promise<import("../../shared/tool-permission").ToolPermissionResult>,
                instance,
                [tool.replace(/^host:/, ""), input]
              )
          }
        : {}),
      invokeTool: async (toolId, args) => {
        if (toolId === "host:task_output" && typeof record.getTaskOutput === "function") {
          const manager = getModsManager()
          if (!manager || typeof args.task_id !== "string")
            throw new ModError("MODS_TOOL_ARGUMENT_TYPE")
          return manager.dispatch(binding(), toolId, args, async (input) => {
            if (typeof input.task_id !== "string") throw new ModError("MODS_TOOL_ARGUMENT_TYPE")
            return Reflect.apply(
              record.getTaskOutput as (...args: unknown[]) => unknown,
              instance,
              [input.task_id]
            )
          })
        }
        const tool = toolId.replace(/^host:/, "")
        const method = originalMethods.get(tool)
        const spec = Object.values(backendMethods).find((value) => value.tool === tool)
        if (!method || !spec) throw new ModError("MODS_TOOL_UNAVAILABLE")
        const values = spec.names.map((key) => args[key])
        // A capability request is a new operation, never an internal backend helper call.
        return backendOperation.run(false, () => method(...values))
      }
    }) ?? (() => {})
  )
}

export function protectCurrentModResult<T>(value: T): T {
  const context = getModCallContext()
  return filterModResult(value, context?.protectedOutput ?? false, context?.identity.toolCallId)
}

export function protectCurrentModData<T>(value: T): T {
  const policy = getModCallContext()?.protectData
  if (policy) return policy(value)
  return getModCallContext()?.protectedOutput ? (filterModData(value, true) as T) : value
}

export async function publishCurrentModResult<T>(value: T): Promise<T> {
  const context = getModCallContext()
  context?.assertLive?.()
  return context?.publish
    ? context.publish(value, "before-observers")
    : protectCurrentModResult(value)
}

export function currentModInput(value: unknown): ModObject {
  return filterModData(value, false) as ModObject
}

export function withScopedModMcp(
  binding: ModThreadBinding,
  tool: McpCapabilityTool,
  args: Record<string, unknown>,
  core: (args: Record<string, unknown>) => Promise<McpInvocationResult>
): Promise<McpInvocationResult> {
  const manager = getModsManager()
  return manager?.isActive(binding.workspace)
    ? manager.dispatch(
        { ...binding, permissionToolName: tool.toolId },
        `mcp:${tool.capabilityId}`,
        args,
        core
      )
    : core(args)
}

export function withRawModMcp(
  tool: McpCapabilityTool,
  args: Record<string, unknown>,
  core: (args: Record<string, unknown>) => Promise<McpInvocationResult>
): Promise<McpInvocationResult> {
  const context = getModCallContext()
  context?.assertMcpTool?.(tool)
  const manager = getModsManager()
  if (!context || !manager) return core(args)
  const toolId = `mcp:${tool.capabilityId}`
  if (
    context.toolId === toolId &&
    !context.mcpPermitConsumed &&
    context.effectiveArgs &&
    encodeModJson(context.effectiveArgs) === encodeModJson(args)
  ) {
    context.mcpPermitConsumed = true
    return core(args)
  }
  return manager.dispatch(
    {
      workspace: context.identity.workspace,
      threadId: context.identity.threadId,
      turnId: context.identity.turnId,
      agentId: context.identity.agentId,
      signal: context.signal,
      readOnly: context.readOnly
    },
    toolId,
    args,
    core
  )
}
