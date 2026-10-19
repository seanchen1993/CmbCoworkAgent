import { FunctionUserConfig } from "../customize/FunctionUserConfig"
import { useEffect, useRef, useState } from "react"
import type { ProjectFunctionSourceReview, ProjectFunctionSourceApi } from "../../../../shared/project-runtime/function-source"

/** Native consent for the package's exact code; never an install or a model-authored approval. */
export function ProjectFunctionConsent({
  projectId,
  version,
  onReady,
  api: providedApi,
  approvalLabel = "确认本包灵件权限"
}: {
  projectId: string
  version: number
  onReady(ready: boolean): void
  api?: ProjectFunctionSourceApi
  approvalLabel?: string
}) {
  const api = providedApi ?? window.api.harnessBoard.localProjects.mods
  const [review, setReview] = useState<ProjectFunctionSourceReview>()
  const [error, setError] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const generation = useRef(0)
  const refresh = async () => {
    const token = ++generation.current
    setError("")
    setConfirmed(false)
    onReady(false)
    try {
      const next = await api.read(projectId)
      if (token !== generation.current) return
      if (next.projectId !== projectId || next.projectVersion !== version)
        throw Error("PROJECT_INPUT_CHANGED")
      setReview(next)
      onReady(
        !next.source || (next.source.state === "ready" && next.source.configurationReady !== false)
      )
    } catch {
      if (token === generation.current)
        setError("无法核对本包功能与权限。请更新记录后重试；不会跳过本包功能执行。")
    }
  }
  useEffect(() => {
    void refresh()
    return () => {
      generation.current++
    }
  }, [projectId, version])
  if (!review?.source && !error) return null
  return (
    <section className="space-y-2 rounded border p-3 text-xs" aria-label="本包功能权限">
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        review?.source && (
          <>
            <p>本包灵件：{review.source.name}</p>
            <p className="break-all">源码摘要：{review.source.digest}</p>
            <p className="break-all">授权目录：{review.workspace}</p>
            <p>
              {review.source.state === "ready"
                ? "此目录已授权当前源码版本。"
                : review.source.state === "disabled"
                  ? "应用灵件功能已关闭，请先按原设置启用。"
                  : "当前源码版本尚未获准在此目录运行。"}
            </p>
            <p>
              静态识别的调用：{review.source.scannedMethods.join("、") || "未识别到直接 SDK 调用"}
            </p>
            {review.source.scanIncomplete && (
              <p>静态扫描不能覆盖所有动态调用，请核对完整能力范围和源码。</p>
            )}
            <details>
              <summary>完整授权范围</summary>
              <p className="break-words">{review.source.capabilities.join("、")}</p>
            </details>
            <p>授权沿用原灵件权限机制；文件、网络、进程和工具操作仍按原规则单独确认。</p>
            {review.workspaceEnabled === false && review.globallyEnabled !== false && (
              <p>
                确认权限将启用当前项目目录的灵件功能。同目录的其他聊天也会使用此前已授权的功能；不会启用其他目录或更改全局开关。
              </p>
            )}
            {review.source.hasConfiguration && (
              <>
                <FunctionUserConfig
                  threadId={projectId}
                  pluginId={review.source.pluginId ?? ""}
                  expectedWorkspace={review.workspace}
                  expectedDigest={review.source.digest}
                  initiallyOpen
                  api={api.config}
                  hideRuntimeControls
                  onSaved={() => void refresh()}
                />
                <p>
                  参数保存在本项目的工作目录，下一次项目操作使用新值；保存参数不等于授权代码运行。
                </p>
              </>
            )}
            {review.source.configurationReady === false && (
              <p role="alert">请先补齐必需参数或确认配置迁移，再授权并运行本包功能。</p>
            )}
            {review.source.state === "needs-approval" && (
              <>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    disabled={busy}
                  />
                  我已核对本包源码版本、目录及完整能力范围，允许此版本在本目录运行，并按需启用本目录的灵件功能。
                </label>
                <button
                  type="button"
                  disabled={!confirmed || busy || review.source.configurationReady === false}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                  onClick={async () => {
                    if (pending.current || !review?.source) return
                    pending.current = true
                    setBusy(true)
                    const token = generation.current
                    try {
                      const next = await api.approve({
                        projectId,
                        projectVersion: review.projectVersion,
                        packageDigest: review.packageDigest,
                        compiledDigest: review.source.digest
                      })
                      if (token !== generation.current) return
                      setConfirmed(false)
                      setReview(next)
                      onReady(
                        next.projectId === projectId &&
                          next.projectVersion === version &&
                          next.source?.state === "ready" &&
                          next.source.configurationReady !== false
                      )
                    } catch (cause) {
                      if (token === generation.current) {
                        setError(
                          cause instanceof Error &&
                            cause.message.includes("PROJECT_MODS_WORKSPACE_ENABLE_UNCONFIRMED")
                            ? "灵件授权已记录，但目录启用结果尚未确认。请重新核对本包权限和目录开关；不会自动执行任务。"
                            : "本包授权未完成。请重新核对源码、参数、项目目录和全局开关后再确认；不会自动执行任务。"
                        )
                        onReady(false)
                      }
                    } finally {
                      pending.current = false
                      if (token === generation.current) setBusy(false)
                    }
                  }}
                >
                  {approvalLabel}
                </button>
              </>
            )}
          </>
        )
      )}
      <button type="button" disabled={busy} className="underline" onClick={() => void refresh()}>
        重新核对本包权限
      </button>
    </section>
  )
}
