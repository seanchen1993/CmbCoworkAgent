import type { HarnessRunDetailViewModel } from "../../../../shared/harness-board-types"
import { LegacyProjectRuntimePanel } from "./LegacyProjectRuntimePanel"

/** Read-only summary of the original adapter; never presents historical hooks as current proof. */
export function ProjectRuntimeOverview({ detail }: { detail: HarnessRunDetailViewModel }) {
  const runtime = detail.projectRuntime
  if (!runtime) return null
  const snapshot = runtime.snapshot
  const current = snapshot?.stages.find(stage => stage.id === snapshot.currentStageId)
  const missing = current?.artifacts.filter(artifact => artifact.presence === "missing") ?? []
  const invalid = current?.artifacts.filter(artifact => artifact.validation === "invalid") ?? []
  return <section aria-label="项目运行概况" className="mb-4 space-y-2 rounded-xl border p-4">
    <h3 className="text-sm font-semibold">项目运行概况</h3>
    {runtime.description?.status === "ready" && runtime.description.manifest.mode === "legacy" &&
      <LegacyProjectRuntimePanel projectId={detail.project.projectId} />}
    {snapshot && <>
      <p className="text-sm">当前阶段：{current?.title ?? "待确认"}</p>
      <p className="text-xs text-muted-foreground">继续使用下方阶段的会话和审批入口。
        原项目插件负责检查和推进，这里展示它返回的状态。</p>
      {!!(missing.length || invalid.length) && <p className="text-sm">
        需要处理：{missing.length} 项产物缺失，{invalid.length} 项检查未通过。请在产物列表查看原因。</p>}
    </>}
    {(runtime.diagnostic || runtime.description?.status === "invalid") &&
      <p role="status" className="break-words text-xs text-muted-foreground">
        {runtime.diagnostic ?? (runtime.description?.status === "invalid" ? runtime.description.message : "")}
        原项目入口仍可使用。</p>}
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">来源与检查范围</summary>
      <p className="mt-2">这是原项目返回的阶段和产物概况；已有成功记录不能证明文件现在仍然有效。
        新运行声明只描述能力，不能代替执行授权或审批。</p>
      <p className="mt-1">{runtime.description?.status === "ready" ?
        `声明版本：${runtime.description.manifest.plugin.version}` : "未加载新运行声明，使用原项目适配。"}</p>
      {snapshot && <p className="mt-1 break-all">工作目录：{snapshot.binding.workspace}</p>}
    </details>
  </section>
}
