import { createMiddleware } from "langchain"
import { BaseMessage, ToolMessage, isToolMessage } from "@langchain/core/messages"
import { getVisionModelConfig } from "../models/registry"
import { projectImageContent } from "../vision/image-assets"

/** Clone only the provider projection, preserving the checkpoint's original message. */
export async function projectImageMessage<T extends BaseMessage>(
  threadId: string,
  message: T
): Promise<T> {
  const content = await projectImageContent(
    threadId,
    message.content,
    isToolMessage(message)
      ? `tool:${message.name ?? "unknown"}:${message.tool_call_id}`
      : `message:${message.id ?? "user"}`
  )
  if (content === message.content) return message
  const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as T
  clone.content = content as BaseMessage["content"]
  return clone
}

export function createImageAnalysisMiddleware(threadId: string) {
  return createMiddleware({
    name: "sharedImageAnalysis",
    wrapModelCall: async (request, handler) => {
      // Re-read configuration on every turn, including agents cached before a
      // model was removed. Configuration validity never depends on a health probe.
      const configured = Boolean(getVisionModelConfig())
      const messages = await Promise.all(
        request.messages.map((message) => projectImageMessage(threadId, message))
      )
      return handler({
        ...request,
        messages,
        tools: configured
          ? request.tools
          : request.tools.filter((entry) => entry.name !== "analyze_images")
      })
    },
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name === "analyze_images" && !getVisionModelConfig()) {
        return new ToolMessage({
          name: "analyze_images",
          tool_call_id: request.toolCall.id ?? "",
          status: "error",
          content: "图片分析不可用：请先在模型配置中选择并完整配置多模态模型。不要猜测图片内容。"
        })
      }
      const result = await handler(request)
      // Persist screenshot references rather than image bytes. This keeps both
      // immediate analysis and subsequent follow-up questions on the same ID.
      return isToolMessage(result) ? projectImageMessage(threadId, result) : result
    }
  })
}
