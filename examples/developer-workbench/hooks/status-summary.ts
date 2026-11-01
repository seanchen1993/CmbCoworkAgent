export interface WorkbenchStatusRow {
  provider: string
  label: string
  detail: string
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Deliberately excludes schemas and nested payloads. Catalog availability is not service state. */
export function workbenchStatusRow(
  ref: { provider: string; id: string; version: string },
  catalog: unknown,
  response: unknown
): WorkbenchStatusRow {
  let truncated = 0
  const scalar = (value: unknown): string | number | boolean | null => {
    if (typeof value === "string") {
      if (value.length > 180) {
        truncated++
        return value.slice(0, 180) + "…[截断]"
      }
      return value
    }
    return typeof value === "number" || typeof value === "boolean" || value === null ? value : null
  }
  const pick = (value: unknown, keys: string[]) => {
    const row = object(value),
      result: Record<string, unknown> = {}
    let omitted = 0
    for (const key of Object.keys(row)) {
      const v = row[key]
      if (!keys.includes(key) || (v !== null && typeof v === "object")) {
        omitted++
        continue
      }
      result[key] = scalar(v)
    }
    if (omitted) result.omittedFields = omitted
    return result
  }
  const directory = object(catalog),
    entries = Array.isArray(directory.capabilities) ? directory.capabilities : []
  const entry = entries.map(object).find((item) => {
    const candidate = object(item.ref)
    return (
      candidate.provider === ref.provider &&
      candidate.id === ref.id &&
      candidate.version === ref.version
    )
  })
  const state = object(response),
    value = object(state.value)
  const ready = state.status === "ready"
  let label: string
  if (ref.provider === "native.code")
    label =
      "Java服务：" +
      (!ready
        ? "状态未知"
        : value.status === "running"
          ? "运行中"
          : value.status === "unavailable"
            ? "未启动"
            : "状态未知")
  else if (ref.provider === "native.workspace")
    label =
      "文件变化：" +
      (!ready
        ? "状态未知"
        : value.observing === true
          ? "正在观察"
          : value.observing === false
            ? "未观察"
            : "状态未知")
  else if (ref.provider === "native.workflow") {
    label =
      "工作流：" +
      (!ready || value.status !== "ready"
        ? "状态未知"
        : typeof value.activeRunId === "string" && value.activeRunId
          ? "运行中"
          : value.activeRunId === null
            ? "无活动运行"
            : "状态未知")
  } else
    label =
      (ref.provider === "native.editor" ? "源码预览：" : "Git检查：") +
      (!ready
        ? "状态未知"
        : ref.provider === "native.editor" && value.mode === "source-text"
          ? "安全源文本"
          : ref.provider === "native.git" && value.readOnly === true
            ? "只读，需明确绑定仓库"
            : "状态未知")
  const detail: Record<string, unknown> = {
    ref,
    capabilitySource: entry
      ? pick(entry, ["available", "reason"])
      : { available: null, reason: "未发现或未知" },
    state: pick(state, ["status", "revision", "reason"]),
    source: pick(state.source, ["provider", "digest", "generation"]),
    observation: pick(value, [
      "status",
      "reason",
      "kind",
      "observing",
      "observationId",
      "mode",
      "language",
      "instanceId",
      "inFlight",
      "diagnostics",
      "activeRunId",
      "readOnly"
    ]),
    catalog: {
      total: entries.length,
      shown: entry ? 1 : 0,
      omitted: Math.max(0, entries.length - (entry ? 1 : 0))
    }
  }
  if (ref.provider === "native.workflow" && value.run !== null && typeof value.run === "object")
    detail.run = pick(value.run, ["id", "runId", "status"])
  detail.truncatedFields = truncated
  return { provider: ref.provider, label, detail: JSON.stringify(detail) }
}
