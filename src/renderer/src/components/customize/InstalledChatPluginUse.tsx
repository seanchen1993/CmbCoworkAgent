import { useEffect, useRef, useState } from "react"
import type { PluginStartUseInput, PluginStartUseReport } from "../../../../shared/plugin-start-use"
import type { ModCommandDescriptor, ModWorkspaceStatus } from "../../../../shared/mods/types"
import { captureConfigurationScope, goToConfigurationThread } from "@/lib/configuration-target"
import { useAppStore } from "@/lib/store"
import { openClawSidebar } from "@/lib/claw-sidebar"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import { FunctionPluginApproval } from "./FunctionPluginApproval"
import { FunctionUserConfig } from "./FunctionUserConfig"
import {
  applyInstalledPluginUse,
  prepareInstalledPluginUse,
  type InstalledPluginUsePlan
} from "@/lib/community-example-use"

const needsPluginConfiguration = (report: PluginStartUseReport) =>
  report.issues.some(
    (issue) =>
      ["configuration", "knowledge"].includes(issue.code) && issue.resolution === "plugin-settings"
  )

/** Explicit consent prepares native switches and the exact source; it never runs a task. */
export function InstalledChatPluginUse({
  input,
  report,
  purpose,
  disabled = false,
  onBusyChange,
  onReportChange,
  onReadyChange
}: {
  input: PluginStartUseInput
  report: PluginStartUseReport
  purpose?: "dependency"
  disabled?: boolean
  onBusyChange?(busy: boolean): void
  onReportChange?(report: PluginStartUseReport): void
  onReadyChange?(ready: boolean): void
}) {
  const [current, setCurrent] = useState(report)
  const [workspace, setWorkspace] = useState<ModWorkspaceStatus>()
  const [global, setGlobal] = useState(false)
  const [commands, setCommands] = useState<ModCommandDescriptor[]>([])
  const [panes, setPanes] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [plan, setPlan] = useState<InstalledPluginUsePlan>()
  const live = useRef(true),
    lock = useRef(false)
  const account = useRef(useAppStore.getState().accountRevision)
  // Retain only consent for this mounted exact source and scope while native configuration
  // is completed. The helper rechecks the retained snapshot before resuming any write.
  const confirmed = useRef<InstalledPluginUsePlan | undefined>(undefined)
  const callbacks = useRef({ onBusyChange, onReportChange, onReadyChange, disabled })
  callbacks.current = { onBusyChange, onReportChange, onReadyChange, disabled }
  const pinned = {
    ...input,
    expected: {
      name: report.identity.name,
      version: report.identity.version,
      digest: report.identity.digest
    }
  }
  const nativeScope = { threadId: input.threadId, workspace: input.expectedWorkspace }
  type Action = (
    fresh: PluginStartUseReport,
    state: ModWorkspaceStatus,
    globalEnabled: boolean,
    guard: () => void
  ) => Promise<void | (() => void)>
  const assertIdentity = (fresh: PluginStartUseReport) => {
    if (
      fresh.kind !== "chat" ||
      fresh.identity.pluginId !== pinned.pluginId ||
      fresh.identity.name !== pinned.expected.name ||
      fresh.identity.version !== pinned.expected.version ||
      fresh.identity.digest !== pinned.expected.digest
    )
      throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
  }
  async function run(action?: Action, requireReady = false, mutation = false) {
    if (lock.current || !live.current || callbacks.current.disabled) return
    lock.current = true
    setBusy(true)
    callbacks.current.onBusyChange?.(true)
    setError("")
    setLoaded(false)
    setCommands([])
    setPanes([])
    callbacks.current.onReadyChange?.(false)
    const scope = captureConfigurationScope(nativeScope)
    const guard = () => {
      if (
        !live.current ||
        callbacks.current.disabled ||
        account.current !== useAppStore.getState().accountRevision ||
        !scope()
      )
        throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
    }
    let attempted = false
    try {
      guard()
      const fresh = await window.api.plugins.prepareStartUse(pinned)
      guard()
      assertIdentity(fresh)
      const context = { ...nativeScope, workspace: input.expectedWorkspace, assertCurrent: guard }
      const preparePlan = async (value: PluginStartUseReport) => {
        const source = value.chat?.functionMod
        if (!source || source.state === "invalid") return undefined
        if (source.pluginId !== input.pluginId) throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
        const next = await prepareInstalledPluginUse(
          window.api.mods,
          context,
          {
            pluginId: input.pluginId,
            pluginName: source.name,
            activationRequired: value.activationRequired
          },
          value.identity.name
        )
        guard()
        if (next.target.digest !== source.digest) throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
        return next
      }
      const initialPlan = await preparePlan(fresh)
      const [state, enabled] = await Promise.all([
        window.api.mods.status(input.threadId),
        window.api.mods.globalEnabled()
      ])
      guard()
      if (!isSameWorkspacePath(state.workspace, input.expectedWorkspace))
        throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      let commit: void | (() => void) = undefined
      if (action) {
        attempted = mutation
        commit = await action(fresh, state, enabled, guard)
        guard()
      }
      const after = action ? await window.api.plugins.prepareStartUse(pinned) : fresh
      guard()
      assertIdentity(after)
      const [finalState, finalGlobal] = action
        ? await Promise.all([
            window.api.mods.status(input.threadId),
            window.api.mods.globalEnabled()
          ])
        : [state, enabled]
      guard()
      if (!isSameWorkspacePath(finalState.workspace, input.expectedWorkspace))
        throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      let finalPlan = action ? await preparePlan(after) : initialPlan
      const functionReady = Boolean(
        finalGlobal &&
        finalState.enabled &&
        after.chat?.functionMod?.state === "ready" &&
        finalPlan?.selection.alreadySelected &&
        !after.issues.length
      )
      const ready =
        functionReady ||
        Boolean(
          !after.activationRequired &&
            !after.chat?.functionMod &&
            after.chat?.skills.length &&
            !after.issues.length
        )
      if (requireReady && !ready && !(confirmed.current && needsPluginConfiguration(after)))
        throw Error("PLUGIN_START_USE_PERMISSION_CHANGED")
      let actual: ModCommandDescriptor[] = [],
        drawings: string[] = []
      if (functionReady && after.canOpen && purpose !== "dependency") {
        const [registered, openPanes] = await Promise.all([
          window.api.mods.commands(input.threadId),
          window.api.mods.panes(input.threadId)
        ])
        guard()
        const exact = after.chat!.functionMod!
        actual = registered.filter(
          (command) =>
            !command.isHidden &&
            command.modId === `function:${exact.name}` &&
            command.digest === exact.digest
        )
        drawings = openPanes.filter((pane) => pane.plugin === exact.name).map((pane) => pane.title)
        finalPlan = await preparePlan(after)
        if (
          !finalPlan?.selection.alreadySelected ||
          !finalPlan.snapshot.global ||
          !finalPlan.snapshot.status.enabled ||
          finalPlan.snapshot.status.functionMods?.find((item) => item.pluginId === input.pluginId)
            ?.state !== "ready"
        )
          throw Error("PLUGIN_START_USE_PERMISSION_CHANGED")
      }
      setCurrent(after)
      setWorkspace(finalState)
      setGlobal(finalGlobal)
      setPlan(finalPlan)
      setCommands(actual)
      setPanes(drawings)
      setLoaded(ready && after.canOpen)
      callbacks.current.onReportChange?.(after)
      callbacks.current.onReadyChange?.(after.canOpen && ready)
      if (typeof commit === "function") commit()
    } catch (cause) {
      if (live.current) {
        confirmed.current = undefined
        setLoaded(false)
        setCommands([])
        setPanes([])
        setPlan(undefined)
        const message = cause instanceof Error ? cause.message : ""
        setError(
          /SCOPE_CHANGED|IDENTITY_CHANGED|CONTENT_CHANGED|UNAVAILABLE/.test(message)
            ? "聊天或插件已变化，请重新打开。"
            : /上限|超过|组件|同名|组合|选择|重新核对/.test(message)
              ? message
              : "未能完成设置，请重新检查后重试。已完成的设置会保留。"
        )
      }
    } finally {
      lock.current = false
      if (attempted) window.dispatchEvent(new Event("mods:configuration-changed"))
      if (live.current) {
        setBusy(false)
        callbacks.current.onBusyChange?.(false)
      }
    }
  }
  useEffect(() => {
    live.current = true
    void run()
    return () => {
      live.current = false
      callbacks.current.onBusyChange?.(false)
      callbacks.current.onReadyChange?.(false)
    }
    // The parent keys this form by exact installation, thread, scope and account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const mod = current.chat?.functionMod
  const ready = Boolean(
    !current.issues.length &&
      !current.activationRequired &&
      (mod
        ? mod.state === "ready" && global && workspace?.enabled && plan?.selection.alreadySelected
        : current.chat?.skills.length)
  )
  const configuration = needsPluginConfiguration(current)
  const activate = () =>
    void run(
      async (fresh, _state, _enabled, guard) => {
        if (!fresh.chat?.functionMod) {
          if (!fresh.activationRequired) throw Error("PLUGIN_START_USE_PERMISSION_CHANGED")
          const enabled = await window.api.plugins.enableStartUse(pinned)
          guard()
          assertIdentity(enabled)
          return
        }
        if (
          !fresh.chat?.functionMod?.digest ||
          fresh.chat.functionMod.pluginId !== input.pluginId ||
          fresh.chat.functionMod.state === "invalid" ||
          fresh.chat.functionMod.digest !== mod?.digest
        )
          throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
        if (!plan || plan.target.digest !== fresh.chat.functionMod.digest)
          throw Error("PLUGIN_START_USE_PERMISSION_CHANGED")
        const result = await applyInstalledPluginUse(
          window.api.mods,
          { ...nativeScope, workspace: input.expectedWorkspace, assertCurrent: guard },
          plan,
          () => {},
          fresh.activationRequired
            ? {
                enable: async () => {
                  const enabled = await window.api.plugins.enableStartUse(pinned)
                  guard()
                  assertIdentity(enabled)
                },
                configurationReady: async () => {
                  const enabled = await window.api.plugins.prepareStartUse(pinned)
                  guard()
                  assertIdentity(enabled)
                  return !needsPluginConfiguration(enabled)
                }
              }
            : undefined
        )
        guard()
        confirmed.current = result.state === "configuration" ? result.plan : undefined
      },
      true,
      true
    )
  const resumeAfterConfiguration = () => {
    const consent = confirmed.current
    if (!consent) {
      void run()
      return
    }
    void run(
      async (fresh, _state, _enabled, guard) => {
        if (needsPluginConfiguration(fresh)) return
        await applyInstalledPluginUse(
          window.api.mods,
          { ...nativeScope, assertCurrent: guard },
          consent,
          () => {}
        )
        guard()
        confirmed.current = undefined
      },
      true,
      true
    )
  }
  const button = "rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
  const needsSelectionRepair = /上限|组合|组件|同名|选择/.test(error)
  const adjustSelection = () => {
    if (lock.current || disabled) return
    const currentScope = captureConfigurationScope(nativeScope)
    // Repair navigation is read-only and must remain available when this plugin cannot be used.
    if (
      !live.current ||
      account.current !== useAppStore.getState().accountRevision ||
      !currentScope() ||
      !goToConfigurationThread(nativeScope, () => openClawSidebar("configuration"))
    )
      setError("聊天已变化，请重新打开。")
  }
  return (
    <section aria-label="聊天插件使用入口" className="space-y-3 rounded-lg border p-3">
      <h4 className="font-medium">
        {purpose === "dependency" ? "准备依赖" : ready ? "使用方式" : "确认使用此插件"}
      </h4>
      {mod?.state === "invalid" && (
        <p role="alert" className="text-sm text-destructive">
          插件校验未通过，请在插件管理中修复。
        </p>
      )}
      {mod && !ready && !configuration && (
        <>
          {workspace && (!global || !workspace.enabled) && (
            <p className="text-xs text-muted-foreground">
              确认后将开启应用和此目录的灵件功能，其他已授权的功能也可能恢复运行。
            </p>
          )}
          {!!plan?.replacements.length && (
            <p role="alert" className="text-sm">
              将更新当前聊天中的{plan.replacements.map((item) => item.previous.name).join("、")}；
              其他搭配设置保留。
            </p>
          )}
          {plan && !plan.selection.alreadySelected && (
            <p className="text-xs text-muted-foreground">此版本将加入当前聊天的搭配。</p>
          )}
          <FunctionPluginApproval
            mod={mod}
            threadId={input.threadId}
            workspace={input.expectedWorkspace}
            busy={busy || disabled || !workspace || !plan}
            approvalRequired={mod.state !== "ready"}
            approveLabel={purpose === "dependency" ? "确认准备依赖" : "确认并进入使用"}
            showConfiguration={false}
            onApprove={activate}
          />
          {mod.state === "ready" && (
            <button className={button} disabled={busy || disabled || !plan} onClick={activate}>
              {purpose === "dependency" ? "确认准备依赖" : "确认并进入使用"}
            </button>
          )}
        </>
      )}
      {!mod && current.activationRequired && (
        <div className="space-y-2 text-sm">
          <p>确认后启用此已安装版本，并显示它的聊天技能入口。</p>
          <p className="break-all text-xs text-muted-foreground">
            版本摘要：{current.identity.digest}
          </p>
          <button className={button} disabled={busy || disabled} onClick={activate}>
            {purpose === "dependency" ? "确认准备依赖" : "确认并进入使用"}
          </button>
        </div>
      )}
      {configuration && (
        <div className="space-y-2 rounded border p-3">
          <p className="text-sm font-medium">
            {confirmed.current ? "已确认此版本，保存配置后继续使用" : "填写后即可继续"}
          </p>
          <FunctionUserConfig
            threadId={input.threadId}
            pluginId={input.pluginId}
            expectedWorkspace={input.expectedWorkspace}
            expectedDigest={mod?.digest}
            initiallyOpen
            onSaved={resumeAfterConfiguration}
          />
        </div>
      )}
      {ready && purpose === "dependency" && <p role="status">依赖已就绪，可以继续制作。</p>}
      {purpose !== "dependency" && loaded && (
        <div className="space-y-2 text-sm" role="status">
          {commands.map((command) => (
            <p key={command.command}>
              <code>/{command.command}</code>
              {command.argumentHint ? ` ${command.argumentHint}` : ""}
              {` · ${command.name}`}
            </p>
          ))}
          {!!commands.length && (
            <p className="text-xs text-muted-foreground">在聊天中输入命令并发送。</p>
          )}
          {!!panes.length && (
            <button
              className={button}
              disabled={busy || disabled}
              onClick={() =>
                void run(
                  async () => () => {
                    if (!goToConfigurationThread(nativeScope, () => openClawSidebar("results")))
                      throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
                  },
                  true
                )
              }
            >
              查看面板
            </button>
          )}
          {!commands.length && !panes.length && !current.chat?.skills.length && (
            <p>请按插件说明触发功能。</p>
          )}
        </div>
      )}
      {purpose !== "dependency" && !!current.chat?.skills.length && (
        <div className="space-y-1 text-sm">
          {current.chat.skills.map((skill) => (
            <p key={skill.id}>
              <code>/{skill.name}</code>
              {skill.description ? ` · ${skill.description}` : ""}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">
            在聊天中输入技能名称，选择本插件的技能后发送需求。
          </p>
        </div>
      )}
      {!mod && !current.activationRequired && !current.chat?.skills.length && (
        <p className="text-sm">未找到聊天入口，请检查插件说明。</p>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">更多操作</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className={button} disabled={busy || disabled} onClick={() => void run()}>
            重新检查
          </button>
          {purpose !== "dependency" && !needsSelectionRepair && (
            <button className={button} disabled={busy || disabled} onClick={adjustSelection}>
              调整聊天搭配
            </button>
          )}
        </div>
      </details>
      {error && (
        <div className="space-y-2 text-sm text-destructive">
          <p role="alert">{error}</p>
          <button className={button} disabled={busy || disabled} onClick={() => void run()}>
            重新检查
          </button>
          {purpose !== "dependency" && needsSelectionRepair && (
            <button className={button} disabled={busy || disabled} onClick={adjustSelection}>
              调整聊天搭配
            </button>
          )}
        </div>
      )}
    </section>
  )
}
