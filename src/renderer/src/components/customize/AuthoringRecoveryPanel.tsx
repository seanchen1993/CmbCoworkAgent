import { useEffect, useRef, useState } from "react"
import type {
  AuthoringInstallApi,
  AuthoringInstallationInspection
} from "../../../../shared/mods/authoring-install"
export function AuthoringRecoveryPanel({
  api,
  threadId,
  workspace,
  operationId,
  onReconciled
}: {
  api: AuthoringInstallApi
  threadId: string
  workspace: string
  operationId: string
  onReconciled(): void
}) {
  const [inspection, setInspection] = useState<AuthoringInstallationInspection | null>(null)
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("")
  const alive = useRef(true),
    pending = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const scope = { threadId, expectedWorkspace: workspace, operationId }
  const run = async (apply: boolean) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setNotice("")
    try {
      if (apply) {
        if (!inspection?.canAccept) return
        const result = await api.reconcile({
          ...scope,
          expectedInspectionDigest: inspection.inspectionDigest
        })
        if (!result.ok) throw Error(result.code)
        if (alive.current) {
          setInspection(null)
          setNotice("已保留当前状态并结束核对。上次中断的记录仍可查看。")
          onReconciled()
        }
      } else {
        const result = await api.inspectUncertain(scope)
        if (!result.ok) throw Error(result.code)
        if (alive.current) setInspection(result.value)
      }
    } catch (error) {
      if (alive.current) {
        setInspection(null)
        setNotice(
          error instanceof Error && error.message === "BUSY"
            ? "还有任务或插件在运行，请结束后重试。"
            : "当前状态暂时无法确认，请刷新后再核对。"
        )
      }
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <div className="mt-2 space-y-2 rounded border border-amber-500/40 p-3">
      <button
        className="rounded border px-3 py-1.5"
        disabled={busy}
        onClick={() => void run(false)}
      >
        查看上次中断的结果
      </button>
      {inspection && (
        <>
          <p>
            安装状态：
            {inspection.catalog === "before"
              ? "与操作前一致"
              : inspection.catalog === "after"
                ? "与目标版本一致"
                : "发生其他变化，无法确认"}
            。
          </p>
          <p>
            配置状态：
            {inspection.configuration === "unchanged"
              ? "与操作前一致"
              : inspection.configuration === "restored"
                ? "已是要恢复的设置"
                : "发生其他变化，将保留当前配置"}
            。
          </p>
          <p className="break-all">
            实际版本：{inspection.observedVersionId ?? "尚未安装或无法确认"}
          </p>
          <p>确认后会保留当前安装和设置，结束这次核对；不会重新执行上次操作。</p>
          <button
            className="rounded border px-3 py-1.5"
            disabled={busy || !inspection.canAccept}
            onClick={() => void run(true)}
          >
            确认保留当前状态
          </button>
        </>
      )}
      {busy && <p role="status">正在核对，请等待…</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
