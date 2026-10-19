import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClawProfile, ClawView } from "../../../../shared/mods/claw"
import type { FlowCatalog, SavedFlow } from "../../../../shared/mods/flows/types"
import type { ClawActionDescriptor } from "../../../../shared/mods/claw-actions"
import type { ModObject, ModCommandDescriptor } from "../../../../shared/mods/types"
import { resolveClawComponents } from "../../../../shared/mods/claw-components"
import { clawChangeSummary } from "../../../../shared/mods/claw-change-summary"
import {
  isConfigurationScopeCurrent,
  useConfigurationDraft,
  goToConfigurationThread
} from "@/lib/configuration-target"
import { flowDraftId } from "@/lib/flow-draft-id"
import { parameterError, type ParameterDraft } from "@/lib/flow-parameter-form"
import {
  createSimpleClawDraft,
  markSimpleDraftSaved,
  simpleDraftDefinition,
  simpleFlowSupported,
  removeSimpleStep,
  saveSimpleCombination,
  simpleConnections,
  simpleFormSupported,
  type SimpleClawDraft,
  type SimpleSaveCheckpoint
} from "@/lib/simple-claw-builder"
import {
  sameSimpleAuthoringScope,
  type SimpleAuthoringPracticeIntent
} from "@/lib/simple-authoring-intent"
import { prepareSimpleAuthoringTask } from "@/lib/simple-authoring-composer"
import { requestChatFlowUse, requestChatComposerFocus } from "@/lib/chat-flow-use"
import { openBuiltinNavigation } from "@/lib/builtin-navigation"
import { Button } from "@/components/ui/button"
import { SimpleActionParameters } from "./SimpleActionParameters"
import { ClawComponentSelector } from "./ClawComponentSelector"
import { FunctionUserConfig } from "./FunctionUserConfig"
import { hasUsableClawComponents, newClawCapability } from "@/lib/claw-capability-usage"

const fieldClass = "devclaw-input w-full min-w-0 text-sm"
const selectClass = "devclaw-select w-full min-w-0 text-sm"
const blankProfile = (): ClawProfile => ({
  id: flowDraftId("claw"),
  name: "我的常用搭配",
  capabilities: []
})
const actionKey = (action: ClawActionDescriptor) => `${action.pluginId}:${action.actionId}`

export function SimpleClawBuilder({
  threadId,
  view,
  catalog,
  initialProfile,
  editor,
  onEditor,
  practiceIntent,
  onView,
  onAdvanced,
  onSources,
  onAssemble,
  externalBusy = false,
  beginMutation,
  endMutation
}: {
  threadId: string
  view: ClawView
  catalog: FlowCatalog
  initialProfile?: ClawProfile
  editor?: SimpleClawDraft
  onEditor?(value: SimpleClawDraft, saved?: boolean): void
  practiceIntent?: SimpleAuthoringPracticeIntent
  onView(view: ClawView): void
  onAdvanced(): boolean | void
  onSources(): void
  onAssemble?(): void
  externalBusy?: boolean
  beginMutation?(): boolean
  endMutation?(): void
}) {
  const usageContext = view.usageContext ?? "chat"
  // Both views edit this document; the fallback supports a standalone builder.
  const [localEditor, setLocalEditor] = useState(() =>
    createSimpleClawDraft(initialProfile ?? blankProfile(), flowDraftId("flow"))
  )
  const draft = editor ?? localEditor
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const commit = (next: SimpleClawDraft, saved = false) => {
    latestDraft.current = next
    if (onEditor) onEditor(next, saved)
    else setLocalEditor(next)
  }
  const mutateDraft = (update: (old: SimpleClawDraft) => SimpleClawDraft, resetFlowText = true) => {
    commit({
      ...update(latestDraft.current),
      ...(resetFlowText ? { flowText: undefined, flowTextError: undefined } : {})
    })
    setDirty(true)
    setPreview(null)
    setApplied(null)
  }
  const { profile, mode, steps, parameterDrafts } = draft
  const actionIds = steps.map((step) => step.action)
  const inputs = steps.map((step) => step.input)
  const configs = steps.map((step) => step.config)
  const setProfile = (value: ClawProfile) =>
    mutateDraft((old) => ({ ...old, profile: value }), false)
  const setMode = (value: "together" | "sequence") =>
    mutateDraft((old) => ({ ...old, mode: value }))
  const setInputs = (update: (old: ModObject[]) => ModObject[]) =>
    mutateDraft((old) => {
      const next = update(old.steps.map((step) => step.input))
      return { ...old, steps: old.steps.map((step, index) => ({ ...step, input: next[index] })) }
    })
  const setConfigs = (update: (old: ModObject[]) => ModObject[]) =>
    mutateDraft((old) => {
      const next = update(old.steps.map((step) => step.config))
      return { ...old, steps: old.steps.map((step, index) => ({ ...step, config: next[index] })) }
    })
  const setParameterDrafts = (
    update: (old: Record<string, ParameterDraft>) => Record<string, ParameterDraft>
  ) => mutateDraft((old) => ({ ...old, parameterDrafts: update(old.parameterDrafts) }))
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
    usageContext: "chat" | "project"
  } | null>(null)
  const [applied, setApplied] = useState<ClawProfile | null>(null)
  const [commands, setCommands] = useState<ModCommandDescriptor[]>([])
  const [dirty, setDirty] = useState(false)
  const [acceptedIntent, setAcceptedIntent] = useState<string>()
  const checkpoint = useRef<SimpleSaveCheckpoint | undefined>(draft.checkpoint)
  checkpoint.current = draft.checkpoint
  const ownSavedProfile = useRef<ClawProfile | undefined>(undefined)
  const savedFlow = useRef<SavedFlow | undefined>(
    draft.checkpoint?.flow ?? draft.savedFlow ?? profile.flow
  )
  useEffect(() => {
    const acknowledged = draft.checkpoint?.flow ?? draft.savedFlow
    savedFlow.current =
      acknowledged &&
      (!profile.flow ||
        (acknowledged.definition.id === profile.flow.definition.id &&
          acknowledged.revision > profile.flow.revision))
        ? acknowledged
        : profile.flow
  }, [profile.id, profile.flow, draft.checkpoint?.flow, draft.savedFlow])
  useEffect(() => {
    if (!lock.current && profile !== ownSavedProfile.current) {
      setPreview(null)
      setApplied(null)
    }
  }, [profile])
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
  useConfigurationDraft(
    scope,
    (!editor && dirty) ||
      Object.values(parameterDrafts).some((item) => item.dirty) ||
      Object.values(draft.componentDrafts).some((values) =>
        Object.values(values).some((item) => item.dirty)
      ),
    busy
  )
  const assertCurrent = () => {
    if ((currentView.current.usageContext ?? "chat") !== usageContext)
      throw Error("使用场景已变化，请重新核对组合。")
    if (!alive.current || !isConfigurationScopeCurrent(scope))
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
    commit(
      createSimpleClawDraft({ ...blankProfile(), ...(name ? { name } : {}) }, flowDraftId("flow"))
    )
    setInvalidComponents({})
    checkpoint.current = undefined
    savedFlow.current = undefined
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
  const supported = simpleFlowSupported(draft.baseDefinition) && !draft.flowTextError
  const actions = useMemo(
    () =>
      (catalog.actions ?? []).filter((action) => {
        const capability = profile.capabilities.find(
          (item) => item.pluginId === action.pluginId && item.digest === action.digest
        )
        const source = view.capabilities.find((item) => item.pluginId === action.pluginId)
        if (!capability || !source) return false
        try {
          const selected = resolveClawComponents(
            source.components ?? [],
            capability.components,
            usageContext
          )
          return (
            !source.components?.length ||
            selected.some((item) => item.actionIds.includes(action.actionId))
          )
        } catch {
          return false
        }
      }),
    [catalog.actions, profile.capabilities, view.capabilities, usageContext]
  )
  const chosen = actionIds.map((id, index) =>
    actions.find(
      (action) =>
        actionKey(action) === id &&
        (!steps[index].digest || action.digest === steps[index].digest) &&
        (!steps[index].plugin || action.plugin === steps[index].plugin)
    )
  )
  const issues: string[] = []
  if (!profile.capabilities.length) issues.push("请至少选择一个功能。")
  for (const capability of profile.capabilities) {
    const source = view.capabilities.find((item) => item.pluginId === capability.pluginId)
    if (!source || source.state !== "ready" || source.digest !== capability.digest)
      issues.push(`${capability.name} 的版本或授权已变化，请重新核对来源。`)
    if (invalidComponents[capability.pluginId])
      issues.push(`${capability.name} 的功能配置尚未完成。`)
  }
  if (mode === "sequence" && supported) {
    chosen.forEach((action, index) => {
      if (!action) {
        issues.push(`步骤 ${index + 1}：请选择要执行的操作。`)
        return
      }
      const binding = steps[index].inputFrom
      if (binding) {
        const source = steps.findIndex((step) => step.id === binding.stepId)
        if (
          source < 0 ||
          source >= index ||
          !simpleConnections(chosen[source]?.outputSchema, action.inputSchema).some(
            (entry) => entry.path === binding.path
          )
        )
          issues.push(`步骤 ${index + 1} 的前置结果已失效，请重新选择输入来源。`)
      }
      if (!simpleFormSupported(action.inputSchema) || !simpleFormSupported(action.configSchema))
        issues.push(`${action.name} 含有复杂参数，请使用高级编辑。当前草稿会保留。`)
      const inputError = parameterError(
        inputs[index],
        action.inputSchema,
        parameterDrafts[`${steps[index].id}:input`],
        !!binding
      )
      const configError = parameterError(
        configs[index],
        action.configSchema,
        parameterDrafts[`${steps[index].id}:config`]
      )
      if (inputError) issues.push(`步骤 ${index + 1}：${inputError}`)
      if (configError) issues.push(`步骤 ${index + 1}：${configError}`)
    })
  }
  const disabled = busy || externalBusy || !view.applicable || !view.enabled
  const currentDefinition = () => simpleDraftDefinition(latestDraft.current, actions)
  const saveDraftFlow = async (definition: NonNullable<ReturnType<typeof currentDefinition>>) => {
    assertCurrent()
    if (
      savedFlow.current &&
      JSON.stringify(savedFlow.current.definition) === JSON.stringify(definition)
    )
      return savedFlow.current
    const saved = await window.api.mods.flowSave(
      threadId,
      definition,
      savedFlow.current?.definition.id === definition.id ? savedFlow.current.revision : 0,
      view.workspace
    )
    savedFlow.current = saved
    return saved
  }
  const continueInAdvanced = () => {
    if (!busy && !externalBusy) onAdvanced()
  }
  const save = async () => {
    if (lock.current || externalBusy || issues.length || beginMutation?.() === false) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      const definition = currentDefinition()
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
          commit({
            ...latestDraft.current,
            checkpoint: value,
            savedFlow: value.flow ?? latestDraft.current.savedFlow
          })
        },
        saveFlow: saveDraftFlow,
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
        bindingRevision: currentView.current.bindingRevision,
        usageContext
      })
      ownSavedProfile.current = result
      commit(markSimpleDraftSaved(latestDraft.current, result), true)
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
      <h3 className="font-semibold">配置常用搭配</h3>
      <p className="text-sm text-muted-foreground">
        这里只列当前聊天可用的功能扩展、工具和已导出的动作。AutoBiz 的需求、设计、开发等业务步骤在项目中运行。
      </p>
      {onAssemble && (
        <Button variant="outline" size="sm" onClick={onAssemble} disabled={disabled}>
          组合业务 Mods 或自己的界面扩展
        </Button>
      )}
      {pendingIntent && (
        <div className="space-y-2 rounded-lg border p-3" role="status">
          <p>演练已结束。现在选择实际安装的功能；当前草稿已保留。</p>
          <Button size="sm" onClick={() => setAcceptedIntent(pendingIntent.id)}>
            继续当前草稿
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (dirty && !window.confirm("另建搭配将替换当前未保存草稿，继续吗？")) return
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
          <p>执行步骤包含高级设置，原始定义和未完成编辑已完整保留。请在高级编辑中继续。</p>
          <Button onClick={() => onAdvanced()}>打开高级编辑</Button>
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
                className={`rounded-xl border p-4 text-left ${mode === value ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
                onClick={() => {
                  setMode(value)
                  setDirty(true)
                  setPreview(null)
                  setApplied(null)
                }}
              >
                <span aria-hidden="true" className="mr-2">
                  {mode === value ? "◉" : "○"}
                </span>
                <strong>{value === "together" ? "一起使用" : "先后执行"}</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  {value === "together"
                    ? "在这段聊天里使用所选功能"
                    : actions.length ? `已选功能提供 ${actions.length} 个动作，可按顺序执行并传递结果` : "选择提供动作的插件后，按顺序执行并传递结果"}
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
            {view.capabilities
              .filter(
                (source) =>
                  hasUsableClawComponents(source, usageContext) ||
                  profile.capabilities.some((item) => item.pluginId === source.pluginId)
              )
              .map((source) => {
                const capability = profile.capabilities.find(
                  (item) => item.pluginId === source.pluginId
                )
                return (
                  <div key={source.pluginId} className="min-w-0 space-y-2 rounded-xl border p-3">
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!capability}
                        disabled={disabled || (!capability && source.state !== "ready")}
                        onChange={(event) => {
                          if (
                            !event.target.checked &&
                            !window.confirm(`移除 ${source.name} 及其简单配置草稿？`)
                          )
                            return
                          update({
                            ...profile,
                            capabilities: event.target.checked
                              ? [...profile.capabilities, newClawCapability(source, usageContext)]
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
                    <p className="text-xs text-muted-foreground">
                      {source.actions?.length
                        ? `支持先后执行 · ${source.actions.length} 个动作`
                        : "当前提供对话或界面功能；未导出可编排动作"}
                    </p>
                    {capability && source.components?.length ? (
                      <ClawComponentSelector
                        source={source}
                        usageContext={usageContext}
                        value={capability}
                        disabled={disabled}
                        onValidity={onValidity}
                        drafts={draft.componentDrafts[source.pluginId] ?? {}}
                        onDraftsChange={(value) =>
                          mutateDraft(
                            (old) => ({
                              ...old,
                              componentDrafts: { ...old.componentDrafts, [source.pluginId]: value }
                            }),
                            false
                          )
                        }
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
          {view.capabilities.filter(
            (source) => source.state === "ready" && hasUsableClawComponents(source, usageContext)
          ).length === 0 && (
            <div className="space-y-2 text-sm">
              <p>暂无适用功能，请添加并确认权限后再配置。</p>
              <Button variant="outline" onClick={onSources}>
                去添加插件
              </Button>
            </div>
          )}
          {mode === "sequence" && (
            <div className="space-y-3" aria-label="执行步骤配置">
              {steps.map((step, index) => {
                const connectionOptions = steps.slice(0, index).flatMap((source, sourceIndex) =>
                  simpleConnections(
                    chosen[sourceIndex]?.outputSchema,
                    chosen[index]?.inputSchema
                  ).map((entry) => ({
                    value: JSON.stringify([source.id, entry.path]),
                    label: `步骤 ${sourceIndex + 1} · ${entry.label}`,
                    binding: { stepId: source.id, path: entry.path }
                  }))
                )
                return (
                  <div key={step.id} className="space-y-3 rounded-xl border p-3">
                    <h4 className="font-medium">步骤 {index + 1}</h4>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`移除步骤 ${index + 1}`}
                      disabled={disabled || steps.length === 1}
                      onClick={() => {
                        if (!window.confirm("移除此步骤？引用它的后续步骤将改为自行填写输入。"))
                          return
                        mutateDraft((old) => removeSimpleStep(old, step.id))
                      }}
                    >
                      移除
                    </Button>
                    <select
                      aria-label={`步骤${index + 1}动作`}
                      className={selectClass}
                      disabled={disabled}
                      value={actionIds[index]}
                      onChange={(event) => {
                        if (
                          dirty &&
                          Object.keys(inputs[index]).length &&
                          !window.confirm("更换动作会清除此步骤的参数，继续吗？")
                        )
                          return
                        const value = event.target.value
                        const selectedAction = actions.find((entry) => actionKey(entry) === value)
                        mutateDraft((old) => ({
                          ...old,
                          steps: old.steps.map((entry) =>
                            entry.id === step.id
                              ? {
                                  ...entry,
                                  action: value,
                                  digest: selectedAction?.digest,
                                  plugin: selectedAction?.plugin,
                                  input: {},
                                  config: {},
                                  inputFrom: undefined
                                }
                              : entry.inputFrom?.stepId === step.id
                                ? { ...entry, inputFrom: undefined }
                                : entry
                          ),
                          parameterDrafts: Object.fromEntries(
                            Object.entries(old.parameterDrafts).filter(
                              ([key]) => !key.startsWith(`${step.id}:`)
                            )
                          )
                        }))
                        setDirty(true)
                        setPreview(null)
                        setApplied(null)
                      }}
                    >
                      <option value="">选择要执行的操作</option>
                      {step.action && !chosen[index] && (
                        <option value={step.action}>原操作不可用，请重新选择</option>
                      )}
                      {actions.map((action) => (
                        <option key={actionKey(action)} value={actionKey(action)}>
                          {action.name}
                        </option>
                      ))}
                    </select>
                    {!actions.length && (
                      <p className="text-sm">
                        请勾选提供动作的插件，例如 AutoBiz 的“收集交付证据”和“生成交付报告”，再选择要执行的操作。
                      </p>
                    )}
                    {chosen[index] && (
                      <>
                        <p className="text-xs text-muted-foreground">
                          {chosen[index]!.description}
                        </p>
                        {index > 0 && (
                          <label className="grid gap-1 text-sm">
                            输入来源
                            <select
                              aria-label={`步骤${index + 1}输入来源`}
                              className={selectClass}
                              disabled={disabled}
                              value={
                                step.inputFrom
                                  ? JSON.stringify([step.inputFrom.stepId, step.inputFrom.path])
                                  : "manual"
                              }
                              onChange={(event) => {
                                const binding = connectionOptions.find(
                                  (entry) => entry.value === event.target.value
                                )?.binding
                                mutateDraft((old) => ({
                                  ...old,
                                  steps: old.steps.map((entry) =>
                                    entry.id === step.id ? { ...entry, inputFrom: binding } : entry
                                  )
                                }))
                              }}
                            >
                              <option value="manual">自行填写输入</option>
                              {step.inputFrom &&
                                !connectionOptions.some(
                                  (entry) =>
                                    entry.value ===
                                    JSON.stringify([step.inputFrom!.stepId, step.inputFrom!.path])
                                ) && (
                                  <option
                                    value={JSON.stringify([
                                      step.inputFrom.stepId,
                                      step.inputFrom.path
                                    ])}
                                  >
                                    原连接已失效，请重新选择
                                  </option>
                                )}
                              {connectionOptions.map((entry) => (
                                <option key={entry.value} value={entry.value}>
                                  {entry.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {simpleFormSupported(chosen[index]!.inputSchema) && !step.inputFrom && (
                          <fieldset disabled={disabled}>
                            <SimpleActionParameters
                              title={`步骤${index + 1}输入`}
                              value={inputs[index]}
                              schema={chosen[index]!.inputSchema}
                              draft={parameterDrafts[`${step.id}:input`]}
                              allowMissing={!!step.inputFrom}
                              onDraftChange={(value) =>
                                updateParameterDraft(`${step.id}:input`, value)
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
                        {step.inputFrom && (
                          <div className="space-y-2">
                            <p className="text-sm text-primary">
                              先使用前置步骤的实际结果；下方固定值会覆盖同名字段。
                            </p>
                            <details
                              open={
                                Object.keys(inputs[index]).length > 0 ||
                                !!parameterDrafts[`${step.id}:input`]?.dirty
                              }
                            >
                              <summary className="cursor-pointer text-sm font-medium">
                                固定覆盖值（可选，{Object.keys(inputs[index]).length} 项）
                              </summary>
                              <p className="my-2 text-sm text-muted-foreground">
                                仅勾选需要固定的字段。未设置的字段沿用前置结果；已填写的字段优先使用这里的值。
                              </p>
                              {simpleFormSupported(chosen[index]!.inputSchema) ? (
                                <fieldset disabled={disabled}>
                                  <SimpleActionParameters
                                    title={`步骤${index + 1}输入`}
                                    value={inputs[index]}
                                    schema={chosen[index]!.inputSchema}
                                    draft={parameterDrafts[`${step.id}:input`]}
                                    allowMissing={!!step.inputFrom}
                                    onDraftChange={(value) =>
                                      updateParameterDraft(`${step.id}:input`, value)
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
                              ) : (
                                <p className="text-sm">
                                  此输入含有复杂结构，请在高级编辑中查看或修改固定值。
                                </p>
                              )}
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={
                                  disabled ||
                                  (!Object.keys(inputs[index]).length &&
                                    !parameterDrafts[`${step.id}:input`]?.dirty)
                                }
                                onClick={() => {
                                  if (
                                    !window.confirm(
                                      "清除本步骤的固定覆盖值及未完成输入？之后将完整沿用前置结果。"
                                    )
                                  )
                                    return
                                  mutateDraft((old) => ({
                                    ...old,
                                    steps: old.steps.map((entry) =>
                                      entry.id === step.id ? { ...entry, input: {} } : entry
                                    ),
                                    parameterDrafts: Object.fromEntries(
                                      Object.entries(old.parameterDrafts).filter(
                                        ([key]) => key !== `${step.id}:input`
                                      )
                                    )
                                  }))
                                }}
                              >
                                清除固定覆盖值
                              </Button>
                            </details>
                          </div>
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
                                  draft={parameterDrafts[`${step.id}:config`]}
                                  onDraftChange={(value) =>
                                    updateParameterDraft(`${step.id}:config`, value)
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
                )
              })}
              <Button
                type="button"
                variant="outline"
                disabled={disabled || steps.length >= 32}
                onClick={() =>
                  mutateDraft((old) => ({
                    ...old,
                    steps: [
                      ...old.steps,
                      { id: flowDraftId("step"), action: "", input: {}, config: {} }
                    ]
                  }))
                }
              >
                添加步骤
              </Button>
              {steps.length >= 32 && (
                <p className="text-xs text-muted-foreground">最多配置 32 个步骤。</p>
              )}
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
              {checkpoint.current?.flow
                ? "执行步骤已保存，再次保存将继续完成搭配。"
                : "草稿已保留。"}
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
              <p className="text-xs">
                只更换所选聊天的配置。应用后可直接进入聊天，由你输入并发送任务。
              </p>
              {(preview.revision !== view.revision ||
                preview.bindingRevision !== view.bindingRevision ||
                preview.usageContext !== usageContext) && (
                <p role="alert">配置已变化，请取消预览后重新核对。</p>
              )}
              <Button
                disabled={
                  disabled ||
                  issues.length > 0 ||
                  preview.revision !== view.revision ||
                  preview.bindingRevision !== view.bindingRevision ||
                  preview.usageContext !== usageContext
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
              <h4 className="font-medium">已用于所选聊天</h4>
              <p className="text-sm">
                {applied.flow
                  ? "进入聊天后，本次使用所选执行步骤；填写任务后再发送。"
                  : "进入所选聊天后输入任务。命令和界面仍按各功能原入口使用。"}
              </p>
              <Button
                onClick={() => {
                  try {
                    assertCurrent()
                    if (applied.flow) {
                      goToConfigurationThread(scope, () =>
                        requestChatFlowUse({
                          threadId,
                          workspace: view.workspace,
                          id: applied.flow!.definition.id,
                          revision: applied.flow!.revision,
                          name: applied.flow!.definition.name,
                          bindingRevision: currentView.current.bindingRevision
                        })
                      )
                    } else
                      goToConfigurationThread(scope, () =>
                        requestChatComposerFocus({ threadId, workspace: view.workspace })
                      )
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause))
                  }
                }}
              >
                去这段聊天使用
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
                  查看插件记录
                </Button>
              )}
            </section>
          )}
        </>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy || externalBusy}
        onClick={continueInAdvanced}
      >
        在高级编辑中继续此草稿
      </Button>
      <p className="text-xs text-muted-foreground">
        简单与高级共用此份草稿。切换不会保存、应用或开始任务，未完成的参数仍会保留。
      </p>
    </section>
  )
}
