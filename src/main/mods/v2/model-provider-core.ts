import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import type { CmbModelSettings } from "../../models/model-factory"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  validateFunctionModelText,
  type FunctionModelReply,
  type FunctionModelRequest
} from "./model-sdk"

export async function invokeFunctionModelWith<Config extends CmbModelSettings>(
  config: Config,
  request: FunctionModelRequest,
  signal: AbortSignal,
  create: (config: Config) => import("@langchain/openai").ChatOpenAI
): Promise<FunctionModelReply> {
  signal.throwIfAborted()
  const model = create({ ...config, maxOutputTokens: request.maxTokens ?? 256 })
  const messages = [
    new SystemMessage(
      `You are CMBDevClaw, a coding assistant.${request.system ? `\n\n${request.system}` : ""}`
    ),
    new HumanMessage(request.prompt)
  ]
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
