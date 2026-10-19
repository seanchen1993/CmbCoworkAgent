import { useId, useMemo, useState } from "react"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ClawSourceEntry, ClawSourceSelection } from "../../../../shared/mods/claw"
import { clawSourceSummary } from "@/lib/claw-source-summary"

export function ClawSourceSelector({
  title,
  description,
  entries,
  value,
  disabled,
  unavailable,
  onChange
}: {
  title: string
  description: string
  entries: ClawSourceEntry[]
  value?: ClawSourceSelection
  disabled: boolean
  unavailable: boolean
  onChange(value: ClawSourceSelection): void
}) {
  const [search, setSearch] = useState("")
  const radioName = useId()
  const [visibleCount, setVisibleCount] = useState(100)
  const mode = value?.mode ?? "all"
  const selected = mode === "selected" ? (value?.items ?? []) : []
  const availableById = useMemo(() => new Map(entries.map((item) => [item.id, item])), [entries])
  const selectedById = new Map(selected.map((item) => [item.id, item]))
  const query = search.trim().toLocaleLowerCase()
  const rows = [...entries, ...selected.filter((item) => !availableById.has(item.id))].filter(
    (item) =>
      [item.name, "owner" in item ? item.owner : "", "description" in item ? item.description : ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query)
  )
  return (
    <section aria-label={title} className="space-y-3 rounded-xl border bg-muted/20 p-4">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={`${title}选择方式`}>
        {(
          [
            ["all", "使用全部已开启项", "跟随原来的设置；以后开启的选项也会加入"],
            ["selected", "仅使用所选", "固定当前名单；可以一项也不选"]
          ] as const
        ).map(([id, label, hint]) => (
          <label
            key={id}
            className={`devclaw-control-shell flex items-start gap-2 p-3 text-left ${disabled ? "opacity-60" : "cursor-pointer"} ${mode === id ? "bg-primary/5" : ""}`}
          >
            <input
              type="radio"
              name={radioName}
              aria-label={label}
              checked={mode === id}
              disabled={disabled}
              className="mt-0.5 size-4 shrink-0 accent-primary"
              onChange={() => {
                if (mode !== id) onChange({ mode: id, items: [] })
              }}
            />
            <span>
              <span className="block text-xs font-medium">{label}</span>
              <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {clawSourceSummary(value, title)}
        {mode === "selected" && selected.length === 0 && "；保存并应用后生效"}
      </p>
      {mode === "selected" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="devclaw-control-shell flex min-w-0 flex-1 items-center gap-2 px-2.5">
              <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                aria-label={`搜索${title}`}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent py-2 text-xs outline-none"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setVisibleCount(100)
                }}
                placeholder="搜索名称、来源或说明"
              />
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || unavailable || !entries.length || entries.length > 512}
              onClick={() =>
                onChange({
                  mode: "selected",
                  items: entries.map(({ id, name, digest }) => ({ id, name, digest }))
                })
              }
            >
              全选当前
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || !selected.length}
              onClick={() => onChange({ mode: "selected", items: [] })}
            >
              清空
            </Button>
          </div>
          {unavailable && (
            <p role="alert" className="text-xs text-destructive">
              来源目录读取失败，无法确认可用性。已保存选择仍保留，请重试后添加来源。
            </p>
          )}
          <div className="max-h-72 space-y-2 overflow-y-auto overscroll-contain">
            {rows.slice(0, visibleCount).map((item) => {
              const saved = selectedById.get(item.id)
              const available = availableById.get(item.id)
              const stale = !!saved && (!available || saved.digest !== available.digest)
              return (
                <label
                  key={item.id}
                  className="flex gap-3 rounded-lg border bg-background p-3 text-xs"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    aria-label={`选择${title} ${item.name}`}
                    checked={!!saved}
                    disabled={disabled || (!saved && (unavailable || selected.length >= 512))}
                    onChange={(event) =>
                      onChange({
                        mode: "selected",
                        items: event.target.checked
                          ? [...selected, { id: item.id, name: item.name, digest: item.digest }]
                          : selected.filter((entry) => entry.id !== item.id)
                      })
                    }
                  />
                  <span className="min-w-0">
                    <strong className="break-words">{item.name}</strong>
                    {available?.owner && (
                      <span className="ml-2 text-muted-foreground">{available.owner}</span>
                    )}
                    {available?.description && (
                      <span className="mt-1 block break-words leading-5 text-muted-foreground">
                        {available.description}
                      </span>
                    )}
                    {stale && (
                      <span className="mt-1 block text-destructive">
                        {unavailable
                          ? "待重新核对"
                          : available
                            ? "来源已更新，请移除后重新选择并核对"
                            : "已禁用、移除或不可用，请从组合移除"}
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
            {!rows.length && !unavailable && (
              <p className="py-3 text-xs text-muted-foreground">
                {query ? "没有匹配的来源。" : "暂无可选项，请先在技能或连接器设置中添加并启用。"}
              </p>
            )}
            {rows.length > visibleCount && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setVisibleCount((count) => count + 100)}
              >
                显示更多（已显示 {visibleCount} / {rows.length}）
              </Button>
            )}
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">
            最多 512 项。“全选当前”固定当前名单，不会自动加入以后新增的来源。
          </p>
        </>
      )}
    </section>
  )
}
