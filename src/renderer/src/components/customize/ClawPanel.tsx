import type { FlowCatalog, SavedFlow } from "../../../../shared/mods/flows/types"
import { flowDraftId } from "@/lib/flow-draft-id"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, Plus, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { isThreadDeletionPending, isThreadRetired, useAppStore } from "@/lib/store"
import { ClawEditorDrafts, type ClawEditorScope } from "@/lib/claw-editor-drafts"
import type {
  ClawMutation,
  ClawProfile,
  ClawSourceCatalog,
  ClawView
} from "../../../../shared/mods/claw"
import { ClawSourceSelector } from "./ClawSourceSelector"
import { clawSourceSummary } from "@/lib/claw-source-summary"
import { clawChangeSummary } from "../../../../shared/mods/claw-change-summary"
import { moveClawCapability } from "../../../../shared/mods/claw-order"
import { planClawUpgrade } from "../../../../shared/mods/claw-upgrade"
import { parameterError } from "@/lib/flow-parameter-form"
import { ClawCompletionRules } from "./ClawCompletionRules"
import { ClawComponentSelector } from "./ClawComponentSelector"
import { FunctionUserConfig } from "./FunctionUserConfig"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { createSimpleClawDraft, markSimpleDraftSaved, updateSimpleClawProfile, simpleDraftDefinition, editSimpleFlowText, saveSimpleCombination, type SimpleClawDraft } from "@/lib/simple-claw-builder"
import { requestChatFlowUse, requestChatComposerFocus } from "@/lib/chat-flow-use"
import { SimpleClawBuilder } from "./SimpleClawBuilder"
import { NativePluginCapabilities } from "./NativePluginCapabilities"
import { BusinessModAssemblyPanel } from "./BusinessModAssemblyPanel"
import { hasUsableClawComponents, newClawCapability } from "@/lib/claw-capability-usage"
import type { SimpleAuthoringPracticeIntent } from "@/lib/simple-authoring-intent"
import { goToConfigurationThread, useConfigurationDraft } from "@/lib/configuration-target"
import { ModsUsageSetup } from "./ModsUsageSetup"
import { ModsUsageSettingsEntry } from "./ModsUsageSettingsEntry"

const empty = (): ClawProfile => ({
  id: flowDraftId("claw"),
  name: "我的研发助手",
  capabilities: []
})

const editorDrafts = new ClawEditorDrafts()
function synchronizeEditorDrafts() {
  const state = useAppStore.getState()
  let workspaces: Map<string, string | null> | undefined
  editorDrafts.synchronize(state.accountRevision, (threadId) => {
    if (isThreadRetired(threadId)) return null
    workspaces ??= new Map(state.threads.map((thread) => [thread.thread_id,
      (thread.metadata as { workspacePath?: string } | undefined)?.workspacePath ?? null]))
    return workspaces.get(threadId)
  })
}
// This owner outlives SettingsOverlay; account changes and committed deletions retire drafts.
useAppStore.subscribe((state, previous) => {
  if (state.accountRevision !== previous.accountRevision || state.threads !== previous.threads)
    synchronizeEditorDrafts()
})
synchronizeEditorDrafts()

function isEditorScopeCurrent(scope: ClawEditorScope) {
  const state = useAppStore.getState()
  const thread = state.threads.find((item) => item.thread_id === scope.threadId)
  const workspace = (thread?.metadata as { workspacePath?: string } | undefined)?.workspacePath
  return state.accountRevision === scope.accountRevision &&
    !isThreadDeletionPending(scope.threadId) && !!workspace &&
    normalizeWorkspacePathKey(workspace) === normalizeWorkspacePathKey(scope.workspace)
}

export function ClawPanel({
  threadId,
  workspaceHint,
  practiceIntent
}: {
  threadId: string | null
  workspaceHint?: string | null
  practiceIntent?: SimpleAuthoringPracticeIntent
}) {
  const accountRevision = useAppStore((state) => state.accountRevision)
  return threadId ? (
    <ClawSettings
      key={JSON.stringify([accountRevision, threadId, normalizeWorkspacePathKey(workspaceHint)])}
      accountRevision={accountRevision}
      threadId={threadId}
      workspaceHint={workspaceHint}
      practiceIntent={practiceIntent}
    />
  ) : (
    <p className="p-6 text-sm text-muted-foreground">
      请在上方选择带项目目录的本地聊天，再来组合插件。
    </p>
  )
}

function ClawSettings({
  accountRevision,
  threadId,
  workspaceHint,
  practiceIntent
}: {
  accountRevision: number
  threadId: string
  workspaceHint?: string | null
  practiceIntent?: SimpleAuthoringPracticeIntent
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [assemblyOpen, setAssemblyOpen] = useState(false)
  const [assemblyVisited, setAssemblyVisited] = useState(false)
  const [assemblySource, setAssemblySource] = useState<string>()
  const showAssembly = (pluginId?: string) => {
    setAssemblySource(pluginId)
    setAssemblyVisited(true)
    setAssemblyOpen(true)
  }
  const [view, setView] = useState<ClawView | null>(null)
  const [catalog, setCatalog] = useState<FlowCatalog | null>(null)
  const [flows, setFlows] = useState<SavedFlow[]>([])
  const [editing, setEditingState] = useState(() => createSimpleClawDraft(empty(), flowDraftId("flow")))
  const draft = editing.profile
  const setDraftState = (next: ClawProfile) =>
    setEditingState((old) => updateSimpleClawProfile(old, next))
  const [draftEdited, setDraftEdited] = useState(false)
  const [retentionLimited, setRetentionLimited] = useState(false)
  const [editorSession, setEditorSession] = useState(0)
  const [componentDirty, setComponentDirty] = useState<Record<string, boolean>>({})
  const onComponentDirty = useCallback(
    (id: string, dirty: boolean) =>
      setComponentDirty((old) => (old[id] === dirty ? old : { ...old, [id]: dirty })),
    []
  )
  const [componentValid, setComponentValid] = useState<Record<string, boolean>>({})
  const onComponentValidity = useCallback((id: string, valid: boolean) => {
    setComponentValid((previous) =>
      previous[id] === valid ? previous : { ...previous, [id]: valid }
    )
  }, [])
  const componentsInvalid = draft.capabilities.some(
    (item) => componentValid[item.pluginId] === false
  )
  const unfinishedStepDrafts = editing.mode === "sequence" && Object.values(editing.parameterDrafts)
    .some((value) => !!parameterError({}, undefined, value, false, false))
  const selectDraft = (next: ClawProfile) => {
    if ((componentsInvalid || draftEdited || Object.values(componentDirty).some(Boolean)) &&
      !window.confirm("切换搭配会替换当前未保存的草稿，继续吗？")) return
    setComponentDirty({})
    setComponentValid({})
    setEditorSession((value) => value + 1)
    setEditingState(createSimpleClawDraft(next, flowDraftId("flow")))
    setDraftEdited(false)
    setPreview(null)
  }
  const draftInitialized = useRef(false)
  const setDraft = (next: ClawProfile) => {
    draftInitialized.current = true
    setDraftEdited(true)
    setDraftState(next)
    setPreview(null)
  }
  const [sources, setSources] = useState<ClawSourceCatalog | null>(null)
  const [sourcesError, setSourcesError] = useState("")
  const [busy, setBusy] = useState(false)
  const savedDraft = view?.profiles.find((item) => item.id === draft.id)
  useConfigurationDraft({ threadId, workspace: view?.workspace ?? workspaceHint ?? null },
    (draftEdited && (editing.mode === "sequence" || JSON.stringify(draft) !== JSON.stringify(savedDraft))) ||
      Object.values(componentDirty).some(Boolean), busy)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [preview, setPreview] = useState<{
    profile: ClawProfile | null
    revision: number
    bindingRevision: number
    workspace: string
    usageContext: "chat" | "project"
  } | null>(null)
  const [upgradeIssues, setUpgradeIssues] = useState<string[]>([])
  useLayoutEffect(() => {
    if (!draftInitialized.current) return
    const scope = { accountRevision, threadId, workspace: workspaceHint ?? view?.workspace }
    if (!isEditorScopeCurrent(scope)) return
    const dirty = draftEdited || Object.values(componentDirty).some(Boolean)
    const retained = editorDrafts.write(scope, editing, dirty)
    setRetentionLimited(dirty && !retained)
  }, [accountRevision, threadId, workspaceHint, view?.workspace, editing, draftEdited, componentDirty])
  const previewApply = (profile: ClawProfile | null) => {
    if (view)
      setPreview({
        profile: structuredClone(profile),
        revision: view.revision,
        bindingRevision: view.bindingRevision,
        workspace: view.workspace,
        usageContext: view.usageContext ?? "chat"
      })
  }
  const upgrade = async () => {
    if (!view || !catalog || mutating.current) return
    if (
      (Object.values(componentDirty).some(Boolean) || Object.values(editing.parameterDrafts).some((item) => item.dirty)) &&
      !window.confirm("更新版本会保留当前有效参数，并重置未完成的数字或 JSON 输入草稿，继续吗？")
    )
      return
    let pendingDefinition: ReturnType<typeof simpleDraftDefinition>
    try { pendingDefinition = simpleDraftDefinition(editing, catalog.actions ?? [], true) }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    const proposal = planClawUpgrade(
      draft,
      view.capabilities,
      catalog.actions ?? [],
      (value, schema, providedFields) =>
        parameterError(value, schema, undefined, providedFields ?? false),
      pendingDefinition ?? null
    )
    setUpgradeIssues(proposal.issues)
    setComponentValid({})
    setEditorSession((value) => value + 1)
    setDraft(proposal.profile)
    if (proposal.issues.length) {
      setNotice("已保留选择和参数到可编辑草稿。请处理下列问题，再次检查灵件版本；尚未保存或应用。")
      return
    }
    if (!proposal.flow) {
      setNotice(
        proposal.changes.length
          ? "新版本已写入草稿，请核对后保存并应用。"
          : "当前灵件版本有效，无需更新。技能和工具需分别重新核对。"
      )
      return
    }
    const definition = {
      ...proposal.flow,
      id: flowDraftId("flow"),
      name: `${proposal.flow.name.slice(0, 65)} · 修复副本`
    }
    setEditingState(editSimpleFlowText(createSimpleClawDraft(proposal.profile, definition.id),
      JSON.stringify(definition, null, 2)))
    setDraftEdited(true)
    setNotice("新版本的执行步骤已放入同一份草稿，尚未保存。核对后保存搭配，再应用到所选聊天。")
  }

  const lifetime = useRef(0)
  const reading = useRef(0)
  const mutating = useRef(false)
  const canonicalScope = useRef<string | null>(null)
  const assertViewScope = useCallback(
    (next: ClawView) => {
      const actual = normalizeWorkspacePathKey(next.workspace)
      if (
        !actual ||
        (workspaceHint !== undefined && actual !== normalizeWorkspacePathKey(workspaceHint)) ||
        (canonicalScope.current !== null && canonicalScope.current !== actual)
      ) {
        setView(null)
        setCatalog(null)
        setFlows([])
        setSources(null)
        setPreview(null)
        throw Error("项目范围已变化，已暂停组合操作。请回到对应项目后重新读取配置。")
      }
      canonicalScope.current = actual
    },
    [workspaceHint]
  )
  const refresh = useCallback(async () => {
    if (mutating.current) return
    const generation = lifetime.current
    const request = ++reading.current
    try {
      const [next, nextCatalog, nextFlows, nextSources] = await Promise.all([
        window.api.mods.clawView(threadId),
        window.api.mods.flowCatalog(threadId),
        window.api.mods.flowList(threadId),
        window.api.mods.clawSources(threadId).then(
          (value) => ({ value, error: "" }),
          (cause) => ({
            value: null,
            error: cause instanceof Error ? cause.message : String(cause)
          })
        )
      ])
      if (lifetime.current !== generation || request !== reading.current) return
      assertViewScope(next)
      setView(next)
      setCatalog(nextCatalog)
      setFlows(nextFlows)
      setSources(nextSources.value)
      setSourcesError(nextSources.error)
      if (!draftInitialized.current) {
        draftInitialized.current = true
        // Restore values only after current host scope/catalog reads, never an old permission view.
        const scope = { accountRevision, threadId, workspace: next.workspace }
        const retained = isEditorScopeCurrent(scope) ? editorDrafts.read(scope) : undefined
        if (retained) {
          setEditingState(retained)
          setDraftEdited(true)
        } else if (next.active) setDraftState(next.active)
      }
      setError("")
    } catch (cause) {
      if (lifetime.current === generation && request === reading.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [accountRevision, threadId, assertViewScope])
  useEffect(() => {
    const generation = ++lifetime.current
    void refresh()
    const stop = window.api.mods.onConfigurationChanged(() => {
      void refresh()
    })
    return () => {
      lifetime.current = generation + 1
      stop()
    }
  }, [refresh])

  const run = async (mutation: ClawMutation) => {
    if (mutating.current) return
    if (mutation.kind === "save" && componentsInvalid) return
    mutating.current = true
    const generation = lifetime.current
    ++reading.current
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const next = await window.api.mods.clawChange(threadId, mutation)
      if (generation !== lifetime.current) return
      assertViewScope(next)
      setView(next)
      if (mutation.kind === "apply") setPreview(null)
      if (mutation.kind === "save") setDraftEdited(false)
      setNotice(
        mutation.kind === "save"
          ? "版本已保存，尚未应用。点击“应用到所选聊天”后生效；不会自动执行任务。"
          : next.active
            ? next.enabled
              ? `已在这段聊天使用 ${next.active.name}。点击“去这段聊天使用”即可进入。`
              : `已绑定 ${next.active.name}，灵件开关尚未开启。请先核对下方应用及当前项目目录的灵件使用设置。`
            : "本聊天已恢复原来的灵件、模型、技能和工具设置。"
      )
    } catch (cause) {
      if (generation === lifetime.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      mutating.current = false
      if (generation === lifetime.current) setBusy(false)
    }
  }
  const saveEditing = async () => {
    if (!view || mutating.current || componentsInvalid || unfinishedStepDrafts) return
    const originalView = view
    const generation = lifetime.current
    const assertCurrent = () => {
      if (generation !== lifetime.current ||
        canonicalScope.current !== normalizeWorkspacePathKey(originalView.workspace))
        throw Error("聊天或项目已变化，草稿已保留，请重新核对后保存。")
    }
    mutating.current = true
    ++reading.current
    setBusy(true)
    setError("")
    let checkpoint = editing.checkpoint
    try {
      assertCurrent()
      const definition = simpleDraftDefinition(editing, catalog?.actions ?? [])
      const profile = editing.mode === "together" ? { ...draft, flow: undefined } : draft
      if (checkpoint?.profileSaved) {
        const savedProfile = checkpoint.flow ? { ...profile, flow: checkpoint.flow } : profile
        if (JSON.stringify(originalView.profiles.find((item) => item.id === profile.id)) !==
          JSON.stringify(savedProfile))
          checkpoint = { ...checkpoint, profileSaved: false }
      }
      const result = await saveSimpleCombination({
        profile, definition, checkpoint, assertCurrent,
        onCheckpoint: (value) => {
          checkpoint = value
          setEditingState((old) => ({ ...old, checkpoint: value, savedFlow: value.flow ?? old.savedFlow }))
        },
        saveFlow: async (value) => {
          const prior = [checkpoint?.flow, editing.savedFlow, draft.flow].find((entry) => entry?.definition.id === value.id)
          if (prior && JSON.stringify(prior.definition) === JSON.stringify(value)) return prior
          const saved = await window.api.mods.flowSave(threadId, value,
            prior?.definition.id === value.id ? prior.revision : 0, originalView.workspace)
          assertCurrent()
          setFlows((old) => [...old.filter((item) => item.definition.id !== saved.definition.id), saved])
          return saved
        },
        saveProfile: async (value) => {
          assertCurrent()
          const next = await window.api.mods.clawChange(threadId, { kind: "save", profile: value,
            workspace: originalView.workspace, revision: originalView.revision })
          assertCurrent()
          assertViewScope(next)
          setView(next)
        }
      })
      assertCurrent()
      setEditingState((old) => ({ ...markSimpleDraftSaved(old, result), checkpoint }))
      setDraftEdited(false)
      setNotice("搭配已保存，尚未应用。请从已保存搭配核对后应用到所选聊天。")
    } catch (cause) {
      if (generation === lifetime.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      mutating.current = false
      if (generation === lifetime.current) setBusy(false)
    }
  }
  let editingDefinition: ReturnType<typeof simpleDraftDefinition>
  try { editingDefinition = simpleDraftDefinition(editing, catalog?.actions ?? []) }
  catch { editingDefinition = editing.baseDefinition }
  const changeEditing = (next: SimpleClawDraft, saved = false) => {
    draftInitialized.current = true
    setEditingState(next)
    setDraftEdited(!saved)
    setPreview(null)
  }
  const useInChat = () => {
    if (!view) return
    goToConfigurationThread({ threadId, workspace: view.workspace }, () => {
      const flow = view.active?.flow
      if (flow) requestChatFlowUse({ threadId, workspace: view.workspace,
        id: flow.definition.id, revision: flow.revision, name: flow.definition.name,
        bindingRevision: view.bindingRevision })
      else requestChatComposerFocus({ threadId, workspace: view.workspace })
    })
  }
  const navigate = (tab: string) => useAppStore.getState().setShowCustomizeView(true, tab)
  const disabled = busy || !view?.applicable
  return (
    <div
      className="mx-auto min-h-0 w-full max-w-5xl space-y-6 overflow-y-auto p-4 sm:p-6"
      tabIndex={0}
      aria-label="助手组合设置"
      data-claw-settings
    >
      <header className="rounded-2xl border bg-card p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <Sparkles className="size-5 text-primary" />
          <h2 className="text-xl font-semibold">{assemblyOpen ? "从 Mods 组装新插件" : "常用搭配"}</h2>
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          先选择目标：为聊天配置功能与工具，或把业务 Mods 和界面扩展组装成独立插件。
          项目步骤用于已安装插件的一次需求，需进入对应项目使用。
        </p>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2" aria-label="选择配置目标">
          <button type="button" aria-label="配置聊天搭配" aria-pressed={!assemblyOpen} disabled={busy}
            className={`rounded-xl border p-4 text-left ${!assemblyOpen ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
            onClick={() => setAssemblyOpen(false)}>
            <strong>配置聊天搭配</strong>
            <span className="mt-1 block text-xs text-muted-foreground">
              选择聊天功能、公开动作、技能和工具，保存并确认应用到所选聊天。
            </span>
          </button>
          <button type="button" aria-label="从 Mods 组装新插件" aria-pressed={assemblyOpen} disabled={busy || !view?.workspace}
            className={`rounded-xl border p-4 text-left ${assemblyOpen ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
            onClick={() => showAssembly()}>
            <strong>从 Mods 组装新插件</strong>
            <span className="mt-1 block text-xs text-muted-foreground">
              组合 AutoBiz 业务步骤和自己的界面扩展，生成、检查后再安装新插件。
            </span>
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <ModsUsageSettingsEntry disabled={busy} />
          <Button variant="ghost" size="sm" onClick={() => navigate("flows")}>
            管理聊天任务模板
          </Button>
        </div>
      </header>
      <ModsUsageSetup threadId={threadId} workspaceHint={workspaceHint ?? view?.workspace} />
      {assemblyVisited && <div hidden={!assemblyOpen} inert={!assemblyOpen}>
        <BusinessModAssemblyPanel threadId={threadId} workspace={workspaceHint ?? view?.workspace}
          initialPluginId={assemblySource} active={assemblyOpen} />
      </div>}
      <div hidden={assemblyOpen} inert={assemblyOpen} className="space-y-6" aria-label="聊天搭配配置">
      {retentionLimited && <p role="status" className="text-sm text-amber-600">
        草稿超出临时保留范围。请先保存搭配，再离开配置页；临时草稿仅在本次应用打开期间保留。
      </p>}
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              void refresh()
            }}
          >
            刷新配置
          </Button>
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-xl bg-primary/5 p-4 text-sm">
          {notice}
        </p>
      )}
      {sourcesError && (
        <div role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm">
          <p>技能和工具列表读取失败：{sourcesError}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            已保存的选择不会丢失，也不会自动改为全部启用。
          </p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>
            重新读取列表
          </Button>
        </div>
      )}
      {view && (
        <>
          <section className="space-y-2 rounded-xl border p-4 text-sm">
            <p className="font-medium">当前组合：{view.active?.name ?? "未选择，仍可照常聊天"}</p>
            <p className="break-all text-xs text-muted-foreground">目录：{view.workspace}</p>
            <p className="text-xs text-muted-foreground">
              只用于这段聊天。修改后需再次应用；请等当前任务结束后再切换。
            </p>
            <p className="text-xs text-muted-foreground">
              项目的必需检查和内容保护仍然生效。组合可以增加检查规则，不能取消必需的检查。
            </p>
            {!view.applicable && (
              <p className="text-amber-600">这段会话由项目阶段、工作流或其他运行器管理，不能绑定聊天搭配。请在普通本地聊天配置；项目流程可从下方已安装插件进入原项目。</p>
            )}
            {view.issues.map((issue) => (
              <p key={issue} role="alert" className="text-destructive">
                {issue}
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={disabled}
                onClick={useInChat}
              >
                去这段聊天使用
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || !view.active}
                onClick={() => previewApply(null)}
              >
                恢复原来的聊天设置
              </Button>
            </div>
          </section>
          {preview && (
            <section
              role="region"
              aria-label="应用变化预览"
              className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-5"
            >
              <h3 className="font-semibold">
                核对后应用：{preview.profile?.name ?? "恢复原来的聊天设置"}
              </h3>
              <p className="text-xs text-muted-foreground">
                下面是这段聊天将发生的变化。确认后使用新设置，任务仍需你主动开始。
              </p>
              <ul className="space-y-1 text-sm">
                {(clawChangeSummary(view.active, preview.profile).length
                  ? clawChangeSummary(view.active, preview.profile)
                  : ["插件设置没有变化"]
                ).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {(preview.revision !== view.revision ||
                preview.bindingRevision !== view.bindingRevision ||
                preview.workspace !== view.workspace ||
                preview.usageContext !== (view.usageContext ?? "chat")) && (
                <p role="alert" className="text-sm text-destructive">
                  配置已变化，请关闭后重新预览。
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={
                    disabled ||
                    preview.revision !== view.revision ||
                    preview.bindingRevision !== view.bindingRevision ||
                    preview.workspace !== view.workspace ||
                    preview.usageContext !== (view.usageContext ?? "chat")
                  }
                  onClick={() =>
                    void run({
                      kind: "apply",
                      id: preview.profile?.id ?? null,
                      revision: preview.revision,
                      bindingRevision: preview.bindingRevision,
                      workspace: preview.workspace
                    })
                  }
                >
                  确认应用
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
                  取消
                </Button>
              </div>
            </section>
          )}
          {view.workspace && (
            <NativePluginCapabilities
              key={JSON.stringify([threadId, view.workspace])}
              threadId={threadId}
              workspace={view.workspace}
              functionPluginIds={view.capabilities.map((item) => item.pluginId)}
              onAssemble={showAssembly}
            />
          )}
          {!advancedOpen && catalog && (
            <SimpleClawBuilder
              onAssemble={() => showAssembly()}
              threadId={threadId}
              view={view}
              catalog={catalog}
              editor={editing}
              onEditor={changeEditing}
              practiceIntent={practiceIntent}
              externalBusy={busy}
              beginMutation={() => {
                if (mutating.current) return false
                mutating.current = true
                ++reading.current
                setBusy(true)
                return true
              }}
              endMutation={() => {
                mutating.current = false
                setBusy(false)
                void refresh()
              }}
              onView={(next) => {
                assertViewScope(next)
                setView(next)
              }}
              onAdvanced={() => {
                setAdvancedOpen(true)
                return true
              }}
              onSources={() => navigate("mods")}
            />
          )}
          <details
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer rounded-lg border p-3 text-sm font-medium">
              高级编辑与已保存组合
            </summary>
            <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
              <aside className="space-y-3 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">已保存组合</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => selectDraft(empty())}
                  >
                    <Plus className="mr-1 size-3" />
                    新建
                  </Button>
                </div>
                {!view.profiles.length && (
                  <p className="text-xs text-muted-foreground">
                    还没有保存的组合。选好插件、填好名称后保存即可。
                  </p>
                )}
                {view.profiles.map((profile) => (
                  <div key={profile.id} className="space-y-2 rounded-lg border p-3">
                    <button
                      className="w-full break-words text-left text-sm font-medium"
                      disabled={busy}
                      onClick={() => selectDraft(profile)}
                    >
                      {profile.name}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      {profile.capabilities.length} 个灵件
                      {profile.builtins?.contextMeter && " · 聊天容量提示"} · 点击名称编辑
                    </p>
                    <p className="text-[11px] leading-5 text-muted-foreground">
                      技能：{clawSourceSummary(profile.skills, "技能")}
                      <br />
                      工具：{clawSourceSummary(profile.mcp, "工具")}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => previewApply(profile)}
                    >
                      {JSON.stringify(view.active) === JSON.stringify(profile) && (
                        <Check className="mr-1 size-3" />
                      )}
                      应用到所选聊天
                    </Button>
                  </div>
                ))}
              </aside>
              <section className="space-y-4 rounded-xl border bg-card p-5">
                <Button type="button" size="sm" variant="outline" onClick={() => setAdvancedOpen(false)}>返回简单配置</Button>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">
                    {view.active?.id === draft.id
                      ? "编辑当前使用的组合"
                      : view.profiles.some((profile) => profile.id === draft.id)
                        ? "编辑已保存组合"
                        : "新建组合"}
                  </h3>
                  <span className="text-xs text-muted-foreground">修改后先保存，再应用</span>
                </div>
                <label className="grid gap-2 text-sm font-medium">
                  组合名称
                  <input
                    aria-label="助手组合名称"
                    className="devclaw-input w-full min-w-0 text-sm"
                    disabled={disabled}
                    maxLength={80}
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <div className="space-y-2 rounded-lg border p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      aria-label="启用聊天容量提示"
                      checked={draft.builtins?.contextMeter === true}
                      disabled={disabled}
                      onChange={(event) =>
                        setDraft({ ...draft, builtins: { contextMeter: event.target.checked } })
                      }
                    />
                    聊天容量提示
                  </label>
                  <p className="text-xs text-muted-foreground">
                    在输入框上方显示这段聊天占用了多少模型容量。保存并应用后显示。
                    其他插件可能改变这里的显示。
                  </p>
                </div>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">选择灵件</h3>
                  <p className="text-xs text-muted-foreground">
                    上下调整插件顺序可以改变它们的加载顺序；多个插件修改同一位置时，效果可能不同。
                  </p>
                  {!view.capabilities.some((item) =>
                    hasUsableClawComponents(item, view.usageContext ?? "chat")
                  ) && (
                    <p className="text-sm text-muted-foreground">
                      暂无可用功能。请到“插件”启用，或调整下方搭配。
                    </p>
                  )}
                  {[
                    ...draft.capabilities.flatMap((capability) =>
                      view.capabilities.filter((item) => item.pluginId === capability.pluginId)
                    ),
                    ...view.capabilities.filter(
                      (item) =>
                        hasUsableClawComponents(item, view.usageContext ?? "chat") &&
                        !draft.capabilities.some(
                          (capability) => capability.pluginId === item.pluginId
                        )
                    )
                  ].map((item) => {
                    const position = draft.capabilities.findIndex(
                      (capability) => capability.pluginId === item.pluginId
                    )
                    const checked = position >= 0
                    return (
                      <div
                        key={item.pluginId}
                        className="flex flex-wrap items-start gap-3 rounded-xl border p-3 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          aria-label={`选择能力 ${item.name}`}
                          checked={checked}
                          disabled={disabled || (!checked && item.state !== "ready")}
                          onChange={(event) => {
                            if (
                              !event.target.checked &&
                              componentValid[item.pluginId] === false &&
                              !window.confirm("移除插件会丢弃未完成的组件参数草稿，继续吗？")
                            )
                              return
                            setComponentValid((previous) => {
                              const next = { ...previous }
                              delete next[item.pluginId]
                              return next
                            })
                            setDraft({
                              ...draft,
                              completionRules: event.target.checked
                                ? draft.completionRules
                                : draft.completionRules?.filter(
                                    (rule) => rule.pluginId !== item.pluginId
                                  ),
                              capabilities: event.target.checked
                                ? [
                                    ...draft.capabilities,
                                    newClawCapability(item, view.usageContext ?? "chat")
                                  ]
                                : draft.capabilities.filter(
                                    (capability) => capability.pluginId !== item.pluginId
                                  )
                            })
                          }}
                        />
                        <span className="min-w-0">
                          <strong className="break-all">{item.name}</strong>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {checked &&
                            draft.capabilities.find(
                              (capability) => capability.pluginId === item.pluginId
                            )?.digest !== item.digest
                              ? "版本已更新。使用下方“检查灵件版本”保留组件和参数。"
                              : item.state === "ready"
                                ? "已获准使用 · 具体用法见插件说明"
                                : "需先检查安装状态和授权"}
                          </span>
                        </span>
                        {checked && (
                          <div className="ml-auto flex items-center gap-1">
                            <span className="text-xs text-muted-foreground">
                              顺序 {position + 1}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`上移能力 ${item.name}`}
                              disabled={disabled || position === 0}
                              onClick={() => setDraft(moveClawCapability(draft, item.pluginId, -1))}
                            >
                              上移
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`下移能力 ${item.name}`}
                              disabled={disabled || position === draft.capabilities.length - 1}
                              onClick={() => setDraft(moveClawCapability(draft, item.pluginId, 1))}
                            >
                              下移
                            </Button>
                          </div>
                        )}
                        {!!item.userConfigFieldCount && (
                          <FunctionUserConfig
                            threadId={threadId}
                            pluginId={item.pluginId}
                            expectedWorkspace={view?.workspace}
                          />
                        )}
                        {checked &&
                        (item.components?.length ||
                          draft.capabilities.find(
                            (capability) => capability.pluginId === item.pluginId
                          )?.components) ? (
                          <div className="w-full min-w-0">
                            <ClawComponentSelector
                              key={`${editorSession}:${item.pluginId}`}
                              source={item}
                              usageContext={view.usageContext ?? "chat"}
                              value={
                                draft.capabilities.find(
                                  (capability) => capability.pluginId === item.pluginId
                                )!
                              }
                              disabled={disabled}
                              onValidity={onComponentValidity}
                              drafts={editing.componentDrafts[item.pluginId] ?? {}}
                              onDraftsChange={(value) => {
                                setDraftEdited(true)
                                setEditingState((old) => ({ ...old, componentDrafts: {
                                  ...old.componentDrafts, [item.pluginId]: value
                                } }))
                              }}
                              onDirty={onComponentDirty}
                              onChange={(next) =>
                                setDraft({
                                  ...draft,
                                  capabilities: draft.capabilities.map((capability) =>
                                    capability.pluginId === next.pluginId ? next : capability
                                  )
                                })
                              }
                            />
                          </div>
                        ) : checked ? (
                          <p className="w-full text-xs text-muted-foreground">
                            使用全部功能 · 此灵件不支持单独选择功能。
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                  {draft.capabilities
                    .filter(
                      (capability) =>
                        !view.capabilities.some((item) => item.pluginId === capability.pluginId)
                    )
                    .map((capability) => (
                      <div
                        key={capability.pluginId}
                        className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm"
                      >
                        <span className="break-all">{capability.name} · 已卸载或不可用</span>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={disabled}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              completionRules: draft.completionRules?.filter(
                                (rule) => rule.pluginId !== capability.pluginId
                              ),
                              capabilities: draft.capabilities.filter(
                                (item) => item.pluginId !== capability.pluginId
                              )
                            })
                          }
                        >
                          从组合中移除
                        </Button>
                      </div>
                    ))}
                </div>
                <section className="space-y-2 rounded-xl border p-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || !catalog}
                    onClick={() => void upgrade()}
                  >
                    检查灵件版本
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    检查所选插件是否有已授权的新版本，并保留原来的选择和参数。更新先放入草稿，保存并应用后生效。
                  </p>
                  {upgradeIssues.map((issue) => (
                    <p key={issue} role="alert" className="text-xs text-destructive">
                      {issue}
                    </p>
                  ))}
                </section>
                <details className="space-y-4 rounded-xl border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    更多设置：技能、工具、模型与步骤
                  </summary>
                  <ClawCompletionRules
                    threadId={threadId}
                    value={draft}
                    disabled={disabled}
                    onChange={setDraft}
                  />
                  <ClawSourceSelector
                    title="技能"
                    description="技能告诉助手怎样完成某类任务，例如代码检视。这里选择本组合可以使用哪些技能；命令菜单仍可能显示其他技能。"
                    entries={sources?.skills ?? []}
                    value={draft.skills}
                    disabled={disabled}
                    unavailable={!sources}
                    onChange={(skills) => setDraft({ ...draft, skills })}
                  />
                  <ClawSourceSelector
                    title="连接工具"
                    description="选择助手可使用的外部服务，例如数据库或文档搜索。未选服务不能被这套组合调用，应用本身仍可能保持连接。"
                    entries={sources?.mcp ?? []}
                    value={draft.mcp}
                    disabled={disabled}
                    unavailable={!sources}
                    onChange={(mcp) => setDraft({ ...draft, mcp })}
                  />
                  <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
                    <h3 className="text-sm font-medium">可选：指定使用的模型</h3>
                    <p className="text-xs text-muted-foreground">
                      通常无需修改。这里只记录模型选择，不保存密钥；步骤单独指定的模型优先。
                    </p>
                    <label className="grid gap-1 text-xs">
                      聊天默认模型
                      <select
                        aria-label="聊天默认模型"
                        className="devclaw-select w-full min-w-0 text-sm"
                        disabled={disabled}
                        value={draft.models?.default ?? ""}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            models: {
                              ...draft.models,
                              roles: draft.models?.roles ?? {},
                              default: event.target.value || undefined
                            }
                          })
                        }
                      >
                        <option value="">使用聊天中选择的模型</option>
                        {draft.models?.default &&
                          !catalog?.models.some((model) => model.id === draft.models?.default) && (
                            <option value={draft.models.default}>
                              {draft.models.default}（不可用）
                            </option>
                          )}
                        {catalog?.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {Array.from(
                      new Set([
                        "implementation",
                        "review",
                        ...Object.keys(draft.models?.roles ?? {})
                      ])
                    ).map((role) => (
                      <label key={role} className="grid gap-1 text-xs">
                        {role === "implementation"
                          ? "执行步骤"
                          : role === "review"
                            ? "检查步骤"
                            : role}{" "}
                        · {role}
                        <select
                          aria-label={`步骤模型 ${role}`}
                          className="devclaw-select w-full min-w-0 text-sm"
                          disabled={disabled}
                          value={draft.models?.roles[role] ?? ""}
                          onChange={(event) => {
                            const roles = { ...draft.models?.roles }
                            if (event.target.value) roles[role] = event.target.value
                            else delete roles[role]
                            setDraft({ ...draft, models: { ...draft.models, roles } })
                          }}
                        >
                          <option value="">使用步骤原来的模型设置</option>
                          {draft.models?.roles[role] &&
                            !catalog?.models.some(
                              (model) => model.id === draft.models?.roles[role]
                            ) && (
                              <option value={draft.models.roles[role]}>
                                {draft.models.roles[role]}（不可用）
                              </option>
                            )}
                          {catalog?.models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </section>
                  <section className="space-y-3 rounded-xl border bg-muted/20 p-4">
                    <h3 className="text-sm font-medium">可选：搭配一套执行步骤</h3>
                    {editing.mode === "sequence" && <div className="space-y-2">
                      <p className="text-sm">此份草稿包含 {editing.steps.length} 个执行步骤；切换视图不会保存步骤或替换正式版本。</p>
                      <details className="space-y-2">
                        <summary className="cursor-pointer text-sm">高级：编辑本份执行步骤定义</summary>
                        {editingDefinition || editing.flowText !== undefined ? <>
                          <textarea aria-label="执行步骤定义草稿" spellCheck={false}
                            className="devclaw-input min-h-56 w-full min-w-0 font-mono text-xs"
                            disabled={disabled} value={editing.flowText ?? JSON.stringify(editingDefinition, null, 2)}
                            onChange={(event) => {
                              if (unfinishedStepDrafts && !window.confirm("编辑完整定义会替换尚未完成的简单参数输入，继续吗？")) return
                              changeEditing(editSimpleFlowText(unfinishedStepDrafts
                                ? { ...editing, parameterDrafts: {} } : editing, event.target.value))
                            }}/>
                          {editing.flowTextError && <p role="alert" className="text-sm text-destructive">{editing.flowTextError}</p>}
                          <p className="text-xs text-muted-foreground">这里只编辑草稿；保存时由原流程校验器核对来源、结构与版本。正式版本未改变。</p>
                        </> : <p className="text-sm">先在简单配置中为每一步选择操作，再编辑完整定义。</p>}
                      </details>
                    </div>}

                    <select
                      aria-label="组合使用的流程"
                      className="devclaw-select w-full min-w-0 text-sm"
                      disabled={disabled}
                      value={draft.flow ? `${draft.flow.definition.id}:${draft.flow.revision}` : ""}
                      onChange={(event) => {
                        if (draftEdited && editing.mode === "sequence" &&
                          !window.confirm("改用已保存步骤将替换当前未保存的步骤草稿，继续吗？")) return
                        const flow = flows.find((entry) => `${entry.definition.id}:${entry.revision}` === event.target.value)
                        changeEditing(createSimpleClawDraft({ ...draft, flow }, flowDraftId("flow")))
                      }}
                    >
                      <option value="">不预设执行步骤</option>
                      {draft.flow &&
                        !flows.some(
                          (flow) =>
                            flow.definition.id === draft.flow!.definition.id &&
                            flow.revision === draft.flow!.revision
                        ) && (
                          <option value={`${draft.flow.definition.id}:${draft.flow.revision}`}>
                            {draft.flow.definition.name} · 流程保存修订 {draft.flow.revision}
                          </option>
                        )}
                      {flows.map((flow) => (
                        <option
                          key={flow.definition.id}
                          value={`${flow.definition.id}:${flow.revision}`}
                        >
                          {flow.definition.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs leading-5 text-muted-foreground">
                      应用后点击“去这段聊天使用”。在唯一输入框中填写任务，由你选择本次使用步骤并发送。
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => navigate("flows")}
                    >
                      编辑执行步骤
                    </Button>
                  </section>
                </details>
                <p className="text-xs leading-5 text-muted-foreground">
                  选好后请查看各插件的使用说明：有的在聊天时自动工作，有的需要输入命令，有的需要设置检查规则。
                </p>
                <Button
                  disabled={disabled || !draft.name.trim() || componentsInvalid || unfinishedStepDrafts || !!editing.flowTextError}
                  onClick={() => void saveEditing()}
                >
                  保存组合
                </Button>
                {unfinishedStepDrafts && <p role="alert" className="text-sm text-destructive">执行步骤有未完成的参数输入。请返回简单配置修正，或明确改写完整定义后再保存。</p>}
              </section>
            </div>
          </details>
        </>
      )}
      </div>
    </div>
  )
}
