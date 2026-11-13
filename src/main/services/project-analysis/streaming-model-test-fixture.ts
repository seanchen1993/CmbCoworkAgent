import { projectContextBudget } from "./context-budget"
import { ProjectContext } from "./context"
import { createProjectRunReporter } from "./run-progress"
import { AIMessageChunk, AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ProjectAnalysisModel } from "./model-stream"

export type MockModelInvoke = (
  messages: BaseMessage[],
  options: { signal: AbortSignal }
) => Promise<AIMessage>
/** Tests provide deterministic complete messages; production has no non-streaming fallback. */
export function mockStreamingModel<T extends { invoke: MockModelInvoke }>(
  runner: T
): T & ProjectAnalysisModel {
  return {
    ...runner,
    stream: async (messages, options) =>
      (async function* () {
        const message = await runner.invoke(messages, options)
        yield new AIMessageChunk({
          content: message.content,
          additional_kwargs: message.additional_kwargs,
          usage_metadata: message.usage_metadata,
          tool_call_chunks: [
            ...(message.tool_calls ?? []).map((call, index) => ({
              name: call.name,
              id: call.id,
              args: JSON.stringify(call.args),
              index,
              type: "tool_call_chunk" as const
            })),
            ...(message.invalid_tool_calls ?? []).map((call, index) => ({
              name: call.name,
              id: call.id,
              args: call.args,
              index: index + (message.tool_calls?.length ?? 0),
              type: "tool_call_chunk" as const
            }))
          ]
        })
      })()
  }
}

export const TEST_PROJECT_BUDGET = projectContextBudget({
  maxTokens: 128_000,
  maxOutputTokens: 8192
})
export const testReviewer = (onReview?: (messages: BaseMessage[]) => void) =>
  mockStreamingModel({
    invoke: async (messages: BaseMessage[]) => {
      onReview?.(messages)
      const raw = String(messages.at(-1)?.content ?? "")
      const split = raw.split("对应：\n")[1]
      if (split) {
        const tables = JSON.parse(split) as Array<{
          source: string
          fields: string[]
          values: unknown[][]
        }>
        return new AIMessage(
          tables
            .map(
              (t) =>
                `${t.source}已完整审阅；${t.values
                  .map((row) => row[t.fields.indexOf("projectId")])
                  .filter(Boolean)
                  .join("、")}`
            )
            .join("\n")
        )
      }
      return new AIMessage("已核实的证据保留，完整明细可继续回查；未读分页需要继续核实。")
    }
  })
export function reviewTestContext(model: ProjectAnalysisModel, signal: AbortSignal) {
  const progress = createProjectRunReporter()
  const context = new ProjectContext(progress, signal)
  context.configure(
    { name: "test", budget: TEST_PROJECT_BUDGET, agent: model, final: model, reviewer: model },
    [context.readTool]
  )
  return [TEST_PROJECT_BUDGET, context, progress, "test"] as const
}
