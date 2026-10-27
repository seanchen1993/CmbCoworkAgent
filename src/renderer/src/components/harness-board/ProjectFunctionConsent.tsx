import { FunctionUserConfig } from "../customize/FunctionUserConfig"
import { useEffect, useRef, useState } from "react"
import type {
  ProjectFunctionSourceReview,
  ProjectFunctionSourceApi,
  ProjectFunctionDependencyReview
} from "../../../../shared/project-runtime/function-source"

interface Props {
  projectId: string
  version: number
  onReady(ready: boolean): void
  api?: ProjectFunctionSourceApi
  approvalLabel?: string
}

type Source = NonNullable<ProjectFunctionSourceReview["source"]> | ProjectFunctionDependencyReview
const needsExecution = (review: ProjectFunctionSourceReview) =>
  Boolean((review.source && !review.source.configurationOnly) || review.dependencies?.length)
const sourceIdentity = (review: ProjectFunctionSourceReview) =>
  JSON.stringify({
    source: review.source
      ? [review.source.pluginId, review.source.name, review.source.digest]
      : null,
    dependencies: (review.dependencies ?? [])
      .map((source) => [source.pluginId, source.digest, [...source.actionIds].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  })
const ready = (review: ProjectFunctionSourceReview) =>
  (!needsExecution(review) ||
    (review.workspaceEnabled !== false && review.globallyEnabled !== false)) &&
  (!review.source ||
    (review.source.state === "ready" && review.source.configurationReady !== false)) &&
  (review.dependencies ?? []).every(
    (source) => source.state === "ready" && source.configurationReady !== false
  )

/** Native consent for exact retained sources; never an install or a model-authored approval. */
export function ProjectFunctionConsent(props: Props) {
  return (
    <ProjectFunctionConsentScope
      key={JSON.stringify([props.projectId, props.version])}
      {...props}
    />
  )
}

function ProjectFunctionConsentScope({
  projectId,
  version,
  onReady,
  api: providedApi,
  approvalLabel = "确认本包灵件权限"
}: Props) {
  const api = providedApi ?? window.api.harnessBoard.localProjects.mods
  const [review, setReview] = useState<ProjectFunctionSourceReview>()
  const [error, setError] = useState("")
  const [confirmed, setConfirmed] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<boolean>()
  useEffect(() => {
    if (review) setExpanded(!ready(review))
  }, [review])
  const pending = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(false)
  const accept = (next: ProjectFunctionSourceReview, previous?: ProjectFunctionSourceReview) => {
    if (
      next.projectId !== projectId ||
      next.projectVersion !== version ||
      (previous &&
        (next.packageDigest !== previous.packageDigest ||
          next.workspace !== previous.workspace ||
          sourceIdentity(next) !== sourceIdentity(previous)))
    )
      throw Error("PROJECT_INPUT_CHANGED")
    setReview(next)
    onReady(ready(next))
  }
  const refresh = async () => {
    const token = ++generation.current
    setError("")
    setConfirmed(undefined)
    onReady(false)
    try {
      const next = await api.read(projectId)
      if (token !== generation.current || !mounted.current) return
      accept(next)
    } catch {
      if (token === generation.current && mounted.current)
        setError("无法核对本包及依赖功能与权限。请更新记录后重试；不会跳过所需功能执行。")
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [projectId, version, api])

  const approve = async (source: Source, dependency: boolean) => {
    if (pending.current || !review) return
    pending.current = true
    setBusy(true)
    onReady(false)
    const token = generation.current
    try {
      const input = {
        projectId,
        projectVersion: review.projectVersion,
        packageDigest: review.packageDigest,
        compiledDigest: source.digest
      }
      let next: ProjectFunctionSourceReview
      if (dependency) {
        if (!api.approveDependency || !source.pluginId)
          throw Error("PROJECT_DEPENDENCY_APPROVAL_UNAVAILABLE")
        next = await api.approveDependency({ ...input, pluginId: source.pluginId })
      } else next = await api.approve(input)
      if (token !== generation.current || !mounted.current) return
      setConfirmed(undefined)
      accept(next, review)
    } catch (cause) {
      if (token === generation.current && mounted.current) {
        setError(
          cause instanceof Error &&
            cause.message.includes("PROJECT_MODS_WORKSPACE_ENABLE_UNCONFIRMED")
            ? "灵件授权已记录，但目录启用结果尚未确认。请重新核对权限和目录开关；不会自动执行任务。"
            : "授权未完成。请重新核对源码、参数、项目目录和全局开关后再确认；不会自动执行任务。"
        )
        onReady(false)
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (!review?.source && !review?.dependencies?.length && !error) return null
  const sources: Array<{ source: Source; dependency: boolean }> = [
    ...(review?.source ? [{ source: review.source, dependency: false }] : []),
    ...(review?.dependencies ?? []).map((source) => ({ source, dependency: true }))
  ]
  return (
    <section aria-label="本包功能权限">
      <details
        className="space-y-2 rounded border p-3 text-xs"
        open={expanded ?? (!review || !ready(review))}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm font-medium">
          项目设置 · {review && ready(review) ? "已就绪" : "待完成"}
        </summary>
        {review && needsExecution(review) && review.globallyEnabled === false && (
          <p role="alert">应用灵件功能已关闭，请在原设置中启用后重新核对。不会自动更改全局开关。</p>
        )}
        {review && needsExecution(review) && review.workspaceEnabled === false && (
          <p role="status">当前项目目录尚未启用灵件功能，请完成下方原生确认后再执行。</p>
        )}
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          review &&
          sources.map(({ source, dependency }) => {
            const configurationOnly =
              "configurationOnly" in source && source.configurationOnly === true
            const key = JSON.stringify([dependency, source.pluginId, source.digest])
            const label = dependency ? `依赖功能：${source.name}` : "本包权限与参数"
            const unavailable = !["ready", "needs-approval"].includes(source.state)
            return (
              <section key={key} aria-label={label} className="space-y-2 rounded border p-2">
                <p>
                  {dependency ? "依赖功能" : configurationOnly ? "本包原生配置" : "本包灵件"}：
                  {source.name}
                </p>
                <p className="break-all">
                  {configurationOnly ? "配置目录" : "授权目录"}：{review.workspace}
                </p>
                <p>
                  {configurationOnly
                    ? review.dependencies?.length
                      ? "主包只声明原生参数，不运行 Mod 代码，也不需要授予虚拟机权限。下列依赖功能仍需分别核对参数和授权，全部就绪后才能执行阶段。"
                      : "此包只声明原生参数，不运行 Mod 代码，也不需要授予虚拟机权限。参数就绪后，阶段操作仍须按原流程确认。"
                    : source.state === "ready"
                      ? "此目录已授权当前源码版本。"
                      : source.state === "disabled"
                        ? "此功能或应用灵件开关已关闭，请先按原设置启用，再重新核对。"
                        : source.state === "missing"
                          ? "缺少项目锁定的依赖插件。请通过原插件安装入口安装对应版本后重新核对。"
                          : source.state === "source-changed"
                            ? "已安装依赖与项目锁定的源码摘要不一致。请恢复对应版本，或按原项目更新流程重新审核；不能直接批准不同源码。"
                            : source.state === "invalid"
                              ? "依赖功能无法通过原生检查。请修复插件或参数后重新核对。"
                              : "当前源码版本尚未获准在此目录运行。"}
                </p>
                {!configurationOnly && (
                  <>
                    <details className="text-muted-foreground">
                      <summary className="cursor-pointer">来源与能力</summary>
                      <p className="break-all">源码摘要：{source.digest}</p>
                      {dependency && "actionIds" in source && (
                        <p>项目使用的动作：{source.actionIds.join("、")}</p>
                      )}
                      {"scannedMethods" in source && (
                        <p>
                          静态识别的调用：
                          {source.scannedMethods.join("、") || "未识别到直接 SDK 调用"}
                        </p>
                      )}
                      {"scanIncomplete" in source && source.scanIncomplete && (
                        <p>静态扫描不能覆盖所有动态调用，请核对完整能力范围和源码。</p>
                      )}
                      <details>
                        <summary>完整授权范围</summary>
                        <p className="break-words">{source.capabilities.join("、")}</p>
                      </details>
                      <p>授权沿用原灵件权限机制；文件、网络、进程和工具操作仍按原规则单独确认。</p>
                    </details>
                  </>
                )}
                {!configurationOnly &&
                  review.workspaceEnabled === false &&
                  review.globallyEnabled !== false && (
                    <p>
                      确认权限将启用当前项目目录的灵件功能。同目录的其他聊天也会使用此前已授权的功能；不会启用其他目录或更改全局开关。
                    </p>
                  )}
                {source.hasConfiguration && (!dependency || !unavailable) && (
                  <>
                    <FunctionUserConfig
                      threadId={projectId}
                      pluginId={source.pluginId ?? ""}
                      expectedWorkspace={review.workspace}
                      expectedDigest={source.digest}
                      initiallyOpen={source.configurationReady === false}
                      api={api.config}
                      hideRuntimeControls
                      onSaved={() => void refresh()}
                    />
                  </>
                )}
                {source.configurationReady === false && (
                  <p role="alert">请先补齐必需参数或确认配置迁移，再授权并运行此功能。</p>
                )}
                {!configurationOnly && source.state === "needs-approval" && (
                  <>
                    {dependency && !api.approveDependency && (
                      <p role="alert">当前入口暂不支持依赖授权，请更新应用后重新核对。</p>
                    )}
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={confirmed === key}
                        onChange={(event) => setConfirmed(event.target.checked ? key : undefined)}
                        disabled={busy}
                      />
                      允许{dependency ? "此依赖" : "此插件"}在上方目录运行
                    </label>
                    <button
                      type="button"
                      disabled={
                        confirmed !== key ||
                        busy ||
                        source.configurationReady === false ||
                        (dependency && !api.approveDependency)
                      }
                      className="rounded border px-2 py-1 disabled:opacity-50"
                      onClick={() => void approve(source, dependency)}
                    >
                      {dependency ? `确认依赖权限：${source.name}` : approvalLabel}
                    </button>
                  </>
                )}
              </section>
            )
          })
        )}
        <button type="button" disabled={busy} className="underline" onClick={() => void refresh()}>
          {review?.dependencies?.length
            ? "重新核对本包及依赖权限"
            : review?.source?.configurationOnly
              ? "重新核对本包参数"
              : "重新核对本包权限"}
        </button>
      </details>
    </section>
  )
}
