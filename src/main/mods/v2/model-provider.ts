import { ModError } from "../errors"
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import type { ResolvedModelConfig } from "../../models/registry"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  validateFunctionModelText,
  assertFunctionModelEffort,
  FunctionModelProviderFailure,
  type FunctionModelReply,
  type FunctionModelRequest
} from "./model-sdk"
import type {
  FunctionModelForkReply,
  FunctionModelForkRequest,
  FunctionModelForkSnapshot
} from "./model-operations"

export async function resolveFunctionModel(name: string): Promise<ResolvedModelConfig> {
  const registry = await import("../../models/registry")
  // A miss must not silently route a plugin's data to a different model.
  const model =
    name === "default" ? registry.getDefaultModelConfig() : registry.getModelConfigByRef(name)
  if (!model?.apiKey) throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
  return model
}

/** The existing provider handles protocols; no history, tools or user credentials enter the VM. */
export async function invokeFunctionModel(
  config: ResolvedModelConfig,
  request: FunctionModelRequest,
  signal: AbortSignal
): Promise<FunctionModelReply> {
  const messages = functionModelMessages(request)
  return invokePreparedFunctionModel(config, request, messages, signal)
}

export function functionModelMessages(request: FunctionModelRequest): BaseMessage[] {
  return [
    new SystemMessage(
      `You are CMBDevClaw, a coding assistant.${request.system ? `\n\n${request.system}` : ""}`
    ),
    new HumanMessage(request.prompt)
  ]
}

export function invokePreparedFunctionModel(
  config: ResolvedModelConfig,
  request: FunctionModelRequest,
  messages: BaseMessage[],
  signal: AbortSignal
): Promise<FunctionModelReply> {
  return invokeFunctionMessages(
    config,
    messages,
    request.maxTokens ?? 256,
    signal,
    request.timeoutMs,
    request.effort
  )
}

async function invokeFunctionMessages(
  config: ResolvedModelConfig,
  messages: BaseMessage[],
  maxTokens: number,
  parentSignal: AbortSignal,
  timeoutMs?: number,
  effort?: FunctionModelRequest["effort"]
): Promise<FunctionModelReply> {
  const { getModelInstance } = await import("../../agent/runtime")
  parentSignal.throwIfAborted()
  // Reuse the existing explicit host transport. Never silently discard a requested level.
  assertFunctionModelEffort(config.model, effort)
  const model = getModelInstance(
    {
      ...config,
      maxOutputTokens: maxTokens,
      ...(effort === undefined
        ? { enableThinkingEffort: false }
        : {
            enableThinking: true,
            enableThinkingEffort: true,
            thinkingEffort: effort as "low" | "high" | "max"
          })
    },
    undefined,
    1,
    "function-completion"
  )
  // A nested completion must not inherit the agent's stream callbacks, graph writer or trace
  // configuration. Keep the entire iterator in this scope, not just stream construction.
  // This only replaces LangChain's context; our grant/turn/call AsyncLocalStorage stays intact.
  const timeout = new AbortController()
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => timeout.abort(), Math.min(timeoutMs, 60000))
  const signal = AbortSignal.any([parentSignal, timeout.signal])
  try {
    return await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
      AsyncLocalStorageProviderSingleton.runWithConfig(
        { callbacks: [], tags: [], metadata: {} },
        async () => {
          let text = ""
          let inputTokens: number | undefined
          let outputTokens: number | undefined
          let cacheReadInputTokens: number | undefined
          let cacheCreationInputTokens: number | undefined
          // Stop an unbounded provider before assembling its full reply, even if it ignores max_tokens.
          for await (const chunk of await model.stream(messages, { signal, callbacks: [] })) {
            signal.throwIfAborted()
            if (chunk.tool_calls?.length || chunk.tool_call_chunks?.length)
              throw new ModFunctionError("MODS_MODEL_UNEXPECTED_TOOL")
            if (typeof chunk.content === "string") text += chunk.content
            else
              for (const block of chunk.content)
                if (block.type === "text" && typeof block.text === "string") text += block.text
            validateFunctionModelText(text)
            if (chunk.usage_metadata) {
              inputTokens = chunk.usage_metadata.input_tokens
              outputTokens = chunk.usage_metadata.output_tokens
              cacheReadInputTokens = chunk.usage_metadata.input_token_details?.cache_read
              cacheCreationInputTokens = chunk.usage_metadata.input_token_details?.cache_creation
            }
          }
          signal.throwIfAborted()
          const known = (value: number | undefined) =>
            value === undefined || (Number.isSafeInteger(value) && value >= 0)
          if (
            ![inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens].every(
              known
            )
          )
            throw new ModFunctionError("MODS_MODEL_USAGE_INVALID")
          const cached = (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0)
          if (inputTokens !== undefined && cached > inputTokens)
            throw new ModFunctionError("MODS_MODEL_USAGE_INVALID")
          return {
            text,
            inputTokens,
            outputTokens,
            ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
            ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
            ...(cached && inputTokens !== undefined
              ? { uncachedInputTokens: inputTokens - cached }
              : {})
          }
        }
      )
    )
  } catch (error) {
    if (parentSignal.aborted) throw error
    if (timeout.signal.aborted) throw new FunctionModelProviderFailure({ reason: "aborted" })
    if (error instanceof ModFunctionError || error instanceof ModError) throw error
    const rawStatus =
      error && typeof error === "object" && "status" in error ? error.status : undefined
    const status =
      typeof rawStatus === "number" &&
      Number.isSafeInteger(rawStatus) &&
      rawStatus >= 100 &&
      rawStatus <= 599
        ? rawStatus
        : null
    throw new FunctionModelProviderFailure({
      reason: "api-error",
      status,
      error:
        status === 429
          ? "rate_limit"
          : status === 529
            ? "overloaded"
            : status === 401 || status === 403
              ? "authentication_failed"
              : status !== null && status >= 500
                ? "server_error"
                : status !== null && status >= 400
                  ? "invalid_request"
                  : "unknown"
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run a fork against a host-created, text-only session snapshot. Roles remain separate provider
 * messages and no tool definitions enter the nested model request.
 */
export async function invokeFunctionFork(
  config: ResolvedModelConfig,
  request: FunctionModelForkRequest,
  snapshot: FunctionModelForkSnapshot,
  signal: AbortSignal
): Promise<FunctionModelForkReply> {
  const messages = functionForkMessages(request, snapshot)
  const result = await invokeFunctionMessages(config, messages, request.maxTokens ?? 256, signal)
  return {
    text: result.text,
    accounting: result,
    ...(result.inputTokens === undefined && result.outputTokens === undefined
      ? {}
      : { usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens } })
  }
}

export function functionForkMessages(
  request: FunctionModelForkRequest,
  snapshot: FunctionModelForkSnapshot
): BaseMessage[] {
  if (!snapshot.messages.length && !snapshot.system)
    throw new ModFunctionError("MODS_MODEL_UNAVAILABLE")
  const messages: BaseMessage[] = []
  if (snapshot.system) messages.push(new SystemMessage(snapshot.system))
  for (const message of snapshot.messages) {
    if (message.text.length > 32000) throw new ModFunctionError("MODS_MODEL_ARGUMENTS")
    if (message.role === "system") messages.push(new SystemMessage(message.text))
    else if (message.role === "assistant") messages.push(new AIMessage(message.text))
    else messages.push(new HumanMessage(message.text))
  }
  messages.push(new HumanMessage(request.prompt))
  return messages
}
