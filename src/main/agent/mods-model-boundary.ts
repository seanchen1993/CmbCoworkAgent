import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import { countTokensApproximately } from "langchain"
import type { ModJson, ModObject } from "../../shared/mods/types"
import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import type { ModHookStream, FunctionStreamOptions } from "../mods/v2/stream-dispatcher"

/** The small host surface needed by the model boundary.  Keeping this structural
 * avoids making the LangChain wrapper depend on the concrete Mods manager. */
export interface FunctionModelStreamHost {
  functionModelStream(
    authority: ModRuntimeAuthority,
    input: ModObject,
    core: FunctionStreamOptions["core"],
    signal: AbortSignal
  ): Promise<ModHookStream>
}

interface BoundaryInput {
  turnId: string
  model: string
  effort?: string | number
  agentId?: string
}

export interface FunctionStepModelSelection {
  model: string
  effort?: string | number
}

export interface FunctionStepModel {
  provider: BaseChatModel
  model: string
  effort?: "low" | "high" | "max"
  contextWindow: number
  inputBudget: number
}

/** Only the host resolves credentials, provider adapters, budgets and session metadata. */
export interface FunctionStepModelHost {
  resolve(selection: FunctionStepModelSelection, signal: AbortSignal): Promise<FunctionStepModel>
  activate?(selection: FunctionStepModel): () => void
}

type BoundTools = {
  tools: Parameters<NonNullable<BaseChatModel["bindTools"]>>[0]
  kwargs?: Parameters<NonNullable<BaseChatModel["bindTools"]>>[1]
}

const MAX_MODEL_FRAMES = 512

interface BoundaryFrame extends ModObject {
  ref: string
  kind: "text" | "tool"
  index: number
  text: string
}

function isFrame(value: ModJson): value is BoundaryFrame {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.ref === "string" &&
    typeof value.kind === "string" &&
    (value.kind === "text" || value.kind === "tool") &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    typeof value.text === "string"
  )
}

function frameFor(ref: string, index: number, chunk: ChatGenerationChunk): BoundaryFrame {
  const message = chunk.message as AIMessageChunk | undefined
  const tool = message?.tool_call_chunks?.length || message?.tool_calls?.length
  return {
    ref,
    kind: tool ? "tool" : "text",
    index,
    text: chunk.text
  }
}

function withText(chunk: ChatGenerationChunk, text: string): ChatGenerationChunk {
  if (chunk.text === text) return chunk
  const source = chunk.message as AIMessageChunk
  const message = new AIMessageChunk({
    content: text,
    additional_kwargs: source?.additional_kwargs,
    response_metadata: source?.response_metadata,
    tool_call_chunks: source?.tool_call_chunks,
    id: source?.id,
    usage_metadata: source?.usage_metadata
  })
  return new ChatGenerationChunk({
    text,
    message,
    generationInfo: chunk.generationInfo
  })
}

/**
 * Adapt the actual graph model at the only safe boundary: raw provider chunks
 * are kept in a host-side table and hooks receive only an opaque reference plus
 * text.  A hook can change text, but cannot manufacture usage, tool metadata,
 * provider ids, or callbacks.  Callbacks are emitted only after this stream has
 * returned from the host bridge.
 */
export function createModModelBoundary(
  delegate: BaseChatModel,
  manager: FunctionModelStreamHost | undefined,
  authority: ModRuntimeAuthority | undefined,
  input: BoundaryInput,
  stepModel?: FunctionStepModelHost
): BaseChatModel {
  if (!manager || !authority) return delegate
  return new ModAwareChatModel(delegate, manager, authority, input, { value: 0 }, stepModel)
}

class ModAwareChatModel extends BaseChatModel {
  constructor(
    private readonly delegate: BaseChatModel,
    private readonly manager: FunctionModelStreamHost,
    private readonly authority: ModRuntimeAuthority,
    private readonly boundaryInput: BoundaryInput,
    private readonly stepCounter: { value: number } = { value: 0 },
    private readonly stepModel?: FunctionStepModelHost,
    private readonly boundTools?: BoundTools
  ) {
    super({})
  }

  _llmType(): string {
    return "cmb-mod-aware-model"
  }

  // LangChain binds the graph's tools immediately before invoking the model.
  // Preserve the provider's bound instance and wrap it again so tool schemas
  // and provider-specific options remain host-owned.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bindTools(tools: any[], kwargs?: any): this {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bound = (this.delegate as any).bindTools(tools, kwargs) as BaseChatModel
    return new ModAwareChatModel(
      bound,
      this.manager,
      this.authority,
      this.boundaryInput,
      this.stepCounter,
      this.stepModel,
      { tools: [...tools], kwargs }
    ) as this
  }

  private async *streamThroughBoundary(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const refs = new Map<string, ChatGenerationChunk>()
    const refIndexes = new Map<string, number>()
    const consumedRefs = new Set<string>()
    let lastOutputIndex = -1
    let sequence = 0
    const signal = options.signal ?? new AbortController().signal
    const assertActive = (): void => {
      signal.throwIfAborted()
      this.authority.assertLive()
    }
    assertActive()
    const input: ModObject = {
      turnId: this.boundaryInput.turnId,
      index: this.stepCounter.value++,
      model: this.boundaryInput.model,
      messageCount: messages.length,
      ...(this.boundaryInput.effort !== undefined ? { effort: this.boundaryInput.effort } : {}),
      ...(this.boundaryInput.agentId ? { agentId: this.boundaryInput.agentId } : {})
    }
    const delegate = this.delegate
    const authority = this.authority
    const stepModel = this.stepModel
    const boundTools = this.boundTools
    let activeRequest = false
    const runProvider = <T>(operation: () => Promise<T>): Promise<T> =>
      AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
        AsyncLocalStorageProviderSingleton.runWithConfig(
          { callbacks: [], tags: [], metadata: {} },
          operation
        )
      )
    const core: FunctionStreamOptions["core"] = async function* (received, context) {
      assertActive()
      context.signal.throwIfAborted()
      if (activeRequest) throw new Error("MODS_MODEL_REQUEST_CONCURRENT")
      if (
        !stepModel &&
        (received.model !== input.model ||
          (received.effort ?? undefined) !== (input.effort ?? undefined))
      )
        throw new Error("MODS_MODEL_SELECTION_UNSUPPORTED")
      activeRequest = true
      let release: (() => void) | undefined
      let raw: Awaited<ReturnType<BaseChatModel["stream"]>> | undefined
      try {
        let provider = delegate
        if (stepModel) {
          if (typeof received.model !== "string" || !received.model.trim())
            throw new Error("MODS_MODEL_NOT_CONFIGURED")
          if (
            received.effort !== undefined &&
            typeof received.effort !== "string" &&
            typeof received.effort !== "number"
          )
            throw new Error("MODS_MODEL_EFFORT_UNSUPPORTED")
          const selection = await stepModel.resolve(
            {
              model: received.model,
              ...(received.effort !== undefined ? { effort: received.effort } : {})
            },
            context.signal
          )
          assertActive()
          context.signal.throwIfAborted()
          // This is the host's existing local estimator, including system messages
          // and current tools. It prevents a known overflow, not a tokenizer guarantee.
          const inputTokens = countTokensApproximately(messages, boundTools?.tools)
          if (
            !Number.isFinite(inputTokens) ||
            !Number.isFinite(selection.inputBudget) ||
            selection.inputBudget <= 0 ||
            inputTokens > selection.inputBudget
          )
            throw new Error("MODS_MODEL_INPUT_BUDGET")
          provider = selection.provider
          if (boundTools) {
            if (!provider.bindTools) throw new Error("MODS_MODEL_TOOLS_UNSUPPORTED")
            provider = provider.bindTools(boundTools.tools, boundTools.kwargs) as BaseChatModel
          }
          release = stepModel.activate?.(selection)
          assertActive()
          context.signal.throwIfAborted()
        }
        // Do not pass the graph callback manager to the raw provider.  It is
        // deliberately reattached below only after a transformed chunk returns.
        // Use the public stream API with an empty callback list.  Calling the
        // protected provider method directly is not stable across LangChain
        // releases (and some providers do not expose it at runtime).
        raw = await runProvider(() =>
          provider.stream(messages, {
            ...options,
            callbacks: [],
            signal: context.signal
          })
        )
        while (true) {
          assertActive()
          context.signal.throwIfAborted()
          const item = await runProvider(() => raw!.next())
          if (item.done) break
          assertActive()
          // Limit unconsumed host references, not the length of an ordinary streamed reply.
          if (refs.size >= MAX_MODEL_FRAMES) throw new Error("MODS_MODEL_STREAM_LIMIT")
          const ref = `${authority.turnId}:${sequence++}`
          const message = item.value
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter(
                    (part): part is { type: "text"; text: string } =>
                      !!part &&
                      typeof part === "object" &&
                      part.type === "text" &&
                      typeof part.text === "string"
                  )
                  .map((part) => part.text)
                  .join("")
          const chunk = new ChatGenerationChunk({ text, message })
          refs.set(ref, chunk)
          refIndexes.set(ref, sequence - 1)
          yield frameFor(ref, sequence - 1, chunk)
        }
      } finally {
        try {
          if (raw)
            await runProvider(() => raw!.return?.().then(() => undefined) ?? Promise.resolve())
        } finally {
          activeRequest = false
          // An expired authority cannot republish into its replacement session.
          try {
            authority.assertLive()
          } catch {
            release = undefined
          }
          release?.()
        }
      }
      return { kind: "complete", count: sequence }
    }
    assertActive()
    const stream = await this.manager.functionModelStream(this.authority, input, core, signal)
    for await (const value of stream) {
      assertActive()
      if (!isFrame(value)) throw new Error("MODS_MODEL_FRAME")
      if (consumedRefs.has(value.ref)) throw new Error("MODS_MODEL_REF_REPLAY")
      const source = refs.get(value.ref)
      if (!source) throw new Error("MODS_MODEL_OPAQUE_REF")
      const originalIndex = refIndexes.get(value.ref)
      if (originalIndex === undefined) throw new Error("MODS_MODEL_OPAQUE_REF")
      const original = frameFor(value.ref, originalIndex, source)
      if (value.kind !== original.kind || value.index !== original.index)
        throw new Error("MODS_MODEL_FRAME_METADATA")
      if (value.index < lastOutputIndex) throw new Error("MODS_MODEL_FRAME_ORDER")
      const chunk = withText(source, value.text)
      consumedRefs.add(value.ref)
      refs.delete(value.ref)
      refIndexes.delete(value.ref)
      lastOutputIndex = value.index
      await runManager?.handleLLMNewToken(chunk.text)
      yield chunk
    }
    assertActive()
    await stream.result
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* this.streamThroughBoundary(messages, options, runManager)
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    let combined: ChatGenerationChunk | undefined
    for await (const chunk of this.streamThroughBoundary(messages, options, runManager))
      combined = combined ? combined.concat(chunk) : chunk
    if (!combined) throw new Error("MODS_MODEL_EMPTY")
    return { generations: [combined] }
  }
}
