import type { Message } from "../types"
import { flushStrict, upsertThreadMessages } from "../db"
import { StreamConverter, type SchedulerEvent } from "./stream-converter"
import type { TraceCollector } from "./trace/collector"
import { TurnAttributionRecorder } from "./turn-attribution"

export type StandardTurnStreamSink = (event: SchedulerEvent) => void

function transcriptMessage(
  message: Extract<SchedulerEvent, { type: "full-messages" }>["messages"][number]
): Message | null {
  // The visible user turn is persisted independently with its stable transport
  // id. Internal revision prompts stay checkpoint-only and must not become user
  // bubbles in the desktop transcript.
  if (message.role === "user" || message.role === "system") return null
  if (!message.id.trim()) return null
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.tool_calls?.length
      ? { tool_calls: message.tool_calls as Message["tool_calls"] }
      : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
    created_at: new Date()
  }
}

export function persistStandardTurnUserMessage(input: {
  threadId: string
  messageId: string
  content: string
}): void {
  const count = upsertThreadMessages(input.threadId, [
    {
      id: input.messageId,
      role: "user",
      content: input.content,
      created_at: new Date()
    }
  ])
  if (count !== 1) throw new Error("Failed to persist the remote user transcript message")
}

export interface StandardTurnStreamOptions {
  /** Anchors skill attribution to this turn inside a whole-thread snapshot. */
  userMessageId?: string
  /** Injectable for tests; built from threadId + trace when omitted. */
  attribution?: TurnAttributionRecorder
}

export class StandardTurnStreamConsumer {
  private readonly converter = new StreamConverter()
  private finalAssistantText = ""
  private readonly toolNames = new Set<string>()
  /**
   * Skill attribution runs off the raw stream, not the converted events: the
   * renderer event shapes drop `skillsMetadata` and carry only partially
   * streamed tool-call args, so a consumer built on them cannot attribute code
   * generations to the skills that produced them.
   */
  private readonly attribution?: TurnAttributionRecorder

  constructor(
    private readonly threadId: string,
    private readonly sink?: StandardTurnStreamSink,
    private readonly trace?: TraceCollector,
    options: StandardTurnStreamOptions = {}
  ) {
    this.attribution =
      options.attribution ??
      (trace
        ? new TurnAttributionRecorder({
            threadId,
            tracer: trace,
            ...(options.userMessageId ? { userMessageId: options.userMessageId } : {})
          })
        : undefined)
  }

  getFinalAssistantText(): string {
    return this.finalAssistantText
  }

  getToolNames(): string[] {
    return [...this.toolNames]
  }

  /** Files this turn wrote, for callers that drive memory maintenance. */
  getFileWritePaths(): string[] {
    return this.attribution?.getFileWritePaths() ?? []
  }

  async consume(stream: AsyncIterable<unknown>, signal?: AbortSignal): Promise<void> {
    for await (const chunk of stream) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
      const [mode, data] = chunk as [string, unknown]
      const serialized = JSON.parse(JSON.stringify(data)) as unknown
      this.attribution?.onStreamChunk(mode, serialized)
      for (const event of this.converter.processChunk(mode, serialized)) {
        this.observe(event)
        this.sink?.(event)
      }
    }
  }

  async flush(): Promise<void> {
    await flushStrict()
  }

  private observe(event: SchedulerEvent): void {
    if (event.type === "message-delta" && Array.isArray(event.toolCalls)) {
      for (const call of event.toolCalls as Array<{ id?: string; name?: string; args?: unknown }>) {
        if (!call.name) continue
        this.toolNames.add(call.name)
        this.trace?.addToolNode({
          name: call.name,
          input: call.args,
          llmMessageId: event.id,
          toolCallId: call.id
        })
      }
    }
    if (event.type === "tool-message") {
      if (event.name) this.toolNames.add(event.name)
      this.trace?.addToolResultNode({
        toolCallId: event.toolCallId,
        output: event.content,
        status: event.isError ? "error" : "success",
        metadata: { messageId: event.id }
      })
      return
    }
    if (event.type !== "full-messages") return

    const transcript = event.messages
      .map(transcriptMessage)
      .filter((message): message is Message => message !== null)
    if (transcript.length > 0) upsertThreadMessages(this.threadId, transcript)

    const final = [...event.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) &&
          message.content.trim().length > 0
      )
    if (final) this.finalAssistantText = final.content.trim()
  }
}
