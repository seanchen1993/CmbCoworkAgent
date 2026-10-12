import { botApi } from "@/lib/bot-api"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { BotEffectDetail, BotRunAddress } from "../../../../shared/bot-run-history"
import { BotApprovalContent } from "./BotApprovalContent"

const states = {
  started: "执行已开始，尚未确认结果",
  succeeded: "已确认完成",
  failed: "已确认失败",
  unknown: "结果待核对"
}

/** Receipts show the exact approval that was consumed; an older record is never guessed. */
export function BotEffectDetails({
  address,
  effectId,
  showApproval = true
}: {
  address: BotRunAddress
  effectId: string
  showApproval?: boolean
}) {
  const viewVisible = useBotViewVisibility()
  const [offset, setOffset] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; value: BotEffectDetail } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [retry, setRetry] = useState(0)
  const { conversationId, runId, threadRootId } = address
  const requestKey = JSON.stringify([conversationId, runId, threadRootId, effectId, offset, retry])
  const value = loaded?.key === requestKey ? loaded.value : null
  const error = failure?.key === requestKey ? failure.message : null
  useEffect(() => {
    if (!viewVisible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const value = await botApi.effectDetail({
          conversationId,
          runId,
          threadRootId,
          effectId,
          offset
        })
        if (disposed) return
        setLoaded({ key: requestKey, value })
        setFailure(null)
        if (["started", "unknown"].includes(value.effect.status))
          timer = setTimeout(() => void read(), 2000)
      } catch (error) {
        if (!disposed)
          setFailure({
            key: requestKey,
            message: error instanceof Error ? error.message : "操作详情读取失败"
          })
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [conversationId, runId, threadRootId, effectId, offset, retry, requestKey, viewVisible])
  return (
    <div className="space-y-4 rounded-xl border bg-muted/20 p-4" aria-label="操作详情">
      {error ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          <Button size="sm" variant="outline" onClick={() => setRetry((n) => n + 1)}>
            重试
          </Button>
        </div>
      ) : !value ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取操作详情…
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <strong className="font-medium">{states[value.effect.status]}</strong>
            <time
              className="text-muted-foreground"
              dateTime={new Date(value.createdAt).toISOString()}
            >
              {new Date(value.createdAt).toLocaleString()}
            </time>
          </div>
          {showApproval &&
            (value.approval ? (
              <section className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">当时批准的操作</h4>
                <BotApprovalContent prompt={value.approval.prompt} />
              </section>
            ) : (
              <p className="text-xs text-muted-foreground">
                此旧版记录没有保存对应的审批内容，请结合任务对话核对。
              </p>
            ))}
          <section className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">已知结果</h4>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-xs">
              {value.effect.result || "尚未收到可确认的执行结果"}
            </pre>
            {(offset > 0 || value.nextOffset !== null) && (
              <div className="flex justify-between">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!offset}
                  onClick={() => setOffset((n) => Math.max(0, n - 8000))}
                >
                  上一段
                </Button>
                <span className="self-center text-xs text-muted-foreground">
                  第 {Math.floor(offset / 8000) + 1} 段
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={value.nextOffset === null}
                  onClick={() => {
                    if (value.nextOffset !== null) setOffset(value.nextOffset)
                  }}
                >
                  下一段
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
