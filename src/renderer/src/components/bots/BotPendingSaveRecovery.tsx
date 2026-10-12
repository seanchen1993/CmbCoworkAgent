import type { ProtectedSaveRecord } from "@/lib/bot-protected-save-pending"
import { useState } from "react"
import { Copy, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { discardPendingBotRecord } from "@/lib/bot-editor-pending"

export function BotPendingSaveRecovery({
  record,
  id,
  dataEpoch,
  onRepaired,
  discard,
  operationLabel = "保存",
  obsoleteTitle
}: {
  record: ProtectedSaveRecord<unknown>
  id?: string
  dataEpoch: string
  onRepaired(): void
  discard?: (raw: string) => boolean
  operationLabel?: string
  obsoleteTitle?: string
}) {
  const [exported, setExported] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const raw = record.kind === "corrupt" || record.kind === "obsolete" ? record.raw : null
  if (record.kind === "empty" || record.kind === "valid") return null
  const saveRecord = () => {
    if (raw === null) return
    const href = URL.createObjectURL(new Blob([raw], { type: "application/json;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = href
    anchor.download = "bot-pending-save-record.json"
    document.body.append(anchor)
    try {
      anchor.click()
      setExported(raw)
    } finally {
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(href), 1000)
    }
  }
  return (
    <section
      aria-label={`待确认${operationLabel}记录`}
      role="alert"
      className="space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-5"
    >
      <p className="font-medium">
        {record.kind === "obsolete"
          ? (obsoleteTitle ?? `有恢复前的${operationLabel}记录`)
          : `本机${operationLabel}记录无法读取`}
      </p>
      <p className="text-muted-foreground">
        {record.kind === "unreadable"
          ? "存储权限不可用，原记录保持不变。请恢复应用存储访问后重新打开。"
          : "请先保留原记录并核对已提交结果，再清除此条记录。清除记录不会撤销后台已经完成的操作。"}
      </p>
      {raw !== null && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={saveRecord}
              className="h-7 gap-1.5 text-xs"
            >
              <Download size={13} />
              保存原记录
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => {
                void navigator.clipboard
                  .writeText(raw)
                  .then(() => {
                    setExported(raw)
                    setFeedback("原记录已复制")
                  })
                  .catch(() => setFeedback("复制失败，请保存原记录文件后再继续。"))
              }}
            >
              <Copy size={13} />
              复制原记录
            </Button>
          </div>
          <label className="flex items-start gap-2 text-muted-foreground">
            <input
              type="checkbox"
              checked={confirmed === raw}
              disabled={exported !== raw}
              onChange={(event) => setConfirmed(event.target.checked ? raw : null)}
              className="mt-1"
            />
            <span>我已保存或复制原记录，并已核对相关工作区中的提交结果。</span>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={exported !== raw || confirmed !== raw}
            className="h-7 text-xs"
            onClick={() => {
              if (
                (discard ?? ((expected) => discardPendingBotRecord(id, dataEpoch, expected)))(raw)
              )
                onRepaired()
              else setFeedback("记录已变化或无法清除，请重新打开核对。新记录保持不变。")
            }}
          >
            清除此条记录
          </Button>
        </>
      )}
      {feedback && (
        <p role="status" className="text-muted-foreground">
          {feedback}
        </p>
      )}
    </section>
  )
}
