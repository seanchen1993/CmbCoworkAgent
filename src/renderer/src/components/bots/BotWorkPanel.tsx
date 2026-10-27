import { useEffect, useRef, useState } from "react"
import { useAppStore } from "@/lib/store"
import { Plus, ArrowLeft, ArrowUpRight, Check, RotateCcw } from "lucide-react"
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
    [goal, setGoal] = useState(""),
    [directoryPath, setDirectoryPath] = useState("")
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null),
    [limit, setLimit] = useState(6)
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)
  const threadWorkspace = useAppStore(
    (state) =>
      state.threads.find((thread) => thread.thread_id === selected?.threadId)?.metadata
        ?.workspacePath
  )
  const [workspace, setWorkspace] = useState<{ id: string; path: string } | null>(null)
  useEffect(() => {
    let disposed = false
    setWorkspace(null)
    if (selected && !selected.source)
      void window.api.threads
        .get(selected.threadId)
        .then((row) => {
          const path = row?.metadata?.workspacePath
          if (!disposed && typeof path === "string") setWorkspace({ id: selected.id, path })
        })
        .catch(() => {})
    return () => {
      disposed = true
    }
  }, [
    selected?.id,
    selected?.threadId,
    selected?.threadInitialized,
    selected?.conversation?.state,
    threadWorkspace
  ])
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
  const directory = [
    ...controller.priority,
    ...controller.items.filter((item) => !controller.priority.some((v) => v.id === item.id))
  ]
  const selectedPath =
    selected?.workspace?.path ?? (workspace?.id === selected?.id ? workspace?.path : undefined)
  const sourceLabel = selected?.source
    ? selected.source.transport === "im" ? "IM 渠道交办" : "模拟渠道交办"
    : selected?.conversation?.origin === "existing"
      ? selected.conversation.ref.kind === "project_session"
        ? "已有项目会话关联"
        : selected.conversation.ref.kind === "cloud_session"
          ? "已有云端会话关联"
          : "已有会话关联"
      : "Bot 内新建"
  return (
    <section className="bot-detail-section bot-works" aria-label="独立任务">
      <div className="bot-works-heading">
        <h3>独立任务</h3>
        <button
          disabled={disabled || saving}
          onClick={() => setEditing(!editing)}
          aria-label="新建独立任务"
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
              {selected.state === "completed" ? "继续处理" : "完成任务"}
            </button>
          </div>
          <div className="bot-work-origin" aria-label="任务来源">
            <span>来源 · {sourceLabel}</span>
            {!selected.source && client.conversations && (
              <button disabled={saving} onClick={() => void openConversation()}>
                {selected.conversation?.origin === "existing" ? "打开原会话" : "在对话模式打开"}
                <ArrowUpRight size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          {selectedPath && (
            <small className="block truncate" title={selectedPath}>
              工作目录：{selectedPath}
              {selected.workspace?.kind === "project"
                ? `（项目：${selected.workspace.projectName}）`
                : selected.workspace?.kind === "directory"
                  ? "（指定目录）"
                  : selected.conversation?.origin === "existing"
                    ? ""
                    : "（Bot默认目录）"}
            </small>
          )}
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
      {(error || controller.error) && (
        <p role="alert">
          {error || controller.error}
          <button onClick={() => void controller.refresh()}>刷新</button>
        </p>
      )}
      <div className="bot-work-list" aria-label="全部任务">
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
              {work.source ? (work.source.transport === "im" ? "IM · " : "模拟渠道 · ") : ""}
              {status(work)}
            </small>
          </button>
        ))}
      </div>
      {!directory.length && !controller.loading && <p>明确交办的任务会在这里保留独立会话。</p>}
      {(directory.length > limit || controller.cursor) && (
        <button
          disabled={controller.loading}
          onClick={() => {
            if (limit >= directory.length) void controller.more()
            setLimit((v) => v + 40)
          }}
        >
          更多任务
        </button>
      )}
    </section>
  )
}
