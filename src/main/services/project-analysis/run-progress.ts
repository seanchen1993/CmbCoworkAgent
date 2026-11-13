import type { ProjectAgentRunListener, ProjectAgentStep } from "../../../shared/project-agent-run"

/** Only operational steps and answer text are emitted, never prompts or model reasoning fields. */
export function createProjectRunReporter(listener?: ProjectAgentRunListener) {
  let sequence = 0
  const emit: ProjectAgentRunListener = (event) => {
    try {
      listener?.(event)
    } catch {
      /* Closing a renderer must not break cancellation/cleanup. */
    }
  }
  return {
    text: (stepId: string, text: string, reset = false) =>
      emit({ type: "text", stepId, text, reset }),
    begin(kind: ProjectAgentStep["kind"], title: string, detail?: string, input?: string) {
      const step: ProjectAgentStep = {
        id: `step-${++sequence}`,
        kind,
        title,
        detail,
        input,
        status: "running",
        startedAt: Date.now()
      }
      emit({ type: "step", step: { ...step } })
      return {
        id: step.id,
        update(detail: string) {
          emit({ type: "step", step: { ...step, detail } })
        },
        finish(detail?: string, output?: string, failed = false) {
          emit({
            type: "step",
            step: {
              ...step,
              detail: detail ?? step.detail,
              output,
              status: failed ? "failed" : "completed",
              elapsedMs: Date.now() - step.startedAt
            }
          })
        }
      }
    }
  }
}
export type ProjectRunReporter = ReturnType<typeof createProjectRunReporter>

export const PROJECT_TOOL_LABELS: Record<string, string> = {
  project_list: "查询项目列表",
  project_analysis: "查询项目分析指标",
  diagnose_projects: "诊断待关注项目",
  feature_stages: "查询特性阶段",
  feature_sessions: "查询对话记录",
  report_data: "查询报告周期数据",
  read_context: "回查完整上下文数据"
}
export function toolResultPreview(content: string): { detail: string; output: string } {
  try {
    const result = JSON.parse(content)
    const counts = [
      typeof result.examinedProjects === "number" ? `扫描 ${result.examinedProjects} 个项目` : "",
      typeof result.examinedFeatures === "number" ? `${result.examinedFeatures} 条分析记录` : "",
      typeof result.total === "number" ? `共 ${result.total} 条` : "",
      Array.isArray(result.rows) ? `本次返回 ${result.rows.length} 条` : "",
      result.nextOffset != null || result.nextCursor ? "可继续翻页" : ""
    ].filter(Boolean)
    const preview = JSON.stringify(result, null, 2)
    return {
      detail: counts.join(" · ") || "查询完成",
      output:
        preview.length > 4000
          ? `${preview.slice(0, 4000)}\n…（仅界面预览截短，完整结果已保留，可继续回查）`
          : preview
    }
  } catch {
    return { detail: "查询完成", output: content.slice(0, 4000) }
  }
}
