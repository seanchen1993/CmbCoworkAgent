import { useEffect, useId, useRef, useState } from "react"
import { useAppStore } from "@/lib/store"
import { useThreadContext } from "@/lib/thread-context"
import {
  Plus, ArrowLeft, ArrowUpRight, Check, ChevronRight, CircleAlert, CircleCheck, CircleDashed,
  CircleDot, CirclePause, CircleStop, Clock3, Loader2, RotateCcw, MoreHorizontal,
  Search, Square, X
} from "lucide-react"
import { Close as PopoverClose } from "@radix-ui/react-popover"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem, BotWorkSummary } from "../../../../shared/bots/work"
import type { useBotWorks } from "./use-bot-works"
import { botErrorMessage } from "@/lib/bot-error-message"
import { resolveBotWorkStatus } from "@/lib/bot/work-status"
import { openBotWorkThreadChat, resolveBotWorkThreadForNavigation } from "@/lib/bot/work-thread-summary"

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
  onPreview?(work: BotWorkSummary, trigger: HTMLButtonElement): void
  captureWorkNavigation?(): () => boolean
  heading?: string
  allowCreate?: boolean
  backLabel?: string
  onBack?(): void
  disabled: boolean
}) {
  const threadContext = useThreadContext()
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(""),
    [goal, setGoal] = useState(""),
    [directoryPath, setDirectoryPath] = useState("")
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null),
    [limit, setLimit] = useState(6)
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const closeCreate = () => {
    if (saving) return
    setEditing(false)
    createButton.current?.focus({ preventScroll: true })
  }
  const [searching, setSearching] = useState(false)
  const searchId = useId()
  const searchInput = useRef<HTMLInputElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (searching) searchInput.current?.focus() }, [searching])
  const closeSearch = () => {
    controller.setQuery("")
    setSearching(false)
    setLimit(6)
    searchButton.current?.focus()
  }
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
    const isNavigationCurrent = captureWorkNavigation?.()
    setSaving(true)
    setError(null)
    const isCurrent = () => isNavigationCurrent?.() !== false && controller.current.current.botId === owner &&
      controller.current.current.selectedId === id
    try {
      const threadId = await resolveBotWorkThreadForNavigation(client, selected, isCurrent)
      if (threadId && isCurrent()) await openBotWorkThreadChat(threadContext, threadId)
    } catch (cause) {
      if (isCurrent()) setError(botErrorMessage(cause))
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
    const isNavigationCurrent = captureWorkNavigation?.()
    const trigger = createButton.current
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
      void controller.refresh()
      if (controller.current.current.botId !== owner) return
      operation.current = null
      setEditing(false)
      setTitle("")
      setGoal("")
      setDirectoryPath("")
      if (isNavigationCurrent?.() === false || !trigger || trigger !== createButton.current) return
      if (onPreview) onPreview(receipt.work, trigger)
      else onSelect(receipt.work.id)
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
      action = selected.state === "completed" || selected.dispatchStopped ? "continue" : "complete"
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
  const stopSelected = async () => {
    if (!client.works?.stop || !selected || saving) return
    const owner = botId, workId = selected.id
    setSaving(true)
    setError(null)
    try {
      await client.works.stop(owner, workId)
      if (controller.current.current.botId === owner) void controller.refresh()
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
    <section className="bot-detail-section bot-detail-card bot-works" aria-label={heading}>
      <div className="bot-works-heading bot-detail-card-heading">
        <h3>{heading}</h3>
        <div className="bot-detail-card-actions">
          <button type="button" className="bot-icon-button" ref={searchButton}
            aria-label="搜索任务" aria-expanded={searching || Boolean(controller.query)} aria-controls={searchId}
            onClick={() => searching || controller.query ? closeSearch() : setSearching(true)}>
            <Search size={15} />
          </button>
        {allowCreate && (
          <button
            type="button" className="bot-icon-button"
            ref={createButton}
            disabled={disabled || saving}
            onClick={() => setEditing(!editing)}
            aria-label="新建独立任务"
          >
            <Plus size={16} />
          </button>
        )}
        </div>
      </div>
      {selected && (
        <div className="bot-work-current">
          <div className="bot-work-toolbar">
            <span className="bot-work-status" data-tone={botWorkStatusTone(selected)}>
              <BotWorkStatusIcon work={selected} />
              {botWorkStatus(selected)}
              {selected.readyServiceState && <small> · 服务运行中</small>}
            </span>
            <div className="bot-work-actions">
              {!selected.source && client.conversations && (
                <button disabled={saving || selected.deletionPending} onClick={() => void openConversation()}>
                  {selected.conversation?.origin === "existing" ||
                  selected.conversation?.state === "detached"
                    ? "打开原会话"
                    : "在工作台打开"}
                  <ArrowUpRight size={13} aria-hidden="true" />
                </button>
              )}
              <Popover key={selected.id}>
                <PopoverTrigger asChild>
                  <button className="bot-icon-button" aria-label="任务详情与操作">
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  data-bot-popup
                  align="end"
                  className="bot-workspace-menu bot-work-options rounded-xl"
                  aria-label="任务详情与操作"
                >
                  <strong>{selected.title}</strong>
                  <dl>
                    <dt>来源</dt>
                    <dd>{sourceLabel}</dd>
                    {selected.workspace?.kind === "project" && <>
                      <dt>项目</dt>
                      <dd>{selected.workspace.projectName}</dd>
                    </>}
                    {selectedPath && <>
                      <dt>工作目录</dt>
                      <dd>
                        <details className="bot-work-path">
                          <summary title={selectedPath}>
                            {selected.workspace?.kind === "default" ||
                            (!selected.workspace && selected.conversation?.origin !== "existing")
                              ? "Bot 工作目录"
                              : selectedPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || selectedPath}
                          </summary>
                          <p>{selectedPath}</p>
                        </details>
                      </dd>
                    </>}
                  </dl>
                  {selected.deletionPending && <p className="text-sm text-muted-foreground">清理尚未完成，可在主对话继续删除此任务。</p>}
                  {!selected.deletionPending && selected.conversation?.state !== "detached" && (
                    <>
                    {client.works.stop && (!selected.dispatchStopped || selected.backgroundBusy || selected.pendingPeers ||
                      ["queued", "running", "waiting_user"].includes(selected.executionState ?? "")) && (
                      <PopoverClose asChild>
                        <button className="bot-work-lifecycle" disabled={disabled || saving}
                          onClick={() => void stopSelected()}>
                          <Square size={14} />停止任务
                        </button>
                      </PopoverClose>
                    )}
                    <PopoverClose asChild>
                    <button
                      className="bot-work-lifecycle"
                      disabled={disabled || saving}
                      onClick={() => void lifecycle()}
                    >
                      {selected.state === "completed" || selected.dispatchStopped ? <RotateCcw size={14} /> : <Check size={14} />}
                      {selected.state === "completed" || selected.dispatchStopped ? "继续处理" : "完成任务"}
                    </button>
                    </PopoverClose>
                    </>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </div>
          {onBack && (
            <button onClick={onBack}>
              <ArrowLeft size={13} />
              {backLabel}
            </button>
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
            <button type="button" disabled={saving} onClick={closeCreate}>
              取消
            </button>
            <button disabled={disabled || saving || !title.trim() || !goal.trim()} type="submit">
              交办任务
            </button>
          </div>
        </form>
      )}
      {(searching || controller.query) && <div className="bot-work-search-field" id={searchId}>
      <Search size={14} aria-hidden="true" />
      <input
        ref={searchInput}
        className="bot-work-search"
        aria-label="搜索任务"
        placeholder="搜索任务…"
        value={controller.query}
        onChange={(e) => {
          setLimit(6)
          controller.setQuery(e.target.value)
        }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeSearch() } }}
      />
      <button type="button" className="bot-icon-button" aria-label="关闭任务搜索" onClick={closeSearch}><X size={14} /></button>
      </div>}
      {(error || controller.error) && (
        <p role="alert">
          {error || controller.error}
          <button onClick={() => void controller.refresh()}>刷新</button>
        </p>
      )}
      <div className="bot-work-list" aria-label="全部任务">
        {directory.slice(0, limit).map((work) => {
          const status = resolveBotWorkStatus(work)
          const source = work.source ? (work.source.transport === "im" ? "IM · " : "模拟渠道 · ") : ""
          const statusLabel = source + status.label + (work.readyServiceState ? " · 服务运行中" : "")
          return (
            <button
              className="bot-work-row"
              data-work-id={work.id}
              title={work.title}
              key={work.id}
              aria-pressed={selected?.id === work.id}
              data-tone={status.tone}
              onClick={(event) => onPreview ? onPreview(work, event.currentTarget) : onSelect(work.id)}
            >
              <BotWorkStatusIcon work={work} status={status} />
              <span className="bot-work-row-copy">
                <span className="bot-work-row-title">{work.title}</span>
                <small title={statusLabel}>{statusLabel}</small>
              </span>
              {work.activity?.unread && <span className="bot-work-unread" aria-label="未读" />}
              <ChevronRight aria-hidden="true" className="bot-work-row-chevron" size={14} />
            </button>
          )
        })}
      </div>
      {!directory.length && !controller.loading && <p className="bot-detail-empty">{controller.query ? "没有匹配的任务" : "暂无任务"}</p>}
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
