import { tool } from "langchain"
import { z } from "zod"
import { ToolMessage } from "@langchain/core/messages"
import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { LocalBotHost } from "./host"

/** Extends the ordinary beta Runtime. Final assistant replies remain normal chat. */
export function createBotWorkTools(
  taskId: string,
  getHost: () => LocalBotHost,
  signal: AbortSignal
): DynamicStructuredTool[] {
  const key = z.string().trim().min(1).max(160)
  const id = z.string().trim().min(1).max(160)
  const invoke = async (
    name: string,
    callId: string | undefined,
    action: (host: LocalBotHost) => unknown | Promise<unknown>
  ) => {
    try {
      signal.throwIfAborted()
      if (!callId) throw new Error("缺少可信工具调用标识，未执行工作操作")
      const host = getHost()
      host.workToolSource(taskId)
      return JSON.stringify({
        kind: "bot-work-receipt",
        operation: name,
        receipt: await action(host)
      })
    } catch (cause) {
      signal.throwIfAborted()
      const content = JSON.stringify({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
        recovery:
          "The work operation did not succeed. Report the actual error; never claim a work was created, completed or continued without a successful receipt. Do not bypass these controls using files, SQL or shell."
      })
      return callId
        ? new ToolMessage({ content, status: "error", tool_call_id: callId, name })
        : content
    }
  }
  return [
    tool(
      async ({ cursor, query }, config) =>
        invoke("bot_work_list", config.toolCall?.id, (host) => {
          const task = host.workToolSource(taskId)
          return host.workTargets(task.id, cursor, query)
        }),
      {
        name: "bot_work_list",
        description:
          "List your desktop user's independent works, as bounded summaries. Use the returned exact ID; ask when the intended work is ambiguous. This is not a request to create work or read another work's transcript.",
        schema: z.object({
          cursor: z.string().max(1024).optional(),
          query: z.string().max(160).optional()
        })
      }
    ),
    tool(
      async ({ requestKey, title, goal, contextMessageIds }, config) =>
        invoke("bot_work_create", config.toolCall?.id, (host) => {
          const task = host.workToolSource(taskId)
          return host.createWork(
            {
              botId: task.botId,
              operationId: config.toolCall!.id!,
              title,
              goal,
              contextMessageIds
            },
            { taskId, callId: config.toolCall!.id!, key: requestKey }
          )
        }),
      {
        name: "bot_work_create",
        description:
          "Create one independent continuing work only when the current user explicitly delegates a concrete work in the main conversation. Ordinary discussion, greetings and routine executions do not create works. Cannot create visible works recursively inside a work. Select only relevant existing message IDs (user and assistant, at most 12, 24KB); empty means no history is carried. The host creates one real thread and initial execution and returns their IDs. Reuse requestKey for the same operation after a lost reply, never create another key to hide uncertainty.",
        schema: z.object({
          requestKey: key,
          title: z.string().trim().min(1).max(160),
          goal: z.string().trim().min(1).max(30000),
          contextMessageIds: z.array(id).max(12).default([])
        })
      }
    ),
    tool(
      async ({ requestKey, workId, message }, config) =>
        invoke("bot_work_send", config.toolCall?.id, (host) =>
          host.sendWork({ taskId, callId: config.toolCall!.id!, key: requestKey }, workId, message)
        ),
      {
        name: "bot_work_send",
        description:
          "Forward the user's explicit supplementary instruction to the exact same-audience work ID from a real work receipt/list. It is durably queued for that work. Completed work must first be explicitly continued. Never choose an ambiguous target or claim execution has already succeeded.",
        schema: z.object({
          requestKey: key,
          workId: id,
          message: z.string().trim().min(1).max(30000)
        })
      }
    ),
    ...(["complete", "continue"] as const).map((action) =>
      tool(
        async ({ requestKey, workId, expectedVersion }, config) =>
          invoke(`bot_work_${action}`, config.toolCall?.id, (host) =>
            host.changeWorkFromTool(
              { taskId, callId: config.toolCall!.id!, key: requestKey },
              workId,
              expectedVersion,
              action
            )
          ),
        {
          name: `bot_work_${action}`,
          description:
            action === "complete"
              ? "Mark the exact work completed only on the current user's explicit completion instruction. The host refuses pending work, collaboration, background commands, or completing the currently executing source work. A model result alone is not business completion."
              : "Continue the same completed work only on the user's explicit instruction, preserving its history. This only changes its business state; it does not rerun interrupted or unknown effects. Send a new explicit instruction separately if needed.",
          schema: z.object({
            requestKey: key,
            workId: id,
            expectedVersion: z.number().int().positive()
          })
        }
      )
    )
  ] as DynamicStructuredTool[]
}
