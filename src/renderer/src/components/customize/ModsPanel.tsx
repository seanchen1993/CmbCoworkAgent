import { PluginDerivationPanel } from "./PluginDerivationPanel"
import { BusinessModAssemblyPanel } from "./BusinessModAssemblyPanel"
import {
  sameSimpleAuthoringScope,
  type SimpleAuthoringPracticeIntent
} from "@/lib/simple-authoring-intent"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { ModWorkspaceStatus } from "../../../../shared/mods/types"
import type { FunctionPluginStatus } from "../../../../shared/mods/v2/commands"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { openClawSidebar } from "@/lib/claw-sidebar"
import { goToConfigurationThread, useConfigurationDraft } from "@/lib/configuration-target"
import { openDerivedProject } from "@/lib/derived-project-intent"
import { openPluginSettings } from "@/lib/plugin-settings-intent"
import { useFeatureGate } from "@/lib/feature-gates"
import { installedModNextAction, installedModUseState } from "@/lib/installed-mod-use-state"
import { installedProjectPluginIdentity } from "@/lib/native-project-binding"
import {
  classifyInstalledPluginProjectEntry,
  readInstalledPluginProjectEntry
} from "@/lib/installed-plugin-project-entry"
import type { LocalProjectTemplate } from "../../../../shared/project-runtime/platform-api"
import type { ClawView } from "../../../../shared/mods/claw"
import { FEATURE_GATES } from "../../../../shared/feature-gates"
import type { PluginInstallResult } from "../../../../shared/plugin-install"
import { ModCreator } from "./ModCreator"
import { FunctionCompletionPolicy } from "./FunctionCompletionPolicy"
import { FunctionCompatibilityCheck } from "./FunctionCompatibilityCheck"
import { FunctionPluginApproval } from "./FunctionPluginApproval"
import { ModsGuide } from "./ModsGuide"
import { ModsImportGuide } from "./ModsImportGuide"
import { SparksDocumentationLink } from "./SparksDocumentationLink"
import { OfficialSparksExamples } from "./OfficialSparksExamples"
import { SparksOperationError } from "./SparksOperationError"
import { InstalledPluginStartUse } from "./InstalledPluginStartUse"
import { RuntimeSessions } from "./RuntimeSessions"
import { SnapshotMaintenance } from "./SnapshotMaintenance"
import { readReuseSelection, subscribeReuseSelection } from "./development-reuse-receipts"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog"

const InstalledPluginFlowDefinition = lazy(() =>
  import("./InstalledPluginFlowDefinition").then((module) => ({
    default: module.InstalledPluginFlowDefinition
  }))
)

async function readWorkspaceStatus(threadId: string | null): Promise<ModWorkspaceStatus | null> {
  if (!threadId) return null
  try {
    return await window.api.mods.status(threadId)
  } catch (error) {
    if (String(error).includes("MODS_WORKSPACE_REQUIRED")) return null
    throw error
  }
}

export function ModsPanel({
  threadId,
  workspaceHint,
  onReturnToChat,
  onStartCreator,
  creatorBusy = false,
  creatorUnavailable,
  creatorError,
  onOpenReuseThread,
  developmentAllowed,
  active = true,
  navigationRequest,
  onSectionChange,
  onManageSources
}: {
  threadId: string | null
  workspaceHint?: string | null
  onReturnToChat?: () => void
  onStartCreator?: () => void
  creatorBusy?: boolean
  creatorUnavailable?: string
  creatorError?: string
  onOpenReuseThread?: (threadId: string) => Promise<void>
  developmentAllowed?: boolean
  active?: boolean
  navigationRequest?: {
    id: number
    section: "examples" | "create" | "installed"
    practice?: SimpleAuthoringPracticeIntent
  }
  onSectionChange?: (section: "examples" | "create" | "installed") => void
  onManageSources?: () => void
}): React.JSX.Element {
  const [section, setSection] = useState<"examples" | "create" | "installed">("installed")
  const accountRevision = useAppStore((state) => state.accountRevision)
  const [advanced, setAdvanced] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const [createKind, setCreateKind] = useState<"new" | "derive" | "assemble">("new")
  const [sourceRequest, setSourceRequest] = useState<{
    id: string
    pluginId: string
    name: string
  } | null>(null)
  const [settingsVisited, setSettingsVisited] = useState(true)
  const [consumedNavigation, setConsumedNavigation] = useState<number | null>(null)
  useEffect(() => {
    if (active) onSectionChange?.(section)
  }, [active, section, onSectionChange])
  if (active && navigationRequest && navigationRequest.id !== consumedNavigation) {
    setConsumedNavigation(navigationRequest.id)
    setSection(navigationRequest.section)
    if (navigationRequest.section === "installed") setSettingsVisited(true)
    if (navigationRequest.section === "create") {
      setAdvanced(false)
      setManualOpen(false)
    }
    if (
      navigationRequest.practice?.target === "derive-source" &&
      sameSimpleAuthoringScope(navigationRequest.practice.scope, {
        threadId,
        workspace: workspaceHint
      })
    ) {
      setCreateKind("derive")
      setManualOpen(true)
    }
    if (
      navigationRequest.practice?.target === "new-component" &&
      sameSimpleAuthoringScope(navigationRequest.practice.scope, {
        threadId,
        workspace: workspaceHint
      })
    ) {
      setCreateKind("new")
      setManualOpen(true)
    }
  }
  const selectionScope = JSON.stringify([threadId, workspaceHint])
  useEffect(
    () =>
      subscribeReuseSelection(selectionScope, () => {
        if (readReuseSelection(selectionScope)) {
          setSection("create")
          setAdvanced(false)
          setCreateKind("new")
          setManualOpen(true)
        }
      }),
    [selectionScope]
  )
  const editorActive = section === "create" && manualOpen
  const chooseSection = (next: typeof section) => {
    setSection(next)
    if (next === "installed") setSettingsVisited(true)
  }
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">插件</h1>
        <div className="flex items-center gap-2">
          {onManageSources && (
            <Button size="sm" variant="ghost" onClick={onManageSources}>
              导入与发布
            </Button>
          )}
          <SparksDocumentationLink />
        </div>
      </div>
      <nav aria-label="灵件工作区" className="flex flex-wrap gap-1 border-b pb-3">
        {(
          [
            ["create", "对话创作"],
            ["examples", "挑选使用"],
            ["installed", "我已添加"]
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            variant={section === id ? "secondary" : "ghost"}
            aria-pressed={section === id}
            onClick={() => chooseSection(id)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {section === "examples" && (
        <OfficialSparksExamples
          key={selectionScope}
          active={active}
          threadId={threadId}
          workspaceHint={workspaceHint}
          onReturnToChat={onReturnToChat}
          onInstalled={() => useAppStore.getState().bumpPluginVersion()}
        />
      )}
      {section === "create" && (
        <section className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-5">
          <h2 className="font-semibold">一句话，制作或组合你需要的灵件</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            进入创造者模式后，告诉助手你想改变什么。生成新灵件、调整已有功能、组合多个灵件并应用，都可以在聊天中完成。
          </p>
          {onStartCreator ? (
            <Button onClick={onStartCreator} disabled={creatorBusy || !!creatorUnavailable}>
              {creatorBusy ? "正在进入创造者模式…" : "进入创造者模式"}
            </Button>
          ) : (
            <Button onClick={onReturnToChat} disabled={!onReturnToChat || !threadId}>
              返回聊天选择创造者模式
            </Button>
          )}
          {creatorUnavailable && (
            <p className="text-sm text-muted-foreground">{creatorUnavailable}</p>
          )}
          {creatorError && (
            <p role="alert" className="text-sm text-destructive">
              {creatorError}
            </p>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            需要新权限时会请你确认，当前任务结束后应用到这段聊天。
          </p>
        </section>
      )}
      {section === "create" && (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={manualOpen}
          onClick={() => setManualOpen(!manualOpen)}
        >
          {manualOpen ? "收起高级手动编辑" : "高级：手动组装、源码与历史版本"}
        </Button>
      )}
      <div hidden={!editorActive} inert={!editorActive}>
        <div className="mb-4 flex flex-wrap gap-2" aria-label="制作方式">
          <Button
            variant={createKind === "assemble" ? "secondary" : "outline"}
            onClick={() => setCreateKind("assemble")}
          >
            从 Mods 组装
          </Button>
          <Button
            variant={createKind === "derive" ? "secondary" : "outline"}
            onClick={() => setCreateKind("derive")}
          >
            从已有插件创建
          </Button>
          <Button
            variant={createKind === "new" ? "secondary" : "outline"}
            onClick={() => setCreateKind("new")}
          >
            描述新功能
          </Button>
        </div>
        <div hidden={createKind !== "assemble"} inert={createKind !== "assemble"}>
          <BusinessModAssemblyPanel
            threadId={threadId}
            workspace={workspaceHint}
            active={active && editorActive && createKind === "assemble"}
          />
        </div>
        <div hidden={createKind !== "derive"} inert={createKind !== "derive"}>
          <PluginDerivationPanel
            sourceRequest={sourceRequest}
            practice={navigationRequest?.practice}
            threadId={threadId}
            workspace={workspaceHint}
            active={active && editorActive && createKind === "derive"}
          />
        </div>
        <div hidden={createKind !== "new"} inert={createKind !== "new"}>
          <div className="mb-4 space-y-2">
            <h2 className="font-semibold">说说你想让助手做什么</h2>
            <p className="text-sm text-muted-foreground">先制作和试用，满意后再确认添加与权限。</p>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              {advanced ? "返回需求制作" : "高级：编辑源码与历史版本"}
            </Button>
          </div>
          <ModCreator
            section={advanced ? "advanced" : "create"}
            onOpenAdvanced={() => setAdvanced(true)}
            developmentAllowed={developmentAllowed}
            threadId={threadId}
            workspaceHint={workspaceHint}
            onReturnToChat={onReturnToChat}
            onOpenReuseThread={onOpenReuseThread}
          />
        </div>
      </div>
      <div hidden={section !== "installed"} inert={section !== "installed"}>
        {settingsVisited && (
          <ModsSettings
            key={JSON.stringify([
              accountRevision,
              threadId,
              normalizeWorkspacePathKey(workspaceHint)
            ])}
            threadId={threadId}
            workspaceHint={workspaceHint}
            active={active && section === "installed"}
            onDerive={(plugin) => {
              setSourceRequest({ id: crypto.randomUUID(), pluginId: plugin.id, name: plugin.name })
              setCreateKind("derive")
              setManualOpen(true)
              setSection("create")
            }}
          />
        )}
      </div>
      <details
        className="rounded-xl border p-4"
        open={maintenanceOpen}
        onToggle={(event) => setMaintenanceOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm font-medium">高级：运行管理与恢复</summary>
        <div className="space-y-4 pt-4">
          <RuntimeSessions active={active && maintenanceOpen} threadId={threadId} />
          <SnapshotMaintenance active={active && maintenanceOpen} scopeKey={selectionScope} />
        </div>
      </details>
      {section === "create" && (
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer text-sm font-medium">灵件使用指南</summary>
          <div className="pt-4">
            <ModsGuide />
          </div>
        </details>
      )}
    </div>
  )
}

export function ModsSettings({
  threadId,
  workspaceHint,
  active,
  onDerive
}: {
  threadId: string | null
  workspaceHint?: string | null
  active: boolean
  onDerive?: (plugin: { id: string; name: string }) => void
}): React.JSX.Element {
  const projectMode = useFeatureGate(FEATURE_GATES.projectMode)
  const account = useAppStore((state) => state.accountRevision)
  const projectScope = JSON.stringify([account])
  const [projectSelection, setProjectSelection] = useState<{
    scope: string
    pluginId: string | null
  }>({
    scope: projectScope,
    pluginId: null
  })
  if (projectSelection.scope !== projectScope)
    setProjectSelection({ scope: projectScope, pluginId: null })
  const selectedProjectPlugin =
    projectSelection.scope === projectScope ? projectSelection.pluginId : null
  const uploadInput = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState("")
  const [installed, setInstalled] = useState<Awaited<ReturnType<typeof window.api.plugins.list>>>(
    []
  )
  const [installedAccount, setInstalledAccount] = useState(account)
  const [projectEntries, setProjectEntries] = useState<{
    account: number
    templates?: LocalProjectTemplate[]
    failed?: boolean
  }>({ account })
  const [deleteTarget, setDeleteTarget] = useState<{ pluginId: string; name: string } | null>(null)
  const [managedPlugin, setManagedPlugin] = useState<string | null>(null)
  useEffect(() => {
    if (!active) setDeleteTarget(null)
  }, [active])
  const [status, setStatus] = useState<ModWorkspaceStatus | null>(null)
  const [usage, setUsage] = useState<ClawView | null>(null)
  const [usageReadFailed, setUsageReadFailed] = useState(false)
  const [globalEnabled, setGlobalEnabled] = useState(false)
  const [globalLoaded, setGlobalLoaded] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [activeUsePlugin, setActiveUsePlugin] = useState<string | null>(null)
  const blocked = busy || activeUsePlugin !== null
  useConfigurationDraft({ threadId, workspace: workspaceHint ?? null }, false, blocked)
  const alive = useRef(false)
  const running = useRef(false)
  const readVersion = useRef(0)
  const navigationScope = useRef({ account, active })
  navigationScope.current = { account, active }
  const installationNotice = (result: PluginInstallResult) => {
    const name = result.pluginName ?? "插件"
    return result.kind === "plugin"
      ? `已添加 ${name}，从下方卡片启用插件或继续使用；项目插件可直接新建项目，聊天功能需选择聊天和目录。`
      : `已添加 ${name}，点击下方“开始使用”核对权限与使用方式。`
  }
  const refresh = useCallback(async () => {
    const version = ++readVersion.current
    setProjectEntries({ account })
    try {
      const pluginsRead = window.api.plugins.list()
      void pluginsRead
        .then((plugins) =>
          projectMode.enabled &&
          !(threadId && workspaceHint) &&
          plugins.some((plugin) => plugin.enabled)
            ? window.api.harnessBoard.localProjects.templates()
            : []
        )
        .then(
          (templates) => {
            if (
              alive.current &&
              version === readVersion.current &&
              useAppStore.getState().accountRevision === account
            )
              setProjectEntries({ account, templates })
          },
          () => {
            if (
              alive.current &&
              version === readVersion.current &&
              useAppStore.getState().accountRevision === account
            )
              setProjectEntries({ account, failed: true })
          }
        )
      const [plugins, enabled, workspace, currentUsage] = await Promise.allSettled([
        pluginsRead,
        window.api.mods.globalEnabled(),
        readWorkspaceStatus(threadId),
        threadId && typeof window.api.mods.clawView === "function"
          ? window.api.mods.clawView(threadId)
          : Promise.resolve(null)
      ])
      if (
        !alive.current ||
        version !== readVersion.current ||
        useAppStore.getState().accountRevision !== account
      )
        return
      if (
        workspace.status === "fulfilled" &&
        workspace.value &&
        workspaceHint !== undefined &&
        normalizeWorkspacePathKey(workspace.value.workspace) !==
          normalizeWorkspacePathKey(workspaceHint)
      ) {
        setStatus(null)
        throw Error("项目范围已变化，请等待会话同步后重新读取。")
      }
      if (plugins.status === "fulfilled") {
        setInstalled(plugins.value)
        setInstalledAccount(account)
      }
      if (enabled.status === "fulfilled") setGlobalEnabled(enabled.value)
      if (currentUsage.status === "fulfilled") setUsage(currentUsage.value ?? null)
      setUsageReadFailed(currentUsage.status === "rejected")
      setGlobalLoaded(enabled.status === "fulfilled")
      setStatus(workspace.status === "fulfilled" ? workspace.value : null)
      const failures = [
        plugins.status === "rejected" && "无法读取已添加的灵件",
        enabled.status === "rejected" && "无法读取 灵件总开关状态",
        workspace.status === "rejected" && "无法读取项目灵件状态"
      ].filter(Boolean)
      setReadFailed(failures.length > 0)
      if (failures.length) throw Error(failures.join("；") + "，请重试。")
      setError("")
    } catch (cause) {
      if (alive.current && version === readVersion.current) {
        setReadFailed(true)
        throw cause
      }
    }
  }, [account, threadId, workspaceHint, projectMode.enabled])
  useEffect(() => {
    alive.current = true
    const read = () => {
      void refresh().catch((cause) => {
        if (alive.current)
          setError(cause instanceof Error ? cause.message : "无法读取 灵件状态，请重试。")
      })
    }
    const update = () => {
      if (!running.current) read()
    }
    read()
    const stop = window.api.mods.onConfigurationChanged(update)
    window.addEventListener("mods:configuration-changed", update)
    return () => {
      alive.current = false
      ++readVersion.current
      stop()
      window.removeEventListener("mods:configuration-changed", update)
    }
  }, [refresh])
  async function run(action: () => Promise<unknown>, notify = true): Promise<void> {
    if (running.current) return
    running.current = true
    ++readVersion.current
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await action()
      // Global installs/toggles may finish after switching projects; notify the current view too.
      if (notify) window.dispatchEvent(new Event("mods:configuration-changed"))
      if (!alive.current || useAppStore.getState().accountRevision !== account) return
      await refresh()
    } catch (error) {
      if (alive.current && useAppStore.getState().accountRevision === account)
        setError(error instanceof Error ? error.message : "操作失败")
    } finally {
      running.current = false
      if (alive.current) setBusy(false)
    }
  }
  const functionManagement = (mod: FunctionPluginStatus) => {
    if (!status || status.recovery || !threadId) return null
    return (
      <div className="space-y-3" data-function-mod-id={mod.name}>
        <p role="status" className="text-xs text-muted-foreground" data-plugin-use-state>
          {installedModUseState(
            mod,
            status.workspace,
            globalEnabled && status.enabled,
            usage,
            usageReadFailed
          )}
        </p>
        <FunctionPluginApproval
          mod={mod}
          threadId={threadId}
          workspace={status.workspace}
          busy={blocked}
          onApprove={() =>
            void run(() =>
              window.api.mods.approveFunction(threadId, mod.pluginId, mod.digest!, status.workspace)
            )
          }
        />
        {mod.state === "ready" && (
          <Button
            size="sm"
            variant="outline"
            disabled={blocked}
            onClick={() =>
              void run(() => window.api.mods.revokeFunction(threadId, mod.name, status.workspace))
            }
          >
            撤销权限
          </Button>
        )}
        {mod.digest && mod.state !== "invalid" && (
          <FunctionCompatibilityCheck
            expectedWorkspace={status.workspace}
            threadId={threadId}
            pluginId={mod.pluginId}
            digest={mod.digest}
            disabled={blocked}
          />
        )}
        <FunctionCompletionPolicy
          expectedWorkspace={status.workspace}
          threadId={threadId}
          plugin={mod.name}
          disabled={blocked || mod.state !== "ready"}
        />
      </div>
    )
  }
  return (
    <section className="w-full space-y-5 text-sm" data-mods-settings aria-label="灵件设置">
      <div className="space-y-1">
        <h2 className="font-semibold">我已添加</h2>
        <p className="text-sm text-muted-foreground">从插件卡片继续使用或完成设置。</p>
      </div>
      <section
        aria-label="已安装插件"
        data-installed-mods
        className="space-y-3 rounded-xl border p-4"
      >
        {(installedAccount === account ? installed : []).map((plugin) => {
          const mod = status?.functionMods?.find((item) => item.pluginId === plugin.id)
          const action = installedModNextAction(
            plugin.enabled,
            mod,
            globalEnabled && !!status?.enabled
          )
          const canUseHere = active && threadId && status && !status.recovery && !readFailed
          const hasChatScope = Boolean(threadId && workspaceHint)
          const entries = projectEntries.account === account ? projectEntries : undefined
          const projectEntry =
            !hasChatScope && entries?.templates
              ? classifyInstalledPluginProjectEntry(plugin.id, [plugin], entries.templates)
              : undefined
          const projectCandidate =
            plugin.hasProjectMode ||
            entries?.templates?.some((template) => template.installedPluginId === plugin.id)
          const entryFailed =
            !hasChatScope &&
            plugin.enabled &&
            projectCandidate &&
            projectEntry?.kind === "unavailable"
          const projectUse = projectEntry?.kind === "host" || projectEntry?.kind === "legacy"
          const managing = managedPlugin === plugin.id
          return (
            <article
              key={plugin.id}
              aria-label={plugin.name}
              data-installed-mod-id={plugin.id}
              className="space-y-3 rounded-lg bg-muted/30 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <h4 className="min-w-0 break-all font-medium">{plugin.name}</h4>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={blocked}
                  aria-expanded={managing}
                  onClick={() => setManagedPlugin(managing ? null : plugin.id)}
                >
                  {managing ? "收起管理" : "管理"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {[
                  plugin.skillCount > 0 && `${plugin.skillCount} 项技能`,
                  (plugin.hookCount ?? 0) > 0 && `${plugin.hookCount} 项自动检查`,
                  plugin.mcpServerCount > 0 && `${plugin.mcpServerCount} 个工具连接`,
                  (plugin.modCount ?? 0) > 0 && `${plugin.modCount} 个灵件模块`,
                  (plugin.businessModCount ?? 0) > 0 &&
                    `${plugin.businessModCount} 个可组合业务 Mods`,
                  (plugin.businessExtensionCount ?? 0) > 0 &&
                    `${plugin.businessExtensionCount} 个常驻扩展`,
                  (plugin.hasProjectMode || projectUse) && "支持项目模式"
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {action === "修复" ? (
                <>
                  <p role="alert" className="text-xs text-destructive">
                    {mod?.error || "插件无法加载，请核对配置或重新安装。"}
                  </p>
                  <Button
                    size="sm"
                    disabled={blocked || !active}
                    onClick={() => setManagedPlugin(plugin.id)}
                  >
                    修复
                  </Button>
                </>
              ) : canUseHere && typeof plugin.version === "string" ? (
                <InstalledPluginStartUse
                  threadId={threadId}
                  workspace={status.workspace}
                  pluginId={plugin.id}
                  expected={{ name: plugin.name, version: plugin.version }}
                  actionLabel={action === "启用" ? "开始使用" : action}
                  disabled={
                    busy ||
                    (activeUsePlugin !== null && activeUsePlugin !== plugin.id) ||
                    (plugin.hasProjectMode && !projectMode.enabled)
                  }
                  onBusyChange={(value) =>
                    setActiveUsePlugin((current) =>
                      value ? plugin.id : current === plugin.id ? null : current
                    )
                  }
                />
              ) : (
                <>
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !active ||
                      (!plugin.enabled && hasChatScope) ||
                      (plugin.enabled &&
                        (plugin.hasProjectMode || projectUse) &&
                        (projectMode.loading || !projectMode.enabled))
                    }
                    onClick={() => {
                      if (!plugin.enabled) {
                        if (hasChatScope) return
                        void run(async () => {
                          const result = await window.api.plugins.setEnabled(plugin.id, true)
                          if (result?.success === false)
                            throw new Error(result.error || "启用状态未能保存，请重试。")
                          useAppStore.getState().bumpPluginVersion()
                        })
                      } else if (!hasChatScope && entryFailed) {
                        void run(async () => {}, false)
                      } else if (!hasChatScope && projectEntry?.kind === "host") {
                        void run(async () => {
                          const version = readVersion.current
                          const current = () =>
                            alive.current &&
                            navigationScope.current.active &&
                            navigationScope.current.account === account &&
                            useAppStore.getState().accountRevision === account &&
                            version === readVersion.current
                          const actual = await readInstalledPluginProjectEntry(
                            plugin.id,
                            {
                              plugins: () => window.api.plugins.list(),
                              templates: () => window.api.harnessBoard.localProjects.templates()
                            },
                            current,
                            plugin
                          )
                           if (actual.kind !== projectEntry?.kind)
                            throw Error("插件项目入口已变化，请重新核对。")
                          if (!current()) return
                          openDerivedProject(actual.pluginId, actual.name)
                        }, false)
                      } else if (plugin.hasProjectMode) {
                        openDerivedProject(plugin.id, plugin.name)
                      } else {
                        openPluginSettings(plugin.id)
                      }
                    }}
                  >
                    {!plugin.enabled
                      ? hasChatScope
                        ? "使用状态待核对"
                        : busy
                          ? "正在启用插件…"
                          : "启用插件"
                      : entryFailed
                        ? "重新核对使用入口"
                        : plugin.hasProjectMode || projectUse
                          ? "去使用"
                          : "配置"}
                  </Button>
                  {!hasChatScope && entryFailed && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {projectEntry?.kind === "unavailable" && projectCandidate
                        ? projectEntry.reason
                        : "暂时无法确认项目入口，请重新核对。"}
                    </p>
                  )}
                  {!hasChatScope && projectUse && !projectMode.loading && !projectMode.enabled && (
                    <p role="status" className="text-xs text-muted-foreground">
                      当前应用暂未开放项目模式。
                    </p>
                  )}
                  {!plugin.hasProjectMode && hasChatScope && !canUseHere && (
                    <p className="text-xs text-muted-foreground">
                      {readFailed || status?.recovery
                        ? "使用状态需要核对，请先处理下方提示。"
                        : "打开聊天并选择项目目录后，即可使用此插件。"}
                    </p>
                  )}
                </>
              )}
              {managing && (
                <div className="space-y-3 border-t pt-3" aria-label={`${plugin.name}管理`}>
                  <p className="text-xs text-muted-foreground">插件启停会影响使用它的其他聊天。</p>
                  {!hasChatScope && plugin.enabled && entries?.failed && !plugin.hasProjectMode && (
                    <div className="space-y-2">
                      <p role="status" className="text-xs text-muted-foreground">
                        暂时无法确认项目入口，插件配置仍可使用。
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !active}
                        onClick={() => void run(async () => {}, false)}
                      >
                        重新核对项目入口
                      </Button>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={blocked}
                      onClick={() => openPluginSettings(plugin.id)}
                    >
                      插件配置
                    </Button>
                    {plugin.enabled && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={blocked}
                        onClick={() =>
                          void run(async () => {
                            const result = await window.api.plugins.setEnabled(plugin.id, false)
                            if (result?.success === false)
                              throw new Error(result.error || "停用状态未能保存，请重试。")
                            useAppStore.getState().bumpPluginVersion()
                          })
                        }
                      >
                        停用插件
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={blocked || !active}
                      aria-expanded={selectedProjectPlugin === plugin.id}
                      onClick={() =>
                        setProjectSelection({
                          scope: projectScope,
                          pluginId: selectedProjectPlugin === plugin.id ? null : plugin.id
                        })
                      }
                    >
                      {selectedProjectPlugin === plugin.id ? "收起流程定义" : "查看流程定义"}
                    </Button>
                    {onDerive && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={blocked}
                        onClick={() => onDerive(plugin)}
                      >
                        从此插件创建
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={blocked}
                      onClick={() => setDeleteTarget({ pluginId: plugin.id, name: plugin.name })}
                    >
                      卸载
                    </Button>
                  </div>
                  {active && selectedProjectPlugin === plugin.id && (
                    <Suspense fallback={<p role="status">正在读取插件流程定义…</p>}>
                      <InstalledPluginFlowDefinition
                        key={JSON.stringify([projectScope, installedProjectPluginIdentity(plugin)])}
                        pluginId={plugin.id}
                        name={plugin.name}
                        version={plugin.version}
                      />
                    </Suspense>
                  )}
                  {mod && functionManagement(mod)}
                </div>
              )}
              {plugin.hasProjectMode && !projectMode.loading && !projectMode.enabled && (
                <p className="text-xs text-muted-foreground">当前应用尚未开放项目模式。</p>
              )}
            </article>
          )
        })}
        {installed.length === 0 && (
          <p className="text-xs text-muted-foreground">
            还没有添加插件，可以先到“挑选使用”试一个示例。
          </p>
        )}
      </section>
      <details className="rounded-xl border p-4" data-plugin-import-controls>
        <summary className="cursor-pointer font-medium">从文件添加插件</summary>
        <div className="space-y-3 pt-3">
          <div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              已有插件？上传 ZIP 或选择插件文件夹即可安装。同名、同作者的插件会更新已有版本。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={uploadInput}
              type="file"
              accept=".zip"
              aria-label="选择插件 ZIP 文件"
              className="hidden"
              disabled={blocked}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ""
                if (!file) return
                void run(async () => {
                  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("仅支持 .zip 文件")
                  const result = await window.api.plugins.install(
                    await file.arrayBuffer(),
                    file.name,
                    "local",
                    undefined,
                    "capabilities"
                  )
                  if (!result.success) throw new Error(result.error || "安装失败")
                  useAppStore.getState().bumpPluginVersion()
                  setNotice(installationNotice(result))
                })
              }}
            />
            <Button size="sm" disabled={blocked} onClick={() => uploadInput.current?.click()}>
              上传插件（ZIP）
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={blocked}
              onClick={() =>
                void run(async () => {
                  const result = await window.api.plugins.installFromDir("capabilities")
                  if (!result.success) {
                    if (result.error === "已取消") return
                    throw new Error(result.error || "安装失败")
                  }
                  useAppStore.getState().bumpPluginVersion()
                  setNotice(installationNotice(result))
                })
              }
            >
              从文件夹安装
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={blocked}
              onClick={() =>
                void run(async () => {
                  await window.api.mods.installExamples()
                  useAppStore.getState().bumpPluginVersion()
                  setNotice("示范灵件已添加，点击插件卡片中的“启用”继续。")
                })
              }
            >
              安装示范灵件
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            请选择完整插件文件夹或 ZIP，单个脚本文件无法安装。
          </p>
          <ModsImportGuide />
          {notice && (
            <p role="status" aria-label="灵件操作结果" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
        </div>
      </details>
      <Dialog
        open={active && deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !blocked) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>卸载插件</DialogTitle>
            <DialogDescription>
              确认卸载「{deleteTarget?.name}」的整个来源插件？其中的灵件、技能、工具连接和自动检查
              会一并移除，相关命令与面板停止运行；其他插件保留。聊天记录不受影响，当前组合会移除该插件的灵件引用。
              已保存的搭配和流程模板保留，复用时需重新核对来源。审计记录和已保存的灵件数据不清除。
            </DialogDescription>
          </DialogHeader>
          {error && <SparksOperationError message={error} />}
          <DialogFooter>
            <Button variant="outline" disabled={blocked} onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={blocked || !deleteTarget}
              onClick={() => {
                if (!deleteTarget) return
                const target = deleteTarget
                void run(async () => {
                  const result = await window.api.plugins.delete(target.pluginId)
                  if (!result.success) throw new Error(result.error || "卸载失败")
                  setDeleteTarget(null)
                  useAppStore.getState().bumpPluginVersion()
                })
              }}
            >
              确认卸载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error && !deleteTarget && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 p-4">
          <SparksOperationError message={error} />
          <Button
            size="sm"
            variant="outline"
            disabled={blocked}
            onClick={() => void run(async () => {}, false)}
          >
            重新读取
          </Button>
        </div>
      )}
      {status?.recovery && (
        <div role="alert" className="space-y-2 text-destructive">
          <p>无法读取灵件的权限设置，工具操作已暂停。请关闭应用并联系管理员恢复设置。</p>
          <details className="text-xs">
            <summary className="cursor-pointer">技术详情</summary>
            <p className="mt-2">
              错误：{status.recovery}。请检查控制库和组织策略，保留数据库及 WAL 文件，
              从已核实的完整备份恢复。不要删除数据库重新授权。
            </p>
          </details>
        </div>
      )}
      <details className="space-y-3 rounded-xl border p-4" data-mods-more-settings>
        <summary className="cursor-pointer font-medium">更多设置</summary>
        <p className="pt-3 text-xs text-muted-foreground">
          应用开关会影响其他已授权灵件；项目设置由同目录聊天共用。
        </p>
        <div className="rounded-xl border bg-card p-4 space-y-2">
          <label className="flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={globalEnabled}
              disabled={blocked || !globalLoaded}
              onChange={(event) =>
                void run(async () => {
                  const value = await window.api.mods.configureGlobal(event.target.checked)
                  setGlobalEnabled(value)
                })
              }
            />
            允许使用灵件
          </label>
          <p className="text-xs text-muted-foreground">
            此开关只控制灵件提供的聊天界面和自动操作，不影响上方项目插件的启用状态。
          </p>
        </div>
        {status && !status.recovery && threadId && (
          <>
            <p className="text-xs text-muted-foreground break-all">当前项目：{status.workspace}</p>
            <div className="flex flex-wrap gap-5">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={status.enabled}
                  disabled={blocked || !globalLoaded || !globalEnabled}
                  onChange={(event) =>
                    void run(() =>
                      window.api.mods.configure(
                        threadId,
                        event.target.checked,
                        status.outputPolicy,
                        status.workspace
                      )
                    )
                  }
                />
                在此项目使用灵件
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={status.outputPolicy}
                  disabled={blocked || !globalLoaded || !globalEnabled || status.policy?.required}
                  onChange={(event) =>
                    void run(() =>
                      window.api.mods.configure(
                        threadId,
                        status.enabled,
                        event.target.checked,
                        status.workspace
                      )
                    )
                  }
                />
                检查回答中的敏感信息{status.policy?.required ? "（组织要求）" : ""}
              </label>
            </div>
            {status.outputPolicy && (
              <p className="text-xs text-muted-foreground">
                检查回答中是否包含常见密钥等敏感信息。开启后，完整回答检查通过才会显示，无法检查的内容不会显示。
              </p>
            )}
            {status.policy && (
              <details className="text-xs text-muted-foreground break-all">
                <summary className="cursor-pointer">技术详情 · 检查规则版本</summary>
                <p className="mt-2">
                  {status.policy.id} · {status.policy.digest.slice(0, 16)}
                </p>
              </details>
            )}
            <details className="rounded-xl border p-4">
              <summary className="cursor-pointer text-sm">查看进度或排查问题</summary>
              <p className="my-3 text-xs text-muted-foreground">
                在聊天中描述需求并发送，在原任务卡或“任务进展”查看状态、待确认事项和结果。插件面板在“结果”中，技术记录可展开排查详情。
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  goToConfigurationThread({ threadId, workspace: status.workspace }, () =>
                    openClawSidebar("results")
                  )
                }}
              >
                去这段聊天查看记录
              </Button>
            </details>
            {status.functionMods?.some(
              (mod) => !installed.some((plugin) => plugin.id === mod.pluginId)
            ) && (
              <details>
                <summary className="cursor-pointer">其他插件权限</summary>
                <div className="space-y-3 pt-3">
                  {status.functionMods
                    .filter((mod) => !installed.some((plugin) => plugin.id === mod.pluginId))
                    .map((mod) => (
                      <div key={mod.pluginId} className="space-y-3 rounded-lg border p-3">
                        <strong>{mod.name}</strong>
                        {functionManagement(mod)}
                      </div>
                    ))}
                </div>
              </details>
            )}
            <details>
              <summary className="cursor-pointer">模块与权限（{status.mods.length}）</summary>
              <div className="max-h-64 overflow-auto mt-2 space-y-2">
                {status.mods.map((mod) => (
                  <div
                    key={mod.pluginId}
                    className="rounded border p-3 space-y-1"
                    data-mod-id={mod.manifest?.id}
                  >
                    <div className="flex justify-between gap-3">
                      <strong>{mod.manifest?.name ?? mod.pluginId}</strong>
                      <span>
                        {
                          {
                            ready: "已授权",
                            disabled: "插件已禁用",
                            "needs-approval": "等待授权",
                            invalid: "清单无效"
                          }[mod.state]
                        }
                      </span>
                    </div>
                    {mod.manifest && (
                      <>
                        <p className="text-xs">增强工具：{mod.manifest.tools.join("、") || "无"}</p>
                        <p className="text-xs">
                          读取能力：{mod.manifest.permissions.readTools.join("、") || "无"}
                          ；执行能力：{mod.manifest.permissions.writeTools.join("、") || "无"}
                        </p>
                        <p className="text-xs">
                          上下文：{mod.manifest.permissions.context.join("、") || "无"}
                          ；插件状态存储：{mod.manifest.permissions.store ? "允许" : "不申请"}
                          ；文本产物：{mod.manifest.permissions.artifacts ? "允许" : "不申请"}
                        </p>
                      </>
                    )}
                    <p className="text-xs font-mono break-all">
                      版本摘要：{mod.digest ?? mod.error}
                    </p>
                    {mod.state === "needs-approval" && mod.digest && (
                      <Button
                        size="sm"
                        disabled={blocked}
                        onClick={() =>
                          void run(() =>
                            window.api.mods.approve(
                              threadId,
                              mod.pluginId,
                              mod.digest!,
                              status.workspace
                            )
                          )
                        }
                      >
                        授权以上权限
                      </Button>
                    )}
                    {mod.state === "ready" && mod.manifest && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={blocked}
                        onClick={() =>
                          void run(() =>
                            window.api.mods.revoke(threadId, mod.manifest!.id, status.workspace)
                          )
                        }
                      >
                        撤销权限
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </details>
            {status.diagnostics.length > 0 && (
              <details>
                <summary>运行诊断</summary>
                {status.diagnostics.map((item, index) => (
                  <p className="text-xs" key={`${item.at}-${index}`}>
                    {item.modId} · {item.code}
                  </p>
                ))}
              </details>
            )}
          </>
        )}
      </details>
    </section>
  )
}
