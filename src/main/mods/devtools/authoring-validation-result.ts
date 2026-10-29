import type { AuthoringPreviewAnalysis } from "./authoring-preflight"

/** Static evidence for one exact source; it grants no trial or runtime authority. */
export function authoringValidationResult(digest: string, analysis: AuthoringPreviewAnalysis) {
  const repairHints = analysis.sdk.diagnostics.some((item) => item.code === "MODS_SDK_UNVERIFIED")
    ? [
        "先按具体诊断区分原因。工具提供者未确认时，不要猜测或反复更改工具名；跨 Mod 协作优先通过 catalog(query:'platform.action',catalogSection:'events') 发现 on.capability，并通过 catalog(query:'platform.act',catalogSection:'sdk') 读取调用契约，实际提供者生效后再验证。若诊断是 SDK 来源不明确，SDK 调用须直接放在有明确 SDK 形参的原始事件处理器中，不要把 SDK 对象或方法传给 load/write 等辅助函数，也不要动态索引方法。辅助函数只接收普通数据；按诊断文件和行号修复后，用当前草稿 revision 提交完整文件。"
      ]
    : []
  return {
    digest,
    valid: analysis.sdk.strictCompatible && analysis.typecheck.valid,
    runtimeVerified: false,
    diagnostics: [...analysis.typecheck.diagnostics, ...analysis.sdk.diagnostics],
    capabilities: [...new Set(analysis.sdk.usages.map((usage) => usage.method))].sort(),
    ...(repairHints.length ? { repairHints } : {})
  }
}

export class AuthoringValidationError extends Error {
  constructor(readonly check: ReturnType<typeof authoringValidationResult>) {
    super("AUTHORING_VERSION_CHECK_FAILED")
    this.name = "AuthoringValidationError"
    if (check.valid) throw Error("AUTHORING_VALIDATION_RESULT_INVALID")
  }
}
