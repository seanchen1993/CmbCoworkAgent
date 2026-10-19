import { randomUUID } from "node:crypto"
import { HumanMessage, isAIMessage } from "@langchain/core/messages"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { createMiddleware } from "langchain"
import {
  type AgentRunRequest,
  type AgentRunDelivery,
  type AgentRunExecutionContext
} from "../../agent/agent-run-service"
import { assertLocalThreadRunLease } from "../../agent/thread-run-lease"
import { createDeepAgent } from "../../agent/runtime"

export const REQUIREMENT_INPUT_ONLY_PROMPT = `当前为需求模式的受限文本分析阶段。
只理解本任务提供的需求，梳理业务规则、范围、假设、边界条件、澄清问题和可验收标准，输出需求说明书草稿。
不生成未经业务确认的正式PRD，不把草稿标为已审批；未知系统实现须明确标为待核实，不能杜撰代码事实。
本阶段工具为零，不能读取仓库或文件、执行命令、调用技能或子代理、写代码、设计UI、发布或处理无关任务。
没有个人身份/记忆/聊天记录，也没有未提供的群消息。澄清问题由任务编号继续，不要求回复串。`

export class InputOnlyRequirementFault extends Error {
  constructor(
    readonly code: "EXECUTION_FAILED" | "CANCELLED" | "EMPTY_OUTPUT" | "TOOL_CALL_REJECTED"
  ) {
    super(code)
  }
}
export interface InputOnlyRunDependencies {
  resolveThread(threadId: string): {
    workspacePath: string | undefined
    metadata: Record<string, unknown>
  }
  /** Explicit owner-approved reference; no default/fallback or business supplied model. */
  resolveModel(modelRef: string, configHash?: string): BaseChatModel | Promise<BaseChatModel>
}

/** Uses the EXISTING DeepAgent graph builder with zero tools and an in-memory
 * backend. Deliberately bypasses only the old personal IPC preparation body,
 * not the engine. No checkpointer, global identity, file sources or Hooks. */
export function createInputOnlyRequirementImplementation(deps: InputOnlyRunDependencies) {
  return async (
    request: AgentRunRequest,
    _delivery: AgentRunDelivery,
    context: AgentRunExecutionContext
  ): Promise<void> => {
    const profile = context.partnerInputOnly
    const lease = context.localRunLease
    const signal = context.signal
    let failureCode: InputOnlyRequirementFault["code"] | undefined
    const refuse = (code: InputOnlyRequirementFault["code"]): never => {
      failureCode = code
      throw new InputOnlyRequirementFault(code)
    }
    const check = () => {
      if (signal?.aborted) throw new InputOnlyRequirementFault("CANCELLED")
      if (
        !profile ||
        !lease ||
        !signal ||
        !context.verifyResolvedThread ||
        context.source !== "im" ||
        !lease.managedExternally ||
        lease.owner !== "im" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profile.modelRef) ||
        !profile.systemPrompt.trim() ||
        profile.systemPrompt.length > 120_000 ||
        !request.message.trim() ||
        request.message.length > 60_000 ||
        request.modelId ||
        request.agentMode ||
        request.coordinatorInternalNotification
      )
        throw new InputOnlyRequirementFault("EXECUTION_FAILED")
      assertLocalThreadRunLease(request.threadId, lease.owner, lease.runId)
      if (context.verifyResolvedThread(deps.resolveThread(request.threadId)))
        throw new InputOnlyRequirementFault("EXECUTION_FAILED")
    }
    try {
      check()
      const model = await deps.resolveModel(profile!.modelRef, profile!.modelConfigHash)
      check() // Recheck after asynchronous model/module resolution, before the graph.
      let modelCalls = 0
      const guard = createMiddleware({
        name: "partnerInputOnlyBoundary",
        wrapModelCall: async (request, handler) => {
          check()
          if (++modelCalls > 1) refuse("EXECUTION_FAILED")
          if (request.tools.length) refuse("TOOL_CALL_REJECTED")
          const response = await handler(request)
          check()
          if (response.tool_calls?.length || response.invalid_tool_calls?.length)
            refuse("TOOL_CALL_REJECTED")
          if (typeof response.content === "string" && !response.content.trim())
            refuse("EMPTY_OUTPUT")
          const reason = response.response_metadata?.finish_reason
          if (["length", "content_filter", "error"].includes(String(reason)))
            refuse("EXECUTION_FAILED")
          return response
        },
        wrapToolCall: () => refuse("TOOL_CALL_REJECTED")
      })
      const graph = createDeepAgent({
        model,
        summarizationModel: model,
        tools: [],
        systemPrompt: profile!.systemPrompt,
        mainFilesystemEnabled: false,
        mainTodosEnabled: false,
        mainSubagentsEnabled: false,
        includeGeneralPurposeSubagent: false,
        skills: [],
        memory: [],
        middleware: [guard],
        currentRunMessageQueueOwnerToken: lease!.runId,
        summarizationTrigger: { type: "tokens", value: 1_000_000 },
        summarizationKeep: { type: "messages", value: 1 }
        // No Thread/checkpointer configurable: no old history or steer queue.
      })
      // Graph steps include existing middleware nodes, not only model calls.
      // The guard above separately bounds model calls to exactly one.
      const value = await graph.invoke(
        { messages: [new HumanMessage(request.message)] },
        { signal, recursionLimit: 32 }
      )
      check()
      const final = value.messages.at(-1)
      if (
        !final ||
        !isAIMessage(final) ||
        final.tool_calls?.length ||
        final.invalid_tool_calls?.length
      )
        throw new InputOnlyRequirementFault("EMPTY_OUTPUT")
      const text =
        typeof final.content === "string"
          ? final.content
          : final.content
              .map((part) =>
                typeof part === "object" && part.type === "text" && "text" in part
                  ? String(part.text)
                  : ""
              )
              .join("")
      if (!text.trim() || text.length > 16_384 || /[\u0000\uD800-\uDFFF]/u.test(text))
        throw new InputOnlyRequirementFault("EMPTY_OUTPUT")
      await context.onFinalAssistant?.({ messageId: randomUUID(), finalText: text })
      context.onRunTerminated?.({ outcome: "success", code: "PARTNER_REQUIREMENT_COMPLETED" })
    } catch (error) {
      // LangGraph can wrap middleware exceptions; retain only our safe code,
      // never inspect/stringify a provider error or its potentially secret cause.
      const code = signal?.aborted
        ? "CANCELLED"
        : (failureCode ??
          (error instanceof InputOnlyRequirementFault ? error.code : "EXECUTION_FAILED"))
      if (signal?.aborted) context.onRunCancelled?.()
      context.onRunTerminated?.({ outcome: "error", code })
      // No raw provider error, stack, prompt or credentials in transport callbacks.
    }
  }
}
