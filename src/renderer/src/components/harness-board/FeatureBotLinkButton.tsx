import { useEffect, useState } from "react"
import { Bot } from "lucide-react"
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
  const selected = options?.find((target) => keyOf(target) === key)

  useEffect(() => {
    if (!open) return
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
  }, [open])

  if (!window.api.bots?.features) return null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (next) {
          setKey(draft ? keyOf(draft) : "")
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
          <span className="truncate">{draft ? "创建后关联 · " + draft.label : "关联到 Bot"}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="z-[70] max-w-sm">
        <DialogHeader>
          <DialogTitle>关联到 Bot</DialogTitle>
          <DialogDescription>
            {props.mode === "create"
              ? "创建特性后，可在所选对话的任务列表中跟进。"
              : "选择要跟进这个特性的对话。"}
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-2 text-sm">
          目标对话
          <select
            value={key}
            disabled={busy || !options?.length}
            onChange={(e) => {
              setKey(e.target.value)
              setError("")
            }}
            className="h-9 w-full rounded-md border border-border bg-background px-2"
          >
            <option value="">
              {!options
                ? error
                  ? "读取失败"
                  : "正在读取…"
                : options.length
                  ? "选择对话"
                  : "暂无可关联的 Bot"}
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
        </label>
        {error && (
          <p role="alert" className="text-sm text-status-critical">
            {error}
          </p>
        )}
        <DialogFooter>
          {draft && props.mode === "create" && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                props.onSelect(null)
                setOpen(false)
              }}
            >
              移除选择
            </Button>
          )}
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
                if (props.mode === "create") props.onSelect(selected)
                else {
                  await linkFeatureToBot(props.projectId, props.slug, selected)
                  toast.success("已关联到 " + selected.label)
                }
                setOpen(false)
              } catch (e) {
                setError(botErrorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {props.mode === "create" ? "选定对话" : busy ? "关联中…" : "确认关联"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
