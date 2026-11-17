import { useRef, useState } from "react"
import { Plus, Search, ChevronDown } from "lucide-react"
import { botWorkStatus as status } from "@/lib/bot-work-status"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem } from "../../../../shared/bots/work"
import { FeatureRow, FollowPicker, useBotFeatureTasks } from "./BotFeaturePanel"
import type { useBotWorks } from "./use-bot-works"
import { botErrorMessage } from "@/lib/bot-error-message"

export function BotWorkPanel({
  client,
  botId,
  controller,
  selected,
  onSelect,
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
  const [completedOpen, setCompletedOpen] = useState(false)
  const features = useBotFeatureTasks({ client, botId, groupId })
  const [createKind, setCreateKind] = useState<"work" | "feature">("work")
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
      if (!isCurrentAudience()) return
      operation.current = null
      setEditing(false)
      setTitle("")
      setGoal("")
      setDirectoryPath("")
      onSelect(receipt.work.id)
      void controller.refresh()
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
    ...features.items
      .filter((f) =>
        (f.title + " " + f.projectName + " " + f.slug).toLocaleLowerCase().includes(needle)
      )
      .map((feature) => ({
        kind: "feature" as const,
        feature,
        priority: Boolean(feature.attentionThreadId),
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
    <section className="bot-detail-section bot-works" aria-label={heading}>
      <div className="bot-works-heading">
        <h3>{heading}</h3>
        <div className="bot-task-list-actions">
          <button
            onClick={() => setSearching(!searching)}
            aria-label="搜索任务"
            aria-expanded={searching}
            title="搜索任务"
          >
            <Search size={15} />
          </button>
          {!readOnlyGroup && (
            <button
              disabled={!canAdd || saving}
              onClick={() => setEditing(!editing)}
              aria-label="添加任务"
              title="添加任务"
              aria-expanded={editing}
            >
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>
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
            setEditing(false)
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
        >
          <label>
            任务名称
            <input
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
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
            <button disabled={disabled || saving || !title.trim() || !goal.trim()} type="submit">
              交办任务
            </button>
          </div>
        </form>
      )}
      {(searching || controller.query) && (
        <input
          autoFocus
          className="bot-work-search"
          aria-label="搜索任务"
          placeholder="搜索任务…"
          value={controller.query}
          onChange={(e) => {
            setLimit(6)
            controller.setQuery(e.target.value)
          }}
        />
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
          return (
            <button
              className="bot-work-row"
              data-work-id={work.id}
              key={work.id}
              aria-pressed={selected?.id === work.id}
              onClick={() => onSelect(work.id)}
            >
              <span>
                {work.activity?.unread ? "● " : ""}
                {work.title}
              </span>
              <small>{status(work)}</small>
            </button>
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
          已完成{controller.cursor ? "" : ` · ${completed.length}`}
        </button>
      )}
      {!directory.length &&
        !controller.loading &&
        !features.loading &&
        !controller.error &&
        !features.error && (
          <p className="text-muted-foreground">
            {needle
              ? "没有找到匹配的任务。"
              : readOnlyGroup
                ? "在群聊中告诉 Bot 要完成什么。"
                : "在聊天中交办一项工作，或点击 + 创建。"}
          </p>
        )}
      {(visible.length > limit || controller.cursor) && (
        <button
          disabled={controller.loading}
          onClick={() => {
            if (limit < visible.length) setLimit(Math.min(visible.length, limit + 40))
            else {
              if (controller.cursor) void controller.more()
              setLimit((v) => v + 40)
            }
          }}
        >
          更多任务
        </button>
      )}
    </section>
  )
}
