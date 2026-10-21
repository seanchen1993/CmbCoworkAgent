import { useEffect, useRef, useState } from "react"
import type {
  PluginStageRecoveryApi,
  PluginStageRecoveryInspection,
  PluginStageRecoveryPreparation
} from "../../../../shared/mods/plugin-stage-recovery"
import type { DevelopmentBusinessTrialStatus } from "../../../../shared/mods/development"

const button = "rounded border px-3 py-2 text-sm disabled:opacity-50"
const phaseNames: Record<PluginStageRecoveryPreparation["phase"], string> = {
  "needs-confirmation": "方案已准备，等待确认",
  applying: "正在执行插件恢复",
  verified: "副本已验证，等待原生接管",
  adopted: "独立试用已创建，尚需重新配置并批准运行",
  failed: "本次准备未完成",
  unknown: "结果尚未确认，禁止重放恢复操作"
}

function recoveryProblem(cause: unknown) {
  const text = cause instanceof Error ? cause.message : String(cause)
  if (/ADAPTER_REQUIRED|ADAPTER_INVALID/.test(text))
    return "此插件尚未声明有效的阶段恢复适配器。请由插件作者补充适配并生成新版本；原业务流程仍可使用。"
  if (/SOURCE_UNSETTLED|NOT_ENDED|ACTIVE|BUSY/.test(text))
    return "原试用或关联任务尚未结算。请先在原运行入口停止并核对真实结果。"
  if (/OUTCOME_UNCONFIRMED|UNKNOWN|UNCONFIRMED/.test(text))
    return "本次操作结果尚未确认。请核对已保存的恢复记录；系统不会重复执行恢复命令。"
  if (
    /SOURCE_CHANGED|INPUT_CHANGED|INPUTS_CHANGED|VERSION_CHANGED|FRESH_APPROVAL|SCOPE_CHANGED|PACKAGE_CHANGED/.test(
      text
    )
  )
    return "来源、输入或本次确认已变化。请重新读取原生记录与精确版本，不能复用旧批准。"
  if (/GIT|WORKTREE|REPOSITORY/.test(text))
    return "此项目包含 Git 或工作树绑定，需要插件提供私有仓库重绑定适配。本入口不会改动原仓库。"
  return "操作未完成。请核对原生恢复记录和原试用状态后再处理；不要重复提交未知操作。"
}

/** Native returned plans only. This card never edits checkpoints or declares business success. */
export function PluginStageRecoveryCard({
  threadId,
  workspace,
  trial,
  api,
  disabled,
  onChanged
}: {
  threadId: string
  workspace: string
  trial: DevelopmentBusinessTrialStatus
  api: PluginStageRecoveryApi
  disabled?: boolean
  onChanged(): void | Promise<void>
}) {
  const caller = { threadId, expectedWorkspace: workspace }
  const recoveredStarted =
    trial.stageRecovery?.started ??
    (!!trial.observation?.runId || ["starting", "running", "completed"].includes(trial.phase))
  const sourceId =
    trial.stageRecovery && !recoveredStarted ? trial.stageRecovery.sourceTrialId : trial.id
  const [inspection, setInspection] = useState<PluginStageRecoveryInspection>()
  const stages = inspection?.stages ?? trial.journey?.stages ?? []
  const [preparation, setPreparation] = useState<PluginStageRecoveryPreparation>()
  const [stageId, setStageId] = useState("")
  const [stateMode, setStateMode] = useState<"target_in_progress" | "previous_done">(
    "target_in_progress"
  )
  const [planConsent, setPlanConsent] = useState(false)
  const [applyConsent, setApplyConsent] = useState(false)
  const [verifyConsent, setVerifyConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const mounted = useRef(true)
  const lock = useRef(false)
  const epoch = useRef(Symbol("initial"))
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      epoch.current = Symbol("closed")
    }
  }, [])
  const scopeKey = JSON.stringify([threadId, workspace, sourceId, trial.id])
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  useEffect(() => {
    epoch.current = Symbol("source changed")
    lock.current = false
    setInspection(undefined)
    setPreparation(undefined)
    setStageId("")
    setPlanConsent(false)
    setApplyConsent(false)
    setVerifyConsent(false)
    setBusy(false)
    setError("")
  }, [scopeKey])

  async function act(work: () => Promise<PluginStageRecoveryPreparation | undefined>) {
    if (lock.current || !mounted.current || disabled) return
    lock.current = true
    const ticket = Symbol("operation"),
      captured = scopeKey
    epoch.current = ticket
    const current = () =>
      mounted.current && ticket === epoch.current && captured === currentScope.current
    setBusy(true)
    setError("")
    try {
      const next = await work()
      if (!current()) return
      setPreparation(next)
      setPlanConsent(false)
      setApplyConsent(false)
      setVerifyConsent(false)
      if (next?.phase === "adopted") await onChanged()
    } catch (cause) {
      if (!current()) return
      setError(recoveryProblem(cause))
      // A lost response is never grounds to resend prepare/apply. Read native intent once.
      try {
        const actual = await api.latest(callerWithTrial())
        if (current()) setPreparation(actual)
      } catch {
        /* The explicit refresh retains the error; no guessed outcome. */
      }
      if (current()) {
        setPlanConsent(false)
        setApplyConsent(false)
        setVerifyConsent(false)
      }
    } finally {
      if (current()) {
        setBusy(false)
        lock.current = false
      }
    }
  }
  function callerWithTrial() {
    return { ...caller, trialId: sourceId }
  }
  const blocked = busy || disabled
  const pending = preparation && ["applying", "verified", "unknown"].includes(preparation.phase)
  const canPlan =
    inspection?.sourceId === sourceId && !!stageId && planConsent && !pending && !blocked

  return (
    <section aria-label="插件阶段恢复" className="space-y-3 rounded border p-3 text-sm">
      <h3 className="font-medium">从某个阶段创建独立调试试用</h3>
      <p>
        由插件自己的适配器规划并恢复独立副本，保留原 Hooks 和产物校验。原试用保持不变；
        恢复成功不代表业务阶段通过，新试用仍须重新核对配置、知识、工具权限并明确运行。
      </p>
      <p className="text-xs text-muted-foreground">
        当前入口不恢复 Git、活跃工作树或外部系统状态。规划、应用及必要的只读验证会运行插件脚本，
        Windows 文件隔离不保证阻断所有网络访问，外部影响不会随副本自动回退。
      </p>
      <div className="flex flex-wrap gap-2">
        {trial.stageRecovery && recoveredStarted && (
          <button
            type="button"
            className={button}
            disabled={blocked}
            onClick={() =>
              void act(() => api.latest({ ...caller, trialId: trial.stageRecovery!.sourceTrialId }))
            }
          >
            读取上一次恢复记录（只读）
          </button>
        )}
        <button
          type="button"
          className={button}
          disabled={blocked}
          onClick={() =>
            void act(async () => {
              const actual = await api.latest(callerWithTrial())
              return actual
            })
          }
        >
          读取已保存的恢复记录
        </button>
        <button
          type="button"
          className={button}
          disabled={blocked || !!pending}
          onClick={() =>
            void act(async () => {
              const actual = await api.inspect(callerWithTrial())
              if (mounted.current && currentScope.current === scopeKey) {
                setInspection(actual)
                setPlanConsent(false)
              }
              return api.latest(callerWithTrial())
            })
          }
        >
          检查阶段恢复条件
        </button>
      </div>
      {inspection && (
        <div className="space-y-2 rounded bg-muted/30 p-3">
          <p>已核对插件、适配器和配置知识的精确版本；重新检查会清除本次规划确认。</p>
          <label className="grid gap-1">
            恢复起点
            <select
              aria-label="恢复起点"
              className="rounded border bg-background p-2"
              value={stageId}
              disabled={blocked || !!pending}
              onChange={(event) => {
                setStageId(event.target.value)
                setPlanConsent(false)
              }}
            >
              <option value="">请选择原流程阶段</option>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.title}（{stage.id}）
                </option>
              ))}
            </select>
          </label>
          {!stages.length && (
            <p>当前尚未取得原生流程阶段。请先核对原试用运行记录；不会猜测阶段标识。</p>
          )}
          <label className="grid gap-1">
            恢复后的状态
            <select
              aria-label="恢复后的状态"
              className="rounded border bg-background p-2"
              value={stateMode}
              disabled={blocked || !!pending}
              onChange={(event) => {
                setStateMode(event.target.value as typeof stateMode)
                setPlanConsent(false)
              }}
            >
              <option value="target_in_progress">所选阶段回到执行起点</option>
              <option value="previous_done">回到所选阶段之前的已完成状态</option>
            </select>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={planConsent}
              disabled={blocked || !!pending}
              onChange={(event) => setPlanConsent(event.target.checked)}
            />
            我已核对当前版本、输入及起点，同意运行本次规划脚本及其可能的网络访问。
          </label>
          <button
            type="button"
            className={button}
            disabled={!canPlan}
            onClick={() =>
              void act(() =>
                api.prepare({
                  ...callerWithTrial(),
                  stageId,
                  stateMode,
                  expectedPackageDigest: inspection.packageDigest,
                  expectedAdapterDigest: inspection.adapterDigest,
                  expectedInputsDigest: inspection.inputsDigest,
                  allowNetworkSideEffects: true
                })
              )
            }
          >
            准备插件阶段恢复方案
          </button>
        </div>
      )}
      {preparation && (
        <div className="space-y-2 rounded border p-3">
          <p role="status">{phaseNames[preparation.phase]}</p>
          {preparation.sourceId !== sourceId && (
            <p>这是上一轮恢复的历史记录，仅供查看；新恢复方案使用当前试用的实际产物。</p>
          )}
          <p className="whitespace-pre-wrap break-words">{preparation.summary}</p>
          <p>
            恢复阶段：{preparation.stageId}；原试用：{preparation.sourceId}
          </p>
          {!!preparation.affectedArtifacts.length && (
            <details>
              <summary>受影响的产物</summary>
              <ul className="list-inside list-disc">
                {preparation.affectedArtifacts.map((path) => (
                  <li key={path} className="break-all">
                    {path}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preparation.diagnostics.map((message, index) => (
            <p key={index} className="break-words text-xs">
              {message}
            </p>
          ))}
          {preparation.sourceId === sourceId && preparation.canApply && (
            <>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  disabled={blocked}
                  checked={applyConsent}
                  onChange={(event) => setApplyConsent(event.target.checked)}
                />
                我已核对本方案及受影响产物，同意此次插件恢复命令及可能的网络与外部副作用。
              </label>
              <button
                type="button"
                className={button}
                disabled={blocked || !applyConsent}
                onClick={() =>
                  void act(async () => {
                    const result = await api.apply({
                      ...caller,
                      preparationId: preparation.id,
                      expectedDigest: preparation.digest,
                      allowNetworkSideEffects: true
                    })
                    return result.preparation
                  })
                }
              >
                确认创建恢复后的独立试用（尚不运行）
              </button>
            </>
          )}
          {preparation.sourceId === sourceId && preparation.canReconcile && (
            <>
              <button
                type="button"
                className={button}
                disabled={blocked}
                onClick={() =>
                  void act(() =>
                    api.reconcile({
                      ...caller,
                      preparationId: preparation.id,
                      expectedDigest: preparation.digest
                    })
                  )
                }
              >
                只核对恢复执行记录（不运行脚本）
              </button>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  disabled={blocked}
                  checked={verifyConsent}
                  onChange={(event) => setVerifyConsent(event.target.checked)}
                />
                我同意重新运行只读验证脚本并由原生系统接管已恢复副本；不会重放恢复命令。
              </label>
              <button
                type="button"
                className={button}
                disabled={blocked || !verifyConsent}
                onClick={() =>
                  void act(() =>
                    api.reconcile({
                      ...caller,
                      preparationId: preparation.id,
                      expectedDigest: preparation.digest,
                      allowNetworkSideEffects: true
                    })
                  )
                }
              >
                验证并接管已恢复副本（不重放恢复）
              </button>
            </>
          )}
          {preparation.phase === "adopted" && (
            <button
              type="button"
              className={button}
              disabled={blocked}
              onClick={() => void onChanged()}
            >
              查看恢复后的试用与配置
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {busy && <p role="status">正在核对本次恢复操作，请勿重复提交。</p>}
    </section>
  )
}
