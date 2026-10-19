import { useCallback, useEffect, useRef, useState } from "react"
import type {
  ServiceConversationApi,
  ServiceConversationOverview,
  ServiceRequestView,
  ServiceTaskView
} from "../../../../shared/bot/service-conversation"

export const SERVICE_NEW_TASK = "new-task"
export const SERVICE_EXPERT_SELECTION = "service-expert-conversation"
export const serviceSelection = (ref: string | null) =>
  ref ? SERVICE_EXPERT_SELECTION + ":" + ref : SERVICE_EXPERT_SELECTION
export const serviceTaskRef = (selection: string | null) =>
  selection?.startsWith(SERVICE_EXPERT_SELECTION + ":")
    ? selection.slice(SERVICE_EXPERT_SELECTION.length + 1)
    : null
export const serviceBusy = (r: ServiceRequestView) =>
  !r.supersededBy &&
  (["saved", "next_round", "submitting", "queued", "waiting_node", "starting", "running"].includes(
    r.status
  ) ||
    r.coordination?.state === "waiting")
export function serviceError(error: unknown): string {
  const raw = error instanceof Error ? error.message : ""
  const codes: Record<string, string> = {
    MODEL_UNAVAILABLE: "请先选择可用模型",
    MODEL_CHANGED: "模型配置已变化，请重新选择",
    FORBIDDEN: "当前身份没有访问权限，请检查连接与授权",
    INPUT_CHANGED: "任务状态已变化，或仍有待处理消息，请刷新核对",
    VERSION_CONFLICT: "任务已变化，请刷新核对",
    NOT_CONFIGURED: "请先配置服务专家",
    NODE_OFFLINE: "请先连接控制服务",
    SCOPE_MIGRATION_CONFLICT: "历史连接存在冲突，需要核对后恢复",
    PAYLOAD_TOO_LARGE: "会话内容已超过本轮输入上限，请缩小输入范围",
    DEPENDENCY_UNAVAILABLE: "服务暂时不可用，请稍后刷新"
  }
  return Object.entries(codes).find(([code]) => raw.includes(code))?.[1] ?? "操作未完成，请刷新核对"
}
const merge = <T>(old: T[], fresh: T[], key: (value: T) => string) => {
  const values = new Map(old.map((value) => [key(value), value]))
  for (const value of fresh) values.set(key(value), value)
  return [...values.values()]
}
/** One workspace controller owns the sidebar and selected transcript. It never
 * opens personal Threads, starts a model or submits through local Bot APIs. */
export function useServiceExpertChats(
  api: ServiceConversationApi | undefined,
  selectedRef: string | null,
  active: boolean,
  query = "",
  onSelect?: (ref: string | null) => void
) {
  const [overview, setOverview] = useState<
    (ServiceConversationOverview & { mainTaskRef: string | null }) | null
  >(null)
  const [tasks, setTasks] = useState<ServiceTaskView[]>([]),
    [taskCursor, setTaskCursor] = useState<string | null>(null)
  const [entries, setEntries] = useState<ServiceRequestView[]>([]),
    [entryCursor, setEntryCursor] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<ServiceTaskView | undefined>()
  const [tick, setTick] = useState(0)
  const refreshLock = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null),
    [working, setWorking] = useState(false),
    [draft, setDraftState] = useState("")
  const mounted = useRef(true),
    generation = useRef(0),
    selectionGeneration = useRef(0),
    suspended = useRef(false),
    lock = useRef(false)
  const values = useRef({ overview, tasks, entries, selectedRef, active, query })
  values.current = { overview, tasks, entries, selectedRef, active, query }
  const pendingSend = useRef(
    new Map<
      string,
      {
        conversationId: string
        taskRef: string | null
        role: "main" | "task"
        requestId: string
        text: string
      }
    >()
  )
  const valid = useCallback(
    (g: number, id?: string | null) =>
      mounted.current &&
      !suspended.current &&
      g === generation.current &&
      (id === undefined || id === values.current.overview?.conversationId),
    []
  )
  const clear = useCallback(() => {
    generation.current++
    selectionGeneration.current++
    setOverview(null)
    setTasks([])
    setEntries([])
    setTaskCursor(null)
    setEntryCursor(null)
    setPending(false)
    pendingSend.current.clear()
  }, [])
  const reload = useCallback(async () => {
    if (!api || suspended.current || lock.current) return
    lock.current = true
    const g = generation.current
    try {
      const info = await api.openChats()
      if (!valid(g)) return
      if (
        values.current.overview?.conversationId &&
        values.current.overview.conversationId !== info.conversationId
      ) {
        clear()
        return
      }
      setOverview(info)
      setError(null)
    } catch (error) {
      if (valid(g)) {
        clear()
        setError(serviceError(error))
      }
    } finally {
      lock.current = false
    }
  }, [api, clear, valid])
  useEffect(() => {
    mounted.current = true
    void reload()
    const unsubscribe = api?.subscribeInvalidation?.((busy) => {
      clear()
      suspended.current = busy
      if (!busy) void reload()
    })
    return () => {
      mounted.current = false
      generation.current++
      unsubscribe?.()
    }
  }, [api, reload, clear])
  const conversationId = overview?.conversationId ?? null
  useEffect(() => {
    if (!api || !conversationId) return
    const g = generation.current,
      q = query
    let live = true
    setTasks([])
    setTaskCursor(null)
    void api
      .chatTasks({
        conversationId,
        cursor: null,
        query: q,
        selectedRef:
          values.current.selectedRef === SERVICE_NEW_TASK ? null : values.current.selectedRef
      })
      .then((page) => {
        if (live && valid(g, conversationId) && values.current.query === q) {
          setTasks(page.items)
          setTaskCursor(page.nextCursor)
          setPending(!!page.pending)
        }
      })
      .catch((error) => {
        if (live && valid(g, conversationId)) setError(serviceError(error))
      })
    return () => {
      live = false
    }
  }, [api, conversationId, query, valid])
  const ref = selectedRef ?? overview?.mainTaskRef ?? null
  useEffect(() => {
    const sg = ++selectionGeneration.current,
      g = generation.current
    setEntries([])
    setEntryCursor(null)
    setSelectedTask(undefined)
    setError(null)
    if (!api || !conversationId || !ref || ref === SERVICE_NEW_TASK || !active) return
    void api
      .read({ conversationId, taskRef: ref, cursor: null })
      .then((page) => {
        if (valid(g, conversationId) && sg === selectionGeneration.current) {
          setEntries(page.items)
          setEntryCursor(page.nextCursor)
          setSelectedTask(page.task)
        }
      })
      .catch((error) => {
        if (valid(g, conversationId) && sg === selectionGeneration.current)
          setError(serviceError(error))
      })
  }, [api, conversationId, ref, active, valid])
  const draftKey = conversationId
    ? "service-chat-draft:" + conversationId + ":" + (selectedRef ?? "main")
    : null
  useEffect(() => {
    try {
      setDraftState(draftKey ? (localStorage.getItem(draftKey) ?? "") : "")
    } catch {
      setDraftState("")
    }
  }, [draftKey])
  const setDraft = (text: string) => {
    setDraftState(text)
    if (draftKey) {
      try {
        localStorage.setItem(draftKey, text)
      } catch {
        setError("草稿暂时无法保存")
      }
    }
  }
  const refresh = useCallback(async () => {
    if (
      !api ||
      !values.current.overview?.conversationId ||
      suspended.current ||
      refreshLock.current
    )
      return
    refreshLock.current = true
    const g = generation.current,
      sg = selectionGeneration.current,
      current = values.current,
      id = current.overview!.conversationId!,
      q = current.query
    try {
      const page = await api.chatTasks({
        conversationId: id,
        cursor: null,
        query: q,
        selectedRef:
          values.current.selectedRef === SERVICE_NEW_TASK ? null : values.current.selectedRef
      })
      if (!valid(g, id) || q !== values.current.query) return
      // Keep expanded history. Refresh only the latest bounded summary page.
      setTasks((old) =>
        merge(
          page.items,
          old.filter((value) => !page.items.some((item) => item.taskRef === value.taskRef)),
          (value) => value.taskRef
        )
      )
      setPending(!!page.pending)
      if (current.selectedRef) {
        const summary =
          page.selectedTask ?? page.items.find((t) => t.taskRef === current.selectedRef)
        if (summary && sg === selectionGeneration.current) setSelectedTask(summary)
      }
      const requestIds = current.entries.filter(serviceBusy).map((r) => r.requestId)
      const taskRef = current.selectedRef ?? current.overview!.mainTaskRef
      if (current.active && taskRef && sg === selectionGeneration.current) {
        for (let i = 0; i < requestIds.length; i += 40) {
          const updates = await api.updates({
            conversationId: id,
            taskRef,
            requestIds: requestIds.slice(i, i + 40)
          })
          if (!valid(g, id) || sg !== selectionGeneration.current) return
          setEntries((old) => merge(old, updates, (r) => r.requestId))
        }
      }
      if (valid(g, id)) setError(null)
    } catch (error) {
      if (valid(g, id) && sg === selectionGeneration.current) setError(serviceError(error))
    } finally {
      refreshLock.current = false
      if (mounted.current) setTick((value) => value + 1)
    }
  }, [api, valid])
  const polling =
    pending ||
    entries.some(serviceBusy) ||
    tasks.some(
      (t) =>
        t.busy ||
        [
          "saved",
          "next_round",
          "submitting",
          "queued",
          "waiting_node",
          "starting",
          "running"
        ].includes(t.status)
    )
  useEffect(() => {
    if (!polling || !conversationId) return
    const timer = setTimeout(() => {
      void refresh()
    }, 2000)
    return () => clearTimeout(timer)
  }, [polling, conversationId, pending, entries, tasks, tick, refresh])
  const moreTasks = async () => {
    if (!api || !conversationId || !taskCursor) return
    const g = generation.current,
      q = query,
      anchor = taskCursor
    try {
      const page = await api.chatTasks({ conversationId, cursor: anchor, query: q })
      if (valid(g, conversationId) && q === values.current.query) {
        setTasks((old) => merge(old, page.items, (t) => t.taskRef))
        setTaskCursor(page.nextCursor)
      }
    } catch (error) {
      if (valid(g, conversationId)) setError(serviceError(error))
    }
  }
  const moreEntries = async () => {
    if (!api || !conversationId || !ref || !entryCursor) return
    const g = generation.current,
      sg = selectionGeneration.current,
      anchor = entryCursor
    try {
      const page = await api.read({ conversationId, taskRef: ref, cursor: anchor })
      if (valid(g, conversationId) && sg === selectionGeneration.current) {
        setEntries((old) => merge(page.items, old, (t) => t.requestId))
        setEntryCursor(page.nextCursor)
      }
    } catch (error) {
      if (valid(g, conversationId) && sg === selectionGeneration.current)
        setError(serviceError(error))
    }
  }
  const run = async (action: () => Promise<void>) => {
    if (working || !api) return
    const g = generation.current,
      sg = selectionGeneration.current
    setWorking(true)
    try {
      await action()
      if (valid(g) && sg === selectionGeneration.current) {
        setError(null)
        await refresh()
      }
    } catch (error) {
      if (valid(g) && sg === selectionGeneration.current) setError(serviceError(error))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  const send = () =>
    run(async () => {
      if (!api || !conversationId || !draft.trim()) return
      const g = generation.current,
        sg = selectionGeneration.current,
        text = draft
      const draftId = conversationId + ":" + (selectedRef ?? "main"),
        old = pendingSend.current.get(draftId)
      const payload =
        old && old.text === text
          ? old
          : {
              conversationId,
              taskRef: selectedRef === SERVICE_NEW_TASK ? null : selectedRef,
              role: selectedRef ? ("task" as const) : ("main" as const),
              requestId: crypto.randomUUID(),
              text
            }
      pendingSend.current.set(draftId, payload)
      const request = await api.chat(payload)
      if (!valid(g, conversationId) || sg !== selectionGeneration.current) return
      pendingSend.current.delete(draftId)
      setPending(true)
      setDraft("")
      setEntries((old) => merge(old, [request], (r) => r.requestId))
      if (selectedRef === SERVICE_NEW_TASK) onSelect?.(request.taskRef)
    })
  const selectModel = (modelRef: string) =>
    run(async () => {
      if (!api || !conversationId) return
      const g = generation.current,
        sg = selectionGeneration.current
      const next = await api.selectModel({ conversationId, modelRef })
      if (valid(g, conversationId) && sg === selectionGeneration.current)
        setOverview((old) => (old ? { ...old, ...next } : null))
    })
  const task = selectedTask ?? tasks.find((t) => t.taskRef === selectedRef)
  return {
    overview,
    tasks,
    taskCursor,
    entries,
    entryCursor,
    error,
    working,
    draft,
    setDraft,
    reload,
    refresh,
    moreTasks,
    moreEntries,
    send,
    selectModel,
    task,
    lifecycle: (action: "complete" | "reopen") =>
      run(async () => {
        if (api && conversationId && selectedRef)
          await api.taskLifecycle({
            conversationId,
            taskRef: selectedRef,
            action,
            operationId: crypto.randomUUID()
          })
      }),
    cancel: (requestId: string) =>
      run(async () => {
        if (api && conversationId) await api.cancel({ conversationId, requestId })
      }),
    retry: (requestId: string) =>
      run(async () => {
        if (api && conversationId && ref)
          await api.retryChat({
            conversationId,
            taskRef: ref,
            requestId,
            operationId: crypto.randomUUID()
          })
      })
  }
}
export type ServiceExpertChats = ReturnType<typeof useServiceExpertChats>
