import { useId, useRef, useState } from "react"
import { Plus, Search, ChevronDown, ChevronRight, X, Loader2, Clock3, CirclePause, CircleCheck, CircleAlert, CircleStop, CircleDot, CircleDashed } from "lucide-react"
import { resolveBotWorkStatus } from "@/lib/bot/work-status"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem, BotWorkSummary } from "../../../../shared/bots/work"
import { FeatureRow, FollowPicker, useBotFeatureTasks } from "./BotFeaturePanel"
import type { useBotWorks } from "./use-bot-works"
import { botErrorMessage } from "@/lib/bot-error-message"
import { BotDetailCard } from "./BotDetailsPane"

export function botWorkStatus(work: BotWorkSummary): string {
  return resolveBotWorkStatus(work).label
}

export function botWorkStatusTone(work: BotWorkSummary): string {
  return resolveBotWorkStatus(work).tone
}

const botWorkStatusIcons = {
  running: Loader2,
  queued: Clock3,
  waiting: CirclePause,
  complete: CircleCheck,
  alert: CircleAlert,
  stopped: CircleStop,
  ready: CircleDot,
  idle: CircleDashed
}

export function BotWorkStatusIcon({
  work,
  status = resolveBotWorkStatus(work)
}: {
  work: BotWorkSummary
  status?: ReturnType<typeof resolveBotWorkStatus>
}) {
  const Icon = botWorkStatusIcons[status.icon]
  return <Icon
    aria-hidden="true"
    className={status.icon === "running" ? "bot-work-state-icon motion-safe:animate-spin" : "bot-work-state-icon"}
    data-tone={status.tone}
    size={20}
  />
}

export function BotWorkPanel({
  client,
  botId,
  controller,
  selected,
  onSelect,
  onPreview,
  captureWorkNavigation,
  disabled,
  groupId,
  readOnlyGroup = false,
  heading = "任务"
}: {
  client: BotClient
  botId: string
  controller: ReturnType<typeof useBotWorks>
  selected: BotWorkItem | null
  onSelect(id: string | null): void
  onPreview?(work: BotWorkSummary, trigger: HTMLButtonElement): void
  captureWorkNavigation?(): () => boolean
  groupId?: string
  readOnlyGroup?: boolean
  heading?: string
  backLabel?: string
  onBack?(): void
  disabled: boolean
}) {
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(""),
    [goal, setGoal] = useState(""),
    [directoryPath, setDirectoryPath] = useState("")
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null),
    [limit, setLimit] = useState(6)
  const [searching, setSearching] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
  const searchId = useId()
  const searchOpen = searching || Boolean(controller.query)
  const closeSearch = () => {
    controller.setQuery("")
    setSearching(false)
    setLimit(6)
    searchButton.current?.focus({ preventScroll: true })
  }
  const [completedOpen, setCompletedOpen] = useState(false)
  const features = useBotFeatureTasks({ client, botId, groupId, query: controller.query })
  const [createKind, setCreateKind] = useState<"work" | "feature">("work")
  const createButton = useRef<HTMLButtonElement>(null)
  const closeCreate = () => {
    setEditing(false)
    createButton.current?.focus({ preventScroll: true })
  }
  const canAdd = !disabled && !readOnlyGroup
  const isCurrentAudience = () =>
    controller.current.current.botId === botId &&
    controller.current.current.audience === (groupId ?? "desktop")
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)
  const command = (fingerprint: string) => {
    if (operation.current?.fingerprint !== fingerprint)
      operation.current = { fingerprint, id: crypto.randomUUID() }
    return operation.current.id
  }
  const create = async () => {
    if (!client.works || saving || !canAdd) return
    const trigger = createButton.current
    const isNavigationCurrent = captureWorkNavigation?.()
    setSaving(true)
    setError(null)
    try {
      const receipt = await client.works.create({
        botId,
        operationId: command(JSON.stringify([botId, groupId, title, goal, directoryPath.trim()])),
        ...(groupId ? { imConversationId: groupId } : {}),
        title,
        goal,
        ...(directoryPath.trim()
          ? { workspace: { kind: "directory" as const, path: directoryPath.trim() } }
          : {})
      })
      void controller.refresh()
      if (!isCurrentAudience()) return
      operation.current = null
      setEditing(false)
      setTitle("")
      setGoal("")
      setDirectoryPath("")
      if (isNavigationCurrent?.() === false || !trigger || createButton.current !== trigger) return
      if (onPreview) onPreview(receipt.work, trigger)
      else onSelect(receipt.work.id)
    } catch (cause) {
      if (isCurrentAudience()) setError(botErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  if (!client.works) return null
  const priority = new Set(controller.priority.map((item) => item.id))
  const needle = controller.query.trim().toLocaleLowerCase()
  const ordinary = [
    ...controller.priority,
    ...controller.items.filter((item) => !priority.has(item.id))
  ]
  const directory = [
    ...ordinary.map((work) => ({
      kind: "work" as const,
      work,
      priority: priority.has(work.id),
      updatedAt: work.updatedAt
    })),
    ...[
      ...features.priority,
      ...features.items.filter(
        (item) => !features.priority.some((priority) => priority.id === item.id)
      )
    ]
      .filter((f) =>
        (f.title + " " + f.projectName + " " + f.slug).toLocaleLowerCase().includes(needle)
      )
      .map((feature) => ({
        kind: "feature" as const,
        feature,
        priority:
          Boolean(feature.attentionThreadId) ||
          features.priority.some((item) => item.id === feature.id),
        updatedAt: feature.updatedAt
      }))
  ].sort((a, b) => {
    const done = (entry: typeof a) =>
      (entry.kind === "work" ? entry.work : entry.feature).state === "completed"
    return (
      Number(done(a)) - Number(done(b)) ||
      Number(b.priority) - Number(a.priority) ||
      b.updatedAt - a.updatedAt
    )
  })
  const completed = directory.filter(
    (entry) => (entry.kind === "work" ? entry.work : entry.feature).state === "completed"
  )
  const visible = directory.filter(
    (entry) =>
      needle ||
      completedOpen ||
      (entry.kind === "work" ? entry.work : entry.feature).state !== "completed" ||
      (entry.kind === "work" && entry.work.id === selected?.id)
  )
  return (
    <BotDetailCard className="bot-works" title={heading} actions={
        <>
          <button
            ref={searchButton}
            type="button"
            className="bot-icon-button"
            onClick={() => searchOpen ? closeSearch() : setSearching(true)}
            aria-label="搜索任务"
            aria-expanded={searchOpen}
            aria-controls={searchOpen ? searchId : undefined}
            title="搜索任务"
          >
            <Search size={15} />
          </button>
          {!readOnlyGroup && (
            <button
              type="button"
              className="bot-icon-button"
              ref={createButton}
              disabled={!canAdd || saving}
              onClick={() => setEditing(!editing)}
              aria-label="添加任务"
              title="添加任务"
              aria-expanded={editing}
            >
              <Plus size={16} />
            </button>
          )}
        </>
      }>
      {editing && canAdd && client.features && (
        <div className="bot-task-picker" role="group" aria-label="任务类型">
          <button aria-pressed={createKind === "work"} onClick={() => setCreateKind("work")}>
            普通任务
          </button>
          <button aria-pressed={createKind === "feature"} onClick={() => setCreateKind("feature")}>
            项目 Feature
          </button>
        </div>
      )}
      {editing && canAdd && createKind === "feature" && client.features && (
        <FollowPicker
          api={client.features}
          botId={botId}
          groupId={groupId}
          followed={features.loading || features.error ? undefined : features.items}
          done={() => {
            closeCreate()
            features.refresh()
          }}
        />
      )}
      {editing && canAdd && createKind === "work" && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
          className="bot-work-create"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing || saving) return
            event.preventDefault()
            event.stopPropagation()
            closeCreate()
          }}
        >
          <label>
            任务名称
            <input
              autoFocus
              value={title}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
          <label>
            交办目标
            <textarea
              value={goal}
              maxLength={30000}
              onChange={(e) => setGoal(e.target.value)}
              required
              rows={3}
            />
          </label>
          <label>
            工作目录（可选）
            <input
              value={directoryPath}
              maxLength={4096}
              onChange={(e) => setDirectoryPath(e.target.value)}
              placeholder={groupId ? "留空使用本群默认目录" : "留空使用 Bot 默认目录"}
            />
          </label>
          <div>
            <button type="button" disabled={saving} onClick={closeCreate}>
              取消
            </button>
            <button disabled={disabled || saving || !title.trim() || !goal.trim()} type="submit">
              交办任务
            </button>
          </div>
        </form>
      )}
      {searchOpen && (
        <div className="bot-work-search-field" id={searchId}>
          <Search size={14} aria-hidden="true" />
          <input autoFocus aria-label="搜索任务" placeholder="搜索任务…" value={controller.query}
            onChange={(e) => { setLimit(6); controller.setQuery(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.stopPropagation(); closeSearch() }
            }} />
          <button type="button" className="bot-icon-button" aria-label="关闭搜索" onClick={closeSearch}><X size={14} /></button>
        </div>
      )}
      {(error || controller.error || features.error) && (
        <p role="alert">
          {error || controller.error || features.error}
          <button
            onClick={() => {
              void controller.refresh()
              features.refresh()
            }}
          >
            刷新
          </button>
        </p>
      )}
      <div className="bot-work-list" aria-label="全部任务">
        {visible.slice(0, limit).map((entry) => {
          if (entry.kind === "feature")
            return (
              client.features && (
                <FeatureRow
                  key={entry.feature.id}
                  feature={entry.feature}
                  api={client.features}
                  botId={botId}
                  groupId={groupId}
                  disabled={!canAdd}
                  revision={features.revision}
                  refresh={features.refresh}
                />
              )
            )
          const work = entry.work
          const status = resolveBotWorkStatus(work)
          return (
            <div key={work.id} className="bot-work-entry" data-work-id={work.id}
              data-current={selected?.id === work.id || undefined}>
              <button type="button" className="bot-work-row"
                aria-label={`${onPreview ? "预览任务" : "进入任务"}：${work.title}`}
                aria-describedby={`bot-work-status-${work.id}`}
                onClick={event => onPreview ? onPreview(work, event.currentTarget) : onSelect(work.id)}>
                <BotWorkStatusIcon work={work} status={status} />
                <span className="bot-work-row-copy">
                  <span className="bot-work-row-title" title={work.title}>{work.title}</span>
                  <small id={`bot-work-status-${work.id}`}>{status.label}{work.activity?.unread && <span className="sr-only">，未读</span>}</small>
                </span>
                {work.activity?.unread && <span className="bot-work-unread" aria-hidden="true" />}
                {!onPreview && <ChevronRight size={14} className="bot-work-row-chevron" aria-hidden="true" />}
              </button>
              {onPreview && (
                <button type="button" className="bot-work-open-action"
                  aria-label={`进入任务：${work.title}`} title="进入任务对话"
                  aria-current={selected?.id === work.id || undefined} onClick={() => onSelect(work.id)}>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {completed.length > 0 && !needle && (
        <button
          className="bot-tasks-completed"
          aria-expanded={completedOpen}
          onClick={() => setCompletedOpen(!completedOpen)}
        >
          <ChevronDown size={13} className={completedOpen ? "rotate-180" : ""} />
          已完成{controller.cursor || features.cursor ? "" : ` · ${completed.length}`}
        </button>
      )}
      {!directory.length &&
        !controller.loading &&
        !features.loading &&
        !controller.error &&
        !features.error && (
          <p className="bot-detail-empty">
            {needle ? "没有匹配的任务" : groupId ? "暂无群内任务" : "暂无任务"}
          </p>
        )}
      {(visible.length > limit || controller.cursor || features.cursor) && (
        <button
          className="bot-work-more"
          disabled={controller.loading || features.loading}
          onClick={() => {
            if (limit < visible.length) setLimit(Math.min(visible.length, limit + 40))
            else {
              if (controller.cursor) void controller.more()
              if (features.cursor) features.more()
              setLimit((v) => v + 40)
            }
          }}
        >
          更多任务
        </button>
      )}
    </BotDetailCard>
  )
}
