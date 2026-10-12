import { botApi } from "@/lib/bot-api"
import { useEffect, useState } from "react"
import { Blocks, Plug } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotConnector } from "../../../../shared/bot-api"

export function BotConnectorPicker({
  selected,
  onChange,
  disabled
}: {
  selected: string[]
  onChange(value: string[]): void
  disabled: boolean
}) {
  const [providers, setProviders] = useState<BotConnector[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    botApi
      .connectors()
      .then((value) => {
        if (live) setProviders(value)
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : "连接器列表加载失败")
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [attempt])
  const missing = selected.filter((id) => !providers.some((provider) => provider.id === id))
  return (
    <fieldset className="space-y-2 text-sm disabled:opacity-60" disabled={disabled}>
      <legend className="mb-1">连接器与插件</legend>
      <p className="text-xs leading-relaxed text-muted-foreground">
        为这个 Bot 选择已安装的能力。插件首次运行或代码更新后需确认授权。
      </p>
      {loading ? (
        <p className="text-xs text-muted-foreground">正在加载…</p>
      ) : error ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setLoading(true)
              setError(null)
              setAttempt((value) => value + 1)
            }}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          {providers.length === 0 && (
            <p className="text-xs text-muted-foreground">
              暂无已启用的连接器，可先在 CMBDevClaw 设置中添加。
            </p>
          )}
          {(providers.length > 0 || missing.length > 0) && (
            <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-xl border border-border/60 p-1.5">
              {[
                ...providers,
                ...missing.map(
                  (id): BotConnector => ({
                    id,
                    name: `${id}（当前不可用）`,
                    source: "connector" as const
                  })
                )
              ].map((provider) => (
                <label
                  className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-muted/60 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring has-[:checked]:bg-muted/40"
                  key={provider.id}
                >
                  <input
                    type="checkbox"
                    className="size-3.5 shrink-0 accent-primary focus-visible:outline-none"
                    checked={selected.includes(provider.id)}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...selected, provider.id]
                          : selected.filter((id) => id !== provider.id)
                      )
                    }
                  />
                  {provider.capability === "mods" ? (
                    <Blocks aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Plug aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 break-words text-xs leading-relaxed">
                    {provider.name}
                    <span className="text-muted-foreground">
                      {provider.capability === "mods"
                        ? " · 工作插件"
                        : provider.source === "plugin"
                          ? " · 插件连接器"
                          : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </fieldset>
  )
}
