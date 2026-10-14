import { useEffect, useRef, useState } from "react"
import type {
  AuthoringInstallApi,
  AuthoringRetentionInspection
} from "../../../../shared/mods/authoring-install"

interface Props {
  api: AuthoringInstallApi
  threadId: string
  workspace: string
  disabled?: boolean
  onChanged?(): void
}
const button = "rounded border px-3 py-2 text-sm disabled:opacity-50"
const reasons = {
  current: "正在使用，不能清理",
  rollback: "最近的备用版本，不能清理",
  uncertain: "有待核对的操作或其他版本需要它，暂不能清理",
  candidate: "正在准备或安装的版本需要它，暂不能清理",
  busy: "当前有操作在运行，请结束后刷新",
  eligible: "可以删除；删除后不能再恢复到此版本",
  "cleanup-failed": "此版本已不能恢复，文件清理尚待确认，可重试"
}

export function AuthoringRetentionPanel(props: Props): React.JSX.Element {
  return <Retention key={JSON.stringify([props.threadId, props.workspace])} {...props} />
}

function Retention({ api, threadId, workspace, disabled, onChanged }: Props): React.JSX.Element {
  const [inspection, setInspection] = useState<AuthoringRetentionInspection | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const alive = useRef(true),
    pending = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = async (retire: boolean) => {
    if (disabled || pending.current) return
    if (retire && (!inspection || !selected.length || !consent)) return
    pending.current = true
    setBusy(true)
    setMessage("")
    setError("")
    const scope = { threadId, expectedWorkspace: workspace }
    try {
      const result = retire
        ? await api.retireVersions({
            ...scope,
            expectedFingerprint: inspection!.fingerprint,
            versionIds: selected,
            acknowledgeLostRollback: true
          })
        : await api.inspectRetention(scope)
      if (!result.ok) throw Error(result.code)
      if (!alive.current) return
      setInspection(result.value)
      setSelected([])
      setConsent(false)
      if (retire) {
        setMessage(
          result.value.pendingVersionIds.length
            ? "部分旧版本的清理结果尚不确定，请查看下方结果，再选择需要重试的版本。"
            : "所选旧版本已处理，空间用量已更新。正在使用的版本和保留的备用版本不变。"
        )
        onChanged?.()
      }
    } catch (cause) {
      if (!alive.current) return
      // An uncertain result is not permission to repeat a destructive request.
      setInspection(null)
      setSelected([])
      setConsent(false)
      if (retire) onChanged?.()
      setError(
        cause instanceof Error && cause.message === "BUSY"
          ? "还有任务或安装操作在运行，请结束后刷新空间用量，再清理。"
          : "清理结果尚不确定，或版本已变化。请刷新空间用量，核对结果后再重试。"
      )
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const blocked = disabled || busy
  return (
    <details className="space-y-3 rounded border p-3 text-sm">
      <summary className="cursor-pointer">查看空间用量，清理旧版本</summary>
      <p>
        这里列出所有项目保存的安装版本。删除后不能再恢复到该版本，请核对项目和版本；制作中的草稿会保留。
        需要一起删除的关联版本会自动勾选，请确认全部勾选项。
      </p>
      <button className={button} disabled={blocked} onClick={() => void run(false)}>
        刷新空间用量
      </button>
      {inspection && (
        <>
          <p role="status">
            所有项目合计：{inspection.usedVersions} / {inspection.limit} 个版本
          </p>
          {inspection.usedBytes !== undefined && inspection.byteLimit !== undefined && (
            <p>
              文件与记录占用：{(inspection.usedBytes / 1024 / 1024).toFixed(2)} /{" "}
              {(inspection.byteLimit / 1024 / 1024).toFixed(2)} MiB
            </p>
          )}
          {!!inspection.protectedArtifacts && (
            <p>
              另有 {inspection.protectedArtifacts}{" "}
              份准备文件需要先核对状态，暂不能删除，仍占用空间。
            </p>
          )}
          <p>
            已保留 {inspection.retiredVersions}{" "}
            条清理记录（最多64条）。正在使用、作为备用或仍被其他操作需要的版本不能删除。
          </p>
          {inspection.pendingVersionIds.length > 0 && (
            <p role="alert">
              有 {inspection.pendingVersionIds.length}{" "}
              个旧版本已不能恢复，但文件清理尚待确认，可能仍占用空间。
            </p>
          )}
          <div className="space-y-2">
            {inspection.versions.map((version) => (
              <label key={version.versionId} className="flex items-start gap-2 rounded border p-2">
                <input
                  type="checkbox"
                  aria-label={`清理版本 ${version.versionId}`}
                  disabled={blocked || !version.canRetire}
                  checked={selected.includes(version.versionId)}
                  onChange={(event) => {
                    setSelected((old) =>
                      event.target.checked
                        ? [...new Set([...old, version.versionId, ...(version.requiredVersionIds ?? [])])]
                        : old.filter((id) => id !== version.versionId &&
                          !inspection.versions.find(row => row.versionId === id)
                            ?.requiredVersionIds?.includes(version.versionId))
                    )
                    setConsent(false)
                  }}
                />
                <span className="min-w-0 break-all">
                  {version.name} · 修订 {version.revision} · {version.versionId}
                  <span className="block">项目：{version.workspace}</span>
                  <span className="block">{reasons[version.reason]}</span>
                  {!!version.requiredVersionIds?.some(id => id !== version.versionId) &&
                    <span className="block">将一起删除：{version.requiredVersionIds
                      .filter(id => id !== version.versionId).join("、")}</span>}
                </span>
              </label>
            ))}
          </div>
          {!inspection.versions.some((version) => version.canRetire) && (
            <p>暂时没有可以清理的版本。请先完成正在运行的操作，或核对上次中断的结果。</p>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={consent}
              disabled={blocked || !selected.length}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我已核对所选项目和版本，确认永久删除，之后不能恢复到这些旧版本
          </label>
          <button
            className={button}
            disabled={blocked || !selected.length || !consent}
            onClick={() => void run(true)}
          >
            永久删除所选旧版本（{selected.length}）
          </button>
        </>
      )}
      {busy && <p role="status">正在检查所有项目的版本，请稍候…</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  )
}
