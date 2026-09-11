import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { RunnableConfig } from "@langchain/core/runnables"

import {
  CONTEXT_COMPACTION_MODEL_TAG,
  CONTEXT_COMPACTION_NO_STREAM_TAG,
  type ContextCompactionLifecycleCallback,
  type ContextCompactionPhase
} from "../../shared/context-compaction-events"

interface ConfigurableModel {
  withConfig(config: RunnableConfig): unknown
}

function isConfigurableModel(model: unknown): model is ConfigurableModel {
  return Boolean(
    model &&
    typeof model === "object" &&
    "withConfig" in model &&
    typeof model.withConfig === "function"
  )
}

export class ContextCompactionCallbackHandler extends BaseCallbackHandler {
  name = "ContextCompactionCallbackHandler"

  private readonly startedAtByRunId = new Map<string, number>()

  constructor(private readonly onLifecycle: ContextCompactionLifecycleCallback) {
    // Ensure the renderer sees the start event before summary generation begins.
    super({ _awaitHandler: true })
  }

  handleChatModelStart(_llm: unknown, _messages: unknown, runId: string): void {
    if (this.startedAtByRunId.has(runId)) return
    const startedAt = Date.now()
    this.startedAtByRunId.set(runId, startedAt)
    this.onLifecycle({ id: runId, phase: "started", startedAt })
  }

  handleLLMEnd(_output: unknown, runId: string): void {
    this.finish(runId, "completed")
  }

  handleLLMError(_error: unknown, runId: string): void {
    this.finish(runId, "failed")
  }

  private finish(runId: string, phase: Exclude<ContextCompactionPhase, "started">): void {
    const startedAt = this.startedAtByRunId.get(runId)
    if (startedAt === undefined) return
    this.startedAtByRunId.delete(runId)
    this.onLifecycle({ id: runId, phase, startedAt, finishedAt: Date.now() })
  }
}

/**
 * Returns a model binding dedicated to summarization. Its private output is
 * omitted from LangGraph's normal `messages` stream; the optional callback is
 * used only for the foreground/main-agent compaction card.
 */
export function configureContextCompactionModel<T>(
  model: T,
  onLifecycle?: ContextCompactionLifecycleCallback
): T | unknown {
  if (!isConfigurableModel(model)) return model

  return model.withConfig({
    tags: [CONTEXT_COMPACTION_NO_STREAM_TAG, CONTEXT_COMPACTION_MODEL_TAG],
    ...(onLifecycle && { callbacks: [new ContextCompactionCallbackHandler(onLifecycle)] })
  })
}
