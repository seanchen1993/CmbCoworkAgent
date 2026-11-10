import { useId, useState } from "react"
import { ArrowUpRight, Check, Search, UsersRound } from "lucide-react"
import { BotAvatar } from "@/components/bots/BotAvatar"
import { cn } from "@/lib/utils"
import type { BotFeatureTarget } from "../../../../shared/bots/feature"

export const unavailableLabels = { archived: "Bot 已归档", revoked: "群已解绑" }

export function targetKey(target: BotFeatureTarget) {
  return target.groupId ? "group:" + target.groupId : "bot:" + target.botId
}

export function TargetAvatar({
  target,
  small = false
}: {
  target: BotFeatureTarget
  small?: boolean
}) {
  const size = small ? 20 : 30
  if (!target.groupId) {
    return <BotAvatar color={target.color} shape={target.shape} size={size} animated={false} />
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
        small ? "size-5" : "size-[30px]"
      )}
    >
      <UsersRound size={small ? 13 : 17} />
    </span>
  )
}

export function FeatureBotTargetList({
  targets,
  value,
  disabled,
  onSelect,
  onNavigate
}: {
  targets: BotFeatureTarget[]
  value: string
  disabled: boolean
  onSelect: (target: BotFeatureTarget | null) => void
  onNavigate: (target: BotFeatureTarget) => void
}) {
  const [search, setSearch] = useState("")
  const name = useId()
  const query = search.trim().toLocaleLowerCase()
  const matches = targets.filter((t) =>
    (t.label + " " + t.botName).toLocaleLowerCase().includes(query)
  )
  const sections = [
    { title: "已关联", items: matches.filter((t) => t.linked) },
    { title: "Bot 私聊", items: matches.filter((t) => !t.linked && !t.groupId) },
    { title: "招乎群聊", items: matches.filter((t) => !t.linked && t.groupId) }
  ]
  const rowClass = "flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2 text-left"
  return (
    <>
      {(targets.length > 6 || search) && (
        <label className="mx-5 mb-2 flex shrink-0 items-center gap-2 rounded-md border border-border px-3 text-muted-foreground focus-within:border-ring">
          <Search aria-hidden="true" className="size-3.5" />
          <input
            type="search"
            aria-label="搜索 Bot 或群聊"
            placeholder="搜索 Bot 或群聊"
            value={search}
            className="h-8 w-full min-w-0 bg-transparent text-sm text-foreground outline-none"
            onChange={(e) => {
              setSearch(e.target.value)
              onSelect(null)
            }}
          />
        </label>
      )}
      <div className="min-h-0 max-h-[min(48dvh,24rem)] overflow-y-auto overscroll-contain px-4 pb-4">
        {sections.map(
          ({ title, items }) =>
            items.length > 0 && (
              <fieldset key={title} className="mt-3 first:mt-0" disabled={disabled}>
                <legend className="mb-1 px-3 text-xs font-medium text-muted-foreground">
                  {title}
                </legend>
                {items.map((target) => {
                  const key = targetKey(target)
                  const text = (
                    <>
                      <TargetAvatar target={target} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{target.label}</span>
                        {target.groupId && (
                          <span className="block truncate text-xs text-muted-foreground">
                            服务 Bot · {target.botName}
                          </span>
                        )}
                      </span>
                    </>
                  )
                  if (target.linked) {
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={Boolean(target.unavailable)}
                        aria-label={`打开${target.groupId ? "群聊" : "私聊"} · ${target.label}`}
                        className={cn(
                          rowClass,
                          "hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                        )}
                        onClick={() => onNavigate(target)}
                      >
                        {text}
                        {target.unavailable ? (
                          <span className="text-xs text-muted-foreground">
                            {unavailableLabels[target.unavailable]}
                          </span>
                        ) : (
                          <ArrowUpRight
                            aria-hidden="true"
                            className="size-4 text-muted-foreground"
                          />
                        )}
                      </button>
                    )
                  }
                  const selected = key === value
                  return (
                    <label
                      key={key}
                      className={cn(
                        rowClass,
                        "relative cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                        selected
                          ? "bg-foreground/[0.045] ring-1 ring-inset ring-foreground/15"
                          : "hover:bg-muted/60"
                      )}
                    >
                      <input
                        type="radio"
                        name={name}
                        value={key}
                        checked={selected}
                        className="sr-only"
                        aria-label={
                          target.groupId ? target.label + " · " + target.botName : target.botName
                        }
                        onChange={() => onSelect(target)}
                      />
                      {text}
                      <span
                        aria-hidden="true"
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded-full border",
                          selected
                            ? "border-foreground bg-foreground text-background"
                            : "border-muted-foreground/35"
                        )}
                      >
                        {selected && <Check className="size-3" strokeWidth={2.5} />}
                      </span>
                    </label>
                  )
                })}
              </fieldset>
            )
        )}
        {!matches.length && (
          <p role="status" className="px-3 py-5 text-center text-sm text-muted-foreground">
            {query ? "没有匹配的对话" : "暂无可关联的对话，请先在 Bots 中创建 Bot。"}
          </p>
        )}
      </div>
    </>
  )
}
