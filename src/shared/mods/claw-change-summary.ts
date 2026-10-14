import type { ClawProfile } from "./claw"

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  )

/** Describes changes without exposing configuration values or executing plugin code. */
export function clawChangeSummary(before: ClawProfile | null, after: ClawProfile | null): string[] {
  const changes: string[] = []
  const oldOrder = before?.capabilities.map((item) => item.pluginId) ?? []
  const nextOrder = after?.capabilities.map((item) => item.pluginId) ?? []
  if (
    oldOrder.length === nextOrder.length &&
    oldOrder.every((id) => nextOrder.includes(id)) &&
    canonical(oldOrder) !== canonical(nextOrder)
  )
    changes.push(`调整插件顺序：${after!.capabilities.map((item) => item.name).join(" → ")}`)
  if ((before?.builtins?.contextMeter === true) !== (after?.builtins?.contextMeter === true))
    changes.push(after?.builtins?.contextMeter ? "启用聊天容量提示" : "关闭聊天容量提示")
  for (const item of before?.capabilities ?? [])
    if (!after?.capabilities.some((next) => next.pluginId === item.pluginId))
      changes.push(`移除插件：${item.name}`)
  for (const item of after?.capabilities ?? []) {
    const prior = before?.capabilities.find((old) => old.pluginId === item.pluginId)
    if (!prior) changes.push(`添加插件：${item.name}`)
    if (prior && prior.digest !== item.digest) changes.push(`更新插件版本：${item.name}`)
    const scope = item.components?.mode === "selected" ? item.components.ids.join("、") : "全部功能"
    if (!prior || canonical(prior.components) !== canonical(item.components))
      changes.push(`使用功能：${item.name} · ${scope}`)
    const oldConfig = prior?.components?.config ?? {}
    for (const id of new Set([
      ...Object.keys(oldConfig),
      ...Object.keys(item.components?.config ?? {})
    ])) {
      const old = oldConfig[id] ?? {}
      const next = item.components?.config[id] ?? {}
      const fields = [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(
        (key) => canonical(old[key]) !== canonical(next[key])
      )
      if (fields.length) changes.push(`修改设置：${item.name}/${id} · ${fields.join("、")}`)
    }
  }
  for (const [key, label] of [
    ["models", "模型选择"],
    ["skills", "技能范围"],
    ["mcp", "工具范围"],
    ["completionRules", "组合的额外完成检查"]
  ] as const)
    if (canonical(before?.[key]) !== canonical(after?.[key])) changes.push(`调整${label}`)
  if (before?.flow?.digest !== after?.flow?.digest)
    changes.push(
      after?.flow ? `执行步骤：${after.flow.definition.name} · v${after.flow.revision}` : "不再预设执行步骤"
    )
  if (!after && before) changes.push("恢复原来的聊天设置")
  return changes
}
