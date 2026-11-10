import { useRef, useState } from "react"
import { useAppStore } from "@/lib/store"
import { Plus, ArrowLeft, ArrowUpRight, Check, RotateCcw } from "lucide-react"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem, BotWorkSummary } from "../../../../shared/bots/work"
import { FeatureRow, FollowPicker, useBotFeatureTasks } from "./BotFeaturePanel"
import type { useBotWorks } from "./use-bot-works"
import { botErrorMessage } from "@/lib/bot-error-message"

function status(work: BotWorkSummary): string {
  if (work.state === "completed") return "已完成"
  if (work.executionState === "waiting_user") return "等待你处理"
  if (work.executionState === "running") return "正在处理"
  if (work.pendingPeers) return "协作中"
  if (work.backgroundBusy) return "后台处理中"
  if (work.executionState === "queued") return "等待执行"
  if (work.executionState === "completed") return "已回复"
  if (work.executionState === "failed") return "执行失败"
  if (work.executionState === "cancelled") return "已停止"
  if (work.executionState === "outcome_unknown" || work.executionState === "interrupted")
    return "需要核对结果"
  return "进行中"
}
export function BotWorkPanel({
  client,
  botId,
  controller,
  selected,
  onSelect,
  disabled,
  groupId,
  featureDisabled = disabled,
  heading = "任务",
  allowCreate = true,
  backLabel = "返回主对话",
  onBack
}: {
  client: BotClient
  botId: string
  controller: ReturnType<typeof useBotWorks>
  selected: BotWorkItem | null
  onSelect(id: string | null): void
  groupId?: string
  featureDisabled?: boolean
  heading?: string
  allowCreate?: boolean
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
  const features = useBotFeatureTasks({ client, botId, groupId })
  const [createKind, setCreateKind] = useState<"work" | "feature">(allowCreate ? "work" : "feature")
  const canFollow = Boolean(client.features && !featureDisabled)
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)
  const openConversation = async () => {
    if (!selected || !client.conversations) return
    const owner = botId,
      id = selected.id
    setSaving(true)
    setError(null)
    try {
      const work = await client.conversations.expose(owner, id)
      await useAppStore.getState().loadThreads()
      if (
        controller.current.current.botId !== owner ||
        controller.current.current.selectedId !== id
      )
        return
      await useAppStore.getState().selectThread(work.threadId)
    } catch (cause) {
      if (controller.current.current.botId === owner) setError(botErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  const command = (fingerprint: string) => {
    if (operation.current?.fingerprint !== fingerprint)
      operation.current = { fingerprint, id: crypto.randomUUID() }
    return operation.current.id
  }
  const create = async () => {
    if (!client.works || saving) return
    const owner = botId
    setSaving(true)
    setError(null)
    try {
      const receipt = await client.works.create({
        botId,
        operationId: command(JSON.stringify([botId, title, goal, directoryPath.trim()])),
        title,
        goal,
        ...(directoryPath.trim()
          ? { workspace: { kind: "directory" as const, path: directoryPath.trim() } }
          : {})
      })
      if (controller.current.current.botId !== owner) return
      operation.current = null
      setEditing(false)
      setTitle("")
      setGoal("")
      setDirectoryPath("")
      onSelect(receipt.work.id)
      void controller.refresh()
    } catch (cause) {
      if (controller.current.current.botId === owner) setError(botErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  const lifecycle = async () => {
    if (!client.works || !selected || saving) return
    const owner = botId,
      workId = selected.id,
      action = selected.state === "completed" ? "continue" : "complete"
    setSaving(true)
    setError(null)
    try {
      await client.works.lifecycle({
        botId,
        workId,
        expectedVersion: selected.version,
        operationId: command(JSON.stringify([botId, workId, selected.version, action])),
        action
      })
      if (
        controller.current.current.botId !== owner ||
        controller.current.current.selectedId !== workId
      )
        return
      operation.current = null
      void controller.refresh()
    } catch (cause) {
      if (controller.current.current.botId === owner) setError(botErrorMessage(cause))
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
  ].sort((a, b) => Number(b.priority) - Number(a.priority) || b.updatedAt - a.updatedAt)
  const sourceLabel = selected?.source
    ? selected.source.transport === "im"
      ? "IM 渠道交办"
      : "模拟渠道交办"
    : selected?.conversation?.origin === "existing"
      ? selected.conversation.ref.kind === "project_session"
        ? "已有项目会话关联"
        : selected.conversation.ref.kind === "cloud_session"
          ? "已有云端会话关联"
          : "已有会话关联"
      : "Bot 内新建"
  return (
    <section className="bot-detail-section bot-works" aria-label={heading}>
      <div className="bot-works-heading">
        <h3>{heading}</h3>
        {(allowCreate || canFollow) && (
          <button
            disabled={disabled || saving}
            onClick={() => setEditing(!editing)}
            aria-label={allowCreate ? "添加任务" : "关联项目 Feature"}
            aria-expanded={editing}
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      {selected && (
        <div className="bot-work-current">
          <span>{status(selected)}</span>
          <div>
            <button onClick={() => (onBack ? onBack() : onSelect(null))}>
              <ArrowLeft size={13} />
              {backLabel}
            </button>
            {selected.conversation?.state !== "detached" && (
              <button disabled={disabled || saving} onClick={() => void lifecycle()}>
                {selected.state === "completed" ? <RotateCcw size={13} /> : <Check size={13} />}{" "}
                {selected.state === "completed" ? "继续处理" : "完成任务"}
              </button>
            )}
          </div>
          <div className="bot-work-origin" aria-label="任务来源">
            <span>来源 · {sourceLabel}</span>
            {(!selected.source || selected.source.transport === "im") && client.conversations && (
              <button disabled={saving} onClick={() => void openConversation()}>
                {selected.conversation?.origin === "existing" ||
                selected.conversation?.state === "detached"
                  ? "打开原会话"
                  : "在对话模式打开"}
                <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}
      {editing && allowCreate && canFollow && (
        <div className="bot-task-picker" role="group" aria-label="任务类型">
          <button aria-pressed={createKind === "work"} onClick={() => setCreateKind("work")}>
            普通任务
          </button>
          <button aria-pressed={createKind === "feature"} onClick={() => setCreateKind("feature")}>
            项目 Feature
          </button>
        </div>
      )}
      {editing && createKind === "feature" && canFollow && client.features && (
        <FollowPicker
          api={client.features}
          botId={botId}
          groupId={groupId}
          done={() => {
            setEditing(false)
            features.refresh()
          }}
        />
      )}
      {editing && createKind === "work" && allowCreate && (
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
              placeholder="留空使用 Bot 默认目录"
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
      <input
        className="bot-work-search"
        aria-label="搜索任务"
        placeholder="搜索任务…"
        value={controller.query}
        onChange={(e) => {
          setLimit(6)
          controller.setQuery(e.target.value)
        }}
      />
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
        {directory.slice(0, limit).map((entry) => {
          if (entry.kind === "feature")
            return (
              client.features && (
                <FeatureRow
                  key={entry.feature.id}
                  feature={entry.feature}
                  api={client.features}
                  botId={botId}
                  groupId={groupId}
                  disabled={featureDisabled}
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
              <small>
                {work.source ? (work.source.transport === "im" ? "IM · " : "模拟渠道 · ") : ""}
                {status(work)}
              </small>
            </button>
          )
        })}
      </div>
      {!directory.length &&
        !controller.loading &&
        !features.loading &&
        !controller.error &&
        !features.error && <p>{needle ? "没有找到匹配的任务。" : "此对话的任务会显示在这里。"}</p>}
      {(directory.length > limit || controller.cursor) && (
        <button
          disabled={controller.loading}
          onClick={() => {
            if (controller.cursor && limit + 40 >= ordinary.length) void controller.more()
            setLimit((v) => v + 40)
          }}
        >
          更多任务
        </button>
      )}
    </section>
  )
}
