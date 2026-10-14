import { AuthoringPreparationRecovery } from "./AuthoringPreparationRecovery"
import { AuthoringRetentionPanel } from "./AuthoringRetentionPanel"
import { AuthoringRecoveryPanel } from "./AuthoringRecoveryPanel"
import { useEffect, useRef, useState } from "react"
import type { AuthoringDocument } from "../../../../shared/mods/authoring"
import type {
  AuthoringInstallApi,
  AuthoringInstallationSummary,
  AuthoringPreparedInstallation,
  AuthoringInstallErrorCode,
  AuthoringInstallResult
} from "../../../../shared/mods/authoring-install"

const button = "rounded border px-3 py-2 text-sm disabled:opacity-50"
let nextInstallRequest = 0
const messages: Record<AuthoringInstallErrorCode, string> = {
  BUSY: "当前还有任务、插件或安装操作在运行。待安装版本已保留，请结束后重试。",
  STALE: "项目或插件文件已变化，请刷新安装记录，再准备要安装的版本。",
  INVALID: "这个版本暂时无法安装。若缺少历史设置，可取消勾选“同时恢复这个版本保存的设置”后重试。",
  LIMIT: "保存的版本或安装记录已满，请在下方清理不再需要的旧版本。",
  CANCELLED: "准备已取消，当前安装和组合未改变。",
  FAILED: "操作未完成，请重新刷新安装记录核对结果。"
}
function unwrap<T>(result: AuthoringInstallResult<T>): T {
  if (!result.ok) throw Error(result.code)
  return result.value
}
interface Props {
  threadId: string
  workspace: string
  document: AuthoringDocument
  dirty: boolean
  api?: AuthoringInstallApi
  onSettled?: (candidate: AuthoringPreparedInstallation) => void
  onReconciled?: () => void
}
export function AuthoringInstallPanel(props: Props): React.JSX.Element {
  return (
    <Installation
      key={JSON.stringify([
        props.threadId,
        props.workspace,
        props.document.id,
        props.document.currentRevision,
        props.document.source.digest
      ])}
      {...props}
    />
  )
}
function Installation({
  threadId,
  workspace,
  document,
  dirty,
  api,
  onSettled,
  onReconciled
}: Props): React.JSX.Element {
  const [opened, setOpened] = useState(false)
  const [rows, setRows] = useState<AuthoringInstallationSummary[]>([])
  const [selected, setSelected] = useState("")
  const [restoreConfiguration, setRestoreConfiguration] = useState(false)
  const [candidate, setCandidate] = useState<AuthoringPreparedInstallation | null>(null)
  const [phase, setPhase] = useState<"idle" | "reading" | "preparing" | "cancelling" | "applying">(
    "idle"
  )
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const alive = useRef(true),
    pending = useRef(false),
    request = useRef<string | null>(null)
  const cancelled = useRef(false),
    cancelling = useRef(false)
  const scope = { threadId, expectedWorkspace: workspace }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (request.current && api)
        void api
          .cancel({ threadId, expectedWorkspace: workspace, requestId: request.current })
          .catch(() => {})
    }
  }, [api, threadId, workspace])
  const perform = async (next: typeof phase, action: () => Promise<void>) => {
    if (!api || pending.current) return
    pending.current = true
    setPhase(next)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (error) {
      if (alive.current) {
        const code =
          error instanceof Error && error.message in messages
            ? (error.message as AuthoringInstallErrorCode)
            : "FAILED"
        setError(messages[code])
        if (next === "applying" && code !== "BUSY") {
          setCandidate(null)
          request.current = null
        }
      }
    } finally {
      if (alive.current && !cancelling.current) {
        pending.current = false
        setPhase("idle")
      }
    }
  }
  const read = () =>
    perform("reading", async () => {
      const value = unwrap(await api!.list(threadId))
      if (!alive.current) return
      if (value.workspace !== workspace) throw Error("STALE")
      setRows(value.installations)
      setOpened(true)
    })
  const prepare = (rollback: boolean) =>
    perform("preparing", async () => {
      if (dirty || candidate) throw Error("INVALID")
      const requestId = `install-${Date.now()}-${++nextInstallRequest}`
      request.current = requestId
      cancelled.current = false
      const [installationId, versionId] = selected.split("/")
      const value = unwrap(
        rollback
          ? await api!.rollbackPrepare({
              ...scope,
              requestId,
              installationId,
              versionId,
              restoreConfiguration
            })
          : await api!.prepare({
              ...scope,
              requestId,
              draftId: document.id,
              revision: document.currentRevision,
              sourceDigest: document.source.digest
            })
      )
      if (!alive.current || cancelled.current || request.current !== requestId) return
      if (
        (!rollback &&
          (value.sourceDigest !== document.source.digest || value.configuration !== "unchanged")) ||
        (rollback &&
          (value.installationId !== installationId ||
            value.restoredFromVersionId !== versionId ||
            value.configuration !== (restoreConfiguration ? "restore" : "unchanged")))
      ) {
        await api!.cancel({ ...scope, requestId })
        request.current = null
        throw Error("STALE")
      }
      setCandidate(value)
      setNotice("待安装版本已准备好。请核对下面的变化，再确认安装。")
    })
  const cancel = async () => {
    if (!api || !request.current || phase === "applying" || cancelling.current) return
    cancelling.current = true
    pending.current = true
    cancelled.current = true
    const requestId = request.current
    setPhase("cancelling")
    try {
      unwrap(await api.cancel({ ...scope, requestId }))
      if (alive.current && request.current === requestId) {
        request.current = null
        setCandidate(null)
        setNotice(
          "已取消本次安装，草稿仍保留。正在使用的版本和助手组合不变。"
        )
      }
    } catch {
      if (alive.current) setError(messages.FAILED)
    } finally {
      cancelling.current = false
      if (alive.current) {
        pending.current = false
        setPhase("idle")
      }
    }
  }
  const apply = () =>
    perform("applying", async () => {
      if (!candidate || dirty) throw Error("INVALID")
      const value = unwrap(
        await api!.apply({
          ...scope,
          handle: candidate.handle,
          expectedCatalogDigest: candidate.catalogDigest
        })
      )
      if (!alive.current) return
      if (
        value.installationId !== candidate.installationId ||
        value.versionId !== candidate.versionId
      )
        throw Error("STALE")
      request.current = null
      setCandidate(null)
      setNotice(
        value.state === "settled"
          ? onSettled
            ? "版本已安装。请继续在下方确认使用权限，并选择要搭配的助手组合。"
            : "版本已安装。使用前，请到权限设置和助手组合中完成确认。"
          : value.state === "partial"
            ? "安装尚未全部完成。请刷新安装记录，查看还需要处理什么。"
            : "安装结果尚不确定。请先刷新安装记录，不要重复安装。"
      )
      if (value.state === "settled") onSettled?.(candidate)
    })
  const busy = phase !== "idle"
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="安装和历史版本">
      <h3 className="font-medium">安装和历史版本</h3>
      <p className="text-sm text-muted-foreground">
        先准备要安装的版本，查看变化后再确认安装。请先结束正在运行的任务；安装后仍需确认使用权限和助手组合。
      </p>
      {!api ? (
        <p className="text-sm">当前暂不支持安装，可以先保存文件并试用。</p>
      ) : (
        <>
          {dirty && <p className="text-sm">还有未保存的修改，请先保存再准备安装。</p>}
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy} onClick={() => void read()}>
              刷新安装记录
            </button>
            <button
              className={button}
              disabled={busy || dirty || !!candidate}
              onClick={() => void prepare(false)}
            >
              准备安装当前版本
            </button>
            {(phase === "preparing" || phase === "cancelling" || candidate) && (
              <button
                className={button}
                disabled={phase === "applying" || phase === "cancelling"}
                onClick={() => void cancel()}
              >
                {phase === "cancelling" ? "正在取消并清理…" : "取消本次安装"}
              </button>
            )}
          </div>
          {phase === "preparing" && (
            <p role="status" className="text-sm">
              正在检查并准备安装文件…
            </p>
          )}
          {phase === "applying" && (
            <p role="status" className="text-sm">
              正在检查能否安装并更新版本，请稍候。
            </p>
          )}
          <AuthoringPreparationRecovery api={api} threadId={threadId} workspace={workspace} />
          <AuthoringRetentionPanel
            api={api}
            threadId={threadId}
            workspace={workspace}
            disabled={busy}
            onChanged={() => {
              setRows([])
              setOpened(false)
              setSelected("")
              setRestoreConfiguration(false)
            }}
          />
          {opened && (
            <div className="space-y-3">
              {!rows.length && (
                <p className="text-sm text-muted-foreground">这个项目还没有安装记录。</p>
              )}
              {rows.map((row) => (
                <article key={row.installationId} className="rounded border p-3 text-sm">
                  <p className="font-medium">{row.name}</p>
                  <p className="break-all">当前版本：{row.currentVersionId ?? "尚未确认"}</p>
                  {row.pending && (
                    <p role="status">
                      上次安装的结果尚待确认：{row.pending.state}。请先核对结果。
                    </p>
                  )}
                  {row.pending && (
                    <AuthoringRecoveryPanel
                      key={row.pending.operationId}
                      api={api}
                      threadId={threadId}
                      workspace={workspace}
                      operationId={row.pending.operationId}
                      onReconciled={() => {
                        setRows([])
                        setOpened(false)
                        setNotice("核对完成，请重新刷新安装记录。")
                        onReconciled?.()
                      }}
                    />
                  )}
                  <p>已保留 {row.versions.length} 个历史版本</p>
                </article>
              ))}
              <label className="block space-y-1 text-sm">
                选择要恢复的旧版本
                <select
                  aria-label="选择要恢复的旧版本"
                  className="w-full rounded border bg-background p-2"
                  value={selected}
                  disabled={busy || !!candidate}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="">选择一个历史版本</option>
                  {rows.flatMap((row) =>
                    row.versions.map((version) => (
                      <option
                        key={`${row.installationId}/${version.versionId}`}
                        value={`${row.installationId}/${version.versionId}`}
                      >
                        {row.name} · 版本 {version.revision} ·{" "}
                        {version.sourceDigest.slice(0, 12)}
                        {row.currentVersionId === version.versionId ? "（当前）" : ""}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={restoreConfiguration}
                  disabled={busy || !!candidate}
                  onChange={(event) => setRestoreConfiguration(event.target.checked)}
                />
                同时恢复这个版本保存的设置（需要有对应的历史设置）
              </label>
              <p className="text-xs text-muted-foreground">
                不勾选时保留当前设置。恢复旧版本不会撤销已经完成的业务操作。
              </p>
              <button
                className={button}
                disabled={busy || !selected || dirty || !!candidate}
                onClick={() => void prepare(true)}
              >
                预览恢复旧版本
              </button>
            </div>
          )}
          {candidate && (
            <div className="space-y-2 rounded border p-3 text-sm" aria-label="待应用版本审阅">
              <p className="font-medium">待安装：{candidate.name}</p>
              <dl className="grid gap-1 break-all">
                <dt>当前版本</dt>
                <dd>{candidate.currentVersionId ?? "首次安装"}</dd>
                <dt>目标版本</dt>
                <dd>{candidate.versionId}</dd>
                <dt>文件校验值</dt>
                <dd>{candidate.sourceDigest}</dd>
                <dt>配置</dt>
                <dd>
                  {candidate.configuration === "restore"
                    ? "恢复这个版本保存的设置"
                    : "保留当前配置"}
                </dd>
              </dl>
              {candidate.review && (
                <div className="space-y-2">
                  <p>
                    本地检查：
                    {candidate.review.strictCompatible && candidate.review.typesValid
                      ? "代码类型和接口用法检查通过"
                      : "检查信息不完整"}
                    。接下来可用样例试用，再检查实际任务结果。
                  </p>
                  <p className="break-words">
                    代码使用的接口：{candidate.review.sdkMethods.join("、") || "无"}
                    （使用权限需另行确认）。
                  </p>
                  <p>
                    模型调用方式：{candidate.review.modelProtocol}
                    。准备安装不会调用模型。
                  </p>
                  <p>
                    配置项：{candidate.review.configurationKeys.join("、") || "无"}
                    ；此处不显示配置值。
                  </p>
                  <p>
                    功能之间的依赖：
                    {candidate.review.components
                      .map(
                        (component) =>
                          component.id + " → " + (component.dependsOn.join("、") || "无依赖")
                      )
                      .join("；") || "单个功能"}
                    。
                  </p>
                  <details>
                    <summary>本次修改的文件（{candidate.review.changedFiles.length}）</summary>
                    <ul className="list-inside list-disc break-all">
                      {candidate.review.changedFiles.map((file) => (
                        <li key={file.path}>
                          {{ added: "新增", changed: "修改", removed: "删除" }[file.change]}：
                          {file.path}
                        </li>
                      ))}
                    </ul>
                    <p>需要逐行查看时，可打开草稿的历史版本比较。</p>
                  </details>
                </div>
              )}
              <p>点击确认后才会安装；若仍有任务运行，请结束后再试。</p>
              <button className={button} disabled={busy || dirty} onClick={() => void apply()}>
                确认安装此版本
              </button>
            </div>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
