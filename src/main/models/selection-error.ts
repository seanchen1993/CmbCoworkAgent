/** A pinned selection is user intent, never permission to choose another provider. */
export class SelectedModelUnavailableError extends Error {
  readonly code = "PINNED_MODEL_UNAVAILABLE"
  constructor(
    requestedModelId: string,
    readonly reason: "missing_config" | "missing_credentials"
  ) {
    // Refs are user-controlled input. Never echo a URL, arbitrary display text or credentials.
    const ref = /^(?:(?:custom|builtin):)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestedModelId)
      ? `「${requestedModelId}」`
      : "所选模型"
    super(
      `${ref}${reason === "missing_config" ? "不存在或尚未配置" : "尚未配置 API 凭据"}。请打开“管理模型与 API 配置”${reason === "missing_config" ? "恢复配置，或明确选择其他模型" : "补齐该模型的 API 凭据"}后再试。`
    )
    this.name = "SelectedModelUnavailableError"
  }
}
