import { PluginDerivationPanel } from "./PluginDerivationPanel"
import {
  sameSimpleAuthoringScope,
  type SimpleAuthoringPracticeIntent
} from "@/lib/simple-authoring-intent"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ModWorkspaceStatus } from "../../../../shared/mods/types"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { openClawSidebar } from "@/lib/claw-sidebar"
import { openDerivedProject } from "@/lib/derived-project-intent"
import { openPluginSettings } from "@/lib/plugin-settings-intent"
import { useFeatureGate } from "@/lib/feature-gates"
import { FEATURE_GATES } from "../../../../shared/feature-gates"
import type { PluginInstallResult } from "../../../../shared/plugin-install"
import { ModCreator } from "./ModCreator"
import { FunctionCompletionPolicy } from "./FunctionCompletionPolicy"
import { FunctionCompatibilityCheck } from "./FunctionCompatibilityCheck"
import { FunctionUserConfig } from "./FunctionUserConfig"
import { ModsGuide, ModsSetupProgress } from "./ModsGuide"
import { ModsImportGuide } from "./ModsImportGuide"
import { SparksDocumentationLink } from "./SparksDocumentationLink"
import { OfficialSparksExamples } from "./OfficialSparksExamples"
import { SparksOperationError } from "./SparksOperationError"
import { readReuseSelection, subscribeReuseSelection } from "./development-reuse-receipts"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog"

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
  onOpenReuseThread,
  developmentAllowed,
  active = true,
  navigationRequest,
  onSectionChange
}: {
  threadId: string | null
  workspaceHint?: string | null
  onReturnToChat?: () => void
  onOpenReuseThread?: (threadId: string) => Promise<void>
  developmentAllowed?: boolean
  active?: boolean
  navigationRequest?: {
    id: number
    section: "examples" | "create"
    practice?: SimpleAuthoringPracticeIntent
  }
  onSectionChange?: (section: "examples" | "create" | "installed") => void
}): React.JSX.Element {
  const [section, setSection] = useState<"examples" | "create" | "installed">("examples")
  const [advanced, setAdvanced] = useState(false)
  const [createKind, setCreateKind] = useState<"new" | "derive">("new")
  const [sourceRequest, setSourceRequest] = useState<{
    id: string
    pluginId: string
    name: string
  } | null>(null)
  const [settingsVisited, setSettingsVisited] = useState(false)
  const [consumedNavigation, setConsumedNavigation] = useState<number | null>(null)
  useEffect(() => {
    if (active) onSectionChange?.(section)
  }, [active, section, onSectionChange])
  if (active && navigationRequest && navigationRequest.id !== consumedNavigation) {
    setConsumedNavigation(navigationRequest.id)
    setSection(navigationRequest.section)
    if (navigationRequest.section === "create") setAdvanced(false)
    if (
      navigationRequest.practice?.target === "derive-source" &&
      sameSimpleAuthoringScope(navigationRequest.practice.scope, {
        threadId,
        workspace: workspaceHint
      })
    )
      setCreateKind("derive")
  }
  const selectionScope = JSON.stringify([threadId, workspaceHint])
  useEffect(
    () =>
      subscribeReuseSelection(selectionScope, () => {
        if (readReuseSelection(selectionScope)) {
          setSection("create")
          setAdvanced(false)
        }
      }),
    [selectionScope]
  )
  const editorActive = section === "create"
  const chooseSection = (next: typeof section) => {
    setSection(next)
    if (next === "installed") setSettingsVisited(true)
  }
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">灵件</h1>
        <SparksDocumentationLink />
      </div>
      <p className="text-sm text-muted-foreground">为聊天添加新功能，或制作自己的插件。</p>
      <div className="rounded-lg bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        <p>
          {threadId
            ? "选好后确认权限，即可在这段聊天中使用。"
            : "可以先添加灵件；使用时需要打开聊天。"}
        </p>
        <p className="mt-1 break-all">
          {workspaceHint
            ? `当前项目：${workspaceHint}`
            : "尚未选择项目目录。使用前请为聊天选择项目。"}
        </p>
      </div>
      <nav aria-label="灵件工作区" className="flex flex-wrap gap-1 border-b pb-3">
        {(
          [
            ["examples", "挑选使用"],
            ["installed", "我已添加"],
            ["create", "自己制作"]
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
      <div hidden={!editorActive} inert={!editorActive}>
        <div className="mb-4 flex flex-wrap gap-2" aria-label="制作方式">
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
            key={JSON.stringify([threadId, normalizeWorkspacePathKey(workspaceHint)])}
            threadId={threadId}
            workspaceHint={workspaceHint}
            active={active && section === "installed"}
            onDerive={(plugin) => {
              setSourceRequest({ id: crypto.randomUUID(), pluginId: plugin.id, name: plugin.name })
              setCreateKind("derive")
              setSection("create")
            }}
          />
        )}
      </div>
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
  const uploadInput = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState("")
  const [installed, setInstalled] = useState<Awaited<ReturnType<typeof window.api.plugins.list>>>(
    []
  )
  const [deleteTarget, setDeleteTarget] = useState<{ pluginId: string; name: string } | null>(null)
  useEffect(() => {
    if (!active) setDeleteTarget(null)
  }, [active])
  const [status, setStatus] = useState<ModWorkspaceStatus | null>(null)
  const [globalEnabled, setGlobalEnabled] = useState(false)
  const [globalLoaded, setGlobalLoaded] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const alive = useRef(false)
  const running = useRef(false)
  const readVersion = useRef(0)
  const installedMods = installed.filter(
    (plugin) =>
      (plugin.modCount ?? 0) > 0 ||
      status?.functionMods?.some((mod) => mod.pluginId === plugin.id) ||
      status?.mods.some((mod) => mod.pluginId === plugin.id)
  )
  const installationNotice = (result: PluginInstallResult) => {
    const name = result.pluginName ?? "插件"
    return result.kind === "plugin"
      ? `已安装 ${name}。${result.enabled ? "已启用，可继续使用原有功能。" : "尚未启用，请在下方点击“启用插件”。"}原有技能和检查规则已保留。`
      : `已安装 ${name}。请在下方核对灵件权限；安装不会自动开始任务。`
  }
  const refresh = useCallback(async () => {
    const version = ++readVersion.current
    try {
      const [plugins, enabled, workspace] = await Promise.allSettled([
        window.api.plugins.list(),
        window.api.mods.globalEnabled(),
        readWorkspaceStatus(threadId)
      ])
      if (!alive.current || version !== readVersion.current) return
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
      if (plugins.status === "fulfilled") setInstalled(plugins.value)
      if (enabled.status === "fulfilled") setGlobalEnabled(enabled.value)
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
  }, [threadId, workspaceHint])
  useEffect(() => {
    alive.current = true
    const update = () => {
      if (running.current) return
      void refresh().catch((cause) => {
        if (alive.current)
          setError(cause instanceof Error ? cause.message : "无法读取 灵件状态，请重试。")
      })
    }
    update()
    const stop = window.api.mods.onConfigurationChanged(update)
    window.addEventListener("mods:configuration-changed", update)
    return () => {
      alive.current = false
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
      if (!alive.current) return
      await refresh()
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : "操作失败")
    } finally {
      running.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <section className="w-full space-y-5 text-sm" data-mods-settings aria-label="灵件设置">
      <div className="space-y-1">
        <h2 className="font-semibold">我已添加</h2>
        <p className="text-sm text-muted-foreground">
          AutoBiz 等项目插件和灵件都可以在这里安装。安装后，按插件卡片上的提示继续使用。
        </p>
      </div>
      {installedMods.length > 0 && (
        <ModsSetupProgress
          installed={installedMods.length > 0}
          globalLoaded={globalLoaded}
          readFailed={readFailed}
          globalEnabled={globalEnabled}
          workspace={status}
          authorized={Boolean(
            status?.mods.some((mod) => mod.state === "ready") ||
            status?.functionMods?.some((mod) => mod.state === "ready")
          )}
        />
      )}
      <div className="space-y-3">
        <div>
          <h3 className="font-semibold">添加能力</h3>
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
            disabled={busy}
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
          <Button size="sm" disabled={busy} onClick={() => uploadInput.current?.click()}>
            上传插件（ZIP）
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
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
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await window.api.mods.installExamples()
                useAppStore.getState().bumpPluginVersion()
                setNotice(
                  "示范灵件 已安装。接下来开启应用和项目开关，在插件卡片完成授权；使用指南中有可复制的体验命令。"
                )
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
      <section
        aria-label="已安装插件"
        data-installed-mods
        className="space-y-3 rounded-xl border p-4"
      >
        <h3 className="font-medium">已安装插件</h3>
        <p className="text-xs text-muted-foreground">
          保留插件原有功能，无需改写成灵件。启用后，自动检查仍按原插件规则运行。
        </p>
        {installed.map((plugin) => (
          <article
            key={plugin.id}
            aria-label={plugin.name}
            data-installed-mod-id={plugin.id}
            className="space-y-3 rounded-lg bg-muted/30 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="break-all font-medium">{plugin.name}</h4>
              <span className="text-xs text-muted-foreground">
                {plugin.enabled ? "已启用" : "尚未启用"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {plugin.skillCount} 项技能 · {plugin.hookCount ?? 0} 项自动检查
              {` · ${plugin.mcpServerCount} 个工具连接`}
              {(plugin.modCount ?? 0) > 0 ? ` · ${plugin.modCount} 个灵件模块` : ""}
              {plugin.hasProjectMode ? " · 支持项目模式" : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => openPluginSettings(plugin.id)}
              >
                设置使用
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await window.api.plugins.setEnabled(plugin.id, !plugin.enabled)
                    if (result?.success === false)
                      throw new Error(result.error || "启用状态未能保存，请重试。")
                    useAppStore.getState().bumpPluginVersion()
                  })
                }
              >
                {plugin.enabled ? "停用插件" : "启用插件"}
              </Button>
              {plugin.hasProjectMode && (
                <Button
                  size="sm"
                  disabled={busy || !plugin.enabled || !projectMode.enabled}
                  onClick={() => openDerivedProject(plugin.id, plugin.name)}
                >
                  新建项目
                </Button>
              )}
              {onDerive && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onDerive(plugin)}
                >
                  从此插件创建
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setDeleteTarget({ pluginId: plugin.id, name: plugin.name })}
              >
                卸载
              </Button>
            </div>
            {plugin.hasProjectMode && !plugin.enabled && (
              <p className="text-xs text-muted-foreground">
                先启用插件，再新建项目。已有项目继续使用原来的设置。
              </p>
            )}
            {plugin.hasProjectMode && !projectMode.loading && !projectMode.enabled && (
              <p className="text-xs text-muted-foreground">当前应用尚未开放项目模式。</p>
            )}
            {!plugin.hasProjectMode && (
              <p className="text-xs text-muted-foreground">
                {plugin.skillCount > 0 ? "启用后可在聊天中使用技能。" : ""}
                {plugin.mcpServerCount > 0 ? "工具连接可在“设置使用”中查看。" : ""}
                {(plugin.hookCount ?? 0) > 0 ? "自动检查按原插件规则运行。" : ""}
              </p>
            )}
            {(plugin.modCount ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">灵件还需在下方核对并确认项目权限。</p>
            )}
          </article>
        ))}
        {installed.length === 0 && (
          <p className="text-xs text-muted-foreground">
            还没有添加插件，可以先到“挑选使用”试一个示例。
          </p>
        )}
      </section>
      <div className="rounded-xl border bg-card p-4 space-y-2">
        <label className="flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={globalEnabled}
            disabled={busy || !globalLoaded}
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
      <Dialog
        open={active && deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>卸载插件</DialogTitle>
            <DialogDescription>
              确认卸载「{deleteTarget?.name}」的整个来源插件？其中的灵件、技能、工具连接和自动检查
              会一并移除，相关命令与面板停止运行；其他插件保留。审计记录和已保存的灵件 数据不清除。
            </DialogDescription>
          </DialogHeader>
          {error && <SparksOperationError message={error} />}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !deleteTarget}
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
      {!status && !readFailed && (
        <p className="rounded-xl border border-dashed p-4 text-sm leading-relaxed text-muted-foreground">
          为当前会话选择项目目录后配置权限；安装和卸载无需项目目录。
        </p>
      )}
      {error && !deleteTarget && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 p-4">
          <SparksOperationError message={error} />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
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
      {status && !status.recovery && threadId && (
        <>
          <p className="text-xs text-muted-foreground break-all">当前项目：{status.workspace}</p>
          <div className="flex flex-wrap gap-5">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={status.enabled}
                disabled={busy || !globalLoaded || !globalEnabled}
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
                disabled={busy || !globalLoaded || !globalEnabled || status.policy?.required}
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
              步骤结果、检查记录和项目调用记录已集中到聊天右侧的“运行过程”。
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                useAppStore.getState().setShowCustomizeView(false)
                openClawSidebar("results")
              }}
            >
              打开运行过程
            </Button>
          </details>
          {(status.functionMods?.length ?? 0) > 0 && (
            <details open>
              <summary className="cursor-pointer">
                允许哪些插件访问项目（{status.functionMods!.length}）
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                确认插件可以做什么，再点击授权。插件代码更新后需要重新确认。
              </p>
              <div className="mt-2 space-y-2">
                {status.functionMods!.map((mod) => (
                  <div
                    key={mod.pluginId}
                    className="rounded-xl border bg-card p-4 space-y-3"
                    data-function-mod-id={mod.name}
                  >
                    <div className="flex justify-between gap-3">
                      <strong>{mod.name}</strong>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${mod.state === "ready" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                      >
                        {
                          {
                            ready: "已授权",
                            disabled: "插件已禁用",
                            "needs-approval": "等待授权",
                            invalid: "插件无效"
                          }[mod.state]
                        }
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      可读取项目、扩展工具与界面、调用已配置的模型。模型调用产生实际用量；写文件与执行命令仍需批准最终参数。
                    </p>
                    <details className="rounded-lg bg-muted/30 px-3 py-2 text-xs">
                      <summary className="cursor-pointer font-medium">查看完整能力与版本</summary>
                      <p className="pt-2 leading-relaxed text-muted-foreground">
                        允许注册命令和主助手的自定义工具、读取项目文件与会话标识、保存偏好、打开交互组件、调用或拦截工具及调用已配置的模型。
                        写文件和执行命令仍需批准最终参数；即时查询命令不能执行写操作。
                        模型调用自定义工具时可读取项目，不能借此自动执行写操作。
                        模型请求会产生实际用量，限每插件每项目每分钟 30 次及 32768 个预留输出
                        Token。
                      </p>
                      <p className="text-xs font-mono break-all">
                        版本摘要：{mod.digest ?? mod.error}
                      </p>
                    </details>
                    {mod.state === "needs-approval" && mod.digest && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            window.api.mods.approveFunction(
                              threadId,
                              mod.pluginId,
                              mod.digest!,
                              status.workspace
                            )
                          )
                        }
                      >
                        授权以上能力
                      </Button>
                    )}
                    {threadId && !!mod.userConfigFieldCount && (
                      <FunctionUserConfig
                        threadId={threadId}
                        pluginId={mod.pluginId}
                        expectedWorkspace={status.workspace}
                      />
                    )}
                    {mod.state === "ready" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            window.api.mods.revokeFunction(threadId, mod.name, status.workspace)
                          )
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
                        disabled={busy}
                      />
                    )}
                    <FunctionCompletionPolicy
                      expectedWorkspace={status.workspace}
                      threadId={threadId}
                      plugin={mod.name}
                      disabled={busy || mod.state !== "ready"}
                    />
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
                  <p className="text-xs font-mono break-all">版本摘要：{mod.digest ?? mod.error}</p>
                  {mod.state === "needs-approval" && mod.digest && (
                    <Button
                      size="sm"
                      disabled={busy}
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
                      disabled={busy}
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
    </section>
  )
}
