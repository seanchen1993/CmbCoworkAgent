import { variants } from "./workflow.generated.ts"

export function relativePath(value, allowRoot = false) {
  if (allowRoot && value === ".") return "."
  if (typeof value !== "string" || !value || value.length > 240 ||
    value.startsWith("/") || /[\\:*?\[\]\x00-\x1f]/.test(value) ||
    value.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    throw Error("请使用当前项目内的相对路径，不能包含 ..、绝对路径或特殊设备名。")
  return value
}

export function recordsFrom(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ""))
  if (value?.schemaVersion !== "autobizdevops.state.v3" || !value.features ||
    typeof value.features !== "object" || Array.isArray(value.features))
    throw Error("仅支持 autobizdevops.state.v3；请使用原看板迁移状态格式。")
  const rows = Object.entries(value.features)
  if (rows.length > 100) throw Error("Feature 超过 100 个，请使用原项目看板。")
  return rows.map(([id, raw]) => {
    relativePath(id)
    if (id.includes("/")) throw Error("Feature 名称不能包含目录。")
    const record = typeof raw === "string" ? { checkpoint: raw } : raw
    if (!record || typeof record !== "object" || Array.isArray(record) ||
      typeof record.checkpoint !== "string" || (record.feature && record.feature !== id))
      throw Error(`Feature ${id} 的状态记录无效。`)
    return { ...record, feature: id }
  })
}

export function stageFor(record) {
  const template = record.workflowTemplate || "standard"
  const profile = record.workflowProfile === "base" ? "standard" : record.workflowProfile || "standard"
  const decisions = record.workflowDecisions ?? {}
  if (!decisions || typeof decisions !== "object" || Array.isArray(decisions) ||
    Object.keys(decisions).some(key => key !== "detail_design_before_code") ||
    (record.workflowNodes != null) || (record.workflowSkippedNodes?.length))
    throw Error("当前包含自定义或跳过节点，请使用原看板的动态工作流解析。")
  const decision = decisions.detail_design_before_code ?? ""
  if (!["", "enabled", "skipped"].includes(decision)) throw Error("动态阶段决策无效。")
  const nodes = variants[[template, profile, decision].join("|")]
  if (!nodes) throw Error("当前流程模板未纳入此版本，请使用原项目看板。")
  const blocked = record.checkpoint === "needs_fix"
  const checkpoint = blocked ? record.needsFixFromCheckpoint : record.checkpoint
  const node = nodes.find(n => n.checkpoints?.includes(checkpoint))
  if (!node) throw Error(`未知 checkpoint：${record.checkpoint}；不能推断为完成。`)
  const state = blocked ? "blocked" : checkpoint.endsWith("_done") || checkpoint === "archived"
    ? "done" : "in_progress"
  const next = node.states?.find(s => (s.nodeStatus || s.id) === state)?.nextAction?.slashSkill || ""
  const choice = template === "standard" &&
    (checkpoint === "prd_done" || (checkpoint === "plan_done" && !decision))
  return { node, state, next: blocked || choice ? "" : next, choice }
}

export function formatReport(record, stage, evidence) {
  const required = evidence.filter(e => e.required)
  const missing = required.filter(e => !e.present)
  return [
    `Feature：${record.feature}`,
    `当前阶段：${stage.node.label} · ${record.checkpoint}${stage.state === "blocked" ? "（需要修复）" : ""}`,
    `必需产物：${required.length - missing.length}/${required.length} 个非空文件已找到`,
    ...evidence.map(e => `${e.present ? "已找到" : e.required ? "缺失" : "可选未找到"} ${e.direction}：${e.path}`),
    stage.choice ? "下一步：先在原项目看板确认流程选择。" :
      stage.next ? `原流程建议：/${stage.next}（检查结果不会自动执行技能或推进状态）` : "下一步：请在原项目看板确认。",
    `原语义校验器：${(stage.node.validators || []).join("、") || "此阶段未配置"}（本命令未执行）`,
    "这里只检查产物存在且非空；不代表代码评审、测试或验收通过。"
  ].join("\n")
}

// Deliberately small glob contract. Other upstream patterns fail explicitly.
export function matchesArtifact(pattern, path) {
  if (pattern === "specs/**/*.md") return path.startsWith("specs/") && path.endsWith(".md")
  if (/[*?\[]/.test(pattern)) throw Error(`未支持的产物模式：${pattern}`)
  relativePath(pattern)
  return pattern === path || path.startsWith(pattern + "/")
}
