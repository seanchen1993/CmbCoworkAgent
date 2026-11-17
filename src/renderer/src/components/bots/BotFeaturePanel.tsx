import { useBotRefresh } from "./use-bot-refresh"
import { useCallback, useEffect, useRef, useState } from "react"
import "./bot-features.css"
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react"
import { useAppStore } from "@/lib/store"
import { botErrorMessage } from "@/lib/bot-error-message"
import type { BotClient } from "../../../../shared/bots/contracts"
import type {
  BotFeatureDetail,
  BotFeatureFollow,
  BotFeatureClient,
  BotFeatureTask
} from "../../../../shared/bots/feature"
import { featureTaskLabels } from "../../../../shared/bots/feature"
import { MANAGED_RUN_STATUS_LABELS } from "../../../../shared/harness-board-types"

const phaseLabel = {
  idle: "已空闲",
  running: "正在执行",
  question: "等待回答",
  approval: "待桌面审批",
  decision: "待阶段确认",
  interrupted: "已中断",
  failed: "执行失败",
  unavailable: "不可用",
  unknown: "状态暂不可用"
}
type Props = { client: BotClient; botId: string; groupId?: string }

export function FollowPicker({
  api,
  botId,
  groupId,
  followed,
  done
}: {
  api: BotFeatureClient
  botId: string
  groupId?: string
  followed?: readonly BotFeatureFollow[]
  done: () => void
}) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>()
  const [features, setFeatures] = useState<{ slug: string; title: string; linked?: boolean }[]>()
  const [project, setProject] = useState(""),
    [slug, setSlug] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false)
  const linkedSlugs = new Set([
    ...(followed?.filter((f) => f.projectId === project).map((f) => f.slug) ?? []),
    ...(features?.filter((f) => f.linked).map((f) => f.slug) ?? [])
  ])
  const canFollow = Boolean(
    (api.page || followed) && features?.some((f) => f.slug === slug) && !linkedSlugs.has(slug)
  )
  useEffect(() => {
    let current = true
    api
      .projects(botId, groupId)
      .then((x) => {
        if (current) setProjects(x)
      })
      .catch((e) => {
        if (current) setError(botErrorMessage(e))
      })
    return () => {
      current = false
    }
  }, [api, botId, groupId])
  useEffect(() => {
    let current = true
    setFeatures(undefined)
    setSlug("")
    if (project)
      api
        .catalog(botId, project, groupId)
        .then((x) => {
          if (current) setFeatures(x)
        })
        .catch((e) => {
          if (current) setError(botErrorMessage(e))
        })
    return () => {
      current = false
    }
  }, [api, botId, groupId, project])
  return (
    <form
      className="bot-feature-form"
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy || !canFollow) return
        setBusy(true)
        setError("")
        try {
          await api.follow(botId, project, slug, groupId)
          done()
        } catch (e) {
          setError(botErrorMessage(e))
          setBusy(false)
        }
      }}
    >
      <select
        aria-label="选择项目"
        value={project}
        onChange={(e) => {
          setProject(e.target.value)
          setError("")
        }}
      >
        <option value="">
          {!projects ? "正在读取项目…" : projects.length ? "选择项目" : "没有可跟进的项目"}
        </option>
        {projects?.map((p) => (
          <option value={p.id} key={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {project && (
        <select
          aria-label="选择 Feature"
          value={linkedSlugs.has(slug) ? "" : slug}
          onChange={(e) => setSlug(e.target.value)}
        >
          <option value="">
            {!features ? "正在读取…" : features.length ? "选择 Feature" : "没有可跟进的 Feature"}
          </option>
          {features?.map((f) => (
            <option key={f.slug} value={f.slug} disabled={linkedSlugs.has(f.slug)}>
              {f.title}
              {linkedSlugs.has(f.slug) ? " · 已关联" : ""}
            </option>
          ))}
        </select>
      )}
      {groupId && canFollow && <p>关联后，本群可查看并继续此 Feature 的普通项目会话。</p>}
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="button" onClick={done}>
          取消
        </button>
        <button type="submit" disabled={!canFollow || busy}>
          跟进
        </button>
      </div>
    </form>
  )
}
function openProject(feature: BotFeatureFollow, threadId?: string) {
  useAppStore.getState().setShowHarnessBoardView(true)
  useAppStore.setState({
    botFeatureDestination: { projectId: feature.projectId, slug: feature.slug, threadId }
  })
}
export function FeatureRow({
  feature,
  api,
  botId,
  groupId,
  disabled,
  revision,
  refresh
}: {
  feature: BotFeatureTask
  api: BotFeatureClient
  botId: string
  groupId?: string
  disabled?: boolean
  revision: number
  refresh(): void
}) {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState<BotFeatureDetail>(),
    [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const detailRead = useBotRefresh(
    JSON.stringify([botId, groupId, feature.id, open]),
    () => (open ? api.detail(botId, feature.id, groupId) : Promise.resolve(undefined)),
    (value) => {
      if (value) {
        setDetail(value)
        setError("")
      }
    },
    (cause) => setError(botErrorMessage(cause))
  )
  useEffect(() => {
    setDetail(undefined)
  }, [botId, groupId, feature.id])
  useEffect(() => {
    if (open) void detailRead.refresh()
  }, [open, revision, api, botId, groupId, feature.id, detailRead.refresh])
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void detailRead.refresh()
    }, 5000)
    return () => clearInterval(timer)
  }, [open, detailRead.refresh])
  const current = open && detail ? detail : feature
  return (
    <div className="bot-feature-row">
      <button
        type="button"
        className="bot-work-row bot-feature-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>{feature.title}</span>
        <small>
          <span data-attention={Boolean(current.attentionThreadId)}>
            {featureTaskLabels[current.phase]}
          </span>
          {" · Feature · "}
          {feature.projectName}
        </small>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="bot-feature-expanded">
          {detail?.run && (
            <p>
              {MANAGED_RUN_STATUS_LABELS[detail.run.status]}
              {detail.run.nodeId && ` · ${detail.run.nodeId}`}
            </p>
          )}
          {detail?.run?.waitingForDecision && <p>等待项目决策 · {detail.run.waitingForDecision}</p>}
          {detail?.sessions.map((s) => (
            <button
              key={s.threadId}
              disabled={s.phase === "unavailable"}
              className="bot-feature-session"
              onClick={() => openProject(feature, s.threadId)}
            >
              <span>{s.title}</span>
              <small>{s.activity ?? phaseLabel[s.phase]}</small>
            </button>
          ))}
          <div className="bot-feature-links">
            <button onClick={() => openProject(feature)}>
              打开 Feature <ArrowUpRight size={13} />
            </button>
            {!disabled && (
              <button
                disabled={
                  busy ||
                  ["managed", "running", "approval", "decision", "question", "unknown"].includes(
                    current.phase
                  )
                }
                onClick={async () => {
                  setBusy(true)
                  setError("")
                  try {
                    await api.lifecycle(
                      botId,
                      feature.id,
                      current.state === "completed" ? "reopen" : "complete",
                      current.version,
                      groupId
                    )
                    refresh()
                  } catch (e) {
                    setError(botErrorMessage(e))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {current.state === "completed" ? "继续处理" : "完成任务"}
              </button>
            )}
          </div>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
export function useBotFeatureTasks({
  client,
  botId,
  groupId,
  query = ""
}: Props & { query?: string }) {
  const [items, setItems] = useState<BotFeatureTask[]>([]),
    [priority, setPriority] = useState<BotFeatureTask[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0)
  const api = client.features
  const key = JSON.stringify([client.hostId, botId, groupId, query])
  const [loadedKey, setLoadedKey] = useState("")
  const displayed = useRef(items),
    expanded = useRef(false),
    nextPage = useRef<string | undefined>(undefined)
  const changedIds = useRef(new Set<string>()),
    restart = useRef(true)
  displayed.current = items
  const reader = useBotRefresh(
    key,
    async () => {
      const after = nextPage.current
      nextPage.current = undefined
      const reset = restart.current
      restart.current = false
      const ids = [...changedIds.current]
      changedIds.current.clear()
      if (!api)
        return {
          page: { items: [], priority: [], refreshed: [], nextCursor: null },
          after,
          reset,
          ids
        }
      if (!api.page)
        return {
          page: {
            items: await api.list(botId, groupId),
            priority: [],
            refreshed: [],
            nextCursor: null
          },
          after,
          reset: true,
          ids
        }
      // A single target change normally refreshes at most one older row. Larger scoped
      // invalidations restart paging instead of fetching an unbounded loaded directory.
      const page = await api.page(botId, groupId, {
        cursor: after,
        query,
        refreshIds: ids.slice(0, 40)
      })
      return { page, after, reset: reset || ids.length > 40, ids }
    },
    ({ page, after, reset, ids }) => {
      if (reset) expanded.current = false
      if (after) expanded.current = true
      const head = new Set(page.items.map((item) => item.id))
      const updates = new Map(page.refreshed.map((item) => [item.id, item]))
      const requested = new Set(ids)
      const matches = (item: BotFeatureTask) =>
        (item.title + " " + item.projectName + " " + item.slug)
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      setItems((old) => {
        const remaining = reset
          ? []
          : old
              .filter((item) => !requested.has(item.id) || updates.has(item.id))
              .map((item) => updates.get(item.id) ?? item)
              .filter(matches)
        if (after) {
          const known = new Set(remaining.map((item) => item.id))
          return [...remaining, ...page.items.filter((item) => !known.has(item.id))]
        }
        const merged = new Map(page.items.map((item) => [item.id, item]))
        if (expanded.current)
          for (const item of remaining) if (!head.has(item.id)) merged.set(item.id, item)
        for (const item of page.refreshed) if (matches(item)) merged.set(item.id, item)
        return [...merged.values()]
      })
      setPriority(page.priority)
      if (after || !expanded.current) setCursor(page.nextCursor)
      setLoadedKey(key)
      setError("")
    },
    (cause) => {
      restart.current = true
      setLoadedKey(key)
      setError(botErrorMessage(cause))
    }
  )
  const refresh = useCallback(() => {
    restart.current = true
    nextPage.current = undefined
    setRevision((value) => value + 1)
    void reader.refresh()
  }, [reader.refresh])
  useEffect(() => {
    setItems([])
    setPriority([])
    setCursor(null)
    setError("")
    changedIds.current.clear()
    expanded.current = false
    refresh()
  }, [api, key, refresh])
  useEffect(() => {
    if (!api) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const audience = groupId ? `im:${groupId}` : "desktop"
    const stop = client.subscribe((event) => {
      const target = event.featureScope
      if (target?.botId !== botId || target.audience !== audience) return
      if (target.followId) changedIds.current.add(target.followId)
      else if (!target.projectId || !target.slug) restart.current = true
      else
        for (const item of displayed.current)
          if (item.projectId === target.projectId && item.slug === target.slug)
            changedIds.current.add(item.id)
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          nextPage.current = undefined
          setRevision((value) => value + 1)
          void reader.refresh()
        }, 150)
    })
    return () => {
      stop()
      clearTimeout(timer)
    }
  }, [api, client, reader.refresh, botId, groupId])
  const more = () => {
    if (!cursor || reader.loading) return
    nextPage.current = cursor
    void reader.refresh()
  }
  return {
    items: loadedKey === key ? items : [],
    priority: loadedKey === key ? priority : [],
    cursor: loadedKey === key ? cursor : null,
    revision,
    refresh,
    more,
    error,
    loading: reader.loading || (Boolean(api) && loadedKey !== key)
  }
}
