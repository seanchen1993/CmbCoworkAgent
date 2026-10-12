import { useEffect, useRef, useState } from "react"
import { FileSearch, FolderOpen, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createBotIpcClient } from "../../../../shared/bot-ipc-result"
import {
  botDesktopShellResourceReviewSchema,
  type BotDesktopShellResourceReview,
  type BotShellResourcesAPI
} from "../../../../shared/bot-shell-resources"

const api = createBotIpcClient<BotShellResourcesAPI>(() => window.api.botShellResources)

/** Mounted only in Help's diagnostic tab. No Host dependency or idle polling. */
export function BotShellResourceReview() {
  const [snapshot, setSnapshot] = useState<BotDesktopShellResourceReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const owner = useRef(0)
  const reading = useRef(false)
  const revealing = useRef(false)

  const inspect = async () => {
    if (reading.current) return
    reading.current = true
    const lease = owner.current
    setLoading(true)
    setError(null)
    setSnapshot(null)
    try {
      const next = botDesktopShellResourceReviewSchema.parse(await api.inspect())
      if (owner.current === lease) setSnapshot(next)
    } catch {
      if (owner.current === lease) setError("暂时无法读取命令现场。请保留原目录，稍后重新核对。")
    } finally {
      if (owner.current === lease) {
        reading.current = false
        setLoading(false)
      }
    }
  }
  useEffect(() => {
    void inspect()
    return () => {
      owner.current += 1
      reading.current = false
      revealing.current = false
    }
    // A single read per mounted diagnostic tab. Explicit refresh owns retries.
  }, [])

  const reveal = async (nonce?: string) => {
    if (revealing.current) return
    revealing.current = true
    const lease = owner.current
    setOpening(nonce ?? "diagnostics")
    setError(null)
    try {
      if (nonce) await api.reveal({ nonce })
      else await api.revealDiagnostics()
    } catch {
      if (owner.current === lease) setError("现场记录暂时无法打开，请重新核对后重试。")
    } finally {
      if (owner.current === lease) {
        revealing.current = false
        setOpening(null)
      }
    }
  }
  const active = snapshot?.mode === "active-owner"
  const needsReview = snapshot?.review.state === "requires_review"
  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label="命令现场核对">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">
            {needsReview && !active ? "命令现场待核对" : "命令现场"}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {active
              ? "后台仍在运行，以下为当前现场。本检查不会停止或重试命令。"
              : "异常退出后核对命令是否停止，保留可能已发生的变更。"}
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void inspect()}>
          {loading ? (
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw size={14} />
          )}
          {loading ? "正在核对…" : "重新核对"}
        </Button>
      </div>
      {snapshot && (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground" role="status">
            {snapshot.review.hint}
          </p>
          {snapshot.review.entries.length > 0 && (
            <ul className="space-y-2">
              {snapshot.review.entries.map((entry) => (
                <li
                  key={entry.nonce}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-xs">
                      {entry.status === "cleanup-pending"
                        ? "命令已关闭，待清理"
                        : entry.status === "prepared-only"
                          ? "准备现场，尚未执行"
                          : active
                            ? "运行中或待确认"
                            : "命令关闭状态待确认"}
                    </p>
                    <p
                      className="truncate font-mono text-[11px] text-muted-foreground"
                      title={entry.runId}
                    >
                      {entry.runId}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={opening !== null}
                    aria-label={`查看现场记录 ${entry.nonce}`}
                    onClick={() => void reveal(entry.nonce)}
                  >
                    {opening === entry.nonce ? (
                      <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <FileSearch size={14} />
                    )}
                    查看记录
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {(needsReview || snapshot.review.entries.length > 0) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={opening !== null}
              onClick={() => void reveal()}
            >
              <FolderOpen size={14} />
              打开诊断目录
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
