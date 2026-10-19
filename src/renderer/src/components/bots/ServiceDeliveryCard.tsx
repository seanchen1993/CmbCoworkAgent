import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Button } from "@/components/ui/button"
import { formatMessageTimeLabel } from "@/lib/message-bubble-timing"
import type {
  ServiceConversationApi,
  ServiceRequestView
} from "../../../../shared/bot/service-conversation"
import type {
  ServiceDeliveryView,
  TextDeliveryDetail,
  TextDeliveryVersionSummary
} from "../../../../shared/bot/text-delivery"
function nextPage(values: TextDeliveryVersionSummary[], fallback: number | null) {
  const gap = values.findIndex((value, i) => i > 0 && values[i - 1].number > value.number + 1)
  return gap > 0 ? values[gap - 1].number : values.at(-1)?.number === 1 ? null : fallback
}
const label = {
  pending: "待确认",
  changes_requested: "修改中",
  invalidated: "已补充，等待新版",
  completed: "已确认完成"
}
const explain = (cause: unknown) => {
  const text = cause instanceof Error ? cause.message : String(cause)
  if (text.includes("MODEL")) return "请重新选择可用模型，再继续修改。"
  if (text.includes("FORBIDDEN")) return "当前身份没有访问或确认权限。"
  if (/INPUT_CHANGED|VERSION_CONFLICT/.test(text)) return "任务或成果已变化，请刷新核对。"
  return "操作尚未完成，原请求已保留，请刷新核对。"
}
export function ServiceDeliveryCard({
  api,
  conversationId,
  taskRef,
  entries,
  localPending,
  onChange,
  onNew
}: {
  api: ServiceConversationApi
  conversationId: string
  taskRef: string
  entries: ServiceRequestView[]
  localPending: boolean
  onChange: () => void
  onNew: () => void
}) {
  const [view, setView] = useState<ServiceDeliveryView | null>(null),
    [versions, setVersions] = useState<TextDeliveryVersionSummary[]>([]),
    [before, setBefore] = useState<number | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<TextDeliveryDetail | null>(null),
    [feedback, setFeedback] = useState(""),
    [editing, setEditing] = useState(false),
    [working, setWorking] = useState(false),
    [error, setError] = useState<string | null>(null)
  const content = useRef<TextDeliveryDetail | null>(null),
    followCurrent = useRef(true)
  const generation = useRef(0),
    mounted = useRef(true),
    selection = useRef<string | null>(null),
    versionsRef = useRef<TextDeliveryVersionSummary[]>([]),
    beforeRef = useRef<number | null>(null),
    headRevision = useRef<number | null>(null),
    operation = useRef<{ fingerprint: string; id: string } | null>(null)
  const change = useRef(onChange)
  change.current = onChange
  const valid = (g: number) => mounted.current && generation.current === g
  const show = async (id: string) => {
    const g = ++generation.current
    selection.current = id
    followCurrent.current = id === view?.summary.head?.versionId
    setSelected(id)
    setDetail(null)
    try {
      const value = await api.deliveryVersion({ conversationId, taskRef, versionId: id })
      if (valid(g) && selection.current === id) {
        content.current = value
        setDetail(value)
        setError(null)
      }
    } catch (cause) {
      if (valid(g)) {
        content.current = null
        setDetail(null)
        setError(explain(cause))
      }
    }
  }
  const reload = async () => {
    const g = ++generation.current
    try {
      const value = await api.delivery({ conversationId, taskRef, before: null })
      if (!valid(g)) return
      setView(value)
      if (!value) return
      const first = !versionsRef.current.length
      const merged = [
        ...new Map([...versionsRef.current, ...value.versions].map((v) => [v.id, v])).values()
      ].sort((a, b) => b.number - a.number)
      versionsRef.current = merged
      setVersions(merged)
      beforeRef.current = nextPage(merged, first ? value.nextBefore : beforeRef.current)
      setBefore(beforeRef.current)
      const rev = value.summary.head?.revision ?? 0
      const target = followCurrent.current
        ? (value.summary.head?.versionId ?? null)
        : selection.current
      if (target) {
        selection.current = target
        setSelected(target)
        if (content.current?.version.id !== target || rev !== headRevision.current) {
          if (content.current?.version.id !== target) {
            content.current = null
            setDetail(null)
          }
          const result = await api.deliveryVersion({ conversationId, taskRef, versionId: target })
          if (!valid(g) || selection.current !== target) return
          content.current = result
          setDetail(result)
        }
      }
      if (!valid(g)) return
      setError(null)
      if (headRevision.current !== null && rev !== headRevision.current) change.current()
      headRevision.current = rev
    } catch (cause) {
      if (valid(g)) {
        setView(null)
        content.current = null
        setDetail(null)
        setError(explain(cause))
      }
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [api, conversationId, taskRef])
  // New Run/publication transitions refresh only the selected Task's summaries.
  const refreshKey = entries
    .map((e) => [e.requestId, e.status, e.publication?.state].join(":"))
    .join("|")
  useEffect(() => {
    void reload()
  }, [refreshKey])
  const saving = view?.actions.some((a) => a.state === "saving") ?? false
  useEffect(() => {
    if (!saving) return
    const timer = setTimeout(() => {
      void reload()
      change.current()
    }, 2000)
    return () => clearTimeout(timer)
  }, [saving, view])
  const runAction = async (fingerprint: string, fn: (id: string) => Promise<void>) => {
    if (working) return
    setWorking(true)
    setError(null)
    if (operation.current?.fingerprint !== fingerprint)
      operation.current = { fingerprint, id: crypto.randomUUID() }
    const g = ++generation.current
    try {
      await fn(operation.current.id)
      if (!valid(g)) return
      operation.current = null
      setEditing(false)
      setFeedback("")
      await reload()
      change.current()
    } catch (cause) {
      if (valid(g)) setError(explain(cause))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  const more = async () => {
    if (!beforeRef.current || working) return
    const g = ++generation.current,
      cursor = beforeRef.current
    setWorking(true)
    try {
      const value = await api.delivery({ conversationId, taskRef, before: cursor })
      if (!valid(g) || !value) return
      const merged = [
        ...new Map([...versionsRef.current, ...value.versions].map((v) => [v.id, v])).values()
      ].sort((a, b) => b.number - a.number)
      versionsRef.current = merged
      setVersions(merged)
      beforeRef.current = nextPage(merged, value.nextBefore)
      setBefore(beforeRef.current)
    } catch (cause) {
      if (valid(g)) setError(explain(cause))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  if (!view?.summary.head && !error) return null
  const head = view?.summary.head,
    current = !!head && selected === head.versionId,
    canReview =
      !!view?.summary.canReview &&
      current &&
      detail?.version.id === selected &&
      !localPending &&
      !saving &&
      !working
  return (
    <section className="service-delivery-card" aria-label="任务成果">
      <header>
        <strong>需求说明文本{head ? ` · ${label[head.status]}` : ""}</strong>
        <Button variant="ghost" size="sm" disabled={working} onClick={() => void reload()}>
          刷新成果
        </Button>
      </header>
      {error && <p role="alert">{error}</p>}
      {versions.length > 0 && (
        <label>
          成果版本{" "}
          <select
            aria-label="成果版本"
            value={selected ?? ""}
            disabled={working}
            onChange={(e) => void show(e.target.value)}
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.number}
                {v.id === head?.versionId ? " · 当前版本" : " · 历史版本"}
              </option>
            ))}
          </select>
        </label>
      )}
      {detail && (
        <>
          <small>
            v{detail.version.number} · 来源运行 {detail.version.sourceRunId} ·{" "}
            {formatMessageTimeLabel(Date.parse(detail.version.createdAt))}
          </small>
          <div className="streaming-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children }) => <span>{children}</span>,
                img: ({ alt }) => <span>{alt}</span>
              }}
            >
              {detail.version.text}
            </ReactMarkdown>
          </div>
          {detail.decision && (
            <p>
              {detail.decision.decision === "approve" ? "确认完成" : "退回修改"} ·{" "}
              {detail.decision.principalId} ·{" "}
              {formatMessageTimeLabel(Date.parse(detail.decision.createdAt))}
              {detail.decision.comment && (
                <span className="service-delivery-feedback">{detail.decision.comment}</span>
              )}
            </p>
          )}
          {!current && <small>历史版本仅供查看，确认操作只针对当前待确认版本。</small>}
        </>
      )}
      {head?.status === "pending" && (
        <div>
          <Button
            disabled={!canReview}
            onClick={() =>
              void runAction(`approve:${selected}`, (operationId) =>
                api.review({
                  conversationId,
                  taskRef,
                  operationId,
                  versionId: selected!,
                  decision: "approve",
                  comment: null
                })
              )
            }
          >
            确认完成
          </Button>
          <Button variant="outline" disabled={!canReview} onClick={() => setEditing(true)}>
            提出修改
          </Button>
          {localPending && <small>仍有已保存的工作待处理，完成后可确认新版。</small>}
          {editing && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void runAction(`reject:${selected}:${feedback}`, (operationId) =>
                  api.review({
                    conversationId,
                    taskRef,
                    operationId,
                    versionId: selected!,
                    decision: "reject",
                    comment: feedback
                  })
                )
              }}
            >
              <label>
                修改意见
                <textarea
                  aria-label="修改意见"
                  value={feedback}
                  maxLength={16384}
                  disabled={working}
                  onChange={(e) => setFeedback(e.target.value)}
                />
              </label>
              <Button type="submit" disabled={!canReview || !feedback.trim()}>
                保存意见并修改
              </Button>
            </form>
          )}
        </div>
      )}
      {saving && <p>正在保存成果或修改请求…</p>}
      {view?.actions
        .filter((a) => a.state === "blocked")
        .map((a) => (
          <p key={a.id}>{explain(new Error(a.notice ?? ""))}</p>
        ))}
      {view?.summary.taskStatus === "active" &&
        view.actions
          .filter(
            (a) =>
              ["reject", "retry"].includes(a.kind) &&
              (a.state === "blocked" ||
                !!entries.find(
                  (e) =>
                    e.requestId === a.requestId &&
                    ["failed", "cancelled", "blocked"].includes(e.status)
                ))
          )
          .slice(0, 1)
          .map((a) => (
            <Button
              key={a.id}
              variant="outline"
              disabled={
                working ||
                saving ||
                entries.some(
                  (e) =>
                    e.status === "outcome_unknown" ||
                    [
                      "queued",
                      "starting",
                      "running",
                      "next_round",
                      "saved",
                      "submitting",
                      "waiting_node"
                    ].includes(e.status)
                )
              }
              onClick={() =>
                void runAction(`retry:${a.id}`, (operationId) =>
                  api.retryRevision({ conversationId, taskRef, actionId: a.id, operationId })
                )
              }
            >
              继续修改
            </Button>
          ))}
      {head?.status === "completed" && (
        <p>
          此任务已确认完成。
          <Button variant="outline" onClick={onNew}>
            交办新任务
          </Button>
        </p>
      )}
      {before && (
        <Button variant="ghost" disabled={working} onClick={() => void more()}>
          更多成果版本
        </Button>
      )}
    </section>
  )
}
