import { createHash } from "node:crypto"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ProjectRunReporter } from "./run-progress"
import { projectMessageText } from "./model-stream"

interface CompletedModelCall {
  title: string
  response: {
    content: AIMessage["content"]
    tool_calls: AIMessage["tool_calls"]
    invalid_tool_calls: AIMessage["invalid_tool_calls"]
    additional_kwargs: AIMessage["additional_kwargs"]
    response_metadata: AIMessage["response_metadata"]
    usage_metadata: AIMessage["usage_metadata"]
  }
}
export interface ProjectModelCheckpointState {
  completed: Record<string, CompletedModelCall>
  pendingStep?: string
}

/** Replay successful model calls against the same frozen data to rebuild context without paying for them again. */
export class ProjectModelCheckpoint {
  private readonly responses = new WeakMap<AIMessage, string>()
  private readonly restored = new WeakSet<AIMessage>()
  constructor(
    readonly state: ProjectModelCheckpointState,
    private readonly save: () => void
  ) {}

  async run(
    identity: string,
    messages: BaseMessage[],
    title: string,
    signal: AbortSignal,
    progress: ProjectRunReporter,
    request: () => Promise<AIMessage>
  ): Promise<AIMessage> {
    signal.throwIfAborted()
    const key = createHash("sha256")
      .update(identity)
      .update(JSON.stringify(messages.map((m) => m.toDict())))
      .digest("hex")
    const existing = this.state.completed[key]
    if (existing) {
      progress
        .begin("review", `恢复已完成步骤 · ${title}`)
        .finish("复用已保存结果，本步骤不再次调用模型")
      const response = new AIMessage(existing.response)
      this.responses.set(response, key)
      this.restored.add(response)
      return response
    }
    this.state.pendingStep = title
    this.save()
    const response = await request()
    signal.throwIfAborted()
    // A failed/empty stream is never a completed checkpoint.
    if (projectMessageText(response.content).trim() || response.tool_calls?.length) {
      this.state.completed[key] = {
        title,
        response: {
          content: response.content,
          tool_calls: response.tool_calls,
          invalid_tool_calls: response.invalid_tool_calls,
          additional_kwargs: response.additional_kwargs,
          response_metadata: response.response_metadata,
          usage_metadata: response.usage_metadata
        }
      }
      this.state.pendingStep = undefined
      this.responses.set(response, key)
      this.save()
    }
    return response
  }

  wasRestored(response: AIMessage): boolean {
    return this.restored.has(response)
  }

  markPending(title: string): void {
    this.state.pendingStep = title
    this.save()
  }

  /** A completed stream may still fail downstream validation; retry that output on continuation. */
  discard(response: AIMessage): void {
    const key = this.responses.get(response)
    if (!key || !this.state.completed[key]) return
    this.state.pendingStep = this.state.completed[key].title
    delete this.state.completed[key]
    this.save()
  }
}
