import { FunctionUserConfig } from "../customize/FunctionUserConfig"
import { useEffect, useRef, useState } from "react"
import { openPluginSettings } from "../../lib/plugin-settings-intent"
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
  approvalLabel = "允许本包在当前目录运行"
}: Props) {
  const api = providedApi ?? window.api.harnessBoard.localProjects.mods
  const [review, setReview] = useState<ProjectFunctionSourceReview>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<boolean>()
  const expansionReview = useRef<{ identity: string; ready: boolean } | undefined>(undefined)
  useEffect(() => {
    if (!review) return
    const next = {
      identity: JSON.stringify([review.workspace, review.packageDigest, sourceIdentity(review)]),
      ready: ready(review)
    }
    const previous = expansionReview.current
    expansionReview.current = next
    if (!previous || previous.identity !== next.identity) setExpanded(!next.ready)
    else if (previous.ready && !next.ready) setExpanded(true)
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
    onReady(false)
    try {
      const next = await api.read(projectId)
      if (token !== generation.current || !mounted.current) return
      accept(next)
    } catch {
      if (token === generation.current && mounted.current)
        setError("无法读取插件权限。请点击“重新核对”；若仍失败，请重新打开项目。")
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
      accept(next, review)
    } catch (cause) {
      if (token === generation.current && mounted.current) {
        setError(
          cause instanceof Error &&
            cause.message.includes("PROJECT_MODS_WORKSPACE_ENABLE_UNCONFIRMED")
            ? "授权已保存，目录启用结果尚未确认。请点击“重新核对”后确认目录状态。"
            : "授权未完成。请点击“重新核对”，按提示补齐参数、恢复插件版本或开启应用功能后重试。"
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
          <p role="alert">应用插件功能已关闭。请在“插件”中开启应用功能后，返回此处重新核对。</p>
        )}
        {review && needsExecution(review) && review.workspaceEnabled === false && (
          <p role="status">当前目录尚未启用插件功能，请在下方确认后再执行。</p>
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
                  {dependency ? "依赖功能" : configurationOnly ? "本包原生配置" : "本包插件"}：
                  {source.name}
                </p>
                <p className="break-all">
                  {configurationOnly ? "配置目录" : "授权目录"}：{review.workspace}
                </p>
                <p>
                  {configurationOnly
                    ? review.dependencies?.length
                      ? "主包仅需配置参数；请完成下列依赖的参数与授权。"
                      : "此包仅需配置参数，无需代码运行授权。"
                    : source.state === "ready"
                      ? "此目录已授权当前源码版本。"
                      : source.state === "disabled"
                        ? "此插件已停用或应用功能已关闭。请恢复对应开关后重新核对。"
                        : source.state === "missing"
                          ? "缺少项目锁定的插件。请在“插件 → 导入与发布”安装对应版本后重新核对。"
                          : source.state === "source-changed"
                            ? "插件版本与此项目锁定的源码不一致。请恢复对应版本，或重新审核项目更新。"
                            : source.state === "invalid"
                              ? "插件未通过检查。请修复插件或参数后重新核对。"
                              : "当前源码版本尚未获准在此目录运行。"}
                </p>
                {!configurationOnly && (
                  <>
                    <details className="text-muted-foreground">
                      <summary className="cursor-pointer">
                        能力与源码详情（{source.capabilities.length} 项）
                      </summary>
                      <p className="mt-2 break-words">
                        授权范围：{source.capabilities.join("、") || "未声明额外能力"}
                      </p>
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
                      <p>文件、网络、进程和工具操作仍按原规则确认；模型请求会产生实际用量。</p>
                    </details>
                  </>
                )}
                {!configurationOnly &&
                  review.workspaceEnabled === false &&
                  review.globallyEnabled !== false && (
                    <p>
                      确认后启用当前目录，同目录其他聊天也会恢复此前已授权的功能；不更改其他目录或应用开关。
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
                  <p role="alert">请先补齐上方必填参数或确认配置迁移。</p>
                )}
                {unavailable && source.pluginId && source.state !== "missing" && (
                  <button
                    type="button"
                    className="underline"
                    disabled={busy}
                    onClick={() => openPluginSettings(source.pluginId!)}
                  >
                    打开对应插件
                  </button>
                )}
                {!configurationOnly &&
                  (source.state === "needs-approval" ||
                    (source.state === "ready" && review.workspaceEnabled === false)) && (
                    <>
                      {dependency && !api.approveDependency && (
                        <p role="alert">当前入口暂不支持依赖授权，请更新应用后重新核对。</p>
                      )}
                      <p className="text-muted-foreground">点击即允许此源码版本在上方目录运行。</p>
                      <button
                        type="button"
                        disabled={
                          busy ||
                          review.globallyEnabled === false ||
                          source.configurationReady === false ||
                          (dependency && !api.approveDependency)
                        }
                        className="rounded border px-2 py-1 disabled:opacity-50"
                        onClick={() => void approve(source, dependency)}
                      >
                        {source.state === "ready"
                          ? "确认此版本并启用目录"
                          : dependency
                            ? `允许依赖在当前目录运行：${source.name}`
                            : approvalLabel}
                      </button>
                    </>
                  )}
              </section>
            )
          })
        )}
        <button type="button" disabled={busy} className="underline" onClick={() => void refresh()}>
          重新核对
        </button>
      </details>
    </section>
  )
}
