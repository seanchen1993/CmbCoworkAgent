import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, ChevronUp, Copy, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  botErrorDiagnosticIds,
  type BotErrorDiagnosticId,
  type BotErrorNotice
} from "@/lib/bot-error-notice"

export interface BotErrorNoticeBodyProps {
  notice: BotErrorNotice
  title?: string
  hint?: string
  /** Persistent notifications expose the provider ID without opening details. */
  showRequestId?: boolean
  /** A trusted short label for compact notifications. Raw details/IDs remain
   * available only after the user explicitly opens diagnostic details. */
  summary?: string
  children?: ReactNode
  className?: string
}

/** Shared by persistent error notifications and existing local error surfaces.
 * Keep retry/approval controls with their owner; this body has no domain actions. */
export function BotErrorNoticeBody({
  notice,
  title,
  hint,
  showRequestId = false,
  summary,
  children,
  className
}: BotErrorNoticeBodyProps) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const compact = summary !== undefined
  const diagnostic = notice.diagnostic
  const ids = botErrorDiagnosticIds(diagnostic)
  const requestId =
    showRequestId && !compact ? ids.find((identity) => identity.kind === "requestId") : undefined
  const detailsControl = (diagnostic || compact) && (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-1 h-7 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground"
      aria-expanded={expanded}
      aria-controls={id}
      onClick={() => setExpanded((value) => !value)}
    >
      {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      {expanded ? "收起详情" : "查看详情"}
    </Button>
  )
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      {title && <p className="text-[13px] font-medium leading-5">{title}</p>}
      <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        {summary ?? notice.message}
      </p>
      {!compact && hint && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}
      {requestId && (
        <dl className="text-[11px] text-muted-foreground">
          <DiagnosticId key={requestId.value} identity={requestId} />
        </dl>
      )}
      {compact ? (
        <div className="flex flex-wrap items-center gap-x-2">
          {detailsControl}
          {children}
        </div>
      ) : (
        detailsControl
      )}
      {expanded && (diagnostic || compact) && (
        <dl
          id={id}
          className="space-y-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[11px] text-muted-foreground"
          aria-label="错误诊断信息"
        >
          {compact && (
            <div className="space-y-1">
              <dt className="font-medium">原始错误</dt>
              <dd className="whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">
                {notice.message}
              </dd>
            </div>
          )}
          {compact && hint && (
            <div className="space-y-1">
              <dt className="font-medium">处理建议</dt>
              <dd className="whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">
                {hint}
              </dd>
            </div>
          )}
          {diagnostic?.status !== undefined && (
            <div className="flex items-start gap-2">
              <dt className="w-20 shrink-0 leading-5">HTTP 状态</dt>
              <dd className="min-w-0 flex-1 font-mono leading-5">{diagnostic.status}</dd>
            </div>
          )}
          {diagnostic && (
            <div className="flex items-start gap-2">
              <dt className="w-20 shrink-0 leading-5">错误码</dt>
              <dd className="min-w-0 flex-1 break-all font-mono leading-5">{diagnostic.code}</dd>
            </div>
          )}
          {ids
            .filter((identity) => identity !== requestId)
            .map((identity) => (
              <DiagnosticId key={`${identity.kind}:${identity.value}`} identity={identity} />
            ))}
        </dl>
      )}
      {!compact && children && (
        <div className="flex flex-wrap items-center gap-2 pt-1">{children}</div>
      )}
    </div>
  )
}

function DiagnosticId({ identity }: { identity: BotErrorDiagnosticId }) {
  const [state, setState] = useState<"idle" | "pending" | "copied" | "failed">("idle")
  const instance = useRef({ active: false, pending: false })
  useLayoutEffect(() => {
    const current = instance.current
    current.active = true
    return () => {
      current.active = false
    }
  }, [])
  const copy = async () => {
    const current = instance.current
    if (!current.active || current.pending) return
    current.pending = true
    setState("pending")
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(identity.value)
      if (current.active) setState("copied")
    } catch {
      if (current.active) setState("failed")
    } finally {
      current.pending = false
    }
  }
  return (
    <div className="space-y-1" data-error-diagnostic-id={identity.kind}>
      <div className="flex items-start gap-2">
        <dt className="w-20 shrink-0 leading-7">{identity.label}</dt>
        <dd className="min-w-0 flex-1 break-all font-mono leading-7">{identity.value}</dd>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 rounded-md"
          aria-label={`复制${identity.label}`}
          title={state === "copied" ? "已复制" : `复制${identity.label}`}
          disabled={state === "pending"}
          onClick={() => void copy()}
        >
          {state === "pending" ? (
            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
          ) : state === "copied" ? (
            <Check className="size-3" />
          ) : (
            <Copy className="size-3" />
          )}
        </Button>
      </div>
      {state === "copied" && (
        <p role="status" className="pl-[88px] text-[11px] text-muted-foreground">
          已复制
        </p>
      )}
      {state === "failed" && (
        <div className="space-y-1.5 pl-[88px]">
          <p role="status" className="text-[11px] leading-4 text-muted-foreground">
            无法访问剪贴板，可选中下方内容手动复制。
          </p>
          <Input
            readOnly
            spellCheck={false}
            aria-label={`手动复制${identity.label}`}
            className="h-7 min-w-0 rounded-md px-2 font-mono text-[11px]"
            value={identity.value}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  )
}
