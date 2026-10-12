import { botApi } from "@/lib/bot-api"
import { useId, useRef, useState, type ReactNode } from "react"
import { KeyRound, ShieldCheck, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { BotSecretCard } from "../../../../shared/bot-secrets"
import type { BotInteraction } from "../../../../shared/bot-types"

/** Transient masked form shared by Browser and exact native password destinations.
 * Keep spaces intact: trimming a password changes the credential. */
export function BotMaskedSecretForm({
  label,
  description,
  destination,
  notice,
  embedded = false,
  disabled = false,
  onSubmit,
  onReject,
  rejectLabel = "取消"
}: {
  label: string
  description?: string
  destination: ReactNode
  notice: string
  embedded?: boolean
  disabled?: boolean
  onSubmit(value: string): Promise<void>
  onReject?(): Promise<void>
  rejectLabel?: string
}) {
  const title = useId(),
    descriptionId = useId()
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const submit = async (reject = false) => {
    if (submitting.current || disabled || (!reject && !value.length)) return
    const provided = value
    setValue("")
    submitting.current = true
    setBusy(true)
    try {
      if (reject) await onReject?.()
      else await onSubmit(provided)
    } catch {
      // Do not display an arbitrary provider exception from a credential-bearing request.
      toast.error("安全输入未完成，请核对目标并重新输入；不会自动重试")
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <form
      aria-labelledby={title}
      className={
        embedded ? undefined : "rounded-xl border border-border bg-background-elevated p-4 shadow-sm"
      }
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <h3
        id={title}
        className={embedded ? "sr-only" : "flex items-center gap-2 text-sm font-medium"}
      >
        <KeyRound size={16} className="text-muted-foreground" />
        {label}
      </h3>
      {description && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{description}</p>
      )}
      <div className="my-3 rounded-lg border bg-background px-3 py-2 text-xs">{destination}</div>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        maxLength={16000}
        value={value}
        disabled={busy || disabled}
        aria-labelledby={title}
        aria-describedby={descriptionId}
        placeholder="输入或粘贴密码"
        onChange={(event) => setValue(event.target.value)}
      />
      <p
        id={descriptionId}
        className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"
      >
        <ShieldCheck size={14} className="mt-0.5 shrink-0" />
        {notice}
      </p>
      <div className="mt-3 flex gap-2">
        <Button type="submit" size="sm" disabled={busy || disabled || !value.length}>
          {busy && <Loader2 size={14} className="animate-spin" />}安全填入
        </Button>
        {onReject && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || disabled}
            onClick={() => void submit(true)}
          >
            {rejectLabel}
          </Button>
        )}
      </div>
    </form>
  )
}

export function BotSecretInput({
  item,
  card,
  refresh
}: {
  item: BotInteraction
  card: BotSecretCard
  refresh(): Promise<void>
}) {
  return (
    <BotMaskedSecretForm
      key={`${item.id}:${item.revision}:${card.token}`}
      label={card.label}
      description={card.description ?? undefined}
      destination={
        <>
          <div className="break-all font-medium">{card.origin}</div>
          <div className="mt-1 break-all text-muted-foreground">
            {card.path} · {card.field}
          </div>
        </>
      }
      notice="仅填入上方网页的密码框，不提交表单。本次输入不保存，不进入聊天或模型上下文。"
      onSubmit={async (value) => {
        await botApi.provideSecret({ id: item.id, revision: item.revision, value })
        await refresh()
      }}
      rejectLabel="拒绝"
      onReject={async () => {
        await botApi.answer({ id: item.id, revision: item.revision, answer: "reject" })
        await refresh()
      }}
    />
  )
}
