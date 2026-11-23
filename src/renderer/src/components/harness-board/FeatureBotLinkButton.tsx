import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowUpRight, Bot, ChevronDown, GitBranch, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { botMainConversationSelection, useBotViewStore } from "@/components/bots/view-store"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { botErrorMessage } from "@/lib/bot-error-message"
import { useAppStore } from "@/lib/store"
import type { BotFeatureTarget } from "../../../../shared/bots/feature"
import {
  FeatureBotTargetList,
  TargetAvatar,
  targetKey,
  unavailableLabels
} from "./FeatureBotTargetList"

export async function linkFeatureToBot(projectId: string, slug: string, target: BotFeatureTarget) {
  const api = window.api.bots?.features
  if (!api) throw new Error("当前版本不支持关联到 Bot")
  await api.follow(target.botId, projectId, slug, target.groupId)
}

type CreateProps = {
  mode: "create"
  target: BotFeatureTarget | null
  onSelect: (value: BotFeatureTarget | null) => void
  disabled?: boolean
}
type DetailProps = {
  mode: "detail"
  projectId: string
  slug: string
  title: string
  disabled?: boolean
}

function useTargets(projectId?: string, slug?: string) {
  const client = window.api.bots
  const [rows, setRows] = useState<BotFeatureTarget[]>()
  const [loadError, setLoadError] = useState("")
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const seq = ++request.current
    try {
      const next = await client.features!.targets(
        projectId && slug ? { projectId, slug } : undefined
      )
      if (request.current === seq) {
        setRows(next)
        setLoadError("")
      }
      return next
    } catch (error) {
      if (request.current === seq) setLoadError(botErrorMessage(error))
      return undefined
    }
  }, [client, projectId, slug])
  useEffect(() => {
    void refresh()
    const stop = client.subscribe(({ featureScope, featureTargetsChanged }) => {
      if (
        featureTargetsChanged ||
        (projectId && featureScope?.projectId === projectId && featureScope.slug === slug)
      )
        void refresh()
    })
    window.addEventListener("focus", refresh)
    return () => {
      request.current++
      stop()
      window.removeEventListener("focus", refresh)
    }
  }, [client, projectId, slug, refresh])
  const deleted = useBotViewStore((s) => s.hosts[client.hostId]?.deletedImConversationIds)
  const targets = rows?.filter((t) => !t.groupId || !deleted?.includes(t.groupId))
  return { targets, loadError, refresh, setRows }
}

function CreateFeatureSelector({ target, onSelect, disabled }: CreateProps) {
  const { targets, loadError, refresh } = useTargets()
  return (
    <div className="grid justify-items-start gap-1.5">
      <div className="relative max-w-full">
        <Bot
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground"
        />
        <select
          aria-label="关联到 Bot（可选）"
          value={target ? targetKey(target) : ""}
          disabled={disabled || !targets?.length}
          onChange={(e) => onSelect(targets?.find((t) => targetKey(t) === e.target.value) ?? null)}
          className="h-8 max-w-full appearance-none truncate rounded-md border border-border bg-background pr-7 pl-8 text-sm"
        >
          <option value="">
            {!targets
              ? loadError
                ? "读取失败"
                : "正在读取…"
              : targets.length
                ? "关联到 Bot（可选）"
                : "暂无可关联的 Bot"}
          </option>
          {[false, true].map((group) => {
            const items = targets?.filter((t) => Boolean(t.groupId) === group)
            return items?.length ? (
              <optgroup key={String(group)} label={group ? "招乎群聊" : "Bot 私聊"}>
                {items.map((t) => (
                  <option key={targetKey(t)} value={targetKey(t)}>
                    {group ? t.label + " · " + t.botName : t.label}
                  </option>
                ))}
              </optgroup>
            ) : null
          })}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-2.5 size-3.5 text-muted-foreground"
        />
      </div>
      {target?.groupId && (
        <p className="text-xs text-muted-foreground">本群可查看并继续此特性的普通项目会话。</p>
      )}
      {loadError && (
        <div role="alert" className="text-xs text-status-critical">
          {loadError}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            重试
          </button>
        </div>
      )}
    </div>
  )
}

function DetailFeatureLinks({ projectId, slug, title, disabled }: DetailProps) {
  const { targets, loadError, refresh, setRows } = useTargets(projectId, slug)
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const linked = targets?.filter((t) => t.linked) ?? []
  const primary = linked.find((t) => !t.unavailable) ?? linked[0]
  const selected = targets?.find((t) => targetKey(t) === key && !t.linked && !t.unavailable)
  const canAdd = !disabled && targets?.some((t) => !t.linked)
  const onOpenChange = (next: boolean) => {
    if (busy) return
    if (next) {
      setKey("")
      setError("")
      void refresh()
    }
    setOpen(next)
  }
  function navigate(target: BotFeatureTarget) {
    const hostId = window.api.bots.hostId
    const views = useBotViewStore.getState()
    views.update(hostId, {
      ...botMainConversationSelection(views.hosts[hostId], target.botId, target.groupId),
      showArchived: false,
      detailOpen: true,
      detailTab: "details"
    })
    useAppStore.getState().setMainView("bots")
  }
  // The binding may have been revoked or deleted while the project was open.
  async function openLinked(target: BotFeatureTarget) {
    if (busy) return
    setBusy(true)
    try {
      const current = await refresh()
      if (!mounted.current) return
      const match = current?.find((t) => targetKey(t) === targetKey(target) && t.linked)
      const deleted =
        useBotViewStore.getState().hosts[window.api.bots.hostId]?.deletedImConversationIds
      if (!current) toast.error("无法读取关联对话，请重试")
      else if (!match || match.unavailable || (match.groupId && deleted?.includes(match.groupId)))
        toast.error("此关联对话已不可用")
      else navigate(match)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function associate(andOpen: boolean) {
    if (!selected || busy || disabled) return
    setBusy(true)
    setError("")
    try {
      await linkFeatureToBot(projectId, slug, selected)
      if (!mounted.current) return
      setRows((current) =>
        current?.map((t) => (targetKey(t) === key ? { ...t, linked: true } : t))
      )
      setOpen(false)
      if (andOpen) navigate(selected)
      else toast.success("已关联到 " + selected.label)
    } catch (cause) {
      if (mounted.current) setError(botErrorMessage(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {primary ? (
        <div className="inline-flex max-w-full items-stretch overflow-hidden rounded-md border border-border bg-background/80 text-xs">
          <button
            type="button"
            disabled={busy || Boolean(primary.unavailable)}
            aria-label={
              primary.unavailable
                ? primary.label + " · " + unavailableLabels[primary.unavailable]
                : `打开${primary.groupId ? "群聊" : "私聊"} · ${primary.label}`
            }
            title={primary.label}
            onClick={() => void openLinked(primary)}
            className="inline-flex h-8 min-w-0 items-center gap-2 px-2.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
          >
            <span className="shrink-0 text-muted-foreground">已关联</span>
            <TargetAvatar target={primary} small />
            <span className="max-w-40 truncate font-medium">{primary.label}</span>
            {primary.unavailable ? (
              <span className="shrink-0 text-muted-foreground">
                {unavailableLabels[primary.unavailable]}
              </span>
            ) : (
              <ArrowUpRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
          </button>
          <DialogTrigger asChild>
            <button
              type="button"
              aria-label="查看关联对话"
              title="查看关联对话"
              disabled={busy}
              className="inline-flex min-w-7 items-center justify-center gap-0.5 border-l border-border px-1.5 text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {linked.length > 1 && <span>+{linked.length - 1}</span>}
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          </DialogTrigger>
        </div>
      ) : (
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="max-w-full"
          >
            <Bot aria-hidden="true" />
            {targets ? "关联到 Bot" : loadError ? "查看关联对话" : "正在读取关联…"}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="z-[70] flex max-h-[calc(100dvh_-_2rem)] w-[calc(100vw_-_2rem)] max-w-[26rem] flex-col gap-0 rounded-xl p-0 sm:rounded-xl">
        <DialogHeader className="shrink-0 px-6 pt-5 pb-4 text-left">
          <DialogTitle>{linked.length ? "关联对话" : "关联到 Bot"}</DialogTitle>
          <DialogDescription className="flex min-w-0 items-center gap-1.5 text-xs">
            <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate" title={title}>
              {title}
            </span>
          </DialogDescription>
        </DialogHeader>
        {targets ? (
          <FeatureBotTargetList
            targets={disabled ? linked : targets}
            value={key}
            disabled={busy}
            onSelect={(target) => {
              setKey(target ? targetKey(target) : "")
              setError("")
            }}
            onNavigate={(target) => void openLinked(target)}
          />
        ) : (
          !loadError && (
            <p role="status" className="px-6 pb-4 text-sm text-muted-foreground">
              正在读取对话…
            </p>
          )
        )}
        {(loadError || error) && (
          <div role="alert" className="px-6 pb-3 text-xs text-status-critical">
            {error || loadError}{" "}
            {loadError && (
              <button type="button" className="underline" onClick={() => void refresh()}>
                重试
              </button>
            )}
          </div>
        )}
        {canAdd && (
          <div className="shrink-0 border-t border-border bg-muted/25 px-5 py-3">
            {selected?.groupId && (
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                本群可查看并继续此特性的普通项目会话。
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!selected || busy}
                onClick={() => void associate(false)}
              >
                仅关联
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!selected || busy}
                onClick={() => void associate(true)}
              >
                {busy ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
                关联并打开 <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function FeatureBotLinkButton(props: CreateProps | DetailProps) {
  if (!window.api.bots?.features) return null
  return props.mode === "create" ? (
    <CreateFeatureSelector {...props} />
  ) : (
    <DetailFeatureLinks {...props} />
  )
}
