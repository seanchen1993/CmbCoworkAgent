import type { useProjectUseReview } from "./use-project-use-review"
import { developmentCapabilitySummary } from "../customize/development-trial-view"

export function ProjectUseConsent({
  state,
  editing = false
}: {
  state: ReturnType<typeof useProjectUseReview>
  editing?: boolean
}) {
  const { review, pending, error, refresh } = state
  if (pending)
    return (
      <p role="status" className="mt-3 text-xs">
        正在核对插件及依赖权限…
      </p>
    )
  if (error)
    return (
      <div className="mt-3 space-y-2 text-xs">
        <p role="alert">{error}</p>
        <button type="button" onClick={refresh} className="underline">
          重新核对
        </button>
      </div>
    )
  if (!review) return null
  const executable = review.sources.filter((source) => !source.configurationOnly)
  const dependencyCount = review.sources.filter(
    (source) => source.pluginId !== review.plugin.pluginId
  ).length
  const capabilities = [...new Set(executable.flatMap((source) => source.capabilities))]
  const summary = developmentCapabilitySummary(capabilities)
  const primary = [
    /调用模型/,
    /运行本地进程/,
    /修改当前目标的文件|读取当前目标的文件/,
    /访问网络服务/
  ]
    .map((pattern) => summary.find((label) => pattern.test(label)))
    .filter((label): label is string => !!label)
  const visibleSummary = primary.length ? primary : summary.slice(0, 2)
  return (
    <div
      className="mt-3 space-y-2 rounded-md border border-border p-3 text-xs"
      aria-label="创建项目时授权"
    >
      <p className="font-medium">
        {review.plugin.name}
        {dependencyCount > 0 ? ` · 含 ${dependencyCount} 个依赖组件` : ""}
      </p>
      {review.authorizationCurrent ? (
        <p>已沿用创建项目时的授权。点击“保存”只更新项目信息，不更改插件或目录开关。</p>
      ) : executable.length > 0 ? (
        <>
          <p>
            点击“{editing ? "保存并授权" : "创建并授权"}”，一次允许本项目及依赖使用以下能力。
            后续新建特性和会话沿用本次授权。
          </p>
          {visibleSummary.length > 0 && (
            <p>主要能力：{visibleSummary.join("；")}。完整范围见下方明细。</p>
          )}
        </>
      ) : (
        <p>{review.sources.length > 0
          ? "此插件只需配置参数，无需代码运行授权。"
          : "此插件无需额外的插件代码运行授权。"}</p>
      )}
      {!review.authorizationCurrent && <p>{review.scopeNotice}</p>}
      <details className="text-muted-foreground">
        <summary className="cursor-pointer">查看组件和权限明细</summary>
        {summary.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {summary.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 break-all">项目目录：{review.workspace}</p>
        {review.sources.map((source) => (
          <div key={source.pluginId} className="mt-2">
            <p>
              {source.name}：
              {source.configurationOnly
                ? "配置参数"
                : source.capabilities.join("、") || "未声明额外能力"}
            </p>
            <p className="break-all">源码摘要：{source.digest}</p>
            {source.actionIds.length > 0 && <p>使用的动作：{source.actionIds.join("、")}</p>}
          </div>
        ))}
      </details>
      <button type="button" onClick={refresh} className="underline text-muted-foreground">
        重新核对
      </button>
    </div>
  )
}
