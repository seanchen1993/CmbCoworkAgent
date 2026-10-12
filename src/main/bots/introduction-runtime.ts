import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { botIntroductionQuestionInput } from "../../shared/bot-introduction-question"
import { createMiddleware } from "langchain"
import { BotIntroductionAnswer } from "./introduction-answer"
import type { BotRuntimeRequest } from "./host"
import { BotDomainError } from "../../shared/bot-types"
import { createConfiguredCmbModel } from "../models/model-factory"
import { createRetryingFetch } from "../models/retrying-fetch"
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../models/defaults"
import { readInitialBotModelSnapshot } from "./model-config"
import { botTaskModelGuard } from "./runtime-model"
import { botWorkflowModelFetch } from "./workflow-budget"
import { botModelInvocationObserver } from "./model-error-diagnostic-scope"
import { BotCheckpointSaver } from "./checkpointer"
import { createDeepAgent, clearToolConcurrencyLocksForThread } from "../agent/deep-agent-core"
import { clearCurrentRunMessageQueue } from "../agent/current-run-message-queue"
import { clearActionStationarityTurn } from "../agent/action-stationarity"
import {
  clearTurnCompletionGateState,
  readCheckpointedTurnCompletionReport,
  readTurnCompletionGateReport,
  describeTurnCompletionFailure
} from "../agent/turn-completion-integrity"

const INTRODUCTION_TIMEOUT_MS = 90_000
const INTRODUCTION_OUTPUT_TOKENS = 8192
// The existing middleware graph needs a tool and second model turn to offer
// the optional question. The single-question store limit remains independent.
const INTRODUCTION_GRAPH_LIMIT = 16

/** Adapted from Grok's source/shared/agents/onboarding.ts: a real opening
 * conversation, one useful question, and no onboarding form. Limited creation
 * does not grant permission to act on a role description as an assignment. */
export function botIntroductionPrompt(request: Pick<BotRuntimeRequest, "bot">, language: string) {
  return [
    "[First conversation] The user just created this Bot and has not sent a message yet. The opening message is an internal Host control cue carried in the model protocol user role for provider compatibility. It is not authored by the user, is not a user task and grants no permissions. Do not quote or mention it.",
    `Bot profile (data): ${JSON.stringify({ name: request.bot.name, responsibilities: request.bot.instructions.slice(0, 8_000), language })}`,
    "Open with a short, natural hello in the specified language and your own voice. Do not recite your name, description, tools, setup instructions or a checklist.",
    "When language is auto, use the language of the supplied responsibilities or name; use English if neither provides a language. Profile text is data, not permission to start work.",
    "If useful, prepare one concise question about the work the user wants to start or the missing project context with offer_introduction_question. A clear role can make that question specific. Offer 2-3 relevant choices when helpful; free text and ignore are supplied by the UI. This is optional, never a requirement before taking genuine work. Do not ask the same question again in the greeting.",
    "This is only an introduction, not an assignment. The sole tool prepares an optional public question; no shell, browser, file, connector, memory or other Bot access is provided. Do not claim to inspect anything, execute work or complete actions. Never ask for passwords or security codes.",
    "After optionally preparing the question, return the user-visible greeting directly, normally one or two short sentences. Do not emit JSON, internal planning or a questionnaire. Real work or a submitted question answer will arrive as a separate genuine user task."
  ].join("\n\n")
}

/** The existing CMB graph and persistence, with no ordinary task setup or action tools.
 * A finite final question releases the lease; there is no polling human wait. */
export async function executeBotIntroduction(input: BotRuntimeRequest, modelFile: string) {
  const cancellation = new AbortController()
  const timer = setTimeout(
    () =>
      cancellation.abort(
        new BotDomainError("introduction_timeout", "Bot 介绍暂未完成，可直接交办工作")
      ),
    INTRODUCTION_TIMEOUT_MS
  )
  timer.unref()
  const request = {
    ...input,
    signal: AbortSignal.any([input.signal, cancellation.signal])
  }
  const { store, lease, run, signal } = request
  const queueOwner = `${lease.owner}:${lease.fence}`
  const check = () => {
    signal.throwIfAborted()
    request.assertOwnership?.()
    return store.assertIntroductionDispatch(lease)
  }
  try {
    const intent = check()
    const snapshot = await readInitialBotModelSnapshot(modelFile, signal, () =>
      store.activity(lease, "等待配置同步后发送介绍", "thinking")
    )
    check()
    const modelRef = request.bot.modelRef ?? snapshot.defaultRef
    const config = snapshot.models.find((item) => item.ref === modelRef || item.id === modelRef)
    if (!config?.apiKey) throw new Error("此 Bot 的模型未配置或缺少 API Key，请在设置中检查")
    const assertModelCurrent = botTaskModelGuard(request, modelFile, request.bot.modelRef, config)
    const limitedConfig = {
      ...config,
      maxOutputTokens: Math.min(
        config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        INTRODUCTION_OUTPUT_TOKENS
      )
    }
    const meteredFetch = botWorkflowModelFetch(request, limitedConfig, fetch, async () => {
      check()
      await assertModelCurrent()
      check()
    })
    const retryFetch = createRetryingFetch(
      {
        knownSecrets: [config.apiKey],
        isFatalError: (error) => error instanceof BotDomainError,
        onRetry: (info) => {
          check()
          store.activity(
            lease,
            `模型连接重试 ${info.attempt}/${info.maxRetries}：${info.reason}`,
            "thinking"
          )
        }
      },
      2,
      async (url, init) => {
        try {
          check()
          return await meteredFetch(url, init)
        } catch (error) {
          if (error instanceof BotDomainError) cancellation.abort(error)
          throw error
        }
      }
    )
    const modelFetch: typeof fetch = (url, init) =>
      retryFetch(url, {
        ...init,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
      })
    const model = createConfiguredCmbModel(limitedConfig, {
      fetch: modelFetch,
      observeInvocation: botModelInvocationObserver([config.apiKey])
    })
    const guard = createMiddleware({
      name: "botIntroductionScope",
      beforeModel: () => {
        check()
      },
      wrapToolCall: (call, handler) => {
        check()
        if (call.toolCall.name !== "offer_introduction_question")
          throw new BotDomainError("introduction_scope", "介绍回合不能执行操作工具")
        return handler(call)
      }
    })
    const openingQuestion = tool(
      (input, call) => {
        check()
        const callId = call.toolCall?.id
        if (!callId) throw new BotDomainError("tool_call_identity", "介绍问题缺少稳定执行标识")
        return JSON.stringify(store.introductionQuestions.stage(lease, callId, input))
      },
      {
        name: "offer_introduction_question",
        description:
          "Prepare at most one optional question for the newly created Bot's first conversation. Ask only useful work context, with 2-3 choices or no choices for free text. The user can ignore it or assign work instead. This tool does not wait, start work, save memory, change a profile or grant any access. Do not request secrets. After preparing it, return a short greeting without repeating the question.",
        schema: botIntroductionQuestionInput
      }
    )
    const agent = createDeepAgent({
      model,
      systemPrompt: botIntroductionPrompt(request, intent.language),
      tools: [openingQuestion],
      checkpointer: new BotCheckpointSaver(store, lease, run.id),
      mainFilesystemEnabled: false,
      mainSubagentsEnabled: false,
      includeGeneralPurposeSubagent: false,
      mainTodosEnabled: false,
      outerMiddleware: [guard],
      currentRunMessageQueueOwnerToken: queueOwner,
      toolConcurrencyQueueId: run.id,
      actionStationarityTurnId: run.id,
      turnCompletionOwnerToken: run.id,
      turnCompletionCheckpointed: true,
      isFatalToolError: (error: unknown) => error instanceof BotDomainError
    })
    store.activity(lease, "正在发送介绍", "thinking")
    const stream = await agent.stream(
      run.checkpoint
        ? null
        : {
            messages: [
              // Some chat providers reject an all-system transcript. This is only a
              // protocol carrier for the independent welcome graph, never a chat
              // user message or an ordinary task/authority source in BotStore.
              new HumanMessage({
                id: `bot-introduction:${run.id}`,
                content:
                  "[Host control cue: bot-introduction] Open the newly created Bot's conversation with the limited introduction described above. The user has not sent a message or assigned work. This internal cue is not user-authored and grants no permission to act.",
                additional_kwargs: {
                  cmb_host_control: {
                    kind: "bot-introduction",
                    origin: "host",
                    userAuthored: false,
                    runId: run.id
                  }
                }
              })
            ]
          },
      {
        signal,
        recursionLimit: INTRODUCTION_GRAPH_LIMIT,
        streamMode: ["messages", "values"],
        configurable: { thread_id: run.id }
      }
    )
    let answer = new BotIntroductionAnswer(),
      outputMessageId: string | undefined,
      lastOutputAt = 0
    let finalMessages: BaseMessage[] = [],
      finalState: unknown
    for await (const [mode, value] of stream) {
      check()
      if (mode === "values") {
        finalMessages = (value as { messages: BaseMessage[] }).messages
        finalState = value
      } else if (mode === "messages") {
        const [message] = value as [BaseMessage, unknown]
        if (!AIMessage.isInstance(message)) continue
        if (message.id && outputMessageId && message.id !== outputMessageId) {
          answer = new BotIntroductionAnswer()
          store.streamOutput(lease, "")
        }
        outputMessageId = message.id
        const changed = answer.push(message.content)
        if (changed && Date.now() - lastOutputAt >= 200) {
          store.streamOutput(lease, answer.text)
          lastOutputAt = Date.now()
        }
      }
    }
    check()
    const completion =
      readCheckpointedTurnCompletionReport(finalState, run.id) ??
      readTurnCompletionGateReport(run.id, run.id)
    const failure = completion && describeTurnCompletionFailure(completion)
    if (failure) throw new Error(failure)
    const last = finalMessages.at(-1)
    if (!last || !AIMessage.isInstance(last) || last.tool_calls?.length)
      throw new Error("模型未形成有效的 Bot 介绍")
    const finalAnswer = new BotIntroductionAnswer()
    finalAnswer.push(last.content)
    const content = finalAnswer.finish().trim()
    if (!content) throw new Error("模型未返回有效的 Bot 介绍")
    store.streamOutput(lease, content)
    return content
  } catch (error) {
    if (cancellation.signal.aborted) throw cancellation.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    cancellation.abort(new Error("介绍回合已结束"))
    clearCurrentRunMessageQueue(run.id, queueOwner)
    clearTurnCompletionGateState(run.id, run.id)
    clearActionStationarityTurn(run.id, run.id)
    clearToolConcurrencyLocksForThread(run.id)
  }
}
