import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useConfigurationDraft } from "@/lib/configuration-target"
import type { EvaluationApi, EvaluationView } from "../../../../shared/mods/evaluation-api"
import type { FlowApi, FlowRun, SavedFlow } from "../../../../shared/mods/flows/types"
import { FlowRunView } from "./FlowRunView"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"

const SkillEvaluationPanel = lazy(() =>
  import("./SkillEvaluationPanel").then((module) => ({ default: module.SkillEvaluationPanel }))
)

const errors = {
  INVALID: "请选择兼容流程、1–5 个任务及有效预算。",
  BUSY: "项目已有任务运行，请结束后再试。",
  STALE: "项目、流程版本或运行状态已改变，请重新读取。",
  LIMIT: "评测记录或预算已达上限。",
  CANCELLED: "评测已取消。",
  FAILED: "操作未完成，请读取记录核对；不会自动重试。"
}
const stateText = {
  running: "运行中",
  complete: "采集结束",
  cancelled: "已取消",
  interrupted: "中断，未结算部分未知"
}
const resultText = {
  passed: "宿主检查通过",
  failed: "宿主检查失败",
  unknown: "未知",
  cancelled: "已取消"
}
const metric = (value: number | null) => (value === null ? "未知" : String(value))
export function EvaluationPanel({
  threadId,
  workspace,
  api,
  flowApi,
  onOpenCandidate
}: {
  threadId: string | null
  workspace: string | null
  api?: EvaluationApi
  flowApi: FlowApi
  onOpenCandidate?: (digest: string) => void
}) {
  const [showSkills, setShowSkills] = useState(false)
  if (!threadId || !workspace) return <p className="p-6">请选择项目中的任务后查看评测。</p>
  if (!api) return <p className="p-6">评测执行接口尚未接通。</p>
  return (
    <div
      className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto"
      tabIndex={0}
      aria-label="评测设置"
    >
      <button
        type="button"
        className="rounded border px-3 py-2"
        aria-expanded={showSkills}
        onClick={() => setShowSkills((value) => !value)}
      >
        比较技能版本
      </button>
      {showSkills && (
        <Suspense fallback={<p>正在读取 Skill 评测面板…</p>}>
          <SkillEvaluationPanel
            threadId={threadId}
            workspace={workspace}
            api={window.api.mods.skillEvaluation}
            flowApi={flowApi}
          />
        </Suspense>
      )}
      <ScopedEvaluationPanel
        key={JSON.stringify([threadId, workspace])}
        threadId={threadId}
        workspace={workspace}
        api={api}
        flowApi={flowApi}
        onOpenCandidate={onOpenCandidate}
      />
    </div>
  )
}
function ScopedEvaluationPanel({
  threadId,
  workspace,
  api,
  flowApi,
  onOpenCandidate
}: {
  threadId: string
  workspace: string
  api: EvaluationApi
  flowApi: FlowApi
  onOpenCandidate?: (digest: string) => void
}) {
  const canonicalScope = useRef<string | null>(null)
  const [flows, setFlows] = useState<SavedFlow[]>([])
  const [baseline, setBaseline] = useState("")
  const [candidate, setCandidate] = useState("")
  const [tasks, setTasks] = useState("")
  const [minutes, setMinutes] = useState(5)
  const [rows, setRows] = useState<EvaluationView[]>([])
  const [run, setRun] = useState<FlowRun | null>(null)
  const [busy, setBusy] = useState(false)
  useConfigurationDraft({ threadId, workspace }, !!tasks.trim(), busy)
  const [message, setMessage] = useState("")
  const [discardTarget, setDiscardTarget] = useState<{ id: string; digest: string } | null>(null)
  const [discardConsent, setDiscardConsent] = useState(false)
  const pending = useRef(false),
    alive = useRef(true),
    generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current
    try {
      const result = await api.list(threadId)
      if (!alive.current || request !== generation.current) return
      if (!result.ok) {
        setMessage(errors[result.code])
        return
      }
      if (
        normalizeWorkspacePathKey(result.value.workspace) !==
          normalizeWorkspacePathKey(workspace) ||
        (canonicalScope.current !== null && result.value.workspace !== canonicalScope.current)
      ) {
        setRows([])
        setDiscardTarget(null)
        setDiscardConsent(false)
        setMessage(errors.STALE)
        return
      }
      if (
        result.value.evaluations.some(
          (row) => row.workspace !== result.value.workspace || row.threadId !== threadId
        )
      ) {
        setMessage(errors.STALE)
        return
      }
      canonicalScope.current = result.value.workspace
      setRows(result.value.evaluations)
      const active = result.value.evaluations.find(
        (row) => row.state === "running" && row.activeRunId
      )
      if (!active?.activeRunId) {
        setRun(null)
        return
      }
      const next = await flowApi.flowRun(threadId, active.activeRunId)
      if (!alive.current || request !== generation.current) return
      if (
        next &&
        (next.id !== active.activeRunId ||
          next.threadId !== threadId ||
          next.workspace !== canonicalScope.current)
      ) {
        setRun(null)
        setMessage(errors.STALE)
        return
      }
      setRun(next)
    } catch {
      if (alive.current && request === generation.current) setMessage(errors.FAILED)
    }
  }, [api, flowApi, threadId, workspace])
  useEffect(() => {
    alive.current = true
    void load()
    void flowApi.flowList(threadId).then(
      (list) => {
        if (!alive.current) return
        setFlows(
          list.filter(
            (row) =>
              row.definition.schemaVersion === 2 &&
              ["prompt-only-v1", "workspace-files-v1"].includes(
                row.definition.execution.profile ?? ""
              )
          )
        )
      },
      () => {
        if (alive.current) setMessage(errors.FAILED)
      }
    )
    const timer = setInterval(() => {
      void load()
    }, 1000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [flowApi, threadId, load])
  const operate = async (operation: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage("")
    try {
      await operation()
    } catch {
      if (alive.current) setMessage(errors.FAILED)
    } finally {
      pending.current = false
      if (alive.current) {
        setBusy(false)
        await load()
      }
    }
  }
  const selected = (id: string) => flows.find((row) => row.definition.id === id)
  const goals = tasks
    .split("\n")
    .map((goal) => goal.trim())
    .filter(Boolean)
  const maxExecutions =
    goals.length *
    ((selected(baseline)?.definition.maxExecutions ?? 0) +
      (selected(candidate)?.definition.maxExecutions ?? 0))
  const active = rows.find((row) => row.state === "running")
  const start = () =>
    operate(async () => {
      const left = selected(baseline),
        right = selected(candidate)
      if (!left || !right) {
        setMessage(errors.INVALID)
        return
      }
      const ref = (row: SavedFlow) => ({
        id: row.definition.id,
        revision: row.revision,
        digest: row.digest
      })
      const result = await api.start({
        threadId,
        expectedWorkspace: canonicalScope.current ?? "",
        baseline: ref(left),
        candidate: ref(right),
        tasks: goals.map((goal, index) => ({ id: `task-${index + 1}`, goal })),
        budget: { timeoutMs: minutes * 60000, maxExecutions }
      })
      if (!alive.current) return
      if (!result.ok) setMessage(errors[result.code])
      else setMessage("已开始测试两套流程。需要人工确认时，会暂停等待你处理。")
    })
  return (
    <section className="min-w-0 space-y-5 p-6" aria-label="比较流程效果">
      <header className="space-y-2">
        <h2 className="font-semibold">比较流程效果</h2>
        <p className="text-sm text-muted-foreground">
          让两套流程完成相同任务，看看哪套效果更好。测试会实际调用模型并运行项目检查，可能修改项目文件。
        </p>
        <p className="text-sm text-muted-foreground">
          测试不会替你安装功能或批准操作。需要确认时会暂停，检查结果不足时不会判定哪套更好。
        </p>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">查看比较规则</summary>
          <p className="mt-2">
            仅项目测试脚本的结果计入通过率，模型自评不计分；缺失结果仍计入任务总数。脚本决定检查范围，运行环境信息不完整时只展示结果，不作比较结论。
          </p>
        </details>
      </header>
      <p className="text-sm">
        当前聊天已保存 {rows.length} / 16 份测试报告。存满后，可清理不再使用且未被引用的已结束报告。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["baseline", "candidate"] as const).map((variant) => (
          <label key={variant} className="space-y-1 text-sm">
            {variant === "baseline" ? "原流程" : "新流程"}
            <select
              className="block w-full rounded border bg-background p-2"
              disabled={busy || !!active}
              value={variant === "baseline" ? baseline : candidate}
              onChange={(event) =>
                (variant === "baseline" ? setBaseline : setCandidate)(event.target.value)
              }
            >
              <option value="">选择已保存版本</option>
              {flows.map((row) => (
                <option key={row.definition.id} value={row.definition.id}>
                  {row.definition.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label className="block space-y-1 text-sm">
        固定任务（每行一个，最多 5 个）
        <textarea
          className="block min-h-28 w-full rounded border bg-background p-2"
          value={tasks}
          disabled={busy || !!active}
          onChange={(event) => setTasks(event.target.value)}
          maxLength={20000}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        总时限（分钟）
        <input
          className="w-20 rounded border bg-background p-2"
          type="number"
          min={1}
          max={60}
          value={minutes}
          disabled={busy || !!active}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </label>
      <p className="text-sm">
        计划 {goals.length * 2} 次运行，最多 {maxExecutions}{" "}
        次步骤执行；调用模型可能产生费用。调用次数按实际记录统计，无法确认的用量显示为未知。
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded border bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
          type="button"
          disabled={
            busy ||
            !!active ||
            rows.length >= 16 ||
            !baseline ||
            !candidate ||
            goals.length < 1 ||
            goals.length > 5 ||
            maxExecutions > 200 ||
            !Number.isInteger(minutes) ||
            minutes < 1 ||
            minutes > 60
          }
          onClick={() => void start()}
        >
          开始比较
        </button>
        <button
          className="rounded border px-3 py-2"
          type="button"
          disabled={busy}
          onClick={() => void load()}
        >
          读取记录
        </button>
        {active && (
          <button
            className="rounded border px-3 py-2"
            type="button"
            disabled={busy}
            onClick={() =>
              void operate(async () => {
                const result = await api.cancel({
                  threadId,
                  expectedWorkspace: canonicalScope.current ?? "",
                  evaluationId: active.id
                })
                if (alive.current && !result.ok) setMessage(errors[result.code])
              })
            }
          >
            取消本次评测
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {run && (
        <FlowRunView
          run={run}
          busy={busy}
          onCancel={() =>
            void operate(async () => {
              if (active)
                await api.cancel({
                  threadId,
                  expectedWorkspace: canonicalScope.current ?? "",
                  evaluationId: active.id
                })
            })
          }
          onDecide={(nonce, approve) =>
            void operate(async () => {
              await flowApi.flowDecide(threadId, run.id, nonce, approve)
            })
          }
        />
      )}
      {[...rows].reverse().map((row) => (
        <article key={row.id} className="space-y-3 rounded border p-4" aria-label="评测报告">
          <div className="flex flex-wrap justify-between gap-2">
            <h3 className="font-medium">
              {row.baseline.name} → {row.candidate.name}
            </h3>
            <span>{stateText[row.state]}</span>
          </div>
          <p className="text-sm">
            {row.provider === "controlled"
              ? "受控服务验证（不代表真实模型效果）"
              : "实际配置服务的运行观察"}{" "}
            ·{" "}
            {row.comparison.comparable
              ? "虚拟输入与运行时观测相符，可作范围内比较"
              : "观测不完整或条件不同，不可比较"}
          </p>
          <p className="text-sm">
            确认通过率：基线 {(row.comparison.baseline.confirmedPassRate * 100).toFixed(0)}% · 候选{" "}
            {(row.comparison.candidate.confirmedPassRate * 100).toFixed(0)}%。未知：
            {row.comparison.baseline.unknown} / {row.comparison.candidate.unknown}。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>版本</th>
                  <th>原生验收</th>
                  <th>耗时 ms</th>
                  <th>模型调用</th>
                  <th>人工确认</th>
                </tr>
              </thead>
              <tbody>
                {row.tasks.flatMap((task) =>
                  (["baseline", "candidate"] as const).map((side) => {
                    const fact = row[side].cases.find((value) => value.caseId === task.id)
                    return (
                      <tr key={task.id + side}>
                        <td className="max-w-56 break-words py-2">{task.goal}</td>
                        <td>{side === "baseline" ? "基线" : "候选"}</td>
                        <td>{fact ? resultText[fact.result] : "未知"}</td>
                        <td>{metric(fact?.durationMs ?? null)}</td>
                        <td>{metric(fact?.modelCalls ?? null)}</td>
                        <td>{metric(fact?.humanTakeovers ?? null)}</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
          {row.comparison.comparable && (
            <p className="text-sm">
              退化任务：{row.comparison.regressions.join("、") || "无已确认退化"}；改进任务：
              {row.comparison.improvements.join("、") || "无已确认改进"}。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            历史证据仅描述当时运行，不证明当前文件状态或
            OS、网络与外部服务完全可重复。请人工核对任务与脚本后决定后续操作；此报告没有自动应用功能。
          </p>
          {discardTarget?.id === row.id && (
            <div
              role="group"
              aria-label="确认清理评测报告"
              className="space-y-2 rounded border p-3"
            >
              <p className="break-all">
                将永久删除报告 {discardTarget.id}{" "}
                的比较结果和历史证据。现有流程与其已发生的操作不会撤销。
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={discardConsent}
                  disabled={busy}
                  onChange={(event) => setDiscardConsent(event.target.checked)}
                />
                我确认不再需要这份评测报告及其历史证据
              </label>
              {!rows.some(
                (row) => row.id === discardTarget.id && row.discardDigest === discardTarget.digest
              ) && <p role="alert">报告状态已变化，请重新读取并选择可清理报告。</p>}
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded border px-3 py-2"
                  disabled={
                    busy ||
                    !discardConsent ||
                    !rows.some(
                      (row) =>
                        row.id === discardTarget.id && row.discardDigest === discardTarget.digest
                    )
                  }
                  onClick={() => {
                    const target = discardTarget
                    setDiscardTarget(null)
                    setDiscardConsent(false)
                    void operate(async () => {
                      const result = await api.discard({
                        threadId,
                        expectedWorkspace: canonicalScope.current ?? "",
                        evaluationId: target.id,
                        expectedDigest: target.digest
                      })
                      if (alive.current)
                        setMessage(
                          result.ok ? "评测报告已清理，已释放一个报告位置。" : errors[result.code]
                        )
                    })
                  }}
                >
                  确认永久清理这份报告
                </button>
                <button
                  className="rounded border px-3 py-2"
                  disabled={busy}
                  onClick={() => {
                    setDiscardTarget(null)
                    setDiscardConsent(false)
                  }}
                >
                  保留报告
                </button>
              </div>
            </div>
          )}
          {row.discardDigest ? (
            <button
              type="button"
              className="rounded border px-3 py-2"
              disabled={busy}
              onClick={() => {
                setDiscardTarget({ id: row.id, digest: row.discardDigest! })
                setDiscardConsent(false)
              }}
            >
              清理这份历史报告…
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">
              运行中、待确认或仍被 Skill 记录引用的报告不能清理；请先完成或核对相关记录。
            </p>
          )}
          {onOpenCandidate && (
            <button
              type="button"
              className="rounded border px-3 py-2"
              onClick={() => onOpenCandidate(row.candidate.digest)}
            >
              打开候选流程（使用或编辑）
            </button>
          )}
        </article>
      ))}
    </section>
  )
}
