import { useCallback, useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { HookLogBucket, HookLogEntry } from "@/lib/thread-context"

/** Status descriptor for an executed log row. */
function entryStatus(log: HookLogEntry): { ok: boolean; text: string } {
  if (log.kind === "skipped") {
    return { ok: false, text: "skipped" }
  }
  const ok =
    !log.blocked && log.continue !== false && log.decision !== "block" && log.exitCode === 0
  if (ok) return { ok: true, text: "✓" }
  if (log.continue === false) return { ok: false, text: "终止" }
  if (log.decision === "block") return { ok: false, text: "修订" }
  if (log.blocked) return { ok: false, text: "✗ 拦截" }
  if (log.exitCode === null) return { ok: false, text: "✗ 超时" }
  return { ok: false, text: `✗ exit=${log.exitCode}` }
}

function formatSkipReason(reason: string | undefined): string {
  switch (reason) {
    case "plugin-not-active":
      return "skipped — 插件未激活（scope 未包含 pluginId）"
    case "skill-name-only-shadowed":
      return "skipped — 同名 skill 被路径作用域屏蔽"
    case "skill-not-in-scope":
      return "skipped — skill 未激活"
    default:
      return reason ? `skipped — ${reason}` : "skipped"
  }
}

/** Small inline pill rendered right under a user message. */
export function HookLogChip({
  bucket,
  onClick
}: {
  bucket: HookLogBucket
  onClick: () => void
}): React.JSX.Element {
  let executedCount = 0
  let skippedCount = 0
  let issueCount = 0
  for (const l of bucket.entries) {
    if (l.kind === "skipped") {
      skippedCount += 1
      continue
    }
    executedCount += 1
    if (!entryStatus(l).ok) issueCount += 1
  }
  const onlySkipped = executedCount === 0 && skippedCount > 0
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-mono transition-colors",
        issueCount > 0
          ? "border-amber-400/60 bg-amber-50/60 text-amber-700 hover:bg-amber-100/70 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
          : "border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted"
      )}
      title="点击查看本轮 Hook 执行详情"
    >
      <span>⚙</span>
      {onlySkipped ? (
        <span>Hook skip {skippedCount}</span>
      ) : (
        <>
          <span>Hook {executedCount}</span>
          {skippedCount > 0 && (
            <span className="text-muted-foreground/70">· skip {skippedCount}</span>
          )}
        </>
      )}
      {issueCount > 0 && (
        <span className="rounded-full bg-amber-500/20 px-1 text-[10px] text-amber-700 dark:text-amber-300">
          ⚠{issueCount}
        </span>
      )}
    </button>
  )
}

function HookLogEntryRow({ log }: { log: HookLogEntry }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const status = entryStatus(log)
  const showCopy = (): void => {
    try {
      void navigator.clipboard.writeText(JSON.stringify(log, null, 2))
      toast.success("已复制为 JSON")
    } catch {
      toast.error("复制失败")
    }
  }
  return (
    <div className="px-3 py-2 text-xs font-mono">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={status.ok ? "text-green-600 dark:text-green-400" : "text-red-500"}>
          {status.text}
        </span>
        <span className="text-foreground/80 font-semibold shrink-0">
          [{log.event}
          {log.toolSuffix}]
        </span>
        {log.pluginName && (
          <span className="text-[10px] text-blue-600/70 dark:text-blue-400/70 shrink-0">
            plugin: {log.pluginName}
          </span>
        )}
        {log.skillName && (
          <span className="text-[10px] text-purple-600/70 dark:text-purple-400/70 shrink-0">
            skill: {log.skillName}
          </span>
        )}
        <span className="text-muted-foreground truncate flex-1">
          {log.hookType}: {log.label}
        </span>
        {typeof log.durationMs === "number" && log.kind === "executed" && (
          <span className="text-[10px] text-muted-foreground/70 shrink-0">{log.durationMs}ms</span>
        )}
        <span className="text-[10px] text-muted-foreground/60 shrink-0">
          {log.timestamp.toLocaleTimeString()}
        </span>
        <span className="text-muted-foreground/60 shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="pl-4 mt-1.5 space-y-1.5">
          {log.kind === "skipped" && (
            <div className="text-[11px] text-muted-foreground italic">
              {formatSkipReason(log.skipReason)}
            </div>
          )}
          {(log.reason || log.stopReason) && (
            <LogBlock
              label={log.stopReason ? "stopReason" : "reason"}
              text={log.stopReason || log.reason || ""}
              tone="amber"
            />
          )}
          {log.stdout && <LogBlock label="stdout" text={log.stdout} tone="neutral" />}
          {log.stderr && <LogBlock label="stderr" text={log.stderr} tone="red" />}
          {log.additionalContext && (
            <LogBlock label="additionalContext" text={log.additionalContext} tone="blue" />
          )}
          {log.systemMessage && (
            <LogBlock label="systemMessage" text={log.systemMessage} tone="blue" />
          )}
          {log.stdinPayload && (
            <LogBlock label="stdin (诊断)" text={log.stdinPayload} tone="neutral" />
          )}
          {log.command && <LogBlock label="command" text={log.command} tone="neutral" />}
          {log.cwd && <LogBlock label="cwd" text={log.cwd} tone="neutral" />}
          {log.hookSourcePath && (
            <LogBlock label="hookSourcePath" text={log.hookSourcePath} tone="neutral" />
          )}
          {log.workerThreadId && (
            <LogBlock
              label="worker"
              text={[
                log.workerId ? `workerId=${log.workerId}` : "",
                `thread=${log.workerThreadId}`,
                typeof log.workerTurn === "number" ? `turn=${log.workerTurn}` : ""
              ]
                .filter(Boolean)
                .join("\n")}
              tone="neutral"
            />
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={showCopy}
              className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              复制 JSON
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function LogBlock({
  label,
  text,
  tone
}: {
  label: string
  text: string
  tone: "amber" | "red" | "blue" | "neutral"
}): React.JSX.Element {
  const toneClass =
    tone === "amber"
      ? "border-amber-300/40 bg-amber-50/40 text-amber-700/90 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300/90"
      : tone === "red"
        ? "border-red-300/40 bg-red-50/40 text-red-500/80 dark:border-red-500/30 dark:bg-red-500/10"
        : tone === "blue"
          ? "border-blue-300/40 bg-blue-50/40 text-blue-600/90 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300/90"
          : "border-border/40 bg-background/70 text-muted-foreground"
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      <div
        className={cn(
          "max-h-48 overflow-auto rounded-md border px-2 py-1 whitespace-pre-wrap break-all",
          toneClass
        )}
      >
        {text}
      </div>
    </div>
  )
}

/** Modal that shows a single turn's bucket of hook executions. */
export function HookLogModal({
  bucket,
  open,
  onOpenChange,
  previewLabel = "用户消息"
}: {
  bucket: HookLogBucket | null
  open: boolean
  onOpenChange: (open: boolean) => void
  previewLabel?: string
}): React.JSX.Element {
  const entries = bucket?.entries ?? []
  const exportJsonl = useCallback((): void => {
    if (!bucket) return
    const text = entries.map((e) => JSON.stringify(e)).join("\n")
    const blob = new Blob([text], { type: "application/jsonl" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `hook-logs-${bucket.turnId}.jsonl`
    a.click()
    URL.revokeObjectURL(url)
  }, [bucket, entries])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col p-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span>Hook 执行记录</span>
            <span className="text-xs font-normal text-muted-foreground">
              · 此轮 {entries.length} 次
            </span>
          </DialogTitle>
          {bucket?.turnPreview && (
            <DialogDescription className="line-clamp-2 text-xs">
              {previewLabel}：{bucket.turnPreview}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="flex items-center gap-2 px-5 py-2 border-b border-border/40 text-xs">
          <button
            type="button"
            onClick={exportJsonl}
            disabled={entries.length === 0}
            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-40 disabled:no-underline"
          >
            导出为 .jsonl
          </button>
          <span className="ml-auto text-[11px] text-muted-foreground/70">
            调试日志写到 stderr；stdout 输出 JSON 会被当作 Hook 返回值解析
          </span>
        </div>
        <div className="flex-1 overflow-auto divide-y divide-border/30">
          {entries.length === 0 ? (
            <div className="px-5 py-6 text-center text-xs text-muted-foreground">
              本轮暂无 Hook 执行记录
            </div>
          ) : (
            entries.map((log) => <HookLogEntryRow key={log.id} log={log} />)
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
