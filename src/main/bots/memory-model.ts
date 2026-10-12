import { botModelInvocationObserver } from "./model-error-diagnostic-scope"
import { withModelResponseDiagnostics } from "../agent/model-response-diagnostics"
import { readFinishSignal, isCompleteTextFinishSignal } from "../agent/turn-completion-integrity"
import { readModelRefusal } from "../agent/model-refusal"
import { BotModelAnswerProjection } from "./model-answer-projection"
import { startBotModelUsage, settleBotModelUsage } from "./model-usage"
import { BotDomainError } from "../../shared/bot-types"
import { botModelCallDiagnostics } from "./model-call-diagnostics"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { createConfiguredCmbModel } from "../models/model-factory"
import { readBotModelSnapshot } from "./model-config"
import type { BotStore } from "./store"
import type { BotMemoryModelFactory } from "./memory-synthesis"
import {
  memoryInputByteLimit,
  memoryOutputLimit,
  memoryRequestFits,
  memoryContextLimitError
} from "./memory-context"

/** Use the same configured Cmb model and transport, with no tools and no desktop singleton. */
export function botMemoryModels(path: string, store: BotStore): BotMemoryModelFactory {
  return async (botId, lifetime) => {
    const bot = store.getBot(botId),
      snapshot = await readBotModelSnapshot(path)
    const ref = bot.modelRef ?? snapshot.defaultRef
    const config = snapshot.models.find((model) => model.ref === ref || model.id === ref)
    if (!config?.apiKey) throw new Error("记忆整理所用模型尚未配置")
    const inputLimit = memoryInputByteLimit(config)
    const fingerprint = JSON.stringify(snapshot)
    const assertCurrent = async () => {
      lifetime.throwIfAborted()
      if (
        store.getBot(botId).revision !== bot.revision ||
        JSON.stringify(await readBotModelSnapshot(path)) !== fingerprint
      )
        throw new Error("Bot 模型配置已变化")
      lifetime.throwIfAborted()
    }
    return {
      assertCurrent,
      fits: (system, data) => memoryRequestFits(system, data, inputLimit),
      async complete(system, data, signal, phase = "synthesis") {
        await assertCurrent()
        if (!memoryRequestFits(system, data, inputLimit)) throw memoryContextLimitError()
        let localFailure: BotDomainError | undefined
        const send: typeof fetch = async (input, init) => {
          await assertCurrent()
          signal.throwIfAborted()
          let body: Record<string, unknown>
          try {
            body = JSON.parse(typeof init?.body === "string" ? init.body : "null")
          } catch {
            throw new BotDomainError("model_usage_protocol", "记忆模型请求格式无效")
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new BotDomainError("model_usage_protocol", "记忆模型请求缺少输出上限")
          const tokenKey = Object.hasOwn(body, "max_completion_tokens")
            ? "max_completion_tokens"
            : "max_tokens"
          const requested = Math.min(
            Number(body[tokenKey] ?? memoryOutputLimit(config)),
            memoryOutputLimit(config)
          )
          if (!Number.isSafeInteger(requested) || requested <= 0)
            throw new BotDomainError("model_usage_protocol", "记忆模型请求的输出上限无效")
          const { id, reserved } = store.transaction(() => {
            const reserved = store.usageBudgets.capacity(botId, requested)
            const id = startBotModelUsage(store, {
              botId,
              model: config,
              purpose: phase === "verification" ? "memory-verification" : "memory-synthesis",
              reserved
            })
            return { id, reserved }
          })
          body[tokenKey] = reserved
          if (Object.hasOwn(body, "max_tokens")) body.max_tokens = reserved
          const diagnostics = botModelCallDiagnostics({
            callId: id,
            botId,
            purpose: phase === "verification" ? "memory-verification" : "memory-synthesis",
            knownSecrets: config.apiKey ? [config.apiKey] : []
          })
          return withModelResponseDiagnostics(
            (url, init) => diagnostics.send(fetch, url, init),
            { model: config.model, purpose: "bot-memory" },
            (usage) => {
              diagnostics.complete(usage)
              store.transaction(() => settleBotModelUsage(store, id, usage))
            }
          )(input, {
            ...init,
            body: JSON.stringify(body),
            signal: AbortSignal.any([lifetime, signal, ...(init?.signal ? [init.signal] : [])])
          })
        }
        const modelFetch: typeof fetch = async (input, init) => {
          try {
            return await send(input, init)
          } catch (error) {
            // Provider SDKs wrap fetch errors as connection failures. Preserve
            // local admission errors so quota waits do not consume retry attempts.
            if (error instanceof BotDomainError) localFailure = error
            throw error
          }
        }
        const model = createConfiguredCmbModel(
          { ...config, maxOutputTokens: memoryOutputLimit(config) },
          {
            fetch: modelFetch,
            purpose: "function-completion",
            preserveProviderRefusal: true,
            observeInvocation: botModelInvocationObserver(config.apiKey ? [config.apiKey] : [])
          }
        )
        try {
          const stream = await model.stream(
            [new SystemMessage(system), new HumanMessage(JSON.stringify(data))],
            { signal }
          )
          const projection = new BotModelAnswerProjection({
            providerCharacters: 96_000,
            answerCharacters: 96_000,
            errorPrefix: "memory_model",
            label: "记忆整理"
          })
          let finish: string | null = null
          for await (const chunk of stream) {
            signal.throwIfAborted()
            if (
              chunk.tool_call_chunks?.length ||
              chunk.tool_calls?.length ||
              chunk.invalid_tool_calls?.length
            )
              throw new Error("记忆整理不能调用工具")
            if (readModelRefusal(chunk)) throw new Error("记忆模型拒绝了请求")
            const currentFinish = readFinishSignal(chunk)
            if (currentFinish !== null && !isCompleteTextFinishSignal(currentFinish))
              throw new Error("记忆整理未正常完成")
            finish = currentFinish ?? finish
            projection.pushMessage(chunk)
          }
          if (!isCompleteTextFinishSignal(finish)) throw new Error("记忆整理未正常完成")
          const text = projection.finish()
          await assertCurrent()
          return text
        } catch (error) {
          throw localFailure ?? error
        }
      }
    }
  }
}
