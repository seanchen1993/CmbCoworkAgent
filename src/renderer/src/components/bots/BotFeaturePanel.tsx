import { useCallback, useEffect, useState } from "react"
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
  approval: "等待审批",
  interrupted: "已中断",
  failed: "执行失败",
  unavailable: "不可用"
}
type Props = { client: BotClient; botId: string; groupId?: string }

export function FollowPicker({
  api,
  botId,
  groupId,
  done
}: {
  api: BotFeatureClient
  botId: string
  groupId?: string
  done: () => void
}) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>()
  const [features, setFeatures] = useState<{ slug: string; title: string }[]>()
  const [project, setProject] = useState(""),
    [slug, setSlug] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false)
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
        if (busy || !slug) return
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
        <select aria-label="选择 Feature" value={slug} onChange={(e) => setSlug(e.target.value)}>
          <option value="">
            {!features ? "正在读取…" : features.length ? "选择 Feature" : "没有可跟进的 Feature"}
          </option>
          {features?.map((f) => (
            <option key={f.slug} value={f.slug}>
              {f.title}
            </option>
          ))}
        </select>
      )}
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="button" onClick={done}>
          取消
        </button>
        <button type="submit" disabled={!slug || busy}>
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
  const [choices, setChoices] = useState<{ id: string; title: string }[] | null>(null),
    [choice, setChoice] = useState(""),
    [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!open) return
    let current = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const value = await api.detail(botId, feature.id, groupId)
        if (current) {
          setDetail(value)
          setError("")
        }
      } catch (e) {
        if (current) setError(botErrorMessage(e))
      } finally {
        pending = false
      }
    }
    void refresh()
    // Wait registries can change independently of a Bot turn, e.g. an approval from the desktop.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, 5000)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [api, feature.id, botId, groupId, open, revision, reload])
  async function choose() {
    if (choices) {
      setChoices(null)
      return
    }
    setBusy(true)
    setError("")
    try {
      const native = await window.api.harnessBoard.getRunDetail(feature.projectId, feature.slug)
      const threads = useAppStore.getState().threads
      const titles = new Map(threads.map((t) => [t.thread_id, t.title]))
      setChoices(
        native.sessions
          .filter((s) => !detail?.sessions.some((existing) => existing.threadId === s.threadId))
          .map((s) => ({
            id: s.threadId,
            title: titles.get(s.threadId) || `项目会话 · ${new Date(s.createdAt).toLocaleString()}`
          }))
      )
      setChoice("")
    } catch (e) {
      setError(botErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="bot-feature-row">
      <div className="bot-feature-summary">
        <button
          className="bot-work-row"
          aria-expanded={feature.attentionThreadId ? undefined : open}
          onClick={() =>
            feature.attentionThreadId
              ? openProject(feature, feature.attentionThreadId)
              : setOpen(!open)
          }
        >
          <span>{feature.title}</span>
          <small>
            <span data-attention={Boolean(feature.attentionThreadId)}>
              {featureTaskLabels[feature.phase]}
            </span>{" "}
            · Feature · {feature.projectName}
          </small>
        </button>
        <button
          className="bot-feature-disclose"
          aria-label={open ? "收起项目任务详情" : "展开项目任务详情"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>
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
              <small>{phaseLabel[s.phase]}</small>
            </button>
          ))}
          <div className="bot-feature-links">
            <button onClick={() => openProject(feature)}>
              打开 Feature <ArrowUpRight size={13} />
            </button>
            {!disabled && feature.state !== "completed" && (
              <button disabled={busy || !detail} onClick={() => void choose()}>
                关联已有会话
              </button>
            )}
            {!disabled && (
              <button
                disabled={
                  busy ||
                  ["managed", "running", "approval", "decision", "question"].includes(feature.phase)
                }
                onClick={async () => {
                  setBusy(true)
                  setError("")
                  try {
                    await api.lifecycle(
                      botId,
                      feature.id,
                      feature.state === "completed" ? "reopen" : "complete",
                      feature.version,
                      groupId
                    )
                    setChoices(null)
                    refresh()
                  } catch (e) {
                    setError(botErrorMessage(e))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {feature.state === "completed" ? "继续处理" : "完成任务"}
              </button>
            )}
          </div>
          {choices && feature.state !== "completed" && (
            <form
              className="bot-feature-form"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!choice || busy) return
                setBusy(true)
                try {
                  await api.link(botId, feature.id, choice, groupId)
                  setChoices(null)
                  setReload((x) => x + 1)
                } catch (e) {
                  setError(botErrorMessage(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              <select
                aria-label="选择要关联的项目会话"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">{choices.length ? "选择已有会话" : "暂无其他项目会话"}</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
              {choice && (
                <p>
                  {groupId
                    ? "关联后，本群可通过 Bot 查询这段会话历史并继续交办。"
                    : "关联后，此 Bot 可查询这段会话历史并继续交办。"}
                </p>
              )}
              <div>
                <button type="button" onClick={() => setChoices(null)}>
                  取消
                </button>
                <button type="submit" disabled={!choice || busy}>
                  确认关联
                </button>
              </div>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
export function useBotFeatureTasks({ client, botId, groupId }: Props) {
  const [items, setItems] = useState<BotFeatureTask[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(Boolean(client.features)),
    [revision, setRevision] = useState(0)
  const api = client.features
  const refresh = useCallback(() => setRevision((x) => x + 1), [])
  useEffect(() => {
    if (!api) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const audience = groupId ? `im:${groupId}` : "desktop"
    const stop = client.subscribe((event) => {
      if (event.featureScope?.botId !== botId || event.featureScope.audience !== audience) return
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined
          refresh()
        }, 150)
    })
    return () => {
      stop()
      clearTimeout(timer)
    }
  }, [api, client, refresh, botId, groupId])
  useEffect(() => {
    if (!api) return
    let current = true
    api
      .list(botId, groupId)
      .then((rows) => {
        if (current) {
          setItems(rows)
          setError("")
        }
      })
      .catch((e) => {
        if (current) setError(botErrorMessage(e))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [api, botId, groupId, revision])
  return { items, revision, refresh, error, loading }
}
