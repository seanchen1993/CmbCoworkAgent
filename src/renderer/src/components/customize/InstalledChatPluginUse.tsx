import { useEffect, useRef, useState } from "react"
import type { PluginStartUseInput, PluginStartUseReport } from "../../../../shared/plugin-start-use"
import type { ModCommandDescriptor, ModWorkspaceStatus } from "../../../../shared/mods/types"
import { captureConfigurationScope, goToConfigurationThread } from "@/lib/configuration-target"
import { useAppStore } from "@/lib/store"
import { openClawSidebar } from "@/lib/claw-sidebar"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"
import { FunctionPluginApproval } from "./FunctionPluginApproval"

/** Native consent, then actual registrations. Discovery never silently enables a plugin. */
export function InstalledChatPluginUse({
  input,
  report,
  purpose
}: {
  input: PluginStartUseInput
  report: PluginStartUseReport
  purpose?: "dependency"
}) {
  const [current, setCurrent] = useState(report)
  const [workspace, setWorkspace] = useState<ModWorkspaceStatus>()
  const [global, setGlobal] = useState(false)
  const [commands, setCommands] = useState<ModCommandDescriptor[]>([])
  const [panes, setPanes] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const live = useRef(true),
    lock = useRef(false)
  const account = useRef(useAppStore.getState().accountRevision)
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
    state: ModWorkspaceStatus
  ) => Promise<void | (() => void)>
  async function run(action?: Action, requireReady = false) {
    if (lock.current || !live.current) return
    lock.current = true
    setBusy(true)
    setError("")
    setCommands([])
    setPanes([])
    setLoaded(false)
    const scope = captureConfigurationScope(nativeScope)
    const guard = () => {
      if (!live.current || account.current !== useAppStore.getState().accountRevision || !scope())
        throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
    }
    try {
      guard()
      const fresh = await window.api.plugins.prepareStartUse(pinned)
      guard()
      if (fresh.kind !== "chat" || fresh.identity.digest !== pinned.expected.digest)
        throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
      const [state, enabled] = await Promise.all([
        window.api.mods.status(input.threadId),
        window.api.mods.globalEnabled()
      ])
      guard()
      if (!isSameWorkspacePath(state.workspace, input.expectedWorkspace))
        throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      let commit: void | (() => void) = undefined
      if (action) {
        commit = await action(fresh, state)
        guard()
      }
      const after = await window.api.plugins.prepareStartUse(pinned)
      guard()
      const [finalState, finalGlobal] = action
        ? await Promise.all([
            window.api.mods.status(input.threadId),
            window.api.mods.globalEnabled()
          ])
        : [state, enabled]
      guard()
      if (
        requireReady &&
        (!finalGlobal || !finalState.enabled || after.chat?.functionMod?.state !== "ready")
      )
        throw Error("PLUGIN_START_USE_PERMISSION_CHANGED")
      setCurrent(after)
      setWorkspace(finalState)
      setGlobal(finalGlobal)
      if (!finalGlobal || !finalState.enabled || after.chat?.functionMod?.state !== "ready") {
        setCommands([])
        setPanes([])
        setLoaded(false)
      }
      if (typeof commit === "function") commit()
    } catch {
      if (live.current) {
        setCommands([])
        setPanes([])
        setLoaded(false)
        setError("插件、权限或原聊天状态已改变，请重新检查使用条件后继续。")
      }
    } finally {
      lock.current = false
      if (live.current) setBusy(false)
    }
  }
  useEffect(() => {
    live.current = true
    void run()
    return () => {
      live.current = false
    }
    // The parent keys this form by exact installation, thread, scope and account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const mod = current.chat?.functionMod
  const ready = mod?.state === "ready" && global && workspace?.enabled
  return (
    <section aria-label="聊天插件使用入口" className="space-y-3 rounded border p-3">
      <h4 className="font-medium">
        {current.identity.name} 的{purpose === "dependency" ? "依赖授权" : "聊天使用方式"}
      </h4>
      {mod && (
        <>
          <p className="text-sm">先核对原生权限；总开关、项目开关与代码授权需要分别确认。</p>
          <p role="status" className="text-sm">
            此插件代码：
            {mod.state === "ready"
              ? "已获原生授权"
              : mod.state === "needs-approval"
                ? "等待用户确认权限"
                : mod.state === "invalid"
                  ? "源码校验未通过"
                  : "当前未启用"}
          </p>
          <button
            className="rounded border px-3 py-2"
            disabled={busy || global}
            onClick={() =>
              void run(async () => {
                await window.api.mods.configureGlobal(true)
              })
            }
          >
            {global ? "灵件总开关已开启" : "开启灵件总开关"}
          </button>
          <button
            className="ml-2 rounded border px-3 py-2"
            disabled={busy || !global || workspace?.enabled}
            onClick={() =>
              void run(async (_fresh, state) => {
                await window.api.mods.configure(
                  input.threadId,
                  true,
                  state.outputPolicy,
                  input.expectedWorkspace
                )
              })
            }
          >
            {workspace?.enabled ? "当前项目已启用灵件" : "在当前项目使用灵件"}
          </button>
          <FunctionPluginApproval
            mod={mod}
            threadId={input.threadId}
            workspace={input.expectedWorkspace}
            busy={busy}
            onApprove={() =>
              void run(async (fresh) => {
                const exact = fresh.chat?.functionMod
                if (
                  !exact?.digest ||
                  exact.pluginId !== input.pluginId ||
                  exact.digest !== mod.digest
                )
                  throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
                await window.api.mods.approveFunction(
                  input.threadId,
                  exact.pluginId,
                  exact.digest,
                  input.expectedWorkspace
                )
              })
            }
          />
          {purpose !== "dependency" && (
            <>
              <button
                className="rounded border px-3 py-2"
                disabled={busy || !ready}
                onClick={() =>
                  void run(async (fresh) => {
                    const exact = fresh.chat?.functionMod
                    if (!exact?.digest || exact.state !== "ready")
                      throw Error("PLUGIN_START_USE_PERMISSION_CHANGED")
                    const actual = await window.api.mods.commands(input.threadId)
                    const drawings = await window.api.mods.panes(input.threadId)
                    return () => {
                      setCommands(
                        actual.filter(
                          (command) =>
                            !command.isHidden &&
                            command.modId === `function:${exact.name}` &&
                            command.digest === exact.digest
                        )
                      )
                      setPanes(
                        drawings
                          .filter((pane) => pane.plugin === exact.name)
                          .map((pane) => pane.title)
                      )
                      setLoaded(true)
                    }
                  }, true)
                }
              >
                读取实际注册的命令与面板入口
              </button>
              {loaded && (
                <div role="status" className="space-y-2 text-sm">
                  {commands.map((command) => (
                    <p key={command.command}>
                      <code>/{command.command}</code>
                      {command.argumentHint ? ` ${command.argumentHint}` : ""}：{command.name}
                    </p>
                  ))}
                  {panes.map((title, index) => (
                    <p key={`${title}-${index}`}>已打开面板：{title}</p>
                  ))}
                  {!commands.length && !panes.length && (
                    <p>
                      当前插件没有注册可见命令或打开的面板。它可能通过事件、工具或聊天组件生效；不能据此假定已完成业务任务。
                    </p>
                  )}
                  {!!commands.length && (
                    <p>返回原聊天后输入上述命令，填写参数并确认发送；这里不自动执行命令。</p>
                  )}
                  {!!panes.length && (
                    <button
                      className="rounded border px-3 py-2"
                      onClick={() =>
                        void run(async () => () => {
                          if (
                            !goToConfigurationThread(nativeScope, () => openClawSidebar("results"))
                          )
                            throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
                        })
                      }
                    >
                      查看此聊天已打开的面板
                    </button>
                  )}
                </div>
              )}
              <button
                className="rounded border px-3 py-2"
                disabled={busy}
                onClick={() =>
                  void run(async () => () => {
                    if (
                      !goToConfigurationThread(nativeScope, () => openClawSidebar("configuration"))
                    )
                      throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
                  })
                }
              >
                前往此聊天的原生常用搭配设置
              </button>
            </>
          )}
        </>
      )}
      {purpose !== "dependency" && !!current.chat?.skills.length && (
        <div className="space-y-2 text-sm">
          <p>本插件公开的技能入口：</p>
          {current.chat.skills.map((skill) => (
            <p key={skill.id}>
              <code>/{skill.name}</code>：{skill.description || "作者未提供描述"}
            </p>
          ))}
          <p>
            返回原聊天，输入技能名称，在斜杠菜单中选择本插件的对应项，补充需求后发送；同名技能需要核对插件来源。
          </p>
        </div>
      )}
      {!mod && !current.chat?.skills.length && (
        <p className="text-sm">
          未发现该插件公开的聊天命令或技能入口。请核对插件声明与使用说明，不能据此认定已经可运行。
        </p>
      )}
      <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void run()}>
        {purpose === "dependency" ? "重新核对依赖授权" : "重新核对聊天使用条件"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
