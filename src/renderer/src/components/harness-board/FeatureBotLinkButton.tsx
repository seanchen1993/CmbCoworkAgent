import { useEffect, useState } from "react"
import { Bot, ChevronDown } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { botErrorMessage } from "@/lib/bot-error-message"
import type { BotSnapshot } from "../../../../shared/bots/contracts"

export interface FeatureBotTarget {
  botId: string
  groupId?: string
  label: string
}

function targetsFor(snapshot: BotSnapshot): FeatureBotTarget[] {
  const bots = snapshot.bots.filter((bot) => !bot.archived && !bot.deleting)
  const names = new Map(bots.map((bot) => [bot.id, bot.name]))
  return [
    ...bots.map((bot) => ({ botId: bot.id, label: bot.name })),
    ...(snapshot.imConversations ?? []).flatMap((group) =>
      group.state === "active" && names.has(group.botId)
        ? [
            {
              botId: group.botId,
              groupId: group.id,
              label: group.title + " · " + names.get(group.botId)
            }
          ]
        : []
    )
  ]
}

function keyOf(target: FeatureBotTarget) {
  return target.groupId ? "group:" + target.groupId : "bot:" + target.botId
}

export async function linkFeatureToBot(projectId: string, slug: string, target: FeatureBotTarget) {
  const api = window.api.bots?.features
  if (!api) throw new Error("当前版本不支持关联到 Bot")
  await api.follow(target.botId, projectId, slug, target.groupId)
}

type Props = { disabled?: boolean } & (
  | {
      mode: "create"
      target: FeatureBotTarget | null
      onSelect: (value: FeatureBotTarget | null) => void
    }
  | { mode: "detail"; projectId: string; slug: string }
)

export function FeatureBotLinkButton(props: Props) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<FeatureBotTarget[]>()
  const [key, setKey] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const draft = props.mode === "create" ? props.target : null
  const creating = props.mode === "create"
  const selectedKey = creating ? (draft ? keyOf(draft) : "") : key
  const selected = options?.find((target) => keyOf(target) === selectedKey)

  useEffect(() => {
    if ((!open && !creating) || !window.api.bots?.features) return
    let current = true
    window.api.bots
      .snapshot()
      .then((snapshot) => {
        if (current) setOptions(targetsFor(snapshot))
      })
      .catch((e) => {
        if (current) setError(botErrorMessage(e))
      })
    return () => {
      current = false
    }
  }, [open, creating])

  if (!window.api.bots?.features) return null
  const selector = (
    <select
      aria-label={creating ? "关联到 Bot（可选）" : "目标对话"}
      value={selectedKey}
      disabled={props.disabled || busy || !options?.length}
      onChange={(event) => {
        const value = event.target.value
        if (props.mode === "create")
          props.onSelect(options?.find((item) => keyOf(item) === value) ?? null)
        else setKey(value)
        setError("")
      }}
      className={
        creating
          ? "h-8 max-w-full appearance-none truncate rounded-md border border-border bg-background pr-7 pl-8 text-sm"
          : "h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
      }
    >
      <option value="">
        {!options
          ? error
            ? "读取失败"
            : "正在读取…"
          : !options.length
            ? "暂无可关联的 Bot"
            : creating
              ? "关联到 Bot（可选）"
              : "选择对话"}
      </option>
      {[false, true].map((group) => {
        const items = options?.filter((target) => Boolean(target.groupId) === group)
        return items?.length ? (
          <optgroup key={String(group)} label={group ? "招乎群聊" : "Bot 私聊"}>
            {items.map((target) => (
              <option key={keyOf(target)} value={keyOf(target)}>
                {target.label}
              </option>
            ))}
          </optgroup>
        ) : null
      })}
    </select>
  )
  const scopeHint = selected?.groupId ? (
    <p className="text-xs text-muted-foreground">本群可查看并继续此特性的普通项目会话。</p>
  ) : null
  if (creating)
    return (
      <div className="grid justify-items-start gap-1.5">
        <div className="relative max-w-full">
          <Bot
            aria-hidden="true"
            className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground"
          />
          {selector}
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute top-2.5 right-2 size-3.5 text-muted-foreground"
          />
        </div>
        {scopeHint}
        {error && (
          <p role="alert" className="text-xs text-status-critical">
            {error}
          </p>
        )}
      </div>
    )
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (next) {
          setKey("")
          setOptions(undefined)
          setError("")
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.disabled}
          className="max-w-full"
        >
          <Bot aria-hidden="true" />
          <span className="truncate">关联到 Bot</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="z-[70] max-w-sm">
        <DialogHeader>
          <DialogTitle>关联到 Bot</DialogTitle>
          <DialogDescription>选择要跟进这个特性的对话。</DialogDescription>
        </DialogHeader>
        <label className="grid gap-2 text-sm">目标对话{selector}</label>
        {scopeHint}
        {error && (
          <p role="alert" className="text-sm text-status-critical">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!selected || busy}
            onClick={async () => {
              if (!selected || busy) return
              setBusy(true)
              try {
                await linkFeatureToBot(props.projectId, props.slug, selected)
                toast.success("已关联到 " + selected.label)
                setOpen(false)
              } catch (e) {
                setError(botErrorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? "关联中…" : "确认关联"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
