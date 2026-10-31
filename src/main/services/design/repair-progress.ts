import path from "node:path"
import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"

export const DESIGN_REPAIR_NUDGE_CALLS = 4
export const DESIGN_REPAIR_STALL_CALLS = 8
const MAX_REPAIR_TOOL_CALLS = 32

/** One instance per repair turn, retained across API/runtime retries. */
export function createDesignRepairProgress(targetPath: string, workspacePath: string) {
  let callsWithoutWrite = 0
  let totalCalls = 0
  const sameTarget = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return false
    const resolve = (p: string) => path.resolve(workspacePath, p)
    return process.platform === "win32"
      ? resolve(value).toLowerCase() === resolve(targetPath).toLowerCase()
      : resolve(value) === resolve(targetPath)
  }
  const middleware = createMiddleware({
    name: "designRepairProgress",
    wrapToolCall: async (request, handler) => {
      totalCalls++
      callsWithoutWrite++
      const call = request.toolCall
      const args = call.args as Record<string, unknown>
      const filePath = call.name === "grep" ? args.path : args.file_path
      let reason: string | undefined
      if (!["read_file", "grep", "edit_file"].includes(call.name) || !sameTarget(filePath)) {
        reason = `修复阶段只允许 read_file、grep、edit_file 操作唯一草稿 ${targetPath}。不要列目录、读取或比较其他草稿。`
      } else if (call.name === "edit_file" && args.old_string === args.new_string) {
        reason = "old_string 与 new_string 相同，没有实际修改；请按校验报告修正内容。"
      } else if (callsWithoutWrite > DESIGN_REPAIR_STALL_CALLS && call.name !== "edit_file") {
        reason = "已连续只读或调用失败而没有成功写入，请根据报告和已有源码直接 edit_file。"
      }
      if (reason)
        return new ToolMessage({
          content: reason,
          tool_call_id: call.id ?? "",
          name: call.name,
          status: "error"
        })
      return handler(request)
    },
    wrapModelCall: async (request, handler) => {
      if (callsWithoutWrite > DESIGN_REPAIR_STALL_CALLS)
        throw new Error(
          `自动修复连续 ${callsWithoutWrite} 次工具调用没有实际写入，已停止无进展的修复并保留草稿。页面尚未通过宿主复检。`
        )
      if (totalCalls >= MAX_REPAIR_TOOL_CALLS)
        throw new Error("自动修复工具调用已达到上限，已停止并保留草稿；页面尚未通过宿主复检。")
      const effectiveRequest =
        callsWithoutWrite >= DESIGN_REPAIR_NUDGE_CALLS
          ? {
              ...request,
              systemMessage: request.systemMessage.concat(
                `\n\n你已连续 ${callsWithoutWrite} 次调用工具而没有实际写入修复。宿主已给出具体字段、片段与唯一目标 ${targetPath}。请停止搜索并直接 edit_file 修复已定位的问题；无法修改时明确说明原因并结束，不要宣称修复成功。`
              )
            }
          : request
      const response = await handler(effectiveRequest)
      // Throw at the model boundary: ToolNode converts tool exceptions into
      // results, which would otherwise allow another round of endless searches.
      if (
        callsWithoutWrite >= DESIGN_REPAIR_STALL_CALLS &&
        AIMessage.isInstance(response) &&
        response.tool_calls?.length &&
        !response.tool_calls.some((call) => call.name === "edit_file")
      )
        throw new Error(
          `自动修复连续 ${callsWithoutWrite} 次工具调用没有实际写入，已停止重复搜索并保留草稿。页面尚未通过宿主复检。`
        )
      return response
    }
  })
  return {
    middleware,
    // Only the successful filesystem mutation callback may reset progress.
    noteWrite: () => {
      callsWithoutWrite = 0
    }
  }
}
