import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ProjectFunctionConsent } from "../harness-board/ProjectFunctionConsent"
import type {
  DevelopmentBusinessStatus,
  DevelopmentBusinessTrialApi,
  DevelopmentBusinessTrialScope,
  DevelopmentBusinessTrialSession,
  DevelopmentBusinessTrialStatus,
  DevelopmentStatus
} from "../../../../shared/mods/development"
import type { ThreadMessagesPage, ThreadMessagesPageOptions } from "../../../../main/types"
import type { CompositionUnitContextOptions } from "../../../../shared/project-runtime/composition-api"
import { compositionProblem } from "@/lib/project-composition-ui"
import { CreatorTrialJourneyCard } from "./CreatorTrialJourneyCard"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import { PluginStageRecoveryCard } from "./PluginStageRecoveryCard"
import {
  businessCreatorTrialScope,
  businessCreatorTrialView,
  businessCreatorTrialSessionView,
  readBusinessCreatorTrialHistory
} from "@/lib/business-creator-trial-view"

const TrialConversation = lazy(() =>
  import("../tabs/TabbedPanel").then((module) => ({
    default: module.TabbedPanel
  }))
)
const button = "rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
const phases: Record<DevelopmentBusinessTrialStatus["phase"], string> = {
  "needs-confirmation": "等待确认创建隔离试用",
  preparing: "正在准备独立试用目录",
  "needs-configuration": "请配置参数、授权源码并选择业务上下文",
  ready: "已准备，请确认后启动",
  starting: "正在启动原业务流程",
  running: "原业务流程正在执行",
  completed: "本次运行已结束，请核对原检查与产物",
  failed: "本次试用未完成",
  unknown: "运行结果尚未确认",
  cancelled: "本次试用已停止"
}

type Review = NonNullable<DevelopmentBusinessStatus["review"]>
type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  threadId: string
  workspace: string
  review: Review
  trial?: DevelopmentBusinessTrialStatus
  api: DevelopmentBusinessTrialApi
  onStatus(status: DevelopmentStatus): void
  onRequestRepair?: (message: string) => void | Promise<void>
  onReturnToCreator?: () => void
  onOpenDelivery?: () => void
}

/** Only host-returned trial identities can reach the native editor or original runner. */
export function BusinessCreatorTrialDialog(props: Props) {
  const [goalDraft, setGoalDraft] = useState({ key: "", message: "" })
  const [feedbackDraft, setFeedbackDraft] = useState({ key: "", message: "" })
  const preserveDestinationFocus = useRef(false)
  const goalKey = JSON.stringify([props.review.planId, props.review.digest])
  const feedbackKey = props.trial?.id ?? ""
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="max-h-[90vh] w-[calc(100vw-1rem)] max-w-5xl overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (preserveDestinationFocus.current) {
            preserveDestinationFocus.current = false
            event.preventDefault()
          }
        }}
      >
        <DialogTitle>插件试用与整轮验收</DialogTitle>
        {props.open && (
          <TrialContents
            key={JSON.stringify([
              props.threadId,
              props.workspace,
              props.review.planId,
              props.review.digest
            ])}
            {...props}
            onReturnToCreator={
              props.onReturnToCreator
                ? () => {
                    preserveDestinationFocus.current = true
                    props.onReturnToCreator?.()
                  }
                : undefined
            }
            onOpenDelivery={
              props.onOpenDelivery
                ? () => {
                    preserveDestinationFocus.current = true
                    props.onOpenDelivery?.()
                  }
                : undefined
            }
            goal={goalDraft.key === goalKey ? goalDraft.message : ""}
            onGoalChange={(message) => setGoalDraft({ key: goalKey, message })}
            feedback={feedbackDraft.key === feedbackKey ? feedbackDraft.message : ""}
            onFeedbackChange={(message) => setFeedbackDraft({ key: feedbackKey, message })}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function TrialContents(
  props: Props & {
    goal: string
    onGoalChange(message: string): void
    feedback: string
    onFeedbackChange(message: string): void
  }
) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const live = useRef(true)
  const lock = useRef(false)
  const generation = useRef(0)
  const latest = useRef(props)
  latest.current = props
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      generation.current++
    }
  }, [])
  const act = useCallback(
    async (work: (assertCurrent: () => void) => Promise<DevelopmentStatus>) => {
      if (lock.current || !live.current) return
      lock.current = true
      const ticket = ++generation.current
      setBusy(true)
      setError("")
      try {
        const assertCurrent = () => {
          if (!live.current || ticket !== generation.current)
            throw Error("DEVELOPMENT_SCOPE_CHANGED")
        }
        const next = await work(assertCurrent)
        if (live.current && ticket === generation.current) latest.current.onStatus(next)
      } catch (cause) {
        if (live.current && ticket === generation.current) {
          const problem = compositionProblem(cause)
          setError([problem.message, problem.nextStep].filter(Boolean).join(" "))
          try {
            const current = latest.current
            const next = await window.api.mods.development.status({ threadId: current.threadId })
            if (
              live.current &&
              ticket === generation.current &&
              next.threadId === current.threadId &&
              isSameWorkspacePath(next.workspace, current.workspace)
            )
              current.onStatus(next)
          } catch {
            /* Expose the error; never repeat a possibly completed preparation. */
          }
        }
      } finally {
        if (live.current && ticket === generation.current) {
          lock.current = false
          setBusy(false)
        }
      }
    },
    []
  )
  const { trial, review, api, threadId, workspace, goal } = props
  const trialId = trial?.id,
    trialDigest = trial?.digest,
    trialVersion = trial?.version
  const scope = useMemo(
    () =>
      trialId && trialDigest && trialVersion !== undefined
        ? businessCreatorTrialScope(threadId, workspace, {
            id: trialId,
            digest: trialDigest,
            version: trialVersion
          })
        : undefined,
    [threadId, workspace, trialId, trialDigest, trialVersion]
  )
  const view = businessCreatorTrialView(review, trial)
  const current = view.current
  useEffect(() => {
    if (!scope || !trial?.canRefresh || !["preparing", "starting", "running"].includes(trial.phase))
      return
    const timer = setInterval(() => {
      if (!lock.current) void act(() => api.refresh(scope))
    }, 2000)
    return () => clearInterval(timer)
  }, [act, api, scope, trial?.canRefresh, trial?.phase])
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm">
        {review.name} · v{review.version}
      </p>
      <div className="flex flex-wrap gap-2 rounded-lg border bg-muted/30 p-3">
        {props.onReturnToCreator && (
          <button type="button" className={button} onClick={props.onReturnToCreator}>
            返回原创造者聊天
          </button>
        )}
        {props.onOpenDelivery && (
          <button type="button" className={button} onClick={props.onOpenDelivery}>
            去保存插件
          </button>
        )}
      </div>
      {(!current || view.canRequest) && (
        <section aria-label="请求当前候选试用" className="space-y-3 rounded border p-3">
          {trial && !current && (
            <p className="text-sm">下方保留的是另一候选的试用，请先核对并结束尚未确认的运行。</p>
          )}
          {trial && current && (
            <p className="text-sm">
              下方保留本候选的上一轮记录。新一轮试用使用新的独立目录，需要重新配置和确认，不会恢复或重放旧任务。
            </p>
          )}
          <label className="grid gap-1 text-sm">
            本次试用目标
            <textarea
              aria-label="本次试用目标"
              className="min-h-20 rounded border bg-background p-2"
              maxLength={8000}
              value={goal}
              disabled={busy || !view.canRequest}
              onChange={(event) => props.onGoalChange(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={busy || !view.canRequest || !goal.trim()}
            onClick={() =>
              void act(async (assertCurrent) => {
                const next = await api.request({
                  threadId,
                  expectedWorkspace: workspace,
                  planId: review.planId,
                  digest: review.digest,
                  goal: goal.trim()
                })
                assertCurrent()
                if (next.threadId !== threadId || !isSameWorkspacePath(next.workspace, workspace))
                  throw Error("DEVELOPMENT_SCOPE_CHANGED")
                const prepared = next.business?.trial
                // Host candidates use their own trial entry. A business candidate can prepare
                // its isolated directory as part of this same user action; it cannot start.
                if (!prepared || !businessCreatorTrialView(review, prepared).canPrepare) return next
                return api.prepare(businessCreatorTrialScope(threadId, workspace, prepared))
              })
            }
          >
            {trial && current ? "重新试用" : "开始试用"}
          </button>
        </section>
      )}
      {trial && scope && (
        <>
          <section aria-label="当前业务试用" className="space-y-3 rounded border p-3">
            <h3 className="font-medium">本轮试用 · {trial.name}</h3>
            <p className="whitespace-pre-wrap break-words text-sm">试用目标：{trial.goal}</p>
            <p role="status" className="text-sm">
              {phases[trial.phase]}
            </p>
            {trial.phase === "needs-confirmation" && (
              <>
                <button
                  type="button"
                  className={button}
                  disabled={busy || !view.canPrepare}
                  onClick={() => void act(() => api.prepare(scope))}
                >
                  继续准备试用
                </button>
              </>
            )}
            {!!trial.diagnostics.length && (
              <ul className="list-inside list-disc space-y-1 text-xs">
                {trial.diagnostics.map((diagnostic, index) => (
                  <li key={index} className="break-words">
                    {diagnostic}
                  </li>
                ))}
              </ul>
            )}
            {trial.error && (
              <p role="alert" className="break-words text-sm">
                {compositionProblem(trial.error).message}
              </p>
            )}
            {trial.phase === "unknown" && (
              <p className="text-sm">
                请先核对原运行记录、会话和产物。这里不会自动重启任务；确认未执行前不要重新提交相同操作。
              </p>
            )}
            {view.showConfiguration && (
              <TrialConfiguration
                key={JSON.stringify([trial.id, trial.version])}
                api={api}
                scope={scope}
                trial={trial}
                busy={busy}
                act={act}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                disabled={busy || !trial.canRefresh}
                onClick={() => void act(() => api.refresh(scope))}
              >
                核对试用状态
              </button>
              {trial.canStop && (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => void act(() => api.stop(scope))}
                >
                  停止本次试用
                </button>
              )}
            </div>
            <details className="text-xs text-muted-foreground">
              <summary>试用版本与来源</summary>
              <p className="mt-2 break-all">试用标识：{trial.id}</p>
              <p className="mt-2 break-all">内容摘要：{trial.digest}</p>
            </details>
          </section>
          {trial.observation && (
            <TrialHumanGates
              key={JSON.stringify([scope.trialId, scope.expectedVersion])}
              scope={scope}
              api={api}
              act={act}
              busy={busy}
            />
          )}
          {trial.observation && (
            <TrialObservation key={trial.id} trial={trial} creatorThreadId={threadId} />
          )}
          {api.recovery &&
            (trial.stageRecovery ||
              ["completed", "failed", "cancelled", "unknown"].includes(trial.phase)) && (
              <PluginStageRecoveryCard
                key={`recovery:${trial.id}`}
                threadId={threadId}
                workspace={workspace}
                trial={trial}
                api={api.recovery}
                disabled={busy || !current}
                onChanged={() => act(() => window.api.mods.development.status({ threadId }))}
              />
            )}
          <TrialFeedback
            key={trial.id}
            trial={trial}
            busy={busy}
            scope={scope}
            api={api}
            act={act}
            message={props.feedback}
            onMessageChange={props.onFeedbackChange}
            onRequestRepair={props.onRequestRepair}
          />
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm">
          正在核对操作结果…
        </p>
      )}
    </div>
  )
}

type Act = (work: (assertCurrent: () => void) => Promise<DevelopmentStatus>) => Promise<void>
function TrialConfiguration({
  api,
  scope,
  trial,
  busy,
  act
}: {
  api: DevelopmentBusinessTrialApi
  scope: DevelopmentBusinessTrialScope
  trial: DevelopmentBusinessTrialStatus
  busy: boolean
  act: Act
}) {
  const [version, setVersion] = useState<number>()
  const [sourceReady, setSourceReady] = useState(false)
  const [contextReady, setContextReady] = useState(false)
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let disposed = false
    void api.source
      .read(scope.trialId)
      .then((review) => {
        if (disposed) return
        if (review.projectId !== scope.trialId) throw Error("PROJECT_SCOPE_CHANGED")
        if (trial.packageDigest && review.packageDigest !== trial.packageDigest)
          throw Error("PROJECT_INPUT_CHANGED")
        setVersion(review.projectVersion)
      })
      .catch(() => {
        if (!disposed) setError("无法核对试用参数和源码权限，请重新读取。不会跳过检查启动。")
      })
    return () => {
      disposed = true
    }
  }, [api, scope.trialId, scope.digest, scope.expectedVersion, trial.packageDigest, refresh])
  useEffect(() => {
    if (sourceReady) void act(() => api.refresh(scope))
  }, [act, api, sourceReady, scope])
  return (
    <section aria-label="业务试用参数与权限" className="space-y-3">
      <h4 className="text-sm font-medium">项目设置</h4>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {version !== undefined && (
        <ProjectFunctionConsent
          key={JSON.stringify([scope.trialId, version, refresh])}
          projectId={scope.trialId}
          version={version}
          api={api.source}
          onReady={(ready) => {
            setSourceReady(ready)
            if (!ready) setContextReady(false)
          }}
          approvalLabel="授权此试用版本"
        />
      )}
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() => {
          setVersion(undefined)
          setSourceReady(false)
          setContextReady(false)
          setError("")
          setRefresh((value) => value + 1)
        }}
      >
        重新核对参数与权限
      </button>
      <TrialContext
        key={JSON.stringify([scope.trialId, scope.expectedVersion, refresh, sourceReady])}
        api={api}
        scope={scope}
        sourceReady={sourceReady}
        busy={busy}
        act={act}
        onReady={setContextReady}
      />
      <button
        type="button"
        className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
        disabled={busy || !sourceReady || !contextReady || !trial.canStart}
        onClick={() => void act(() => api.start(scope))}
      >
        开始执行
      </button>
      <p className="text-xs text-muted-foreground">
        只有当前参数、源码授权和业务上下文均由宿主确认后才能启动。工具操作与人工阶段仍按原流程确认。
      </p>
    </section>
  )
}

function TrialContext({
  api,
  scope,
  sourceReady,
  busy,
  act,
  onReady
}: {
  api: DevelopmentBusinessTrialApi
  scope: DevelopmentBusinessTrialScope
  sourceReady: boolean
  busy: boolean
  act: Act
  onReady(ready: boolean): void
}) {
  const [options, setOptions] = useState<CompositionUnitContextOptions>()
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(sourceReady)
  useEffect(() => {
    let disposed = false
    if (!sourceReady) return
    void api
      .context(scope)
      .then((next) => {
        if (!disposed) {
          setOptions(next)
          setSelected(next.selected)
          onReady(!next.supported ? !next.required : !next.required || next.selected.length > 0)
        }
      })
      .catch((cause) => {
        if (!disposed) setError(compositionProblem(cause).message)
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [api, scope, sourceReady, refresh, onReady])
  if (!sourceReady || (options?.supported === false && !options.required)) return null
  if (options?.supported === false)
    return (
      <p role="alert" className="text-sm">
        此候选需要业务上下文，但尚未提供可用的选择入口。请调整候选后重新试用，不能跳过必需上下文启动。
      </p>
    )
  const candidates = [...new Set([...(options?.candidates ?? []), ...selected])]
  const visible = candidates.filter((id) =>
    id.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  return (
    <section aria-label="试用业务上下文" className="space-y-2 rounded border p-3 text-sm">
      <h5 className="font-medium">选择本次试用的业务上下文</h5>
      <button
        type="button"
        className={button}
        disabled={busy || loading}
        onClick={() => {
          setOptions(undefined)
          setError("")
          setLoading(true)
          onReady(false)
          setRefresh((value) => value + 1)
        }}
      >
        重新读取知识来源
      </button>
      {loading && <p role="status">正在从实际知识来源读取候选…</p>}
      {error && <p role="alert">{error}</p>}
      {options && (
        <>
          <input
            aria-label="查找试用业务上下文"
            className="w-full rounded border bg-background p-2"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入名称查找"
          />
          <p className="text-xs text-muted-foreground">
            共 {options.candidates.length} 项，已选 {selected.length} 项。
            {visible.length > 100
              ? "当前只显示前 100 项，请输入名称查找；未显示的已选项仍保留。"
              : ""}
          </p>
          {!options.candidates.length && (
            <p>当前知识来源未返回可用业务上下文，请检查目录、参数及知识内容。</p>
          )}
          <div className="max-h-56 space-y-1 overflow-auto">
            {visible.slice(0, 100).map((id) => (
              <label key={id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  disabled={busy || loading}
                  checked={selected.includes(id)}
                  onChange={(event) => {
                    onReady(false)
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, id]
                        : previous.filter((value) => value !== id)
                    )
                  }}
                />
                <span>
                  {id}
                  {!options.candidates.includes(id) ? "（已不可用，请取消选择）" : ""}
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className={button}
            disabled={
              busy ||
              loading ||
              !options.contextFingerprint ||
              (options.required && !selected.length) ||
              selected.some((id) => !options.candidates.includes(id))
            }
            onClick={() =>
              void act(() =>
                api.selectContext({
                  ...scope,
                  selection: {
                    deployUnitIds: selected,
                    contextFingerprint: options.contextFingerprint!
                  }
                })
              )
            }
          >
            确认试用业务上下文
          </button>
        </>
      )}
    </section>
  )
}

function TrialObservation({
  trial,
  creatorThreadId
}: {
  trial: DevelopmentBusinessTrialStatus
  creatorThreadId: string
}) {
  const observation = trial.observation!
  const [sessionOpen, setSessionOpen] = useState(false)
  const [selectedThread, setSelectedThread] = useState<string | null>(
    () => observation.sessions?.[0]?.threadId ?? null
  )
  const firstThread = observation.sessions?.[0]?.threadId
  // The first native session may arrive after mounting. Seed once, never follow later sessions.
  if (selectedThread === null && firstThread) setSelectedThread(firstThread)
  const { selected, mode } = businessCreatorTrialSessionView(trial, selectedThread)
  return (
    <section aria-label="原流程运行记录" className="min-w-0 space-y-3 rounded border p-3">
      <h3 className="font-medium">试用结果与运行记录</h3>
      {trial.journey ? (
        <CreatorTrialJourneyCard
          threadId={creatorThreadId}
          digest={trial.digest}
          journey={trial.journey}
        />
      ) : (
        <p className="rounded-lg bg-muted/40 p-3 text-sm" role="status">
          {trial.phase === "completed"
            ? "运行已结束，验收记录尚不完整。请核对下方检查点和产物。"
            : "请查看原流程检查结果。"}
        </p>
      )}
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">原生检查点与流程决策记录</summary>
        <dl className="grid gap-2 text-sm">
          <div>
            <dt>原运行状态</dt>
            <dd className="break-words">{observation.status}</dd>
          </div>
          <div>
            <dt>最近决策来源节点</dt>
            <dd>{observation.stageId ?? "尚无阶段记录"}</dd>
          </div>
          <div>
            <dt>来源节点状态</dt>
            <dd className="break-words">{observation.sourceNodeStatus ?? "尚无节点状态记录"}</dd>
          </div>
          <div>
            <dt>原决策技能</dt>
            <dd className="break-words">{observation.slashSkill ?? "尚无技能记录"}</dd>
          </div>
          <div>
            <dt>原检查点</dt>
            <dd className="break-words">
              {observation.checkpoint ?? "原记录未提供检查点标识，请结合原检查和产物核对。"}
            </dd>
          </div>
        </dl>
        {observation.reason && (
          <p role="status" className="whitespace-pre-wrap break-words text-sm">
            {observation.reason}
          </p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          节点信息来自最近一次原流程决策，不代表下一步正在执行的位置，也不能代替检查点凭据。
          会话结束不等于业务阶段通过，请核对原产物和检查结果。
        </p>
      </details>
      {!!observation.sessions?.length && (
        <>
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              本轮共 {observation.sessions.length} 个阶段执行会话，展开查看所属关系
            </summary>
            <ol className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="同一轮试用的阶段会话">
              {observation.sessions.map((session, index) => (
                <li key={session.threadId} className="rounded-lg border p-3 text-xs">
                  <p className="font-medium">
                    {index + 1}. {session.nodeId ?? "原流程阶段"}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {session.endedAt ? "执行已结束，业务检查需另行核对" : "尚无结束记录"}
                  </p>
                  <button
                    type="button"
                    className="mt-2 underline"
                    onClick={() => {
                      setSelectedThread(session.threadId)
                      setSessionOpen(true)
                    }}
                  >
                    查看执行明细
                  </button>
                </li>
              ))}
            </ol>
          </details>
          <div className="flex flex-wrap items-center gap-2">
            <label>
              查看本次试用会话
              <select
                aria-label="查看本次试用会话"
                className={button}
                value={selectedThread ?? selected?.threadId ?? ""}
                onChange={(event) => setSelectedThread(event.target.value)}
              >
                {!selected && (
                  <option value={selectedThread ?? ""}>原会话已不在当前记录页中</option>
                )}
                {observation.sessions.map((session) => (
                  <option key={session.threadId} value={session.threadId}>
                    {session.nodeId ?? "原会话"} · {session.outcome ?? "尚无结束记录"} ·{" "}
                    {session.threadId}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={button}
              disabled={
                !observation.sessions.some(
                  (session) => session.threadId === observation.threadId
                ) || selected?.threadId === observation.threadId
              }
              onClick={() => {
                setSelectedThread(observation.threadId!)
                setSessionOpen(true)
              }}
            >
              查看当前运行会话
            </button>
          </div>
        </>
      )}
      {observation.sessionsTruncated && (
        <p role="status">仅显示当前原运行最近的会话记录，较早记录已截断。</p>
      )}
      {observation.sessionsUnavailable && (
        <p role="status">部分原会话已删除或归属已变化，未展示该会话。</p>
      )}
      {selected && (
        <>
          <button
            type="button"
            className={button}
            onClick={() => setSessionOpen((value) => !value)}
          >
            {sessionOpen ? "收起试用会话" : "查看试用会话与原工具确认"}
          </button>
          {sessionOpen && (
            <div className="flex h-[min(65vh,640px)] min-h-80 min-w-0 overflow-hidden rounded border">
              {mode === "history" ? (
                <TrialHistory
                  key={`history:${selected.threadId}:${selected.incarnation.token}`}
                  observation={observation}
                  session={selected}
                />
              ) : (
                <Suspense
                  fallback={
                    <p role="status" className="p-3">
                      正在读取原试用会话…
                    </p>
                  }
                >
                  <TrialConversation
                    key={selected.threadId}
                    threadId={selected.threadId}
                    showTabBar={false}
                    hideWelcomeSkillTabs
                    chatSurface="harness-feature-session"
                    readOnlyReason="此会话由当前隔离试用运行。请在试用入口操作阶段；修改候选请在下方提交反馈。"
                  />
                </Suspense>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** Durable native records only. Historical viewing must never mount a FunctionSite or guest VM. */
function TrialHistory({
  observation,
  session
}: {
  observation: NonNullable<DevelopmentBusinessTrialStatus["observation"]>
  session: DevelopmentBusinessTrialSession
}) {
  const [page, setPage] = useState<ThreadMessagesPage>()
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const request = useRef(0)
  const { projectId, featureId, runId, workspace } = observation
  const {
    threadId,
    startedAt,
    incarnation: { token, legacyCreatedAt }
  } = session
  const load = useCallback(
    async (cursor?: Pick<ThreadMessagesPageOptions, "beforeOrdinal" | "beforeMessageId">) => {
      const revision = ++request.current
      setLoading(true)
      setError("")
      try {
        const target = { threadId, startedAt, incarnation: { token, legacyCreatedAt } }
        const result = await readBusinessCreatorTrialHistory(
          { projectId, featureId, runId, workspace, sessions: [target] },
          target,
          window.api.threads,
          cursor
        )
        if (request.current === revision) setPage(result)
      } catch (reason) {
        if (request.current === revision) {
          setPage(undefined)
          setError(compositionProblem(reason).message)
        }
      } finally {
        if (request.current === revision) setLoading(false)
      }
    },
    [projectId, featureId, runId, workspace, threadId, startedAt, token, legacyCreatedAt]
  )
  useEffect(() => {
    void load()
    return () => {
      request.current++
    }
  }, [load])
  return (
    <section aria-label="原会话历史记录" className="min-w-0 flex-1 space-y-2 overflow-auto p-3">
      <p>只读原消息与终态；不重新运行历史组件或提供工具确认。</p>
      <p>
        原会话：{session.threadId} · {session.outcome ?? "尚无结束记录"}
        {session.endReason ? ` / ${session.endReason}` : ""}
      </p>
      {loading && <p role="status">正在读取原消息…</p>}
      {error && <p role="alert">{error}</p>}
      {page?.messages.map((message) => (
        <article key={message.id} className="rounded border p-2">
          <p className="text-xs text-muted-foreground">
            {message.role}
            {message.name ? ` · ${message.name}` : ""}
          </p>
          <pre className="whitespace-pre-wrap break-words text-sm">
            {typeof message.content === "string"
              ? message.content
              : message.content
                  .map((block) => block.text ?? block.content ?? `[${block.type}]`)
                  .join("\n")}
          </pre>
          {!!message.tool_calls?.length && (
            <pre className="whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(message.tool_calls, null, 2)}
            </pre>
          )}
        </article>
      ))}
      {page && (
        <p className="text-xs">
          本页 {page.messages.length} 条，共 {page.total} 条原消息。
          {!!page.truncatedMessageIds?.length && "部分大消息为原生有界预览。"}
        </p>
      )}
      <button type="button" className={button} disabled={loading} onClick={() => void load()}>
        最新原记录
      </button>
      {page?.hasMore && page.beforeOrdinal !== null && page.beforeMessageId !== null && (
        <button
          type="button"
          className={button}
          disabled={loading}
          onClick={() =>
            void load({
              beforeOrdinal: page.beforeOrdinal!,
              beforeMessageId: page.beforeMessageId!
            })
          }
        >
          更早原记录
        </button>
      )}
    </section>
  )
}

function TrialHumanGates({
  scope,
  api,
  busy,
  act
}: {
  scope: DevelopmentBusinessTrialScope
  api: DevelopmentBusinessTrialApi
  busy: boolean
  act: Act
}) {
  const [gates, setGates] = useState<Awaited<ReturnType<DevelopmentBusinessTrialApi["gates"]>>>([])
  const [error, setError] = useState("")
  const [decision, setDecision] = useState<{ id: string; action: "approve" | "reject" }>()
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await api.gates(scope)
        if (!disposed) {
          setGates(next)
          setError("")
        }
      } catch {
        if (!disposed) setError("暂时无法核对原流程人工确认，请刷新试用状态；不会自动批准。")
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2000)
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [api, scope])
  const pending = gates.filter((gate) => gate.status === "pending")
  if (!pending.length && !error) return null
  return (
    <section aria-label="试用原流程人工确认" className="space-y-3 rounded border p-3">
      <h3 className="font-medium">原流程需要人工确认</h3>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      {pending.map((gate) => (
        <div key={gate.id} className="space-y-2 rounded border p-2 text-sm">
          <h4 className="font-medium">{gate.title}</h4>
          <p className="whitespace-pre-wrap break-words">{gate.message}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => setDecision({ id: gate.id, action: "approve" })}
            >
              批准此阶段
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => setDecision({ id: gate.id, action: "reject" })}
            >
              拒绝此阶段
            </button>
          </div>
          {decision?.id === gate.id && (
            <div role="group" aria-label="确认试用审批决定" className="space-y-2">
              <p>
                确认{decision.action === "approve" ? "批准" : "拒绝"}“{gate.title}
                ”？决定由原流程处理。
              </p>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void act(async (assertCurrent) => {
                    const next = await api.decideGate({
                      ...scope,
                      notificationId: gate.id,
                      action: decision.action
                    })
                    assertCurrent()
                    setDecision(undefined)
                    return next
                  })
                }
              >
                确认{decision.action === "approve" ? "批准" : "拒绝"}
              </button>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => setDecision(undefined)}
              >
                返回核对
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  )
}

function TrialFeedback({
  trial,
  busy,
  scope,
  api,
  act,
  message,
  onMessageChange,
  onRequestRepair
}: {
  trial: DevelopmentBusinessTrialStatus
  busy: boolean
  scope: DevelopmentBusinessTrialScope
  api: DevelopmentBusinessTrialApi
  act: Act
  message: string
  onMessageChange(message: string): void
  onRequestRepair?: (message: string) => void | Promise<void>
}) {
  const [submitted, setSubmitted] = useState("")
  return (
    <section aria-label="试用反馈与对话优化" className="space-y-3 rounded border p-3">
      <h3 className="font-medium">反馈试用效果</h3>
      <p className="text-sm text-muted-foreground">
        说明哪里不符合预期。反馈与原试用记录一起保存；修改后使用新候选、新目录试用，不会回退或重放本次任务。
      </p>
      <textarea
        aria-label="业务插件试用反馈"
        className="min-h-20 w-full rounded border bg-background p-2"
        value={message}
        maxLength={4000}
        disabled={busy}
        onChange={(event) => onMessageChange(event.target.value)}
      />
      <button
        type="button"
        className={button}
        disabled={busy || !message.trim()}
        onClick={() =>
          void act(async (assertCurrent) => {
            const feedback = message.trim()
            const next = await api.feedback({ ...scope, message: feedback })
            assertCurrent()
            onMessageChange("")
            setSubmitted("反馈已保存到本次试用记录。")
            if (onRequestRepair) {
              try {
                await onRequestRepair(
                  `请结合业务插件隔离试用 ${trial.id}（候选 ${trial.digest}）的原运行、检查点和已保存反馈继续优化。我的反馈：${feedback}。先核对真实状态；结果未知的操作不要重放。修改后准备新候选和新的隔离试用，不改变原任务。`
                )
                assertCurrent()
                setSubmitted("反馈已保存，并已提交到原创造者对话继续优化。")
              } catch {
                assertCurrent()
                setSubmitted(
                  "反馈已保存，但尚未提交对话优化。请先结束正在运行的试用、处理会话中的待确认事项，再回原创作对话继续；不要重复执行未知操作。"
                )
              }
            }
            return next
          })
        }
      >
        {onRequestRepair ? "保存反馈并对话优化" : "保存试用反馈"}
      </button>
      {submitted && (
        <p role="status" className="text-sm">
          {submitted}
        </p>
      )}
      {!!trial.feedback?.length && (
        <details className="text-xs">
          <summary>已保存的反馈（{trial.feedback.length}，显示最近 20 条）</summary>
          <ul className="mt-2 space-y-2">
            {trial.feedback.slice(-20).map((item) => (
              <li key={item.id}>
                <p className="text-muted-foreground">{new Date(item.at).toLocaleString()}</p>
                <p className="whitespace-pre-wrap break-words">{item.message}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
