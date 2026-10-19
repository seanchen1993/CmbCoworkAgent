import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useConfigurationDraft } from "@/lib/configuration-target"
import { Button } from "@/components/ui/button"
import {
  COMPLETION_CHECKS,
  COMPLETION_MODES,
  COMPLETION_SCOPES,
  type CompletionPolicy,
  type CompletionPolicyView,
  type AutobizEnvironment
} from "../../../../shared/mods/v2/completion-policy-values"

const modes = { off: "关闭", report: "仅报告", check: "阻止完成", repair: "自动修复并复检" }
const scopes = {
  file: "指定文件或目录",
  diff: "本次代码改动",
  feature: "指定功能（Feature）",
  project: "整个项目"
}
const checks = {
  "code-review": "代码评审",
  "unit-test": "单元测试",
  e2e: "E2E",
  "autobiz-validator": "Autobiz 业务验收"
}
const field = "rounded border bg-background px-2 py-1 text-sm min-w-0"
type EnvironmentState = "idle" | "checking" | "ready" | "error"

export function FunctionCompletionPolicyForm({
  value,
  source,
  environment,
  environmentState = "idle",
  environmentError,
  onCheckEnvironment,
  disabled,
  onChange,
  onSave
}: {
  value: CompletionPolicy
  source: CompletionPolicyView["source"]
  environment?: AutobizEnvironment
  environmentState?: EnvironmentState
  environmentError?: string
  onCheckEnvironment?(): void
  disabled: boolean
  onChange(value: CompletionPolicy): void
  onSave(): void
}): React.JSX.Element {
  const stageHelpId = useId()
  const change = (patch: Partial<CompletionPolicy>) => {
    const next = { ...value, ...patch }
    if (!["check", "repair"].includes(next.mode) || !next.checks.includes("autobiz-validator"))
      delete next.autobizStartCheckpoint
    onChange(next)
  }
  const stageAvailable =
    ["check", "repair"].includes(value.mode) && value.checks.includes("autobiz-validator")
  const missingEnvironment =
    value.mode !== "off" &&
    value.checks.includes("autobiz-validator") &&
    (!environment?.ready || environmentState === "checking" || environmentState === "error")
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!missingEnvironment) onSave()
      }}
    >
      <p className="text-xs text-muted-foreground">
        {source === "application"
          ? "由应用保存，插件不能覆盖或删除此规则。"
          : "保存前沿用插件行为；保存后由应用控制此项目的规则。"}
      </p>
      <fieldset disabled={disabled} className="space-y-3">
        <div className="flex flex-wrap gap-2" aria-label="规则模板">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              change({
                mode: "report",
                scope: "diff",
                checks: ["code-review"]
              })
            }
          >
            只给检查报告
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              change({
                mode: "repair",
                scope: "diff",
                checks: ["code-review", "unit-test"]
              })
            }
          >
            修复后再完成
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          选择模板后仍需保存。仅报告不会阻止任务完成；自动修复会在失败时让原 Agent 修复并复检。
          模板保留你的时间和用量预算，不会自动提高上限。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">
            完成模式
            <select
              aria-label="完成模式"
              className={field}
              value={value.mode}
              onChange={(e) => change({ mode: e.target.value as CompletionPolicy["mode"] })}
            >
              {COMPLETION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {modes[mode]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            检查范围
            <select
              aria-label="检查范围"
              className={field}
              value={value.scope}
              onChange={(e) => change({ scope: e.target.value as CompletionPolicy["scope"] })}
            >
              {COMPLETION_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {scopes[scope]}
                </option>
              ))}
            </select>
          </label>
          {value.scope === "file" && (
            <label className="grid gap-1">
              相对文件或目录
              <input
                className={field}
                value={value.target ?? ""}
                maxLength={512}
                required={value.mode !== "off" && value.scope === "file"}
                onChange={(e) => change({ target: e.target.value || undefined })}
                placeholder="src/orders.ts"
              />
            </label>
          )}
          {(value.scope === "feature" || value.checks.includes("autobiz-validator")) && (
            <label className="grid gap-1">
              Feature ID
              <input
                className={field}
                value={value.feature ?? ""}
                maxLength={128}
                required={
                  value.mode !== "off" &&
                  (value.scope === "feature" || !!value.autobizStartCheckpoint)
                }
                onChange={(e) => change({ feature: e.target.value || undefined })}
                placeholder="order-export"
              />
            </label>
          )}
        </div>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1">执行检查</legend>
          {COMPLETION_CHECKS.map((kind) => (
            <label key={kind} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={value.checks.includes(kind)}
                disabled={
                  kind === "autobiz-validator" &&
                  environment?.ready === false &&
                  !value.checks.includes(kind)
                }
                onChange={(e) =>
                  change({
                    checks: COMPLETION_CHECKS.filter((check) =>
                      check === kind ? e.target.checked : value.checks.includes(check)
                    )
                  })
                }
              />
              {checks[kind]}
            </label>
          ))}
        </fieldset>
        <div className="space-y-1 text-xs" data-autobiz-probe>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={environmentState === "checking"}
            onClick={onCheckEnvironment}
          >
            {environmentState === "checking" ? "正在检查 Autobiz 环境…" : "检查 Autobiz 环境"}
          </Button>
          {environmentState === "idle" && <p>尚未检查 Autobiz 环境；普通代码检查无需此依赖。</p>}
          {environmentState === "error" && (
            <p role="alert">
              环境检查未完成：{environmentError}。请重新检查；普通代码检查仍可使用。
            </p>
          )}
        </div>
        {environment && (
          <details
            className="text-xs"
            open={!environment.ready || undefined}
            data-autobiz-environment
          >
            <summary>
              Autobiz 环境：
              {environment.ready ? "基础依赖已就绪" : "尚未就绪（普通代码检查仍可使用）"}
            </summary>
            <p className="break-all">源码目录：{environment.source}</p>
            {environment.issues.map((issue) => (
              <p key={issue}>{issue}</p>
            ))}
            <p>
              这里只检查基础依赖，任务执行时仍会校验项目产物和权限。修复环境后点击“检查 Autobiz
              环境”。
            </p>
            <p>
              {environment.stageSupported
                ? "自动推进仅支持 Windows 本地固定 NTFS 磁盘，执行时会再次校验。"
                : "当前平台暂不支持自动推进阶段；仍可执行检查。"}
            </p>
          </details>
        )}
        {stageAvailable && (
          <label className="grid gap-1">
            自动推进阶段起点
            <input
              aria-label="自动推进阶段起点"
              className={field}
              value={value.autobizStartCheckpoint ?? ""}
              maxLength={128}
              disabled={environment?.stageSupported === false}
              pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{0,127}"
              placeholder="requirements_eval_in_progress"
              onChange={(e) => change({ autobizStartCheckpoint: e.target.value || undefined })}
              aria-describedby={stageHelpId}
            />
            <span id={stageHelpId} className="text-xs text-muted-foreground">
              留空只检查，不推进。填写后须指定 Feature ID；应用根据项目工作流确定下一阶段。
              全部检查通过且证据未变化，再按原权限审批推进。到达终点后只复检本阶段。
            </span>
          </label>
        )}
        <details data-completion-budgets>
          <summary className="cursor-pointer text-sm">
            时间与用量上限：最多 {value.maxRepairs} 次修复 · {value.timeoutMs / 1000} 秒 ·{" "}
            {value.modelTokenBudget} tokens
          </summary>
          <p className="my-2 text-xs text-muted-foreground">
            模型预算累计计算输入和输出，修复时携带的上下文也计入。复杂任务可能耗尽默认预算；
            请根据检查范围调整，耗尽后会停止并说明原因。
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1">
              最大修复次数
              <input
                className={field}
                type="number"
                min={0}
                max={10}
                step={1}
                required
                value={value.maxRepairs}
                onChange={(e) => change({ maxRepairs: Number(e.target.value) })}
              />
            </label>
            <label className="grid gap-1">
              最长时间（秒）
              <input
                className={field}
                type="number"
                min={1}
                max={3600}
                step={1}
                required
                value={value.timeoutMs / 1000}
                onChange={(e) => change({ timeoutMs: Number(e.target.value) * 1000 })}
              />
            </label>
            <label className="grid gap-1">
              模型总预算（tokens）
              <input
                className={field}
                type="number"
                min={256}
                max={1000000}
                step={1}
                required
                value={value.modelTokenBudget}
                onChange={(e) => change({ modelTokenBudget: Number(e.target.value) })}
              />
            </label>
          </div>
        </details>
        <p className="text-xs text-muted-foreground">
          代码评审需要插件提供评审处理器；测试与 Autobiz 业务验收
          由宿主执行。缺少检查能力会明确报告失败。
          关闭后移除此插件的完成门禁；其他插件的规则仍分别生效。
        </p>
        {missingEnvironment && (
          <p role="alert">
            Autobiz 环境尚未确认就绪。请完成环境检查，或取消该检查后保存；也可先关闭规则。
          </p>
        )}
        <Button type="submit" size="sm" disabled={missingEnvironment}>
          保存项目规则
        </Button>
      </fieldset>
    </form>
  )
}

type PolicyProps = {
  threadId: string
  plugin: string
  disabled: boolean
  expectedWorkspace?: string
}

export function FunctionCompletionPolicy(props: PolicyProps): React.JSX.Element {
  // A pending save belongs to its original project; its response must never populate another one.
  return (
    <CompletionPolicySection
      key={JSON.stringify([props.threadId, props.plugin, props.expectedWorkspace])}
      {...props}
    />
  )
}

function CompletionPolicySection(props: PolicyProps): React.JSX.Element {
  const [mounted, setMounted] = useState(false)
  return (
    <details
      data-completion-policy={props.plugin}
      className="border-t pt-2"
      onToggle={(event) => {
        if (event.currentTarget.open) setMounted(true)
      }}
    >
      <summary className="cursor-pointer">完成检查规则</summary>
      {mounted && <CompletionPolicyEditor {...props} />}
    </details>
  )
}

function CompletionPolicyEditor({
  threadId,
  plugin,
  disabled,
  expectedWorkspace
}: PolicyProps): React.JSX.Element {
  const [view, setView] = useState<CompletionPolicyView>()
  const [draft, setDraft] = useState<CompletionPolicy>()
  const [busy, setBusy] = useState(false)
  useConfigurationDraft({ threadId, workspace: expectedWorkspace ?? null },
    !!draft && !!view && JSON.stringify(draft) !== JSON.stringify(view.policy), busy)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [environment, setEnvironment] = useState<AutobizEnvironment>()
  const [environmentState, setEnvironmentState] = useState<EnvironmentState>("idle")
  const [environmentError, setEnvironmentError] = useState("")
  const probing = useRef(false)
  const dirty = useRef(false)
  const alive = useRef(false)
  const saving = useRef(false)
  const readVersion = useRef(0)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let live = true
    alive.current = true
    setError("")
    setNotice("")
    const load = async () => {
      if (saving.current) return
      const version = ++readVersion.current
      try {
        const current = await window.api.mods.completionPolicy(threadId, plugin, expectedWorkspace)
        if (!live || version !== readVersion.current) return
        setView(current)
        if (!dirty.current) setDraft(current.policy)
      } catch (cause) {
        if (live && version === readVersion.current) setError(String(cause))
      }
    }
    void load()
    const stop = window.api.mods.onConfigurationChanged(() => void load())
    return () => {
      live = false
      alive.current = false
      stop()
    }
  }, [threadId, plugin, refresh, expectedWorkspace])
  const save = async () => {
    if (!draft || busy || disabled) return
    setBusy(true)
    saving.current = true
    ++readVersion.current
    setError("")
    setNotice("")
    try {
      const current = await window.api.mods.setCompletionPolicy(
        threadId,
        plugin,
        draft,
        expectedWorkspace
      )
      if (!alive.current) return
      dirty.current = false
      setView(current)
      setDraft(current.policy)
      setNotice("规则已按项目保存，重启后继续生效。旧版本检查证据将重新核验。")
    } catch (cause) {
      if (alive.current) setError(String(cause))
    } finally {
      saving.current = false
      if (alive.current) setBusy(false)
    }
  }
  const checkEnvironment = useCallback(async () => {
    if (probing.current) return
    probing.current = true
    setEnvironment(undefined)
    setEnvironmentError("")
    setEnvironmentState("checking")
    try {
      const result = await window.api.mods.autobizEnvironment(threadId, expectedWorkspace)
      if (alive.current) {
        setEnvironment(result)
        setEnvironmentState("ready")
      }
    } catch (cause) {
      if (alive.current) {
        setEnvironmentError(String(cause))
        setEnvironmentState("error")
      }
    } finally {
      probing.current = false
    }
  }, [threadId, expectedWorkspace])
  const needsEnvironment =
    draft?.mode !== "off" && draft?.checks.includes("autobiz-validator") === true
  useEffect(() => {
    if (needsEnvironment && environmentState === "idle") void checkEnvironment()
  }, [needsEnvironment, environmentState, checkEnvironment])
  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-muted-foreground">
        规则按当前项目保存，对该项目后续任务生效。应用总开关、项目启用和插件授权均开启后才会执行。
        {disabled && " 请先解锁管理设置并启用、授权此插件。"}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => setRefresh((version) => version + 1)}
      >
        重新检查配置
      </Button>
      {view && (
        <p className="text-xs" data-effective-policy>
          当前生效：
          {view.source === "default"
            ? "插件自带行为（尚未设置应用规则）"
            : `${view.source === "application" ? "应用规则" : "插件配置"} · ${modes[view.policy.mode]} · ${scopes[view.policy.scope]}`}
        </p>
      )}
      {view && draft ? (
        <FunctionCompletionPolicyForm
          value={draft}
          source={view.source}
          environment={environment}
          environmentState={environmentState}
          environmentError={environmentError}
          onCheckEnvironment={() => void checkEnvironment()}
          disabled={busy || disabled}
          onChange={(value) => {
            dirty.current = true
            setDraft(value)
            setNotice("")
          }}
          onSave={() => void save()}
        />
      ) : (
        !error && <p>正在读取项目规则…</p>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
