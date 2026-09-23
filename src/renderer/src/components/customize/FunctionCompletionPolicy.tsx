import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  COMPLETION_CHECKS,
  COMPLETION_MODES,
  COMPLETION_SCOPES,
  type CompletionPolicy,
  type CompletionPolicyView
} from "../../../../shared/mods/v2/completion-policy-values"

const modes = { off: "关闭", report: "仅报告", check: "阻止完成", repair: "自动修复并复检" }
const scopes = { file: "当前文件", diff: "当前 diff", feature: "Feature", project: "整个项目" }
const checks = {
  "code-review": "代码评审",
  "unit-test": "单元测试",
  e2e: "E2E",
  "autobiz-validator": "Autobiz validator"
}
const field = "rounded border bg-background px-2 py-1 text-sm min-w-0"

export function FunctionCompletionPolicyForm({
  value,
  source,
  disabled,
  onChange,
  onSave
}: {
  value: CompletionPolicy
  source: CompletionPolicyView["source"]
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
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <p className="text-xs text-muted-foreground">
        {source === "application"
          ? "由应用保存，插件不能覆盖或删除此规则。"
          : "保存前沿用插件行为；保存后由应用控制此项目的规则。"}
      </p>
      <fieldset disabled={disabled} className="space-y-3">
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
        </div>
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1">执行检查</legend>
          {COMPLETION_CHECKS.map((kind) => (
            <label key={kind} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={value.checks.includes(kind)}
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
        {stageAvailable && (
          <label className="grid gap-1">
            自动推进阶段起点
            <input
              aria-label="自动推进阶段起点"
              className={field}
              value={value.autobizStartCheckpoint ?? ""}
              maxLength={128}
              pattern="[A-Za-z0-9][A-Za-z0-9_.\\-]{0,127}"
              placeholder="requirements_eval_in_progress"
              onChange={(e) => change({ autobizStartCheckpoint: e.target.value || undefined })}
              aria-describedby={stageHelpId}
            />
            <span id={stageHelpId} className="text-xs text-muted-foreground">
              留空只检查，不推进。填写后须指定 Feature ID；固定版本 workflow compiler 推导终点。
              全部检查通过且证据未变化，再按原权限审批推进。到达终点后只复检本阶段。
            </span>
          </label>
        )}
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
        <p className="text-xs text-muted-foreground">
          代码评审需要插件提供评审处理器；测试与 Autobiz validator
          由宿主执行。缺少检查能力会明确报告失败。
          关闭后移除此插件的完成门禁；其他插件的规则仍分别生效。
        </p>
        <Button type="submit" size="sm">
          保存项目规则
        </Button>
      </fieldset>
    </form>
  )
}

export function FunctionCompletionPolicy({
  threadId,
  plugin,
  disabled
}: {
  threadId: string
  plugin: string
  disabled: boolean
}): React.JSX.Element {
  const [view, setView] = useState<CompletionPolicyView>()
  const [draft, setDraft] = useState<CompletionPolicy>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const dirty = useRef(false)
  useEffect(() => {
    let live = true
    dirty.current = false
    setView(undefined)
    setDraft(undefined)
    setError("")
    setNotice("")
    const load = async () => {
      try {
        const current = await window.api.mods.completionPolicy(threadId, plugin)
        if (!live) return
        setView(current)
        if (!dirty.current) setDraft(current.policy)
      } catch (cause) {
        if (live) setError(String(cause))
      }
    }
    void load()
    const stop = window.api.mods.onConfigurationChanged(() => void load())
    return () => {
      live = false
      stop()
    }
  }, [threadId, plugin])
  const save = async () => {
    if (!draft || busy || disabled) return
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const current = await window.api.mods.setCompletionPolicy(threadId, plugin, draft)
      dirty.current = false
      setView(current)
      setDraft(current.policy)
      setNotice("规则已按项目保存，重启后继续生效。旧版本检查证据将重新核验。")
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details data-completion-policy={plugin} className="border-t pt-2">
      <summary className="cursor-pointer">完成检查规则</summary>
      <div className="mt-2 space-y-2">
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
    </details>
  )
}
