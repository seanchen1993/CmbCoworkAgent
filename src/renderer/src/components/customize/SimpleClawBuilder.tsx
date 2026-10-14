import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClawProfile, ClawView } from "../../../../shared/mods/claw"
import type { FlowCatalog, SavedFlow } from "../../../../shared/mods/flows/types"
import type { ClawActionDescriptor } from "../../../../shared/mods/claw-actions"
import type { ModObject, ModCommandDescriptor } from "../../../../shared/mods/types"
import { resolveClawComponents } from "../../../../shared/mods/claw-components"
import { clawChangeSummary } from "../../../../shared/mods/claw-change-summary"
import { useAppStore } from "@/lib/store"
import { flowDraftId } from "@/lib/flow-draft-id"
import { parameterError, type ParameterDraft } from "@/lib/flow-parameter-form"
import {
  buildSimpleFlow,
  saveSimpleCombination,
  simpleConnections,
  simpleFormSupported,
  simpleProfileSupported,
  type SimpleSaveCheckpoint
} from "@/lib/simple-claw-builder"
import {
  sameSimpleAuthoringScope,
  type SimpleAuthoringPracticeIntent
} from "@/lib/simple-authoring-intent"
import { prepareSimpleAuthoringTask } from "@/lib/simple-authoring-composer"
import { openBuiltinNavigation } from "@/lib/builtin-navigation"
import { Button } from "@/components/ui/button"
import { SimpleActionParameters } from "./SimpleActionParameters"
import { ClawComponentSelector } from "./ClawComponentSelector"
import { FunctionUserConfig } from "./FunctionUserConfig"

const fieldClass = "w-full min-w-0 rounded-lg border bg-background p-2 text-sm"
const blankProfile = (): ClawProfile => ({
  id: flowDraftId("claw"),
  name: "我的文件检视助手",
  capabilities: []
})
const actionKey = (action: ClawActionDescriptor) => `${action.pluginId}:${action.actionId}`

export function SimpleClawBuilder({
  threadId,
  view,
  catalog,
  initialProfile,
  practiceIntent,
  onView,
  onAdvanced,
  onSources,
  externalBusy = false,
  beginMutation,
  endMutation
}: {
  threadId: string
  view: ClawView
  catalog: FlowCatalog
  initialProfile: ClawProfile
  practiceIntent?: SimpleAuthoringPracticeIntent
  onView(view: ClawView): void
  onAdvanced(): void
  onSources(): void
  externalBusy?: boolean
  beginMutation?(): boolean
  endMutation?(): void
}) {
  // Separate from the retained advanced editor: entering a tutorial cannot overwrite that draft.
  const [profile, setProfile] = useState(() => structuredClone(initialProfile))
  const originalFlow = initialProfile.flow?.definition
  const [mode, setMode] = useState<"together" | "sequence">(originalFlow ? "sequence" : "together")
  const [actionIds, setActionIds] = useState<string[]>(
    () =>
      originalFlow?.steps.map((step) =>
        step.kind === "plugin-action" ? `${step.pluginId}:${step.actionId}` : ""
      ) ?? ["", ""]
  )
  const [inputs, setInputs] = useState<ModObject[]>(
    () =>
      originalFlow?.steps.map((step) => (step.kind === "plugin-action" ? step.input : {})) ?? [
        {},
        {}
      ]
  )
  const [configs, setConfigs] = useState<ModObject[]>(
    () =>
      originalFlow?.steps.map((step) =>
        step.kind === "plugin-action" ? (step.config ?? {}) : {}
      ) ?? [{}, {}]
  )
  const [connection, setConnection] = useState<string | null>(() => {
    const step = originalFlow?.steps[1]
    return step?.kind === "plugin-action" ? (step.inputFrom?.path ?? "") : null
  })
  const [parameterDrafts, setParameterDrafts] = useState<Record<string, ParameterDraft>>({})
  const [invalidComponents, setInvalidComponents] = useState<Record<string, boolean>>({})
  const onValidity = useCallback(
    (id: string, valid: boolean) =>
      setInvalidComponents((old) => (old[id] === !valid ? old : { ...old, [id]: !valid })),
    []
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [preview, setPreview] = useState<{
    profile: ClawProfile
    revision: number
    bindingRevision: number
  } | null>(null)
  const [applied, setApplied] = useState<ClawProfile | null>(null)
  const [commands, setCommands] = useState<ModCommandDescriptor[]>([])
  const [dirty, setDirty] = useState(false)
  const [acceptedIntent, setAcceptedIntent] = useState<string>()
  const checkpoint = useRef<SimpleSaveCheckpoint | undefined>(undefined)
  const savedFlow = useRef<SavedFlow | undefined>(initialProfile.flow)
  const flowId = useRef(initialProfile.flow?.definition.id ?? flowDraftId("flow"))
  const alive = useRef(true)
  const lock = useRef(false)
  const currentView = useRef(view)
  currentView.current = view
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const scope = { threadId, workspace: view.workspace }
  const assertCurrent = () => {
    const store = useAppStore.getState()
    const workspace = store.threads.find((item) => item.thread_id === store.currentThreadId)
      ?.metadata?.workspacePath
    if (
      !alive.current ||
      !sameSimpleAuthoringScope(scope, {
        threadId: store.currentThreadId,
        workspace: typeof workspace === "string" ? workspace : null
      })
    )
      throw Error("对话或项目已切换，已停止旧操作；请回到原项目继续。")
    for (const capability of profile.capabilities) {
      const source = currentView.current.capabilities.find(
        (item) => item.pluginId === capability.pluginId
      )
      if (!source || source.state !== "ready" || source.digest !== capability.digest)
        throw Error("插件来源或授权已改变，请重新核对后继续。")
    }
  }
  const update = (next: ClawProfile) => {
    setProfile(next)
    setDirty(true)
    setPreview(null)
    setApplied(null)
  }
  const reset = (name?: string) => {
    setProfile({ ...blankProfile(), ...(name ? { name } : {}) })
    setMode("together")
    setActionIds(["", ""])
    setInputs([{}, {}])
    setConfigs([{}, {}])
    setConnection(null)
    setParameterDrafts({})
    setInvalidComponents({})
    checkpoint.current = undefined
    savedFlow.current = undefined
    flowId.current = flowDraftId("flow")
    setPreview(null)
    setApplied(null)
    setDirty(false)
    setError("")
  }
  const updateParameterDraft = (key: string, value: ParameterDraft) => {
    setParameterDrafts((old) => ({ ...old, [key]: value }))
    setDirty(true)
    setPreview(null)
    setApplied(null)
  }
  const pendingIntent =
    practiceIntent &&
    acceptedIntent !== practiceIntent.id &&
    sameSimpleAuthoringScope(practiceIntent.scope, scope)
      ? practiceIntent
      : undefined
  const supported = simpleProfileSupported(profile)
  const actions = useMemo(
    () =>
      (catalog.actions ?? []).filter((action) => {
        const capability = profile.capabilities.find(
          (item) => item.pluginId === action.pluginId && item.digest === action.digest
        )
        const source = view.capabilities.find((item) => item.pluginId === action.pluginId)
        if (!capability || !source) return false
        try {
          const selected = resolveClawComponents(source.components ?? [], capability.components)
          return (
            !source.components?.length ||
            selected.some((item) => item.actionIds.includes(action.actionId))
          )
        } catch {
          return false
        }
      }),
    [catalog.actions, profile.capabilities, view.capabilities]
  )
  const chosen = actionIds.map((id) => actions.find((action) => actionKey(action) === id))
  const connections = simpleConnections(chosen[0]?.outputSchema, chosen[1]?.inputSchema)
  const selectedConnection = connection ?? (connections.length === 1 ? connections[0].path : null)
  const issues: string[] = []
  if (profile.capabilities.length !== 2) issues.push("请选择两个插件。")
  for (const capability of profile.capabilities) {
    const source = view.capabilities.find((item) => item.pluginId === capability.pluginId)
    if (!source || source.state !== "ready" || source.digest !== capability.digest)
      issues.push(`${capability.name} 的版本或授权已变化，请重新核对来源。`)
    if (invalidComponents[capability.pluginId])
      issues.push(`${capability.name} 的功能配置尚未完成。`)
  }
  if (mode === "sequence") {
    if (!chosen[0] || !chosen[1]) issues.push("请选择每个插件要完成的操作。")
    else {
      if (chosen[0].pluginId === chosen[1].pluginId) issues.push("请选择分别来自两个插件的动作。")
      if (
        selectedConnection === null ||
        !connections.some((entry) => entry.path === selectedConnection)
      )
        issues.push(
          "第二步不能直接使用第一步的结果。请换一个操作，或到高级编辑中设置。"
        )
      chosen.forEach((action, index) => {
        if (!action) return
        if (!simpleFormSupported(action.inputSchema) || !simpleFormSupported(action.configSchema))
          issues.push(`${action.name} 含有复杂参数，请使用高级编辑。当前草稿会保留。`)
        const inputError = parameterError(
          inputs[index],
          action.inputSchema,
          parameterDrafts[`${index}:input`],
          index === 1 && selectedConnection !== null
        )
        const configError = parameterError(
          configs[index],
          action.configSchema,
          parameterDrafts[`${index}:config`]
        )
        if (inputError) issues.push(`步骤 ${index + 1}：${inputError}`)
        if (configError) issues.push(`步骤 ${index + 1}：${configError}`)
      })
    }
  }
  const disabled = busy || externalBusy || !view.applicable || !view.enabled
  const save = async () => {
    if (lock.current || externalBusy || issues.length || beginMutation?.() === false) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      const definition =
        mode === "sequence"
          ? buildSimpleFlow({
              id: flowId.current,
              name: profile.name,
              actions: chosen as [ClawActionDescriptor, ClawActionDescriptor],
              inputs: inputs as [ModObject, ModObject],
              configs: configs as [ModObject, ModObject],
              connection: selectedConnection!
            })
          : undefined
      const nextProfile = mode === "sequence" ? profile : { ...profile, flow: undefined }
      if (checkpoint.current?.profileSaved) {
        const savedProfile = checkpoint.current.flow
          ? { ...nextProfile, flow: checkpoint.current.flow }
          : nextProfile
        if (
          JSON.stringify(currentView.current.profiles.find((item) => item.id === profile.id)) !==
          JSON.stringify(savedProfile)
        )
          checkpoint.current = { ...checkpoint.current, profileSaved: false }
      }
      const result = await saveSimpleCombination({
        profile: nextProfile,
        definition,
        checkpoint: checkpoint.current,
        assertCurrent,
        onCheckpoint: (value) => {
          checkpoint.current = value
        },
        saveFlow: async (value) => {
          assertCurrent()
          const saved = await window.api.mods.flowSave(
            threadId,
            value,
            savedFlow.current?.revision ?? 0,
            view.workspace
          )
          savedFlow.current = saved
          return saved
        },
        saveProfile: async (value) => {
          assertCurrent()
          const next = await window.api.mods.clawChange(threadId, {
            kind: "save",
            profile: value,
            revision: currentView.current.revision,
            workspace: view.workspace
          })
          assertCurrent()
          currentView.current = next
          onView(next)
        }
      })
      assertCurrent()
      setPreview({
        profile: result,
        revision: currentView.current.revision,
        bindingRevision: currentView.current.bindingRevision
      })
      setDirty(false)
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      lock.current = false
      if (alive.current) {
        setBusy(false)
        endMutation?.()
      }
    }
  }
  const apply = async () => {
    if (!preview || lock.current || externalBusy || beginMutation?.() === false) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      assertCurrent()
      const next = await window.api.mods.clawChange(threadId, {
        kind: "apply",
        id: preview.profile.id,
        revision: preview.revision,
        bindingRevision: preview.bindingRevision,
        workspace: view.workspace
      })
      assertCurrent()
      onView(next)
      setApplied(next.active)
      setPreview(null)
      if (next.active && !next.active.flow) {
        const commands = await window.api.mods.commands(threadId).catch(() => [])
        assertCurrent()
        setCommands(
          commands.filter(
            (item) =>
              !item.isHidden &&
              next.active!.capabilities.some(
                (capability) => capability.pluginId === item.modId || capability.name === item.name
              )
          )
        )
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      lock.current = false
      if (alive.current) {
        setBusy(false)
        endMutation?.()
      }
    }
  }
  return (
    <section className="space-y-4 rounded-2xl border bg-card p-4" aria-label="简单组合">
      <h3 className="font-semibold">把两个插件搭配起来</h3>
      {pendingIntent && (
        <div className="space-y-2 rounded-lg border p-3" role="status">
          <p>演练已结束。现在选择你实际安装的两个插件；现有草稿仍保留。</p>
          <Button size="sm" onClick={() => setAcceptedIntent(pendingIntent.id)}>
            继续当前草稿
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (
                dirty &&
                !window.confirm("另建组合将替换此处的简单配置草稿。高级编辑草稿仍保留，继续吗？")
              )
                return
              reset(pendingIntent.suggestedName)
              setAcceptedIntent(pendingIntent.id)
            }}
          >
            另建演练中的组合
          </Button>
        </div>
      )}
      {!supported ? (
        <div className="space-y-3">
          <p>此组合包含更多设置，已完整保留。请用高级编辑修改，或另建一个简单组合。</p>
          <Button onClick={onAdvanced}>打开高级编辑</Button>
          <Button variant="ghost" onClick={() => reset()}>
            另建简单组合
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["together", "sequence"] as const).map((value) => (
              <button
                key={value}
                type="button"
                disabled={disabled}
                aria-pressed={mode === value}
                className={`rounded-xl border p-4 text-left ${mode === value ? "border-primary bg-primary/5" : ""}`}
                onClick={() => {
                  setMode(value)
                  setDirty(true)
                  setPreview(null)
                  setApplied(null)
                }}
              >
                <strong>{value === "together" ? "一起使用" : "先后执行"}</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  {value === "together"
                    ? "在同一段聊天里使用两个插件"
                    : "把第一个插件的结果交给第二个处理"}
                </p>
              </button>
            ))}
          </div>
          <label className="grid gap-1 text-sm">
            组合名称
            <input
              maxLength={80}
              className={fieldClass}
              value={profile.name}
              disabled={disabled}
              onChange={(event) => update({ ...profile, name: event.target.value })}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {view.capabilities.map((source) => {
              const capability = profile.capabilities.find(
                (item) => item.pluginId === source.pluginId
              )
              return (
                <div key={source.pluginId} className="min-w-0 space-y-2 rounded-xl border p-3">
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!capability}
                      disabled={
                        disabled ||
                        (!capability &&
                          (profile.capabilities.length >= 2 || source.state !== "ready"))
                      }
                      onChange={(event) => {
                        if (
                          !event.target.checked &&
                          !window.confirm(`移除 ${source.name} 及其简单配置草稿？`)
                        )
                          return
                        update({
                          ...profile,
                          capabilities: event.target.checked
                            ? [
                                ...profile.capabilities,
                                {
                                  pluginId: source.pluginId,
                                  name: source.name,
                                  digest: source.digest!
                                }
                              ]
                            : profile.capabilities.filter(
                                (item) => item.pluginId !== source.pluginId
                              ),
                          completionRules: event.target.checked
                            ? profile.completionRules
                            : profile.completionRules?.filter(
                                (rule) => rule.pluginId !== source.pluginId
                              )
                        })
                      }}
                    />
                    <strong className="break-all">{source.name}</strong>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {source.actions?.[0]?.description ??
                      (source.components?.map((item) => item.name).join("、") ||
                        "具体用法请查看插件说明")}
                  </p>
                  <p className="text-xs">
                    {source.state === "ready"
                      ? "已准备好"
                      : source.error || "需要先安装、启用或授权"}
                  </p>
                  {capability && source.components?.length ? (
                    <ClawComponentSelector
                      source={source}
                      value={capability}
                      disabled={disabled}
                      onValidity={onValidity}
                      onChange={(next) =>
                        update({
                          ...profile,
                          capabilities: profile.capabilities.map((item) =>
                            item.pluginId === next.pluginId ? next : item
                          )
                        })
                      }
                    />
                  ) : null}
                  {capability && !!source.userConfigFieldCount && (
                    <FunctionUserConfig
                      threadId={threadId}
                      pluginId={source.pluginId}
                      expectedWorkspace={view.workspace}
                    />
                  )}
                </div>
              )
            })}
          </div>
          {view.capabilities.filter((source) => source.state === "ready").length < 2 && (
            <div className="space-y-2 text-sm">
              <p>请先添加并授权两个插件，再回来选择组合。</p>
              <Button variant="outline" onClick={onSources}>
                去添加插件
              </Button>
            </div>
          )}
          {mode === "sequence" && (
            <div className="space-y-3" aria-label="两步流程">
              {[0, 1].map((index) => (
                <div key={index} className="space-y-3 rounded-xl border p-3">
                  <h4 className="font-medium">
                    {index === 0 ? "步骤一 · 准备输入" : "↓ 步骤二 · 接着处理"}
                  </h4>
                  <select
                    aria-label={`步骤${index + 1}动作`}
                    className={fieldClass}
                    disabled={disabled}
                    value={actionIds[index]}
                    onChange={(event) => {
                      if (
                        dirty &&
                        Object.keys(inputs[index]).length &&
                        !window.confirm("更换动作会清除此步骤的参数，继续吗？")
                      )
                        return
                      setActionIds((old) =>
                        old.map((value, i) => (i === index ? event.target.value : value))
                      )
                      setInputs((old) => old.map((value, i) => (i === index ? {} : value)))
                      setConfigs((old) => old.map((value, i) => (i === index ? {} : value)))
                      setParameterDrafts((old) =>
                        Object.fromEntries(
                          Object.entries(old).filter(([key]) => !key.startsWith(`${index}:`))
                        )
                      )
                      setConnection(null)
                      setDirty(true)
                      setPreview(null)
                      setApplied(null)
                    }}
                  >
                    <option value="">选择要执行的操作</option>
                    {actions.map((action) => (
                      <option key={actionKey(action)} value={actionKey(action)}>
                        {action.name}
                      </option>
                    ))}
                  </select>
                  {!actions.length && (
                    <p className="text-sm">
                      所选插件暂不支持在这里分步调用。可以改选“一起使用”；AutoBiz 的阶段任务请从项目模式中创建。
                    </p>
                  )}
                  {chosen[index] && (
                    <>
                      <p className="text-xs text-muted-foreground">{chosen[index]!.description}</p>
                      {index === 1 && (
                        <label className="grid gap-1 text-sm">
                          从步骤一取得
                          <select
                            aria-label="两步连接"
                            className={fieldClass}
                            disabled={disabled}
                            value={selectedConnection ?? "unconnected"}
                            onChange={(event) => {
                              setConnection(
                                event.target.value === "unconnected" ? null : event.target.value
                              )
                              setDirty(true)
                              setPreview(null)
                              setApplied(null)
                            }}
                          >
                            <option value="unconnected">请选择兼容的结果</option>
                            {connections.map((entry) => (
                              <option key={entry.path} value={entry.path}>
                                {entry.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {simpleFormSupported(chosen[index]!.inputSchema) &&
                        (index === 0 ||
                          selectedConnection === null ||
                          Object.keys(inputs[index]).length > 0) && (
                          <fieldset disabled={disabled}>
                            <SimpleActionParameters
                              title={`步骤${index + 1}输入`}
                              value={inputs[index]}
                              schema={chosen[index]!.inputSchema}
                              draft={parameterDrafts[`${index}:input`]}
                              onDraftChange={(value) =>
                                updateParameterDraft(`${index}:input`, value)
                              }
                              onChange={(value) => {
                                setInputs((old) =>
                                  old.map((item, i) => (i === index ? value : item))
                                )
                                setDirty(true)
                                setPreview(null)
                                setApplied(null)
                              }}
                            />
                          </fieldset>
                        )}
                      {index === 1 && selectedConnection !== null && (
                        <p className="text-sm text-primary">
                          第二步会使用第一步的结果，无需再次填写。
                        </p>
                      )}
                      {chosen[index]!.configSchema &&
                        simpleFormSupported(chosen[index]!.configSchema) && (
                          <details>
                            <summary className="cursor-pointer text-xs">
                              可选设置（默认沿用当前模型）
                            </summary>
                            <fieldset disabled={disabled}>
                              <SimpleActionParameters
                                title={`步骤${index + 1}设置`}
                                value={configs[index]}
                                schema={chosen[index]!.configSchema}
                                draft={parameterDrafts[`${index}:config`]}
                                onDraftChange={(value) =>
                                  updateParameterDraft(`${index}:config`, value)
                                }
                                onChange={(value) => {
                                  setConfigs((old) =>
                                    old.map((item, i) => (i === index ? value : item))
                                  )
                                  setDirty(true)
                                  setPreview(null)
                                  setApplied(null)
                                }}
                              />
                            </fieldset>
                          </details>
                        )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {issues.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}{" "}
              {checkpoint.current?.flow ? "流程已保存，再次点击会继续保存组合。" : "草稿已保留。"}
            </p>
          )}
          {!preview && !applied && (
            <Button
              disabled={disabled || !profile.name.trim() || !!issues.length}
              onClick={() => void save()}
            >
              {busy ? "正在保存…" : "保存并核对应用"}
            </Button>
          )}
          {preview && (
            <section
              className="space-y-3 rounded-xl border border-primary/30 p-4"
              aria-label="简单组合应用预览"
            >
              <h4 className="font-medium">核对后应用：{preview.profile.name}</h4>
              <ul className="text-sm">
                {clawChangeSummary(view.active, preview.profile).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="text-xs">只更换当前聊天的配置，接下来还会让你准备首次任务。</p>
              {(preview.revision !== view.revision ||
                preview.bindingRevision !== view.bindingRevision) && (
                <p role="alert">配置已变化，请取消预览后重新核对。</p>
              )}
              <Button
                disabled={
                  disabled ||
                  issues.length > 0 ||
                  preview.revision !== view.revision ||
                  preview.bindingRevision !== view.bindingRevision
                }
                onClick={() => void apply()}
              >
                确认应用
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
                取消
              </Button>
            </section>
          )}
          {applied && (
            <section
              className="space-y-3 rounded-xl border border-primary/30 p-4"
              aria-label="组合首次使用"
            >
              <h4 className="font-medium">已应用 · 现在怎么用</h4>
              <p className="text-sm">
                {applied.flow
                  ? "已准备两步流程。回聊天填写本次检视目标，再发送任务。"
                  : "回到当前聊天，输入你希望这两个插件完成的任务。命令和界面仍按各插件原入口使用。"}
              </p>
              <Button
                onClick={() => {
                  try {
                    assertCurrent()
                    prepareSimpleAuthoringTask({
                      id: flowDraftId("claw"),
                      scope,
                      profileId: applied.id,
                      flow: applied.flow,
                      suggestedText: applied.flow ? "检查这个文件是否存在问题，并说明依据。" : ""
                    })
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause))
                  }
                }}
              >
                准备首次任务
              </Button>
              {!applied.flow &&
                commands.map((command) => (
                  <Button
                    key={`${command.modId}:${command.command}`}
                    variant="outline"
                    onClick={() => {
                      try {
                        assertCurrent()
                        prepareSimpleAuthoringTask({
                          id: flowDraftId("claw"),
                          scope,
                          profileId: applied.id,
                          kind: "command",
                          suggestedText:
                            command.apiVersion === "cmb.mods/v2"
                              ? `/${command.command} `
                              : `/mod ${command.command} `
                        })
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : String(cause))
                      }
                    }}
                  >
                    填入{" "}
                    {command.apiVersion === "cmb.mods/v2"
                      ? `/${command.command}`
                      : `/mod ${command.command}`}
                  </Button>
                ))}
              {!applied.flow && (
                <Button variant="ghost" onClick={() => openBuiltinNavigation("runs", scope)}>
                  打开运行过程与插件面板
                </Button>
              )}
            </section>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        需要调整技能、工具、模型或检查规则时，可展开下方高级编辑。两个编辑区的草稿分别保留。
      </p>
    </section>
  )
}
