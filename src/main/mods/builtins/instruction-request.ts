import type { BuiltinInstructionsFinalObservation } from "../../../shared/mods/builtin-instructions"

/** Checks the whole assembled block at the provider-request boundary, not semantic obedience. */
export function compareInstructionRequest(
  assembled: string,
  finalPrompt: string
): Pick<BuiltinInstructionsFinalObservation, "result" | "reason"> {
  if (!assembled.trim()) return { result: "unknown", reason: "本次没有可核对的完整规范文本。" }
  if (finalPrompt.includes(assembled))
    return {
      result: "confirmed",
      reason: "已在模型请求边界观察到装配时的完整规范文本；这不证明模型已接收、执行或遵守规范。"
    }
  return {
    result: "modified",
    reason:
      "模型请求边界未保留装配时的完整规范文本，可能经过修改、裁剪或省略；无法据此定位到单个文件。"
  }
}
