import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import type { ResolvedModelConfig } from "../../models/registry"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  validateFunctionModelText,
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
  const messages = [
    new SystemMessage(
      `You are CMBDevClaw, a coding assistant.${request.system ? `\n\n${request.system}` : ""}`
    ),
    new HumanMessage(request.prompt)
  ]
  return invokeFunctionMessages(config, messages, request.maxTokens ?? 256, signal)
}

async function invokeFunctionMessages(
  config: ResolvedModelConfig,
  messages: BaseMessage[],
  maxTokens: number,
  signal: AbortSignal
): Promise<FunctionModelReply> {
  const { getModelInstance } = await import("../../agent/runtime")
  signal.throwIfAborted()
  const model = getModelInstance(
    { ...config, maxOutputTokens: maxTokens },
    undefined,
    1,
    "function-completion"
  )
  // A nested completion must not inherit the agent's stream callbacks, graph writer or trace
  // configuration. Keep the entire iterator in this scope, not just stream construction.
  // This only replaces LangChain's context; our grant/turn/call AsyncLocalStorage stays intact.
  return AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
    AsyncLocalStorageProviderSingleton.runWithConfig(
      { callbacks: [], tags: [], metadata: {} },
      async () => {
        let text = ""
        let inputTokens: number | undefined
        let outputTokens: number | undefined
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
          }
        }
        signal.throwIfAborted()
        return { text, inputTokens, outputTokens }
      }
    )
  )
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
  const result = await invokeFunctionMessages(config, messages, request.maxTokens ?? 256, signal)
  return {
    text: result.text,
    ...(result.inputTokens === undefined && result.outputTokens === undefined
      ? {}
      : { usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens } })
  }
}
