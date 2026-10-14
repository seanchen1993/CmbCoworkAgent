import { ModToolLoading, MODS_TOOL_SEARCH } from "./mods-tool-loading"
import type { RegisteredFunctionTool } from "../../shared/mods/v2/tools"
import { collectRuntimeToolCatalog } from "./runtime-tool-catalog"
import { applyClassicToolOutput } from "../hooks/tool-output"
import { ToolMessage } from "@langchain/core/messages"
import { Command, isCommand } from "@langchain/langgraph"
import { createMiddleware } from "langchain"
import { withModToolCall, publishCurrentModResult } from "../mods/adapters"
import { authorizeCurrentModInput, getModsManager } from "../mods/manager"
import { functionToolContexts } from "../mods/v2/tool-result"
import { withFunctionExecution, currentFunctionExecution } from "../mods/v2/execution-context"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import type { HookContext, HookResultCallback } from "../hooks/runner"
import { runHooksEnriched } from "../hooks/required-skill"
import {
  getCurrentHookAgentId,
  getHookAgentIdFromRequest,
  runWithHookAgentId
} from "../hooks/execution-context"
import { throwIfHookHalt } from "../hooks/halt"
import { mergeUpdatedInput as mergeHookUpdatedInput } from "../hooks/updated-input"
import type { HookConfig, HookEvent, HookResult } from "../hooks/types"
import type { HookScopeController } from "../hooks/scope"
import { detectToolFailure, hasFailureFired, type ToolFailureSignal } from "../hooks/tool-failure"
import {
  formatFailureFuseWarning,
  shouldAttachFailureFuseFeedback,
  shouldSendFailureFuseNotice,
  throwIfFailureFuseHalt,
  type FailureFuseDecision,
  type FailureFuseNoticeCallback
} from "./failure-fuse"

export interface ToolHookMiddlewareOptions {
  runtimeAuthority?: ModRuntimeAuthority
  workspacePath: string
  threadId: string
  hookScope: HookScopeController
  resolveHooksForContext: (event: HookEvent, context: HookContext) => HookConfig[]
  onHookResult?: HookResultCallback
  hookTurnId?: string
  agentId?: string
  systemId?: string
  pluginWorkspace?: string
  featureId?: string
  harnessProjectId?: string
  harnessAdapterId?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  projectCode?: string
  projectDir?: string
  workspaceHookCwd?: string
  forceSyncWorkspaceHooks?: boolean
  skipToolNames?: ReadonlySet<string>
  onToolFailureDecision?: (input: {
    toolName: string
    toolCallId?: string
    toolArgs: Record<string, unknown>
    signal: ToolFailureSignal
  }) => FailureFuseDecision | null
  onFailureFuseNotice?: FailureFuseNoticeCallback
  onToolSuccess?: (input: { toolName: string; toolArgs: Record<string, unknown> }) => void
}

function buildHookContext(
  toolName: string,
  toolArgs: Record<string, unknown>,
  options: ToolHookMiddlewareOptions
): HookContext {
  return {
    toolName,
    toolArgs,
    workspacePath: options.workspacePath,
    sessionId: options.threadId,
    turnId: options.hookTurnId,
    agentId: getCurrentHookAgentId() ?? options.agentId,
    systemId: options.systemId,
    pluginWorkspace: options.pluginWorkspace,
    featureId: options.featureId,
    harnessProjectId: options.harnessProjectId,
    harnessAdapterId: options.harnessAdapterId,
    harnessAdapterName: options.harnessAdapterName,
    harnessAdapterVersion: options.harnessAdapterVersion,
    harnessNodeName: options.harnessNodeName,
    harnessNodeStatus: options.harnessNodeStatus,
    projectCode: options.projectCode,
    projectDir: options.projectDir,
    workspaceHookCwd: options.workspaceHookCwd,
    forceSyncWorkspaceHooks: options.forceSyncWorkspaceHooks
  }
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result
  if (ToolMessage.isInstance(result)) {
    if (typeof result.content === "string") return result.content
    if (Array.isArray(result.content)) {
      return result.content
        .map((item) => {
          if (typeof item === "string") return item
          if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
            return item.text
          }
          return JSON.stringify(item)
        })
        .join("")
    }
  }
  try {
    return JSON.stringify(result) ?? String(result)
  } catch {
    return String(result)
  }
}

function getFailureDetectionInput(result: unknown): unknown {
  if (typeof result === "string") return result
  if (ToolMessage.isInstance(result)) {
    const content = stringifyToolResult(result)
    return result.status === "error"
      ? {
          is_error: true,
          error: content || "tool returned error status"
        }
      : content
  }
  if (isCommand(result)) return stringifyToolResult(result)
  return result
}

function buildPostHookFeedback(postResult: HookResult | null): string | null {
  if (!postResult) return null
  const parts = [
    !postResult.suppressOutput && postResult.stdout
      ? `[Hook output]\n${postResult.stdout}`
      : undefined,
    postResult.additionalContext ? `[Hook context]\n${postResult.additionalContext}` : undefined,
    postResult.systemMessage ? `[Hook notice]\n${postResult.systemMessage}` : undefined,
    postResult.decision === "block" && postResult.reason
      ? `[Hook requested review] ${postResult.reason}`
      : undefined,
    postResult.continue === false
      ? `[Hook stopped turn] ${postResult.stopReason || postResult.reason || "PostToolUse hook stopped the turn"}`
      : undefined
  ].filter((item): item is string => Boolean(item))
  return parts.length > 0 ? parts.join("\n\n") : null
}

function mergeFailureFuseWarning(
  postResult: HookResult | null,
  decision: FailureFuseDecision | null
): HookResult | null {
  if (!shouldAttachFailureFuseFeedback(decision)) return postResult
  const warning = formatFailureFuseWarning(decision)
  if (!postResult) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      blocked: false,
      additionalContext: warning
    }
  }
  return {
    ...postResult,
    additionalContext: postResult.additionalContext
      ? `${postResult.additionalContext}\n\n${warning}`
      : warning
  }
}

function appendFeedbackToToolContent(content: unknown, feedback: string): unknown {
  if (typeof content === "string") return content ? `${content}\n\n${feedback}` : feedback
  if (Array.isArray(content)) {
    return [...content, { type: "text", text: feedback }]
  }
  if (content == null) return feedback
  return `${stringifyToolResult(content)}\n\n${feedback}`
}

function appendFeedbackToToolMessage(message: ToolMessage, feedback: string): ToolMessage {
  return new ToolMessage({
    content: appendFeedbackToToolContent(message.content, feedback) as ToolMessage["content"],
    tool_call_id: message.tool_call_id,
    name: message.name,
    status: message.status,
    artifact: message.artifact,
    metadata: {
      ...(message.metadata ?? {}),
      hookFeedback: feedback
    }
  })
}

function appendFeedbackToCommand(result: unknown, feedback: string, toolCallId?: string): unknown {
  if (!isCommand(result)) return result
  const command = result as Command<unknown, Record<string, unknown>, string>
  const update = command.update
  if (!update || typeof update !== "object" || Array.isArray(update)) return result
  const typedUpdate = update as Record<string, unknown>
  const messages = Array.isArray(typedUpdate.messages) ? typedUpdate.messages : []
  if (messages.length === 0) return result

  const nextMessages = [...messages]
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index]
    if (!ToolMessage.isInstance(message)) continue
    if (toolCallId && message.tool_call_id !== toolCallId) continue
    nextMessages[index] = appendFeedbackToToolMessage(message, feedback)
    const nextUpdate = { ...typedUpdate, messages: nextMessages }
    const commandArgs: Record<string, unknown> = { update: nextUpdate }
    if (command.graph !== undefined) commandArgs.graph = command.graph
    if (command.resume !== undefined) commandArgs.resume = command.resume
    if (command.goto !== undefined) commandArgs.goto = command.goto
    return new Command(commandArgs)
  }

  return result
}

function appendFeedbackToResult(result: unknown, feedback: string, toolCallId?: string): unknown {
  if (ToolMessage.isInstance(result)) {
    return appendFeedbackToToolMessage(result, feedback)
  }
  if (isCommand(result)) {
    return appendFeedbackToCommand(result, feedback, toolCallId)
  }
  if (typeof result === "string") {
    return result ? `${result}\n\n${feedback}` : feedback
  }
  return result
}

function buildBlockedToolResult(
  toolName: string,
  toolCallId: string | undefined,
  reason: string
): ToolMessage {
  return new ToolMessage({
    content: `[Hook blocked] ${reason}`,
    tool_call_id: toolCallId ?? toolName,
    name: toolName,
    status: "error"
  })
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {}
  return args as Record<string, unknown>
}

function mergeUpdatedInput(
  toolArgs: Record<string, unknown>,
  updatedInput?: Record<string, unknown>
): Record<string, unknown> {
  return mergeHookUpdatedInput(toolArgs, updatedInput)
}

export function createToolHookMiddleware(options: ToolHookMiddlewareOptions) {
  const skipToolNames = options.skipToolNames ?? new Set<string>()
  const loadingScopes: Array<{
    key: string
    authority: ModRuntimeAuthority | undefined
    loading: ModToolLoading
  }> = []
  const loadingFor = (authority: ModRuntimeAuthority | undefined, turnId: string, agentId: string) => {
    const key = JSON.stringify([options.workspacePath, options.threadId, turnId, agentId])
    let scope = loadingScopes.find(entry => entry.key === key && entry.authority === authority)
    if (!scope) {
      scope = { key, authority, loading: new ModToolLoading() }
      loadingScopes.push(scope)
      if (loadingScopes.length > 32) loadingScopes.shift()?.loading.clear()
    }
    return scope.loading
  }

  return createMiddleware({
    name: "toolHookMiddleware",
    wrapModelCall: async (request, handler) => {
      const manager = getModsManager()
      if (!manager?.isActive(options.workspacePath)) {
        for (const scope of loadingScopes) scope.loading.clear()
        return handler(request)
      }
      const execution = currentFunctionExecution()
      const runtimeAuthority = execution ? execution.runtimeAuthority : options.runtimeAuthority
      const turnId = execution?.turnId ?? options.hookTurnId ?? options.threadId
      const agentId =
        runtimeAuthority?.agentId ?? execution?.agentId ?? options.agentId ?? "main"
      const nativeTools = collectRuntimeToolCatalog(request.tools)
      manager.bindFunctionToolCatalog(
        {
          runtimeAuthority,
          workspace: options.workspacePath,
          threadId: options.threadId,
          turnId,
          agentId
        },
        nativeTools
      )
      const signal = (request as unknown as { runtime?: { signal?: AbortSignal } }).runtime?.signal
        ?? new AbortController().signal
      const loading = loadingFor(runtimeAuthority, turnId, agentId)
      const projection = await withFunctionExecution(
        {
          workspace: manager.workspaceKey(options.workspacePath), runtimeAuthority,
          threadId: options.threadId, agentId, userInitiated: false, turnId,
          leased: true, immediate: false
        },
        async () => {
          signal.throwIfAborted()
          const guard = manager.captureFunctionToolCatalogGuard(options.workspacePath, options.threadId)
          const registered = agentId === "main" || runtimeAuthority
            ? await manager.registeredFunctionTools(options.workspacePath, options.threadId) : []
          if (registered.some(tool => nativeTools.some(native => native.name === tool.name)))
            throw new Error("MODS_TOOL_NAME_COLLISION")
          const described: RegisteredFunctionTool[] = []
          for (const tool of registered) {
            const output = await manager.presentationEvent(options.workspacePath, options.threadId,
              "tool.describe", {
                tool: tool.name, description: tool.description,
                provider: { plugin: tool.plugin, tier: tool.tier ?? "user" },
                isDeferred: tool.isDeferred !== false
              }, signal)
            signal.throwIfAborted()
            guard()
            if (typeof output.description !== "string" ||
                (output.isDeferred !== undefined && typeof output.isDeferred !== "boolean"))
              throw Error("MODS_TOOL_DESCRIPTION_UNSUPPORTED")
            described.push({ ...tool, registrationId: tool.registrationId ?? JSON.stringify(tool),
              description: output.description,
              isDeferred: output.isDeferred === undefined ? tool.isDeferred !== false : output.isDeferred })
          }
          // A description hook may register/replace a tool. Never publish the stale schema.
          const current = agentId === "main" || runtimeAuthority
            ? await manager.registeredFunctionTools(options.workspacePath, options.threadId) : []
          signal.throwIfAborted()
          guard()
          if (JSON.stringify(current) !== JSON.stringify(registered))
            throw Error("MODS_TOOL_CATALOG_CHANGED")
          const assertLive = () => { signal.throwIfAborted(); guard() }
          const placement = loading.prepare(described, assertLive)
          if (loading.ownsSearch() && nativeTools.some(tool => tool.name === MODS_TOOL_SEARCH)) {
            loading.clear()
            throw new Error("MODS_TOOL_NAME_COLLISION")
          }
          return { ...placement, assertLive }
        }
      )
      const tools = [...request.tools, ...projection.tools]
      const blocks = [
        ...(await manager.context({
          runtimeAuthority,
          workspace: options.workspacePath,
          threadId: options.threadId,
          turnId,
          agentId,
          activePluginIds: options.hookScope.activePluginIds
        })),
        ...functionToolContexts(request.messages),
        ...(projection.context ? [projection.context] : [])
      ]
      projection.assertLive()
      return handler({
        ...request,
        tools,
        ...(blocks.length
          ? { systemMessage: request.systemMessage.concat("\n\n" + blocks.join("\n\n")) }
          : {})
      })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapToolCall: async (request: any, handler: any): Promise<any> => {
      const execution = currentFunctionExecution()
      const runtimeAuthority = execution ? execution.runtimeAuthority : options.runtimeAuthority
      const toolName = request.toolCall?.name
      const manager = getModsManager()
      const turnId = execution?.turnId ?? options.hookTurnId ?? options.threadId
      const agentId = runtimeAuthority?.agentId ?? execution?.agentId ?? options.agentId ?? "main"
      const loading = loadingFor(runtimeAuthority, turnId, agentId)
      const ownsSearch = toolName === MODS_TOOL_SEARCH && loading.ownsSearch()
      if (ownsSearch || (typeof toolName === "string" && toolName.startsWith("mcp__"))) {
        const signal = request.runtime?.signal as AbortSignal | undefined
        try {
          const searchResult = await withFunctionExecution({
            workspace: manager?.workspaceKey(options.workspacePath) ?? options.workspacePath,
            runtimeAuthority, threadId: options.threadId, agentId, userInitiated: false,
            turnId, leased: true, immediate: false
          }, async () => {
            signal?.throwIfAborted()
            const current = manager && (agentId === "main" || runtimeAuthority)
              ? await manager.registeredFunctionTools(options.workspacePath, options.threadId) : []
            if (ownsSearch) return loading.search(request.toolCall.args, current, signal)
            // Native MCP tools still follow their normal adapter path. Only registered Mods
            // definitions are subject to this model-publication check.
            if (loading.has(toolName) || current.some(tool => tool.name === toolName))
              loading.assertCallable(toolName, current, signal)
            return undefined
          })
          if (searchResult) return new ToolMessage({ name: toolName,
            tool_call_id: request.toolCall.id ?? "", status: "success",
            content: JSON.stringify(searchResult) })
        } catch (error) {
          signal?.throwIfAborted()
          return new ToolMessage({ name: toolName, tool_call_id: request.toolCall.id ?? "",
            status: "error", content: error instanceof Error ? error.message : "MODS_TOOL_NOT_LOADED" })
        }
      }
      return withModToolCall(
        {
          runtimeAuthority,
          workspace: options.workspacePath,
          threadId: options.threadId,
          turnId: execution?.turnId ?? options.hookTurnId ?? options.threadId,
          agentId: execution?.agentId ?? options.agentId,
          activePluginIds: options.hookScope.activePluginIds,
          signal: request.runtime?.signal
        },
        request,
        skipToolNames,
        async (request) => {
          const agentId =
            getHookAgentIdFromRequest(request) ?? execution?.agentId ?? options.agentId
          return runWithHookAgentId(agentId, async () => {
            const toolCall = request.toolCall as
              | { id?: string; name?: string; args?: unknown }
              | undefined
            const toolName = toolCall?.name
            if (!toolName || skipToolNames.has(toolName)) {
              return handler(request)
            }

            const baseToolArgs = normalizeToolArgs(toolCall.args)
            const hookContext = buildHookContext(toolName, baseToolArgs, options)
            hookContext.toolCallId = toolCall?.id
            hookContext.signal = request.runtime?.signal
            const preResult = await runHooksEnriched(
              options.resolveHooksForContext("PreToolUse", hookContext),
              "PreToolUse",
              hookContext,
              options.onHookResult
            )
            if (preResult) {
              options.hookScope.activatePersistentHooks(
                options.resolveHooksForContext("PreToolUse", hookContext)
              )
            }
            throwIfHookHalt("PreToolUse", preResult, `${toolName} was stopped by a PreToolUse hook`)

            if (preResult?.blocked || preResult?.decision === "block") {
              const reason =
                preResult.reason ||
                preResult.stopReason ||
                preResult.stdout ||
                preResult.stderr ||
                `${toolName} was blocked by a hook`
              return buildBlockedToolResult(toolName, toolCall?.id, reason)
            }

            const toolArgs = mergeUpdatedInput(baseToolArgs, preResult?.updatedInput)
            await authorizeCurrentModInput(`host:${toolName}`, toolArgs)
            const result = await publishCurrentModResult(
              await handler({
                ...request,
                toolCall: toolCall ? { ...toolCall, args: toolArgs } : toolCall,
                state:
                  request.state &&
                  typeof request.state === "object" &&
                  !Array.isArray(request.state)
                    ? { ...(request.state as Record<string, unknown>) }
                    : request.state
              })
            )

            const signal = detectToolFailure(toolName, getFailureDetectionInput(result))
            const alreadyRecordedThrowFailure = Boolean(
              signal && toolCall?.id && hasFailureFired(toolCall.id)
            )
            const failureFuseDecision =
              signal && !alreadyRecordedThrowFailure
                ? (options.onToolFailureDecision?.({
                    toolName,
                    toolCallId: toolCall?.id,
                    toolArgs,
                    signal
                  }) ?? null)
                : null
            if (shouldSendFailureFuseNotice(failureFuseDecision)) {
              options.onFailureFuseNotice?.(failureFuseDecision)
            }
            if (!signal) options.onToolSuccess?.({ toolName, toolArgs })

            const postContext: HookContext = {
              ...hookContext,
              toolArgs,
              toolResult: stringifyToolResult(result)
            }
            const postResult = await runHooksEnriched(
              options.resolveHooksForContext("PostToolUse", postContext),
              "PostToolUse",
              postContext,
              options.onHookResult
            )
            if (postResult) {
              options.hookScope.activatePersistentHooks(
                options.resolveHooksForContext("PostToolUse", postContext)
              )
            }
            throwIfHookHalt(
              "PostToolUse",
              postResult,
              `${toolName} was stopped by a PostToolUse hook`
            )
            if (failureFuseDecision) throwIfFailureFuseHalt(failureFuseDecision)

            const feedback = buildPostHookFeedback(
              mergeFailureFuseWarning(postResult, failureFuseDecision)
            )
            const presented = applyClassicToolOutput(result, postResult, { toolCallId: toolCall?.id })
            return feedback ? appendFeedbackToResult(presented, feedback, toolCall?.id) : presented
          })
        }
      )
    }
  })
}
