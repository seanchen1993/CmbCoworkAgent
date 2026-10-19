import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type {
  SnapshotGroup,
  SnapshotMaintenancePreview,
  SnapshotMaintenanceResult
} from "../../../../shared/project-runtime/snapshot-maintenance"

const labels: Record<SnapshotGroup, string> = {
  host: "项目流程",
  legacy: "原有项目运行",
  composition: "项目组合流程",
  capabilities: "项目对话能力"
}

export function SnapshotMaintenance({
  active = true,
  scopeKey
}: {
  active?: boolean
  scopeKey: string
}): React.JSX.Element {
  const [preview, setPreview] = useState<SnapshotMaintenancePreview | null>(null)
  const [result, setResult] = useState<SnapshotMaintenanceResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const revision = useRef(0)
  const busy = useRef(false)
  const invalidate = useCallback(() => {
    revision.current++
    busy.current = false
  }, [])
  useEffect(() => {
    invalidate()
    setPreview(null)
    setResult(null)
    setError(null)
    setPending(false)
    setConfirm(false)
    return invalidate
  }, [active, scopeKey, invalidate])
  const inspect = async () => {
    if (busy.current || !active) return
    busy.current = true
    const id = ++revision.current
    setPending(true)
    setConfirm(false)
    setPreview(null)
    setResult(null)
    setError(null)
    try {
      const next = await window.api.mods.previewSnapshotMaintenance()
      if (id === revision.current) setPreview(next)
    } catch (failure) {
      if (id === revision.current) setError(String(failure))
    } finally {
      if (id === revision.current) {
        busy.current = false
        setPending(false)
      }
    }
  }
  const collect = async () => {
    if (busy.current || !active || !confirm || !preview) return
    busy.current = true
    const id = ++revision.current
    setPending(true)
    setConfirm(false)
    setPreview(null)
    setError(null)
    try {
      const next = await window.api.mods.collectSnapshotGarbage(preview.previewId)
      if (id === revision.current) setResult(next)
    } catch (failure) {
      if (id === revision.current) setError(String(failure))
    } finally {
      if (id === revision.current) {
        busy.current = false
        setPending(false)
      }
    }
  }
  const candidates = preview?.groups.reduce((sum, group) => sum + group.candidates, 0) ?? 0
  return (
    <details className="rounded-lg border p-3 text-xs">
      <summary className="cursor-pointer font-medium">项目插件版本维护</summary>
      <p className="mt-2 text-muted-foreground">
        每类最多保留 64
        个运行版本。检查历史记录和正在读取的任务后，可清理未被使用的版本，为新版本腾出名额。
        历史运行引用的版本会保留；升级前的版本须在系统重启后确认读取已结束。
      </p>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending || !active}
        onClick={() => void inspect()}
      >
        {pending ? "正在处理…" : "检查可清理版本"}
      </Button>
      {preview && (
        <div className="mt-2 space-y-2">
          {preview.groups.map((group) => (
            <div key={group.id} className="rounded border p-2">
              <p className="font-medium">
                {labels[group.id]}：{group.published}/64
              </p>
              <p className="text-muted-foreground">
                已保留 {group.protected} 个 · 可清理 {group.candidates} 个
              </p>
              {!!group.blockers.length && (
                <p className="mt-1 text-muted-foreground">
                  引用或读取状态尚未完全确认，本类暂不清理。请结束相关任务后重新检查。
                </p>
              )}
            </div>
          ))}
          {candidates > 0 && !confirm && (
            <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
              清理 {candidates} 个版本…
            </Button>
          )}
          {candidates === 0 && <p>当前没有可安全清理的版本。</p>}
        </div>
      )}
      {confirm && (
        <div role="alert" className="mt-3 space-y-2 rounded border p-3">
          <p>
            确认清理已检查的 {candidates}{" "}
            个版本？执行前会再次核对引用；新被引用或仍在读取的版本会保留。
          </p>
          <Button size="sm" disabled={pending} onClick={() => void collect()}>
            确认清理
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            取消
          </Button>
        </div>
      )}
      {result && (
        <p role="status" className="mt-2">
          已清理 {result.removed} 个版本，保留 {result.remaining} 个。
          {!!result.blockers.length && "部分版本的读取状态有变化，已保留；可重新检查。"}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 break-all text-destructive">
          {error} 请重新检查。
        </p>
      )}
    </details>
  )
}
