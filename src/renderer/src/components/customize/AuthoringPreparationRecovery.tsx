import { useEffect, useRef, useState } from "react"
import type {
  AuthoringInstallApi,
  AuthoringPreparationInspection
} from "../../../../shared/mods/authoring-install"
export function AuthoringPreparationRecovery({
  api,
  threadId,
  workspace
}: {
  api: AuthoringInstallApi
  threadId: string
  workspace: string
}) {
  const [status, setStatus] = useState<AuthoringPreparationInspection | null>(null)
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("")
  const alive = useRef(true),
    pending = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = async (apply: boolean) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage("")
    try {
      const scope = { threadId, expectedWorkspace: workspace }
      if (apply) {
        if (!status?.canRecover || !status.fingerprint) return
        const result = await api.recoverPreparation({
          ...scope,
          expectedFingerprint: status.fingerprint
        })
        if (!result.ok) throw Error(result.code)
        if (alive.current) {
          setStatus(null)
          setMessage(
            "可以重新准备安装了。已安装版本不变；上次未完成的文件仍保留并占用空间。"
          )
        }
      } else {
        const result = await api.inspectPreparation(scope)
        if (!result.ok) throw Error(result.code)
        if (alive.current) setStatus(result.value)
      }
    } catch {
      if (alive.current) {
        setStatus(null)
        setMessage("暂时无法确认上次准备是否已经结束。请刷新状态，现有版本不变。")
      }
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <details className="rounded border p-3 text-sm">
      <summary>安装准备卡住了？</summary>
      <p className="my-2">先检查上次准备是否已经结束，确认后才能重新准备。</p>
      <button
        className="rounded border px-3 py-1.5"
        disabled={busy}
        onClick={() => void run(false)}
      >
        检查上次准备的状态
      </button>
      {status && (
        <p className="my-2">
          {
            {
              none: "没有未完成的准备，可以继续安装。",
              live: "安装文件还在准备中，请稍候。",
              stale: "上次准备已结束，可以保留文件并重新准备。",
              unknown: "暂时无法确认状态。请检查是否还打开了另一个应用窗口，然后重试。"
            }[status.state]
          }
        </p>
      )}
      {status?.canRecover && (
        <button
          className="rounded border px-3 py-1.5"
          disabled={busy}
          onClick={() => void run(true)}
        >
          保留文件，允许重新准备
        </button>
      )}
      {busy && <p role="status">正在核对…</p>}
      {message && <p role="status">{message}</p>}
    </details>
  )
}
