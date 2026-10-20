import { useRef, useState } from "react"
import { Plus, ArrowLeft, Check, RotateCcw } from "lucide-react"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem, BotWorkSummary } from "../../../../shared/bots/work"
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
  disabled
}: {
  client: BotClient
  botId: string
  controller: ReturnType<typeof useBotWorks>
  selected: BotWorkItem | null
  onSelect(id: string | null): void
  disabled: boolean
}) {
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(""),
    [goal, setGoal] = useState("")
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null),
    [limit, setLimit] = useState(6)
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)
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
        operationId: command(JSON.stringify([botId, title, goal])),
        title,
        goal
      })
      if (controller.current.current.botId !== owner) return
      operation.current = null
      setEditing(false)
      setTitle("")
      setGoal("")
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
  const directory = [
    ...controller.priority,
    ...controller.items.filter((item) => !controller.priority.some((v) => v.id === item.id))
  ]
  return (
    <section className="bot-detail-section bot-works" aria-label="独立工作">
      <div className="bot-works-heading">
        <h3>独立工作</h3>
        <button
          disabled={disabled || saving}
          onClick={() => setEditing(!editing)}
          aria-label="新建独立工作"
        >
          <Plus size={16} />
        </button>
      </div>
      {selected && (
        <div className="bot-work-current">
          <span>{status(selected)}</span>
          <div>
            <button onClick={() => onSelect(null)}>
              <ArrowLeft size={13} />
              返回主对话
            </button>
            <button disabled={disabled || saving} onClick={() => void lifecycle()}>
              {selected.state === "completed" ? <RotateCcw size={13} /> : <Check size={13} />}{" "}
              {selected.state === "completed" ? "继续处理" : "完成工作"}
            </button>
          </div>
        </div>
      )}
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
          className="bot-work-create"
        >
          <label>
            工作名称
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
          <div>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
            <button disabled={disabled || saving || !title.trim() || !goal.trim()} type="submit">
              交办工作
            </button>
          </div>
        </form>
      )}
      <input
        className="bot-work-search"
        aria-label="搜索工作"
        placeholder="搜索工作…"
        value={controller.query}
        onChange={(e) => {
          setLimit(6)
          controller.setQuery(e.target.value)
        }}
      />
      {(error || controller.error) && (
        <p role="alert">
          {error || controller.error}
          <button onClick={() => void controller.refresh()}>刷新</button>
        </p>
      )}
      <div className="bot-work-list" aria-label="全部工作">
        {directory.slice(0, limit).map((work) => (
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
              {work.source ? "模拟渠道 · " : ""}
              {status(work)}
            </small>
          </button>
        ))}
      </div>
      {!directory.length && !controller.loading && <p>明确交办的工作会在这里保留独立会话。</p>}
      {(directory.length > limit || controller.cursor) && (
        <button
          disabled={controller.loading}
          onClick={() => {
            if (limit >= directory.length) void controller.more()
            setLimit((v) => v + 40)
          }}
        >
          更多工作
        </button>
      )}
    </section>
  )
}
