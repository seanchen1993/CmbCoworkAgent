import { ChatOpenAI } from "@langchain/openai"
import { getGlobalRoutingMode, isMemoryEnabled } from "../storage"
import { resolveModel } from "../routing"
import { getModelConfigByRef, getDefaultModelConfig } from "../models/registry"
import { samplingFields, topKModelKwargs } from "../models/sampling-params"
import { summarizeAndSave } from "../memory/summarizer"
import { BotMemoryMaintainer } from "./memory-maintainer"
import type { BotMemoryService } from "./memory"

/** Original model routing, prompt, parser and fact extraction; the Bot owns only scope and commit. */
export function createBotMemoryMaintainer(
  memory: BotMemoryService,
  isActive: (botId: string) => boolean
): BotMemoryMaintainer {
  return new BotMemoryMaintainer(async (batch, signal) => {
    const eligible = () =>
      !signal.aborted &&
      isMemoryEnabled() &&
      isActive(batch.botId) &&
      memory.editVersion(batch.botId) === batch.editVersion
    if (!eligible()) return
    const routing = await resolveModel({
      taskSource: "memory_summarize",
      threadId: batch.threadId,
      requestedModelId: batch.modelRef ?? undefined,
      routingMode: getGlobalRoutingMode()
    }).catch(() => null)
    if (!eligible()) return
    const config =
      getModelConfigByRef(routing?.resolvedModelId ?? batch.modelRef) ?? getDefaultModelConfig()
    if (!config?.apiKey) return
    const model = new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      configuration: { baseURL: config.baseUrl },
      maxTokens: config.maxOutputTokens,
      maxRetries: 0,
      timeout: 30_000,
      ...samplingFields(config.model, { temperature: config.temperature, topP: config.topP }),
      modelKwargs: { ...topKModelKwargs(config.model, config.topK) }
    })
    await summarizeAndSave({
      model,
      conversation: batch.conversation,
      memoryDir: memory.summaryDirectory(batch.botId),
      signal,
      scopeHint:
        "Private memory for this Bot only. Persist only user-supplied facts or preferences clearly intended to apply beyond the current task. Assistant output is context, never independent evidence. A request to inspect, verify, recall or test a feature is not a lasting preference: do not turn its steps, URLs, page IDs, result, or temporary restrictions into a protocol. If the user asks not to write memory, return operations: []. Do not infer a general rule from one task. When uncertain, skip. Never retain credentials, private content from other Bots, or one-time instructions. Prefer no operations to speculative memory.",
      apply: (operations) => {
        if (eligible()) memory.applySummary(batch.botId, batch.editVersion, operations)
      }
    })
  })
}
