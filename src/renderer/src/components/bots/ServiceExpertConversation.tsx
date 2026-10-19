import { ServiceDeliveryCard } from "./ServiceDeliveryCard"
import { useEffect, useRef, useState } from "react"
import { ArrowUp, Loader2, Plus, RefreshCw, Square } from "lucide-react"
import { BotAvatar } from "./BotAvatar"
import { Button } from "@/components/ui/button"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { formatMessageTimeLabel } from "@/lib/message-bubble-timing"
import { useAppStore } from "@/lib/store"
import type {
  ServiceConversationApi,
  ServiceConversationOverview,
  ServiceRequestStatus,
  ServiceRequestView,
  ServiceTaskView
} from "../../../../shared/bot/service-conversation"

export const SERVICE_EXPERT_SELECTION = "service-expert-conversation"
export const SERVICE_STATUS: Record<ServiceRequestStatus, string> = {
  saved: "已保存",
  next_round: "下一轮分析采用",
  submitting: "正在保存到服务",
  queued: "等待执行",
  waiting_node: "等待设备上线",
  starting: "准备分析",
  running: "执行中",
  succeeded: "分析完成",
  failed: "分析失败",
  cancelled: "已停止",
  outcome_unknown: "结果待核对",
  blocked: "受阻"
}
const busy = (status: ServiceRequestStatus) =>
  ["saved", "next_round", "submitting", "queued", "waiting_node", "starting", "running"].includes(
    status
  )
function message(error: unknown) {
  const raw = error instanceof Error ? error.message : ""
  const codes: Record<string, string> = {
    MODEL_UNAVAILABLE: "请先选择可用模型",
    MODEL_CHANGED: "模型配置已变化，请重新选择",
    FORBIDDEN: "当前身份没有访问权限，请检查连接与授权",
    COMMAND_CONFLICT: "请求内容已变化，原请求已保留",
    VERSION_CONFLICT: "任务已变化，请刷新核对",
    NOT_CONFIGURED: "请先配置服务专家",
    NODE_OFFLINE: "请先连接控制服务",
    EXECUTION_BINDING_MISMATCH: "执行绑定不一致，需要核对",
    DEPENDENCY_UNAVAILABLE: "服务暂时不可用，请稍后刷新"
  }
  return Object.entries(codes).find(([code]) => raw.includes(code))?.[1] ?? "操作未完成，请刷新核对"
}
/** No chat Thread, generic submit, attachments, personal files or local Bot API.
 * Reuses the Bot workspace visual elements and markdown presentation only. */
export function ServiceExpertConversation({
  api = window.api.serviceConversation,
  onName
}: {
  api?: ServiceConversationApi
  onName?: (name: string | null) => void
}) {
  const [overview, setOverview] = useState<ServiceConversationOverview | null>(null)
  const [tasks, setTasks] = useState<ServiceTaskView[]>([]),
    [taskCursor, setTaskCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null),
    [entries, setEntries] = useState<ServiceRequestView[]>([]),
    [entryCursor, setEntryCursor] = useState<string | null>(null)
  const [text, setText] = useState(""),
    [error, setError] = useState<string | null>(null),
    [working, setWorking] = useState(false)
  const suspended = useRef(false),
    workingRef = useRef(false),
    entryValues = useRef<ServiceRequestView[]>([])
  useEffect(() => {
    entryValues.current = entries
  }, [entries])
  const generation = useRef(0),
    lock = useRef(false),
    rerun = useRef(false),
    mounted = useRef(true)
  const selection = useRef<string | null>(null),
    conversation = useRef<string | null>(null)
  const loadedTasks = useRef(1),
    loadedEntries = useRef(1)
  const taskAnchor = useRef<string | null>(null),
    entryAnchor = useRef<string | null>(null)
  const pendingSend = useRef<{
    conversationId: string
    taskRef: string | null
    requestId: string
    text: string
  } | null>(null)
  const configure = () => useAppStore.getState().setShowCustomizeView(true, "partnerDev")
  const valid = (g: number, id = conversation.current, ref = selection.current) =>
    mounted.current &&
    g === generation.current &&
    id === conversation.current &&
    ref === selection.current
  const clear = () => {
    setOverview(null)
    setTasks([])
    setTaskCursor(null)
    setEntries([])
    setEntryCursor(null)
    conversation.current = null
    selection.current = null
    setSelected(null)
    loadedTasks.current = 1
    loadedEntries.current = 1
    taskAnchor.current = null
    entryAnchor.current = null
  }
  const select = (ref: string | null) => {
    generation.current++
    selection.current = ref
    setSelected(ref)
    setEntries([])
    setEntryCursor(null)
    loadedEntries.current = 1
    entryAnchor.current = null
    setError(null)
  }
  const refresh = async (activeOnly = false) => {
    if (suspended.current) return
    if (workingRef.current || lock.current) {
      rerun.current = true
      return
    }
    lock.current = true
    const g = generation.current
    try {
      const info = await api.open()
      if (!valid(g)) return
      if (conversation.current !== info.conversationId) {
        clear()
        conversation.current = info.conversationId
        pendingSend.current = null
        setText("")
      }
      setOverview(info)
      onName?.(info.expertName)
      const id = info.conversationId,
        ref = selection.current
      if (!id) {
        setTasks([])
        setEntries([])
        return
      }
      let next: string | null = null,
        taskValues: ServiceTaskView[] = [],
        taskPages = 0
      const taskCursors = new Set<string>()
      do {
        const page = await api.tasks({ conversationId: id, cursor: next })
        if (!valid(g, id, ref)) return
        taskValues.push(...page.items)
        next = page.nextCursor
        taskPages++
        if (next) {
          if (taskCursors.has(next)) throw Error("repeated cursor")
          taskCursors.add(next)
        }
      } while (
        next &&
        (taskPages < loadedTasks.current ||
          (!!taskAnchor.current && !taskValues.some((t) => t.taskRef === taskAnchor.current)))
      )
      let requestValues: ServiceRequestView[] = [],
        requestNext: string | null = null,
        requestPages = 0
      if (ref && activeOnly) {
        requestValues = [...entryValues.current]
        requestNext = entryCursor
        requestPages = loadedEntries.current
        const pending = requestValues
          .filter((r) => busy(r.status) || r.publication?.state === "saving")
          .map((r) => r.requestId)
        for (let i = 0; i < pending.length; i += 40) {
          const updates = await api.updates({
            conversationId: id,
            taskRef: ref,
            requestIds: pending.slice(i, i + 40)
          })
          if (!valid(g, id, ref)) return
          const changed = new Map(updates.map((r) => [r.requestId, r]))
          requestValues = requestValues.map((r) => changed.get(r.requestId) ?? r)
        }
      } else if (ref) {
        const requestCursors = new Set<string>()
        do {
          const page = await api.read({ conversationId: id, taskRef: ref, cursor: requestNext })
          if (!valid(g, id, ref)) return
          requestValues = [...page.items, ...requestValues]
          requestNext = page.nextCursor
          requestPages++
          if (requestNext) {
            if (requestCursors.has(requestNext)) throw Error("repeated cursor")
            requestCursors.add(requestNext)
          }
        } while (
          requestNext &&
          (requestPages < loadedEntries.current ||
            (!!entryAnchor.current &&
              !requestValues.some((e) => e.requestId === entryAnchor.current)))
        )
      }
      if (!valid(g, id, ref)) return
      setTasks(taskValues)
      setTaskCursor(next)
      loadedTasks.current = taskPages
      taskAnchor.current = taskValues.at(-1)?.taskRef ?? null
      setEntries(requestValues)
      setEntryCursor(requestNext)
      loadedEntries.current = Math.max(1, requestPages)
      entryAnchor.current = requestValues[0]?.requestId ?? null
      setError(null)
    } catch (cause) {
      if (valid(g)) {
        clear()
        setError(message(cause))
      }
    } finally {
      lock.current = false
      if (rerun.current && mounted.current) {
        rerun.current = false
        void refresh()
      }
    }
  }
  useEffect(() => {
    mounted.current = true
    const focus = () => {
      void refresh()
    }
    window.addEventListener("focus", focus)
    const unsubscribe = api.subscribeInvalidation?.((busy = false) => {
      generation.current++
      suspended.current = busy
      clear()
      pendingSend.current = null
      setText("")
      if (!busy) void refresh()
    })
    void refresh()
    return () => {
      mounted.current = false
      generation.current++
      window.removeEventListener("focus", focus)
      unsubscribe?.()
    }
  }, [api])
  const polling =
    tasks.some((t) => busy(t.status)) ||
    entries.some((e) => busy(e.status) || e.publication?.state === "saving")
  useEffect(() => {
    if (!polling) return
    const timer = setTimeout(() => void refresh(true), 2000)
    return () => clearTimeout(timer)
  }, [polling, tasks, entries])
  useEffect(() => {
    if (selected) void refresh()
  }, [selected])
  const action = async (
    fn: (g: number, id: string | null, ref: string | null) => Promise<void>
  ) => {
    if (workingRef.current) return
    workingRef.current = true
    const g = ++generation.current,
      id = conversation.current,
      ref = selection.current
    setWorking(true)
    setError(null)
    try {
      await fn(g, id, ref)
    } catch (cause) {
      if (valid(g, id, ref)) setError(message(cause))
    } finally {
      workingRef.current = false
      if (mounted.current) {
        setWorking(false)
        if (rerun.current && !lock.current) {
          rerun.current = false
          void refresh()
        }
      }
    }
  }
  const send = () =>
    action(async (g, id, ref) => {
      if (!id || !text.trim()) return
      const input = pendingSend.current ?? {
        conversationId: id,
        taskRef: ref,
        requestId: crypto.randomUUID(),
        text
      }
      pendingSend.current = input
      const receipt = await api.send(input)
      if (!valid(g, id, ref)) return
      pendingSend.current = null
      setText("")
      select(receipt.taskRef)
      setEntries([receipt])
      await refresh()
    })
  const moreTasks = () =>
    action(async (g, id, ref) => {
      if (!id || !taskCursor) return
      const page = await api.tasks({ conversationId: id, cursor: taskCursor })
      if (!valid(g, id, ref)) return
      setTasks((old) => [...old, ...page.items])
      setTaskCursor(page.nextCursor)
      loadedTasks.current++
      taskAnchor.current = page.items.at(-1)?.taskRef ?? taskAnchor.current
    })
  const moreEntries = () =>
    action(async (g, id, ref) => {
      if (!id || !ref || !entryCursor) return
      const page = await api.read({ conversationId: id, taskRef: ref, cursor: entryCursor })
      if (!valid(g, id, ref)) return
      setEntries((old) => [...page.items, ...old])
      setEntryCursor(page.nextCursor)
      loadedEntries.current++
      entryAnchor.current = page.items[0]?.requestId ?? entryAnchor.current
    })
  return (
    <div className="service-expert-shell" data-service-conversation>
      <section className="service-expert-chat">
        <header className="service-expert-header">
          <BotAvatar color="#168bea" shape="circle" size={34} />
          <div>
            <strong>{overview?.expertName ?? "服务专家"}</strong>
            <p>服务管理 · 本机文本分析</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新服务会话"
            onClick={() => void refresh()}
          >
            <RefreshCw size={17} />
          </Button>
        </header>
        {error && (
          <div className="bot-notice" role="alert">
            {error}
          </div>
        )}
        {!overview?.conversationId ? (
          <div className="bot-empty">
            <p>{overview?.connected ? "尚未配置服务专家" : "连接服务后即可与专家合作"}</p>
            <Button onClick={configure}>配置服务专家</Button>
          </div>
        ) : (
          <>
            <div className="service-expert-controls">
              <label>
                分析模型{" "}
                <select
                  aria-label="服务分析模型"
                  value={overview.selectedModel?.ref ?? ""}
                  disabled={working}
                  onChange={(e) => {
                    const modelRef = e.target.value
                    void action(async (g, id, ref) => {
                      const next = await api.selectModel({ conversationId: id!, modelRef })
                      if (valid(g, id, ref) && next.conversationId === id) setOverview(next)
                    })
                  }}
                >
                  <option value="" disabled>
                    请选择模型
                  </option>
                  {overview.models.map((m) => (
                    <option key={m.ref} value={m.ref}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <span>{overview.nodeEnabled ? "本机已启用" : "本机未启用"}</span>
              {!overview.nodeEnabled && (
                <Button variant="outline" onClick={configure}>
                  启用本机
                </Button>
              )}
            </div>
            <div className="service-expert-messages" aria-live="polite">
              {!selected && (
                <div className="bot-empty">
                  <p>交办一件新工作，或从右侧选择任务继续补充。</p>
                  <small>仅分析你提供的任务文本，结果为草稿。</small>
                </div>
              )}
              {selected && overview.conversationId && (
                <ServiceDeliveryCard
                  key={overview.conversationId + ":" + selected}
                  api={api}
                  conversationId={overview.conversationId}
                  taskRef={selected}
                  entries={entries}
                  localPending={entries.some(
                    (e) =>
                      !e.supersededBy &&
                      (busy(e.status) || e.status === "outcome_unknown" || e.status === "blocked")
                  )}
                  onChange={() => void refresh()}
                  onNew={() => select(null)}
                />
              )}
              {entries.map((entry) => (
                <article key={entry.requestId} className="service-expert-exchange">
                  <div className="service-expert-user">
                    <p>{entry.text}</p>
                  </div>
                  <div className="service-expert-state">
                    <span>{SERVICE_STATUS[entry.status]}</span>
                    {entry.notice && (
                      <small>
                        {/^[A-Z_]+$/.test(entry.notice)
                          ? message(new Error(entry.notice))
                          : entry.notice}
                      </small>
                    )}
                    {busy(entry.status) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`停止请求 ${entry.requestId}`}
                        disabled={working}
                        onClick={() =>
                          void action(async (g, id, ref) => {
                            await api.cancel({ conversationId: id!, requestId: entry.requestId })
                            if (valid(g, id, ref)) await refresh()
                          })
                        }
                      >
                        <Square size={12} />
                        停止
                      </Button>
                    )}
                  </div>
                  {entry.result && (
                    <div className="service-expert-result">
                      <BotAvatar color="#168bea" shape="circle" size={24} />
                      <div>
                        <div className="streaming-markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              a: ({ children }) => <span>{children}</span>,
                              img: ({ alt }) => <span>{alt}</span>
                            }}
                          >
                            {entry.result.text}
                          </ReactMarkdown>
                        </div>
                        <small>
                          分析记录 · {formatMessageTimeLabel(Date.parse(entry.result.settledAt))}
                          {entry.publication?.state === "saving" && " · 分析完成，成果保存中"}
                          {entry.publication?.state === "blocked" && " · 成果保存受阻"}
                        </small>
                        {entry.publication?.state === "history" && (
                          <Button
                            variant="outline"
                            disabled={working}
                            onClick={() =>
                              void action(async (g, id, ref) => {
                                await api.publish({
                                  conversationId: id!,
                                  requestId: entry.requestId
                                })
                                if (valid(g, id, ref)) await refresh()
                              })
                            }
                          >
                            提交为成果
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              ))}
              {entryCursor && (
                <Button variant="outline" disabled={working} onClick={() => void moreEntries()}>
                  查看更多记录
                </Button>
              )}
            </div>
            <form
              className="service-expert-composer"
              onSubmit={(e) => {
                e.preventDefault()
                void send()
              }}
            >
              <label htmlFor="service-text">{selected ? "补充当前任务" : "交办新任务"}</label>
              <textarea
                id="service-text"
                aria-label="服务任务文本"
                maxLength={16384}
                rows={3}
                value={text}
                disabled={
                  working ||
                  !!pendingSend.current ||
                  tasks.find((t) => t.taskRef === selected)?.delivery?.taskStatus === "completed"
                }
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  selected
                    ? "补充要求；执行中的内容会在下一轮分析采用"
                    : "例如：整理需求说明，列出业务规则和待确认事项"
                }
              />
              <div>
                <small>
                  {selected &&
                  entries.some((e) => busy(e.status) || e.publication?.state === "saving")
                    ? "补充已保存后，将等待前一轮结束。"
                    : "仅使用当前任务材料 · 本机保留历史"}
                </small>
                <Button
                  type="submit"
                  disabled={
                    working ||
                    !text.trim() ||
                    !overview.selectedModel ||
                    tasks.find((t) => t.taskRef === selected)?.delivery?.taskStatus === "completed"
                  }
                >
                  {working ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={16} />}{" "}
                  {pendingSend.current ? "重试原请求" : "发送"}
                </Button>
              </div>
            </form>
          </>
        )}
      </section>
      <aside className="service-expert-tasks" aria-label="服务任务记录">
        <header>
          <strong>任务记录</strong>
          <Button
            variant="ghost"
            size="sm"
            disabled={working || !!pendingSend.current}
            onClick={() => select(null)}
          >
            <Plus size={15} />
            新任务
          </Button>
        </header>
        <p>选择任务后，补充会关联同一件工作。</p>
        {tasks.map((task) => (
          <button
            key={task.taskRef}
            className="service-expert-task"
            data-selected={selected === task.taskRef}
            onClick={() => select(task.taskRef)}
            disabled={working || !!pendingSend.current}
          >
            <strong>{task.title}</strong>
            <small>
              {task.taskNumber ?? "正在保存"} ·{" "}
              {task.delivery?.taskStatus === "completed"
                ? "已确认完成"
                : task.delivery?.head?.status === "pending"
                  ? "待确认"
                  : SERVICE_STATUS[task.status]}
            </small>
          </button>
        ))}
        {taskCursor && overview?.conversationId && (
          <Button variant="outline" onClick={() => void moreTasks()}>
            更多任务
          </Button>
        )}
        {polling && <small role="status">正在更新任务状态…</small>}
        <Button variant="ghost" onClick={configure}>
          专家与本机设置
        </Button>
      </aside>
    </div>
  )
}
