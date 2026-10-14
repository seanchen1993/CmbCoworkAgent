import { randomUUID } from "node:crypto"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import type { ModAuditEntry } from "../../../shared/mods/types"
import type {
  BuiltinPolicyScope,
  BuiltinPolicyDecision,
  BuiltinPolicyDecisionView
} from "../../../shared/mods/builtin-policy-metrics"

type Resolver = (threadId: string) => BuiltinPolicyScope | undefined
let resolver: Resolver | undefined
const entries = new Map<
  string,
  { scope: BuiltinPolicyScope; records: BuiltinPolicyDecision[]; limited: boolean }
>()
const explanations = {
  COMMAND_FORBIDDEN: ["原命令安全规则拒绝了本次执行。", "在原工具结果查看限制，改用允许的操作；自动批准设置不会解除该规则。"],
  HUMAN_APPROVAL_PENDING: ["原工具操作正在等待人工确认。", "在原会话的审批卡片中查看并决定。"],
  HUMAN_APPROVAL_ALLOWED: [
    "原工具审批已允许本次操作。",
    "继续查看原操作结果；批准不等于执行成功。"
  ],
  HUMAN_APPROVAL_DENIED: [
    "原工具审批未允许本次操作。",
    "查看原审批卡片；调整请求后重新提交，不绕过确认。"
  ],
  HUMAN_APPROVAL_CANCELLED: [
    "等待审批时运行已取消。",
    "本记录不说明外部操作结果；查看原运行终态。"
  ],
  HOOK_ALLOWED: ["该原 Hook 没有阻止本次事件。", "后续检查及其他 Hook 仍按原链执行。"],
  HOOK_BLOCKED: [
    "该原 Hook 阻止了本次事件。",
    "在原会话展开对应 Hook 结果，按其要求修正并重新验证。"
  ],
  HOOK_HUMAN_GATE: [
    "项目原 Hook 要求人工阶段确认。",
    "使用原项目会话的人工确认入口；此面板不批准阶段。"
  ],
  MODS_POLICY_TOOL_DENIED: [
    "宿主组织策略拒绝了该工具。",
    "请联系策略维护者核对原配置；关闭展示不会解除限制。"
  ],
  MODS_POLICY_ALLOWED: ["宿主组织策略允许了本次调用入场。", "工具权限和发布检查仍独立执行。"],
  PUBLICATION_BLOCKED: [
    "宿主发布检查拦截了本次输出。",
    "打开对应灵件调用的原审计记录核对规则；本面板不放行输出。"
  ],
  PUBLICATION_OBSERVED: [
    "已有调用记录保存了宿主发布规则。",
    "查看对应调用结果；记录不代表业务阶段通过。"
  ]
} as const
export type BuiltinPolicyReasonCode = keyof typeof explanations
export function registerBuiltinPolicyScopeResolver(next: Resolver): () => void {
  resolver = next
  return () => {
    if (resolver === next) {
      resolver = undefined
      entries.clear()
    }
  }
}
/** Only host code calls this. No arguments, command text, file paths or arbitrary reason text survive. */
export function observeBuiltinPolicyDecision(input: {
  threadId?: string
  workspace?: string
  id?: string
  source: BuiltinPolicyDecision["source"]
  scope?: BuiltinPolicyDecision["scope"]
  event: string
  decision: BuiltinPolicyDecision["decision"]
  code: BuiltinPolicyReasonCode
  policyDigest?: string
}): void {
  try {
    if (!input.threadId || !input.workspace) return
    const scope = resolver?.(input.threadId)
    if (!scope || !isSameWorkspacePath(scope.workspace, input.workspace)) return
    let entry = entries.get(scope.threadId)
    if (
      !entry ||
      entry.scope.incarnationKey !== scope.incarnationKey ||
      !isSameWorkspacePath(entry.scope.workspace, scope.workspace)
    ) {
      if (entries.size >= 100) entries.delete(entries.keys().next().value!)
      entry = { scope: { ...scope }, records: [], limited: false }
      entries.set(scope.threadId, entry)
    }
    const safeEvent = /^[a-zA-Z0-9_.:-]{1,100}$/.test(input.event)
      ? input.event
      : "original-operation"
    const copy = explanations[input.code]
    if (!copy) return
    const id = input.id ? `${input.source}:${input.id}` : randomUUID()
    const record: BuiltinPolicyDecision = {
      id,
      at: Date.now(),
      source: input.source,
      scope: input.scope ?? "host",
      event: safeEvent,
      decision: input.decision,
      ruleId: input.code,
      explanation: copy[0],
      nextStep: copy[1],
      policyDigest:
        input.policyDigest && /^[a-f0-9]{64}$/.test(input.policyDigest) ? input.policyDigest : null
    }
    entry.records = entry.records.filter((item) => item.id !== id)
    entry.records.push(record)
    if (entry.records.length > 100) {
      entry.records.shift()
      entry.limited = true
    }
  } catch {
    /* Observation never changes the original permission or hook outcome. */
  }
}
export function readBuiltinPolicyDecisions(
  scope: BuiltinPolicyScope,
  audits: readonly ModAuditEntry[] = []
): BuiltinPolicyDecisionView {
  const current = resolver?.(scope.threadId)
  if (
    !current ||
    current.incarnationKey !== scope.incarnationKey ||
    !isSameWorkspacePath(current.workspace, scope.workspace)
  )
    return {
      state: "unavailable",
      records: [],
      limited: false,
      explanation: "当前线程身份无法核实，没有可用决策记录。"
    }
  const entry = entries.get(scope.threadId)
  const records =
    entry?.scope.incarnationKey === scope.incarnationKey &&
    isSameWorkspacePath(entry.scope.workspace, scope.workspace)
      ? [...entry.records]
      : []
  for (const row of audits) {
    if (
      row.identity?.threadId !== scope.threadId ||
      !isSameWorkspacePath(row.identity.workspace, scope.workspace)
    )
      continue
    // Audit rows lack a thread incarnation. Only attach them when their call id was observed in this incarnation.
    if (!records.some((record) => record.id === `managed-policy:${row.callId}`)) continue
    if (!row.policyDigest && !row.ruleIds.length && row.publication !== "blocked") continue
    const code = row.publication === "blocked" ? "PUBLICATION_BLOCKED" : "PUBLICATION_OBSERVED"
    records.push({
      id: `publication:${row.callId}`,
      at: row.finishedAt ?? row.startedAt,
      source: "publication",
      scope: "host",
      event: "publication",
      decision: row.publication === "blocked" ? "deny" : "unknown",
      ruleId:
        row.ruleIds
          .filter((rule) => /^[a-zA-Z0-9_.:-]{1,100}$/.test(rule))
          .join(",")
          .slice(0, 400) || code,
      explanation: explanations[code][0],
      nextStep: explanations[code][1],
      policyDigest: row.policyDigest
    })
  }
  records.sort((a, b) => b.at - a.at)
  return {
    state: records.length ? "observed" : "unavailable",
    records: records.slice(0, 100),
    limited: !!entry?.limited || records.length > 100,
    explanation:
      "仅显示本进程当前线程身份实际观察的审批、原Hook和组织策略结果。无记录表示未知；关闭展示不改变原门禁。"
  }
}
