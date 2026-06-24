import { ToolMessage } from "@langchain/core/messages"
import { Command, isCommand } from "@langchain/langgraph"
import { createMiddleware } from "langchain"
import type { HookContext, HookResultCallback } from "../hooks/runner"
import { runHooksEnriched } from "../hooks/required-skill"
import { throwIfHookHalt } from "../hooks/halt"
import { mergeUpdatedInput as mergeHookUpdatedInput } from "../hooks/updated-input"
import type { HookConfig, HookEvent, HookResult } from "../hooks/types"
import type { HookScopeController } from "../hooks/scope"

export interface ToolHookMiddlewareOptions {
  workspacePath: string
  threadId: string
  hookScope: HookScopeController
  resolveHooksForContext: (event: HookEvent, context: HookContext) => HookConfig[]
  onHookResult?: HookResultCallback
  hookTurnId?: string
  systemId?: string
  pluginWorkspace?: string
  featureId?: string
  harnessProjectId?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  projectCode?: string
  projectDir?: string
  skipToolNames?: ReadonlySet<string>
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
    systemId: options.systemId,
    pluginWorkspace: options.pluginWorkspace,
    featureId: options.featureId,
    harnessProjectId: options.harnessProjectId,
    harnessAdapterName: options.harnessAdapterName,
    harnessAdapterVersion: options.harnessAdapterVersion,
    projectCode: options.projectCode,
    projectDir: options.projectDir
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

function appendFeedbackToCommand(
  result: unknown,
  feedback: string,
  toolCallId?: string
): unknown {
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

function appendFeedbackToResult(
  result: unknown,
  feedback: string,
  toolCallId?: string
): unknown {
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

  return createMiddleware({
    name: "toolHookMiddleware",
    wrapToolCall: async (request: any, handler: any): Promise<any> => {
      const toolCall = request.toolCall as
        | { id?: string; name?: string; args?: unknown }
        | undefined
      const toolName = toolCall?.name
      if (!toolName || skipToolNames.has(toolName)) {
        return handler(request)
      }

      const baseToolArgs = normalizeToolArgs(toolCall.args)
      const hookContext = buildHookContext(toolName, baseToolArgs, options)
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
      const result = await handler({
        ...request,
        toolCall: toolCall ? ({ ...toolCall, args: toolArgs } as any) : toolCall,
        state:
          request.state && typeof request.state === "object" && !Array.isArray(request.state)
            ? ({ ...(request.state as Record<string, unknown>) } as any)
            : request.state
      } as any)

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
      throwIfHookHalt("PostToolUse", postResult, `${toolName} was stopped by a PostToolUse hook`)

      const feedback = buildPostHookFeedback(postResult)
      return feedback ? appendFeedbackToResult(result, feedback, toolCall?.id) : result
    }
  })
}
