import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { dispatchFunctionStream } from "./stream-dispatcher"

/** B1 feasibility probe, not the production multi-provider/tool-call model adapter. */
class BoundaryProbeModel extends BaseChatModel {
  constructor(
    private readonly provider: FakeStreamingChatModel,
    private readonly guest: FunctionGuestRuntime
  ) {
    super({})
  }

  _llmType(): string {
    return "mods-boundary-probe"
  }
  bindTools(): this {
    return this
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const provider = this.provider
    const stream = dispatchFunctionStream(
      [{ guest: this.guest, name: "boundary", root: "/probe", tier: "user", capabilities: [] }],
      {
        turnId: "probe-turn",
        index: 0,
        model: "fixture",
        messageCount: messages.length
      },
      {
        signal: options.signal,
        async *core() {
          let answer = ""
          // The raw delegate gets no callbacks. Only the approved chunks below can publish.
          for await (const chunk of provider._streamResponseChunks(messages, options, undefined)) {
            answer += chunk.text
            yield { kind: "text", index: 0, text: chunk.text }
          }
          return { answer }
        }
      }
    )
    for await (const value of stream) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.text !== "string"
      )
        throw Error("invalid probe chunk")
      const chunk = new ChatGenerationChunk({
        text: value.text,
        message: new AIMessageChunk({ content: value.text })
      })
      await runManager?.handleLLMNewToken(value.text)
      yield chunk
    }
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    let combined: ChatGenerationChunk | undefined
    for await (const chunk of this._streamResponseChunks(messages, options, runManager))
      combined = combined ? combined.concat(chunk) : chunk
    if (!combined) throw Error("empty probe response")
    return { generations: [combined] }
  }
}

it("the real agent graph records and publishes the transformed stream before any callback", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){for await(const chunk of next(e))yield {...chunk,text:chunk.text.replace("RAW_MARKER","SAFE")}})
  }}`)
  try {
    const raw = new FakeStreamingChatModel({
      chunks: [new AIMessageChunk({ content: "RAW_MARKER" })]
    })
    const model = new BoundaryProbeModel(raw, guest)
    const agent = createAgent({ model, tools: [], checkpointer: new MemorySaver() })
    const tokens: string[] = []
    const ends: string[] = []
    const config = {
      configurable: { thread_id: "mods-boundary" },
      callbacks: [
        {
          name: "mods-boundary-observer",
          handleLLMNewToken(token: string) {
            tokens.push(token)
          },
          handleLLMEnd(output: unknown) {
            ends.push(JSON.stringify(output))
          }
        }
      ]
    }
    const visible: unknown[] = []
    const stream = await agent.stream(
      { messages: [new HumanMessage("probe")] },
      { ...config, streamMode: ["messages", "values"] }
    )
    for await (const chunk of stream) visible.push(chunk)
    const saved: { values: unknown } = await agent.getState(config)
    expect(tokens.join("")).toBe("SAFE")
    expect(JSON.stringify(visible)).toContain("SAFE")
    expect(JSON.stringify(visible)).not.toContain("RAW_MARKER")
    expect(JSON.stringify(saved.values)).not.toContain("RAW_MARKER")
    expect(JSON.stringify(saved.values)).toContain("SAFE")
    expect(ends.join("")).not.toContain("RAW_MARKER")
  } finally {
    guest.dispose()
  }
})
