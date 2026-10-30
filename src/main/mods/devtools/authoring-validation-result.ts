import type { AuthoringPreviewAnalysis } from "./authoring-preflight"

/** Static evidence for one exact source; it grants no trial or runtime authority. */
export function authoringValidationResult(digest: string, analysis: AuthoringPreviewAnalysis) {
  const repairHints = analysis.sdk.diagnostics.some((item) => item.code === "MODS_SDK_UNVERIFIED")
    ? [
        "先按具体诊断区分原因。工具提供者未确认时，不要猜测或反复更改工具名；跨 Mod 协作优先通过 catalog(query:'platform.action',catalogSection:'events') 发现 on.capability，并通过 catalog(query:'platform.act',catalogSection:'sdk') 读取调用契约，实际提供者生效后再验证。SDK 根对象及 on 可传给当前已捕获包内、可唯一解析的具名函数或 const 函数，以简单且不可重新赋值的形参接收；相对导入可用，函数体仍逐方法检查。同一局部作用域的唯一直接调用且不逃逸的 helper 可捕获来源。明确 ui.render 原生 SDK 根及只读 const 别名保留词法 UI 回调；这是既有静态契约兼容，不证明外部回调或 SDK 生命周期获得新授权，仍受原生运行期 query/custody 约束。传入 helper 的新参数不继承 UI 例外。不要把 SDK 对象或方法传给动态或第三方调用，不得返回或存储 SDK；除上述原生 UI 词法兼容外，不得以闭包带出 SDK，也不要动态索引方法。按诊断文件和行号修复后，用当前草稿 revision 提交完整文件。"
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
