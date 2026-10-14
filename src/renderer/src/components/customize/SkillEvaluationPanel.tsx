import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { useEffect, useRef, useState } from "react"
import type {
  SkillEvaluationApi,
  SkillEvaluationView
} from "../../../../shared/mods/skill-evaluation"
import { FlowRunView } from "./FlowRunView"
import type { FlowApi, FlowRun, SavedFlow } from "../../../../shared/mods/flows/types"

const states = {
  prepared: "已冻结，尚未运行",
  evaluating: "评测记录",
  adopting: "正在采纳",
  adopted: "已采纳",
  "rolling-back": "正在回退",
  "rolled-back": "已回退",
  unknown: "结果待核对",
  discarded: "已丢弃冻结记录"
}
const errors = {
  INVALID: "仅支持没有脚本或配套文件的纯文本 Skill；请核对固定夹具、任务和预算。",
  STALE: "候选、基线或项目已经变化，请重新读取和冻结。",
  BUSY: "已有运行或待核对的 Skill 操作，请先处理。",
  LIMIT:
    "冻结记录或本聊天评测报告已达上限。下方管理全局冻结记录；本聊天报告请在“创作者模式 → 评测 → 固定任务评测”中清理。",
  CANCELLED: "操作已取消。请读取记录核对。",
  FAILED: "操作未完成，不能视为成功；请读取记录，不要盲目重试。"
}
export function SkillEvaluationPanel({
  threadId,
  workspace,
  api,
  flowApi
}: {
  threadId: string
  workspace: string
  api?: SkillEvaluationApi
  flowApi: FlowApi
}) {
  return api ? (
    <ScopedSkillEvaluation
      key={JSON.stringify([threadId, workspace])}
      threadId={threadId}
      workspace={workspace}
      api={api}
      flowApi={flowApi}
    />
  ) : (
    <p>Skill 评测接口尚未接通。</p>
  )
}
function ScopedSkillEvaluation({
  threadId,
  workspace,
  api,
  flowApi
}: {
  threadId: string
  workspace: string
  api: SkillEvaluationApi
  flowApi: FlowApi
}) {
  const canonicalScope = useRef<string | null>(null)
  const scopeValid = useRef(false)
  const [scopeReady, setScopeReady] = useState(false)
  const [candidates, setCandidates] = useState<
    { candidateId: string; name: string; skillId: string }[]
  >([])
  const [run, setRun] = useState<FlowRun | null>(null)
  const [records, setRecords] = useState<SkillEvaluationView[]>([])
  const [capacity, setCapacity] = useState<{
    limit: number
    entries: {
      id: string
      digest: string
      name: string
      workspace: string
      threadId: string
      canDiscard: boolean
      canForgetHistory?: boolean
      recoveryDirectory?: string
    }[]
  }>()
  const [forget, setForget] = useState<{ id: string; digest: string } | null>(null)
  const [forgetAck, setForgetAck] = useState(false)
  const [flows, setFlows] = useState<SavedFlow[]>([])
  const [candidateId, setCandidateId] = useState(""),
    [fixtureId, setFixtureId] = useState(""),
    [stepId, setStepId] = useState("")
  const [tasks, setTasks] = useState(""),
    [minutes, setMinutes] = useState(5),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false)
  const alive = useRef(true),
    pending = useRef(false),
    generation = useRef(0)
  const selected = flows.find((row) => row.definition.id === fixtureId)
  const goals = tasks
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
  const invalidateScope = () => {
    scopeValid.current = false
    setScopeReady(false)
    setCandidates([])
    setRecords([])
    setCapacity(undefined)
    setForget(null)
    setForgetAck(false)
    setFlows([])
    setRun(null)
    setCandidateId("")
    setFixtureId("")
    setStepId("")
    setMessage(errors.STALE)
  }
  const read = async () => {
    const ticket = ++generation.current
    try {
      const [result, saved] = await Promise.all([api.list(threadId), flowApi.flowList(threadId)])
      if (!alive.current || ticket !== generation.current) return
      if (!result.ok) {
        invalidateScope()
        setMessage(errors[result.code])
        return
      }
      if (
        !normalizeWorkspacePathKey(workspace) ||
        normalizeWorkspacePathKey(result.value.workspace) !==
          normalizeWorkspacePathKey(workspace) ||
        (canonicalScope.current !== null &&
          normalizeWorkspacePathKey(result.value.workspace) !==
            normalizeWorkspacePathKey(canonicalScope.current))
      ) {
        invalidateScope()
        return
      }
      canonicalScope.current = result.value.workspace
      const running = result.value.records.find((row) => row.evaluation?.state === "running")
      const currentRun = running?.evaluation?.activeRunId
        ? await flowApi.flowRun(threadId, running.evaluation.activeRunId)
        : null
      if (!alive.current || ticket !== generation.current) return
      if (
        currentRun &&
        (currentRun.id !== running?.evaluation?.activeRunId ||
          currentRun.threadId !== threadId ||
          currentRun.workspace !== canonicalScope.current)
      ) {
        invalidateScope()
        return
      }
      scopeValid.current = true
      setScopeReady(true)
      setRun(currentRun)
      setCandidates(result.value.candidates)
      setRecords(result.value.records)
      setCapacity(result.value.capacity)
      setFlows(
        saved.filter(
          (row) =>
            row.definition.schemaVersion === 2 &&
            ["prompt-only-v1", "workspace-files-v1"].includes(
              row.definition.execution.profile ?? ""
            )
        )
      )
    } catch (error) {
      if (alive.current && ticket === generation.current) invalidateScope()
      throw error
    }
  }
  useEffect(() => {
    alive.current = true
    void read().catch(() => {
      if (alive.current) setMessage(errors.FAILED)
    })
    const timer = setInterval(() => {
      if (!pending.current) void read().catch(() => undefined)
    }, 1500)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
    // Scope-keyed component owns all response publication.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, workspace, api, flowApi])
  const act = async (run: () => ReturnType<SkillEvaluationApi["prepare"]>) => {
    if (pending.current) return
    if (
      !scopeValid.current ||
      !canonicalScope.current ||
      normalizeWorkspacePathKey(canonicalScope.current) !== normalizeWorkspacePathKey(workspace)
    ) {
      invalidateScope()
      return
    }
    generation.current++
    pending.current = true
    setBusy(true)
    setMessage("")
    try {
      const result = await run()
      if (!alive.current) return
      await read()
      if (!alive.current || !scopeValid.current) return
      if (!result.ok) setMessage(errors[result.code])
      else {
        setMessage(
          result.value.state === "discarded"
            ? result.value.recoveryDirectory
              ? `已放弃此条应用内恢复历史并释放位置，当前 Skill 内容保留。备份仍在，可手工复制：${result.value.recoveryDirectory}`
              : "已丢弃冻结记录并释放位置；Skill 文件保留；无其他引用的已结算评测报告也会清理。"
            : "已记录。没有自动授权、启用 Skill 或执行后续任务。"
        )
      }
    } catch {
      if (alive.current) setMessage(errors.FAILED)
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const scope = { threadId, expectedWorkspace: canonicalScope.current ?? "" }
  const change = (row: SkillEvaluationView, action: "adopt" | "rollback" | "cancel") => {
    if (
      action !== "cancel" &&
      !window.confirm(
        action === "adopt"
          ? "将精确候选文本写入个人 Skill，影响以后读取此 Skill 的任务。已发生的业务效果不会回滚。确认采纳？"
          : "仅恢复本次保存的旧 Skill 文本；若当前文件已变更将拒绝。业务效果不会撤销。确认回退？"
      )
    )
      return
    void act(() => api.change({ ...scope, id: row.id, expectedDigest: row.digest, action }))
  }
  return (
    <section className="space-y-4 rounded border p-4" aria-label="Skill 候选固定任务评测">
      <h3 className="font-medium">Skill 候选：先评测，再明确采纳</h3>
      <p className="text-sm text-muted-foreground">
        读取现有 Skill Optimizer 的待审候选。冻结个人 Skill 原文、候选和来源
        Trace；仅把纯文本注入选定 Agent 步骤，不启动 Skill
        脚本或扩展权限。普通优化器入口保持原样。文本采纳与回退当前使用 Windows
        文件句柄保护，其他平台暂不开放写入。
      </p>
      <label className="block">
        待审候选
        <select
          aria-label="Skill 待审候选"
          className="ml-2 rounded border p-2"
          value={candidateId}
          onChange={(event) => setCandidateId(event.target.value)}
        >
          <option value="">选择候选</option>
          {candidates.map((row) => (
            <option key={row.candidateId} value={row.candidateId}>
              {row.name} · {row.skillId}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        固定流程夹具
        <select
          aria-label="Skill 固定流程夹具"
          className="ml-2 rounded border p-2"
          value={fixtureId}
          onChange={(event) => {
            setFixtureId(event.target.value)
            setStepId("")
          }}
        >
          <option value="">选择已保存的受限流程</option>
          {flows.map((row) => (
            <option key={row.definition.id} value={row.definition.id}>
              {row.definition.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        注入步骤
        <select
          aria-label="Skill 注入步骤"
          className="ml-2 rounded border p-2"
          value={stepId}
          onChange={(event) => setStepId(event.target.value)}
        >
          <option value="">选择 Agent 步骤</option>
          {selected?.definition.steps
            .filter((step) => step.enabled && step.kind === "agent")
            .map((step) => (
              <option key={step.id} value={step.id}>
                {step.name}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        className="rounded border px-3 py-2"
        disabled={busy || !scopeReady || !candidateId || !selected || !stepId}
        onClick={() =>
          void act(() =>
            api.prepare({
              ...scope,
              candidateId,
              agentStepId: stepId,
              fixture: {
                id: selected!.definition.id,
                revision: selected!.revision,
                digest: selected!.digest
              }
            })
          )
        }
      >
        冻结基线与候选（不运行）
      </button>
      <p className="text-sm">
        需包含真实
        unit-test/e2e。文本模式未观察完整环境时不可比较、不可采纳；含脚本、资源、复杂元数据或多层目录的
        Skill 暂不支持。旧版不会因冻结而改变。
      </p>
      <label className="block">
        固定任务（每行一个，最多 5 个）
        <textarea
          aria-label="Skill 固定任务"
          className="block w-full rounded border p-2"
          value={tasks}
          onChange={(event) => setTasks(event.target.value)}
        />
      </label>
      <label className="block">
        总时限（分钟）
        <input
          aria-label="Skill 总时限"
          className="ml-2 w-20 rounded border p-2"
          type="number"
          min={1}
          max={60}
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </label>
      <p className="text-sm">
        显式运行两组固定任务会调用已配置模型并可能产生费用；预算是时间和步骤上限，不是金额上限。未测量的
        token 用量保持未知。
      </p>
      {run && (
        <FlowRunView
          run={run}
          busy={busy || !scopeReady}
          onDecide={(nonce, approve) => {
            const row = records.find((row) => row.evaluation?.activeRunId === run.id)
            if (row)
              void act(async () => {
                await flowApi.flowDecide(threadId, run.id, nonce, approve)
                return { ok: true, value: row }
              })
          }}
          onCancel={() => {
            const row = records.find((row) => row.evaluation?.activeRunId === run.id)
            if (row) change(row, "cancel")
          }}
        />
      )}
      {records.length === 0 && (
        <p className="text-sm">
          此聊天尚无冻结记录。选择候选与夹具后可冻结；其他聊天的占位可在下方全局记录容量中管理。
        </p>
      )}
      {records.map((row) => (
        <article key={row.id} className="space-y-2 rounded border p-3" aria-label="Skill 评测记录">
          <h4>
            {row.name} · {states[row.state]}
          </h4>
          <p className="break-all text-xs">
            基线 {row.baselineDigest} → 候选 {row.candidateDigest}
          </p>
          <p className="text-xs">
            来源 Trace：{row.sourceTraceIds.join("、") || "无"}。关联仅为来源，不是成功证明。
          </p>
          <details>
            <summary>核对冻结文本</summary>
            <div className="grid gap-3 md:grid-cols-2">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                {row.baselineText ?? "原先不存在"}
              </pre>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                {row.candidateText}
              </pre>
            </div>
          </details>
          {row.state === "prepared" && (
            <button
              type="button"
              className="rounded border px-3 py-2"
              disabled={
                busy ||
                !scopeReady ||
                goals.length < 1 ||
                goals.length > 5 ||
                goals.some((goal) => goal.length > 4000) ||
                !Number.isInteger(minutes) ||
                minutes < 1 ||
                minutes > 60 ||
                goals.length * row.maxExecutions * 2 > 200
              }
              onClick={() =>
                void act(() =>
                  api.start({
                    ...scope,
                    id: row.id,
                    expectedDigest: row.digest,
                    tasks: goals.map((goal, index) => ({ id: `task-${index + 1}`, goal })),
                    budget: {
                      timeoutMs: minutes * 60000,
                      maxExecutions: goals.length * row.maxExecutions * 2
                    }
                  })
                )
              }
            >
              运行此 Skill 对比（最多 {goals.length * row.maxExecutions * 2} 步）
            </button>
          )}
          {row.evaluation && (
            <>
              <p>
                {row.evaluation.provider === "controlled"
                  ? "受控服务，只验证机制，不代表真实质量"
                  : "实际配置服务观察"}{" "}
                · {row.evaluation.state} ·{" "}
                {row.evaluation.comparison.comparable
                  ? "在已观察虚拟输入与运行时范围内比较"
                  : "条件不完整，不可比较"}
              </p>
              <p>
                通过 {row.evaluation.comparison.baseline.passed} →{" "}
                {row.evaluation.comparison.candidate.passed}；未知{" "}
                {row.evaluation.comparison.baseline.unknown} →{" "}
                {row.evaluation.comparison.candidate.unknown}。退化{" "}
                {row.evaluation.comparison.regressions.join("、") || "未记录"}。
              </p>
              <p className="text-xs">
                完整耗时、逻辑模型调用和原生检查证据见本页固定任务报告；模型自评分不计通过率。
              </p>
            </>
          )}
          {row.evaluation?.state === "running" && (
            <button
              type="button"
              disabled={busy || !scopeReady}
              onClick={() => change(row, "cancel")}
            >
              取消此 Skill 评测
            </button>
          )}
          {row.state === "evaluating" && row.evaluation?.state === "complete" && (
            <button
              type="button"
              className="rounded border px-3 py-2"
              disabled={
                busy ||
                !scopeReady ||
                !row.evaluation.comparison.comparable ||
                row.evaluation.candidate.cases.some((value) => value.result !== "passed")
              }
              onClick={() => change(row, "adopt")}
            >
              核对并采纳此候选
            </button>
          )}
          {row.state === "adopted" && (
            <button
              type="button"
              className="rounded border px-3 py-2"
              disabled={busy || !scopeReady}
              onClick={() => change(row, "rollback")}
            >
              回退本次 Skill 文本
            </button>
          )}
          {row.recoveryDirectory && (
            <p className="break-all text-xs">原文恢复材料：{row.recoveryDirectory}</p>
          )}
          {row.state === "unknown" && (
            <p role="alert">操作结果待核对，禁止重复操作；保留备份，未宣称自动恢复。</p>
          )}
          {row.state === "evaluating" && !row.evaluation && (
            <p>评测启动记录未完整关联或历史已不可用；结果未知，不能采纳或自动重试。</p>
          )}
        </article>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() => void read().catch(() => setMessage(errors.FAILED))}
      >
        重新读取 Skill 记录
      </button>
      {capacity && (
        <details className="rounded border p-3">
          <summary>
            全局记录容量 {capacity.entries.length}/{capacity.limit}（点击管理）
          </summary>
          <p className="text-sm">
            冻结记录与本聊天的评测报告分别计数；旧孤立报告可在“创作者模式 → 评测 →
            固定任务评测”中清理。所有聊天共用此冻结容量。可丢弃未运行或已确认结束且未采纳的冻结记录，释放位置；
            丢弃后不能再从该记录采纳。同时清理无其他引用的已结算评测报告，不删除 Skill 文件或 Flow
            运行历史。
            运行中及结果未知的记录必须保留。已完成采纳/回退可明确放弃应用内恢复能力后释放位置。
          </p>
          {capacity.entries.map((entry) => (
            <div key={entry.id} className="my-2 rounded border p-2">
              <p>{entry.name}</p>
              <p className="break-all text-xs">
                项目：{entry.workspace} · 聊天：{entry.threadId}
              </p>
              <button
                type="button"
                disabled={busy || !scopeReady || !entry.canDiscard}
                onClick={() => {
                  if (
                    window.confirm(
                      "永久丢弃此冻结记录及它无其他引用的已结算评测报告？Skill 文件和 Flow 运行历史保留。"
                    )
                  )
                    void act(() =>
                      api.change({
                        ...scope,
                        id: entry.id,
                        expectedDigest: entry.digest,
                        action: "discard"
                      })
                    )
                }}
              >
                {entry.canDiscard
                  ? "丢弃冻结记录，释放位置"
                  : "需保留：运行、未知结果或采纳/回退依据"}
              </button>
              {entry.canForgetHistory && (
                <>
                  <button
                    type="button"
                    disabled={busy || !scopeReady}
                    onClick={() => {
                      setForget({ id: entry.id, digest: entry.digest })
                      setForgetAck(false)
                    }}
                  >
                    放弃已完成采纳/回退历史
                  </button>
                  {forget?.id === entry.id && forget.digest === entry.digest && (
                    <div>
                      <p>
                        此操作移除应用内历史与回退入口，不修改当前 Skill
                        内容。备份目录仍保留，可手工复制其中材料；应用不会自动导出或删除这些备份。
                      </p>
                      <p className="break-all">备份目录：{entry.recoveryDirectory}</p>
                      <label>
                        <input
                          type="checkbox"
                          checked={forgetAck}
                          onChange={(event) => setForgetAck(event.target.checked)}
                        />
                        我确认放弃此条历史的应用内恢复能力
                      </label>
                      <button
                        type="button"
                        disabled={busy || !scopeReady || !forgetAck}
                        onClick={() => {
                          setForget(null)
                          setForgetAck(false)
                          void act(() =>
                            api.change({
                              ...scope,
                              id: entry.id,
                              expectedDigest: entry.digest,
                              action: "forget-history",
                              acknowledgeRecoveryLoss: true
                            })
                          )
                        }}
                      >
                        确认放弃历史并释放位置
                      </button>
                      <button type="button" onClick={() => setForget(null)}>
                        保留历史
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </details>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
