/** Shared Cmb model factory, extracted from agent/runtime.ts. No Electron or configuration-store dependency. */
import { ChatOpenAI, ChatOpenAICompletions } from "@langchain/openai"
import {
  DeepSeekChatOpenAICompletions,
  InterleavedThinkingChatOpenAICompletions,
  ReasoningDisplayChatOpenAICompletions,
  ToolCallAwareChatOpenAICompletions
} from "../agent/interleaved-thinking-completions"
import { samplingFields, topKModelKwargs } from "./sampling-params"
import { withModelResponseDiagnostics } from "../agent/model-response-diagnostics"
import { withModelStreamCancellation } from "../agent/model-stream-cancellation"
import { safeSensitiveErrorText } from "../error-text"
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  DEFAULT_TOP_K,
  DEFAULT_THINKING_EFFORT
} from "./defaults"
const CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS = 20_000
export type ModelInstancePurpose =
  | "agent"
  | "context-compaction"
  | "function-completion"
  | "evidence-review"
  | "operation-review"
export interface CmbModelInvocationObserver {
  run<T>(execute: () => Promise<T>): Promise<T>
  stream<T>(execute: () => AsyncGenerator<T>): AsyncGenerator<T>
}

function observeCompletions<T extends ChatOpenAICompletions>(
  completions: T,
  observer?: CmbModelInvocationObserver
): T {
  if (!observer) return completions
  const generate = completions._generate.bind(completions)
  const stream = completions._streamResponseChunks.bind(completions)
  completions._generate = (...args) => observer.run(() => generate(...args))
  completions._streamResponseChunks = (...args) => observer.stream(() => stream(...args))
  return completions
}

function observeModel(model: ChatOpenAI, observer?: CmbModelInvocationObserver): ChatOpenAI {
  if (!observer) return model
  const invoke = model.invoke.bind(model)
  const generate = model._generate.bind(model)
  const stream = model._streamIterator.bind(model)
  const configure = model.withConfig.bind(model)
  model.invoke = (...args) => observer.run(() => invoke(...args))
  model._generate = (...args) => observer.run(() => generate(...args))
  // Includes LangChain's aggregation/empty-output errors, which occur after
  // the completions iterator ends, and the SDK's responses API routing.
  model._streamIterator = (...args) => observer.stream(() => stream(...args))
  model.withConfig = (config) => {
    const configured = configure(config)
    return configured instanceof ChatOpenAI ? observeModel(configured, observer) : configured
  }
  return model
}

function localCompactionTokenCount(content: unknown): number {
  let text: string
  if (typeof content === "string") {
    text = content
  } else {
    try {
      text = JSON.stringify(content) ?? ""
    } catch {
      text = String(content ?? "")
    }
  }
  return Math.ceil(text.length / 4)
}

function configureLocalCompactionTokenEstimation(model: ChatOpenAI): ChatOpenAI {
  const completions = (
    model as unknown as {
      completions?: { getNumTokens: (content: unknown) => Promise<number> }
    }
  ).completions
  if (!completions) return model

  // LangChain's streaming invoke() estimates usage after the SSE completes and
  // otherwise downloads a Tiktoken vocabulary. Compaction does not consume
  // that estimate, so keep this bookkeeping local, deterministic, and offline.
  completions.getNumTokens = async (content: unknown): Promise<number> =>
    localCompactionTokenCount(content)
  return model
}

/** @internal Exported for protocol-level tests. */
export type CmbModelSettings = {
  id: string
  model: string
  baseUrl: string
  apiKey?: string
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  interleavedThinking?: boolean
  enableThinking?: boolean
  enableThinkingEffort?: boolean
  thinkingEffort?: "low" | "high" | "max"
}

export function createConfiguredCmbModel(
  customConfig: CmbModelSettings,
  options: {
    fetch: typeof fetch
    purpose?: ModelInstancePurpose
    observeInvocation?: CmbModelInvocationObserver
    /** Keep explicit provider refusal facts for isolated diagnostics. Does not
     * enable thinking or change the default helper/agent adapter selection. */
    preserveProviderRefusal?: boolean
    /** Override the normal agent default only for a protocol that has a
     * single semantic tool invocation. */
    parallelToolCalls?: boolean
    /** MiniMax M3 otherwise places reasoning in content for tool calls. Keep
     * the provider field opt-in and exact-model scoped: other MiniMax releases
     * and OpenAI-compatible endpoints do not share this contract. */
    splitMiniMaxM3Reasoning?: boolean
  }
): ChatOpenAI {
  const purpose = options.purpose ?? "agent"
  const apiKey = customConfig.apiKey
  if (!apiKey) {
    throw new Error("Custom API key not configured")
  }

  const resolvedModel = customConfig.model
  if (!resolvedModel.trim()) {
    throw new Error("Custom model name is empty. Please configure a valid model name in Settings.")
  }
  console.log(
    "[Runtime] Custom model:",
    safeSensitiveErrorText(resolvedModel, 256, [apiKey]),
    "baseUrl:",
    safeSensitiveErrorText(customConfig.baseUrl, 512, [apiKey])
  )
  const configuredMaxOutputTokens = customConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const maxOutputTokens =
    purpose === "context-compaction"
      ? Math.min(configuredMaxOutputTokens, CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS)
      : configuredMaxOutputTokens
  const temperature = customConfig.temperature ?? DEFAULT_TEMPERATURE
  const topP = customConfig.topP ?? DEFAULT_TOP_P
  const topK = customConfig.topK ?? DEFAULT_TOP_K
  const thinkingEffort = customConfig.thinkingEffort ?? DEFAULT_THINKING_EFFORT
  const thinkingConfigured = customConfig.enableThinking === true
  const isDeepSeek = /deepseek/i.test(resolvedModel)
  // Compaction and formatting helpers need a final-text handoff. Source and
  // operation reviews perform substantive reasoning using the task's model
  // behavior; their callers bound time/output and discard private reasoning.
  // Review instances expose only inert conclusions, not executable agent tools.
  const reasoningPurpose =
    purpose === "agent" || purpose === "evidence-review" || purpose === "operation-review"
  const enableThinking = reasoningPurpose && thinkingConfigured
  // MiniMax M3's OpenAI API defaults to thinking when this field is absent;
  // chat_template_kwargs alone does not disable it. M2 and M3.1 have different
  // contracts, so only the documented M3 text helper gets this explicit switch.
  const isExactMiniMaxM3 = /(?:^|\/)minimax-m3$/i.test(resolvedModel.trim())
  const disableMiniMaxM3Thinking = !reasoningPurpose && isExactMiniMaxM3
  const enableThinkingEffort = enableThinking && customConfig.enableThinkingEffort === true
  const modelFetch = options.fetch

  const baseFields = {
    model: resolvedModel,
    apiKey,
    // Text-only helpers use separate SSE instances and never change the agent protocol.
    ...(purpose !== "agent" ? { streaming: true } : {}),
    maxTokens: maxOutputTokens,
    ...samplingFields(resolvedModel, { temperature, topP }),
    // SDK-level retry AND timeout disabled — unified retry + per-attempt
    // timeout live in retryingFetch below. Setting SDK timeout here would
    // create a shared AbortSignal that, once fired, permanently blocks all
    // subsequent retry attempts at the fetch layer.
    maxRetries: 0,
    modelKwargs: {
      parallel_tool_calls: options.parallelToolCalls ?? true,
      ...topKModelKwargs(resolvedModel, topK),
      chat_template_kwargs: {
        enable_thinking: enableThinking,
        ...(enableThinkingEffort ? { reasoning_effort: thinkingEffort } : {})
      },
      ...(isDeepSeek
        ? {
            thinking: { type: enableThinking ? "enabled" : "disabled" },
            ...(enableThinkingEffort ? { reasoning_effort: thinkingEffort } : {})
          }
        : {
            ...(enableThinking
              ? { thinking: { type: "enabled" } }
              : disableMiniMaxM3Thinking
                ? { thinking: { type: "disabled" } }
                : {}),
            ...(options.splitMiniMaxM3Reasoning && isExactMiniMaxM3
              ? { reasoning_split: true }
              : {})
          })
    },
    configuration: {
      baseURL: customConfig.baseUrl,
      fetch: withModelResponseDiagnostics(
        withModelStreamCancellation(modelFetch),
        { model: resolvedModel, purpose, knownSecrets: [apiKey] },
        (diagnostic) => console.log("[Runtime][ModelResponse]", JSON.stringify(diagnostic))
      )
    }
  }

  let model: ChatOpenAI
  if (enableThinking && isDeepSeek) {
    model = new ChatOpenAI({
      ...baseFields,
      completions: observeCompletions(
        new DeepSeekChatOpenAICompletions(baseFields),
        options.observeInvocation
      )
    } as never)
  } else if (enableThinking && /minimax/i.test(resolvedModel) && customConfig.interleavedThinking) {
    model = new ChatOpenAI({
      ...baseFields,
      completions: observeCompletions(
        new InterleavedThinkingChatOpenAICompletions(baseFields, {
          exposeReasoning: enableThinking
        }),
        options.observeInvocation
      )
    } as never)
  } else if (enableThinking) {
    model = new ChatOpenAI({
      ...baseFields,
      completions: observeCompletions(
        new ReasoningDisplayChatOpenAICompletions(baseFields),
        options.observeInvocation
      )
    } as never)
  } else if (purpose !== "agent") {
    // ChatOpenAI.withConfig() rebuilds the wrapper from its original fields.
    // Keep text-only completions explicit so the local token counter below
    // survives the tags/callback binding applied by configureContextCompactionModel().
    model = new ChatOpenAI({
      ...baseFields,
      completions: observeCompletions(
        options.preserveProviderRefusal
          ? new ToolCallAwareChatOpenAICompletions(baseFields)
          : new ChatOpenAICompletions(baseFields),
        options.observeInvocation
      )
    } as never)
  } else {
    model = new ChatOpenAI({
      ...baseFields,
      completions: observeCompletions(
        new ToolCallAwareChatOpenAICompletions(baseFields),
        options.observeInvocation
      )
    } as never)
  }

  return observeModel(
    purpose !== "agent" ? configureLocalCompactionTokenEstimation(model) : model,
    options.observeInvocation
  )
}
