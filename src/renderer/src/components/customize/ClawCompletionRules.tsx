import { useEffect, useState } from "react"
import type { ClawProfile } from "../../../../shared/mods/claw"
import { mergeClawCompletionPolicy } from "../../../../shared/mods/claw-completion"
import {
  DEFAULT_COMPLETION_POLICY,
  type CompletionPolicyView,
  type CompletionCheck,
  type CompletionMode,
  type CompletionScope
} from "../../../../shared/mods/v2/completion-policy-values"
import { Button } from "@/components/ui/button"

const checks: Record<CompletionCheck, string> = {
  "code-review": "代码检视",
  "unit-test": "单元测试",
  e2e: "完整操作测试",
  "autobiz-validator": "Autobiz 验收"
}
const modes: Record<CompletionMode, string> = {
  off: "未开启额外检查",
  report: "只展示检查结果",
  check: "检查通过才能完成",
  repair: "检查并尝试修复"
}
const scopes: Record<CompletionScope, string> = {
  file: "指定文件",
  diff: "本次改动",
  feature: "当前需求",
  project: "整个项目"
}
export function ClawCompletionRules({
  threadId,
  value,
  disabled,
  onChange
}: {
  threadId: string
  value: ClawProfile
  disabled: boolean
  onChange(profile: ClawProfile): void
}) {
  const [policies, setPolicies] = useState<Record<string, CompletionPolicyView>>({})
  const [error, setError] = useState("")
  const sources = JSON.stringify(
    value.capabilities.map(({ name, pluginId }) => ({ name, pluginId }))
  )
  useEffect(() => {
    let alive = true
    let reading = 0
    const refresh = async () => {
      const request = ++reading
      try {
        const rows = await Promise.all(
          (JSON.parse(sources) as { name: string; pluginId: string }[]).map(
            async (item) =>
              [item.pluginId, await window.api.mods.completionPolicy(threadId, item.name)] as const
          )
        )
        if (alive && request === reading) {
          setPolicies(Object.fromEntries(rows))
          setError("")
        }
      } catch {
        if (alive && request === reading) {
          setPolicies({})
          setError("暂时无法读取项目检查规则。项目原有的必需检查仍会执行。")
        }
      }
    }
    void refresh()
    const stop = window.api.mods.onConfigurationChanged(() => void refresh())
    return () => {
      alive = false
      stop()
    }
  }, [threadId, sources])
  const update = (
    pluginId: string,
    rule: NonNullable<ClawProfile["completionRules"]>[number] | null
  ) =>
    onChange({
      ...value,
      completionRules: [
        ...(value.completionRules ?? []).filter((item) => item.pluginId !== pluginId),
        ...(rule ? [rule] : [])
      ]
    })
  return (
    <section className="space-y-3 rounded-xl border bg-muted/20 p-4" aria-label="组合完成检查">
      <h3 className="text-sm font-semibold">任务完成前检查什么</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        在项目必需检查之外，为这套组合增加检查项。保存并应用后生效；不会因此获得自动修复或推进项目阶段的权限。
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!value.capabilities.length && (
        <p className="text-xs text-muted-foreground">
          选择灵件的全部功能后，可以增加任务结束前的检查。
        </p>
      )}
      {value.capabilities.map((capability) => {
        const project = policies[capability.pluginId]?.policy
        const rule = value.completionRules?.find((item) => item.pluginId === capability.pluginId)
        let effective = ""
        try {
          const merged = mergeClawCompletionPolicy(project, rule?.policy)
          if (merged && merged.mode !== "off")
            effective = `${merged.mode === "report" ? "报告" : "必须通过"}：${merged.checks.map((id) => checks[id]).join("、")}`
        } catch (cause) {
          effective = cause instanceof Error ? cause.message : String(cause)
        }
        return (
          <div className="space-y-2 rounded-lg border bg-background p-3" key={capability.pluginId}>
            <p className="text-sm font-medium">{capability.name}</p>
            <p className="text-xs text-muted-foreground">
              项目规则：
              {project
                ? project.mode === "off"
                  ? modes.off
                  : `${modes[project.mode]} · ${scopes[project.scope]} · ${project.checks.map((id) => checks[id]).join("、")}`
                : "读取中或不可用"}
            </p>
            {!rule ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || !project || capability.components?.mode === "selected"}
                onClick={() => {
                  const base =
                    project?.mode !== "off" && project
                      ? project
                      : {
                          ...DEFAULT_COMPLETION_POLICY,
                          scope: "diff" as const,
                          checks: ["code-review" as const]
                        }
                  const policy = { ...base }
                  delete policy.autobizStartCheckpoint
                  update(capability.pluginId, {
                    pluginId: capability.pluginId,
                    name: capability.name,
                    digest: capability.digest,
                    policy: { ...policy, mode: "check", maxRepairs: 0 }
                  })
                }}
              >
                添加检查要求
              </Button>
            ) : (
              <fieldset disabled={disabled} className="space-y-2">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs">
                    检查不通过时
                    <select
                      aria-label={`附加模式 ${capability.name}`}
                      className="rounded-lg border bg-background p-2"
                      value={rule.policy.mode}
                      onChange={(e) =>
                        update(capability.pluginId, {
                          ...rule,
                          policy: { ...rule.policy, mode: e.target.value as "report" | "check" }
                        })
                      }
                    >
                      <option value="check">阻止任务完成</option>
                      <option value="report">只展示问题</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs">
                    检查范围
                    <select
                      aria-label={`附加范围 ${capability.name}`}
                      className="rounded-lg border bg-background p-2"
                      disabled={project?.mode !== "off"}
                      value={rule.policy.scope}
                      onChange={(e) =>
                        update(capability.pluginId, {
                          ...rule,
                          policy: { ...rule.policy, scope: e.target.value as "diff" | "project" }
                        })
                      }
                    >
                      <option value="diff">本次代码改动</option>
                      <option value="project">整个项目</option>
                      {!["diff", "project"].includes(rule.policy.scope) && (
                        <option value={rule.policy.scope}>与项目一致：{scopes[rule.policy.scope]}</option>
                      )}
                    </select>
                  </label>
                </div>
                <div className="flex flex-wrap gap-3">
                  {Object.entries(checks).map(([id, name]) => (
                    <label className="flex items-center gap-1 text-xs" key={id}>
                      <input
                        type="checkbox"
                        aria-label={`附加检查 ${capability.name} · ${name}`}
                        checked={rule.policy.checks.includes(id as CompletionCheck)}
                        onChange={(e) =>
                          update(capability.pluginId, {
                            ...rule,
                            policy: {
                              ...rule.policy,
                              checks: e.target.checked
                                ? [...rule.policy.checks, id as CompletionCheck]
                                : rule.policy.checks.filter((entry) => entry !== id)
                            }
                          })
                        }
                      />
                      {name}
                    </label>
                  ))}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => update(capability.pluginId, null)}
                >
                  移除额外检查
                </Button>
              </fieldset>
            )}
            {capability.components?.mode === "selected" && (
              <p className="text-xs text-muted-foreground">
                额外完成检查需要选择全部功能；只选部分功能时，项目必需的检查仍然生效。
              </p>
            )}
            {effective && <p className="text-xs">最终要求：{effective}</p>}
          </div>
        )
      })}
    </section>
  )
}
