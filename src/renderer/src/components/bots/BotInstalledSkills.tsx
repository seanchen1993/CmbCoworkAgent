import { botApi } from "@/lib/bot-api"
import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { CoworkBotAPI } from "../../../../shared/bot-api"
import type { BotSkill } from "../../../../shared/bot-types"
import type { BotSkillTrial } from "../../../../shared/bot-teach"
import { BotSkillCard } from "./BotSkillCard"
import { UploadSkillDialog } from "../customize/UploadSkillDialog"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"

export function BotInstalledSkills({
  botId,
  focusId,
  manage,
  trials,
  reload
}: {
  botId: string
  focusId?: string
  manage?: () => void
  trials: BotSkillTrial[]
  reload(): Promise<void>
}) {
  const viewVisible = useBotViewVisibility()
  const [importing, setImporting] = useState(false)
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<CoworkBotAPI["installedSkills"]>
  > | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<BotSkill | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef({ value: 0 }),
    previewGeneration = useRef({ value: 0 })
  const latest = useRef(catalog)
  const refresh = useCallback(async () => {
    const token = ++generation.current.value
    setBusy(true)
    try {
      const value = await botApi.installedSkills(botId)
      if (token !== generation.current.value) return
      latest.current = value
      setCatalog(value)
      setError(null)
      setSelected((old) =>
        old && value.skills.some((item) => item.id === old.id && item.version === old.version)
          ? { ...old, verified: value.skills.find((item) => item.id === old.id)!.verified }
          : null
      )
    } catch (failure) {
      if (token === generation.current.value)
        setError(failure instanceof Error ? failure.message : "技能读取失败")
    } finally {
      if (token === generation.current.value) setBusy(false)
    }
  }, [botId])
  useEffect(() => {
    if (!viewVisible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const requests = generation.current,
      previews = previewGeneration.current
    const poll = async () => {
      await refresh()
      if (!disposed) timer = setTimeout(() => void poll(), 10_000)
    }
    void poll()
    return () => {
      disposed = true
      ++requests.value
      ++previews.value
      clearTimeout(timer)
    }
  }, [refresh, viewVisible])
  const inspect = useCallback(
    async (id: string, version: number) => {
      const token = ++previewGeneration.current.value
      setSelected(null)
      setError(null)
      try {
        const skill = await botApi.inspectInstalledSkill({ botId, id, version })
        if (
          token === previewGeneration.current.value &&
          latest.current?.skills.some((item) => item.id === id && item.version === version)
        )
          setSelected(skill)
      } catch (failure) {
        if (token === previewGeneration.current.value)
          setError(failure instanceof Error ? failure.message : "技能已变化，请刷新")
      }
    },
    [botId]
  )
  const inspectedFocus = useRef("")
  const positionedFocus = useRef("")
  useEffect(() => {
    const item = focusId ? catalog?.skills.find((skill) => skill.id === focusId) : undefined
    if (!item) return
    const key = `${botId}:${item.id}:${item.version}`
    if (inspectedFocus.current === key) return
    inspectedFocus.current = key
    void inspect(item.id, item.version)
  }, [botId, focusId, catalog, inspect])
  useEffect(() => {
    if (!focusId || selected?.id !== focusId) return
    const key = `${botId}:${selected.id}:${selected.version}`
    if (positionedFocus.current === key) return
    const node = document.getElementById(`bot-skill-${selected.id}`)
    if (!node) return
    node.scrollIntoView({ block: "center" })
    node.focus({ preventScroll: true })
    positionedFocus.current = key
  }, [botId, focusId, selected])
  const items =
    catalog?.skills.filter((item) =>
      `${item.name} ${item.sourceName ?? ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
    ) ?? []
  return (
    <section className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        使用 CMBDevClaw
        已启用的技能与插件流程。安装、更新和停用在原技能设置中管理；这里的技能不会额外获得连接器、文件写入或命令执行权限。
      </p>
      <div className="flex gap-2">
        <Input
          aria-label="搜索 CMBDevClaw 技能"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索技能或插件"
        />
        <Button
          size="icon"
          variant="outline"
          aria-label="刷新 CMBDevClaw 技能"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={busy ? "motion-safe:animate-spin" : ""} />
        </Button>
        {manage && (
          <Button variant="outline" onClick={manage}>
            安装与管理
          </Button>
        )}
        <Button variant="outline" onClick={() => setImporting(true)}>
          导入技能
        </Button>
      </div>
      <UploadSkillDialog
        open={importing}
        onOpenChange={setImporting}
        onSuccess={() => void refresh()}
      />
      {catalog?.warning && (
        <p
          role="status"
          className="whitespace-pre-line rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed"
        >
          {catalog.warning}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!busy && !items.length && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {catalog?.ready ? "没有匹配的可用技能" : "技能目录暂不可用"}
        </p>
      )}
      <div className="max-h-64 overflow-y-auto rounded-lg border border-border/70">
        {items.map((item) => (
          <button
            key={item.id}
            className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-2.5 text-left last:border-0 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => void inspect(item.id, item.version)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{item.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {item.sourceName}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">v{item.version}</span>
          </button>
        ))}
      </div>
      {selected && (
        <BotSkillCard
          revealSteps={selected.id === focusId}
          key={selected.id}
          skill={selected}
          trials={trials.filter((trial) => trial.skillId === selected.id)}
          reload={async () => {
            await reload()
            await refresh()
          }}
        />
      )}
    </section>
  )
}
