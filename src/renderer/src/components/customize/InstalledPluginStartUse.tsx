import { useEffect, useRef, useState } from "react"
import type { PluginStartUseInput, PluginStartUseReport } from "../../../../shared/plugin-start-use"
import { captureConfigurationScope } from "@/lib/configuration-target"
import { openPluginStartUse } from "@/lib/plugin-start-use-intent"
import { useAppStore } from "@/lib/store"
import { FunctionUserConfig } from "./FunctionUserConfig"
import { InstalledChatPluginUse } from "./InstalledChatPluginUse"

const button = "rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
function errorMessage(cause: unknown) {
  const code = cause instanceof Error ? cause.message : ""
  if (/SCOPE_CHANGED|THREAD|INCARNATION/.test(code))
    return "原聊天或目录已变化，请回到原聊天重新打开。"
  if (/CONTENT_CHANGED|IDENTITY_CHANGED/.test(code))
    return "插件源码或版本已改变，请核对当前安装后重新开始。"
  if (/PLUGIN_UNAVAILABLE/.test(code)) return "插件已停用或卸载，请恢复安装后重新检查。"
  return "暂时无法确认使用条件，请检查插件配置与环境后重新检查。"
}

export function InstalledPluginStartUse(props: {
  threadId: string
  workspace: string
  pluginId: string
  expected: PluginStartUseInput["expected"]
  purpose?: "dependency"
}) {
  const accountRevision = useAppStore((state) => state.accountRevision)
  return <ScopedStartUse key={JSON.stringify([accountRevision, props])} {...props} />
}
function ScopedStartUse({
  threadId,
  workspace,
  pluginId,
  expected,
  purpose
}: Parameters<typeof InstalledPluginStartUse>[0]) {
  const [report, setReport] = useState<PluginStartUseReport>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const active = useRef(true)
  const lock = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const input: PluginStartUseInput = { threadId, expectedWorkspace: workspace, pluginId, expected }
  const check = async (open: boolean, enable = false) => {
    if (lock.current || !active.current) return
    lock.current = true
    setBusy(true)
    setError("")
    const account = useAppStore.getState().accountRevision
    const current = captureConfigurationScope({ threadId, workspace })
    try {
      const actualInput = {
        ...input,
        expected:
          (open || enable) && report
            ? {
                name: report.identity.name,
                version: report.identity.version,
                digest: report.identity.digest
              }
            : expected
      }
      // Re-read before enabling so a late account/scope change cannot dispatch a mutation.
      let next = await window.api.plugins.prepareStartUse(actualInput)
      if (!active.current) return
      if (useAppStore.getState().accountRevision !== account || !current())
        throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      if (enable && next.activationRequired) {
        next = await window.api.plugins.enableStartUse(actualInput)
        if (!active.current) return
        if (useAppStore.getState().accountRevision !== account || !current())
          throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      }
      setReport(next)
      if (open) openPluginStartUse(actualInput, next)
    } catch (cause) {
      if (active.current) {
        setReport(undefined)
        setError(errorMessage(cause))
      }
    } finally {
      lock.current = false
      if (active.current) setBusy(false)
    }
  }
  const configuration = report?.issues.some(
    (issue) => issue.code === "configuration" || issue.code === "knowledge"
  )
  return (
    <section aria-label="已安装插件开始使用" className="space-y-3 rounded-lg border p-3">
      <p className="text-sm">
        {purpose === "dependency"
          ? "在这里完成此依赖的启用、原生授权和配置，然后继续准备模板。"
          : "直接核对新插件的入口、配置与运行条件，然后进入对应使用表单。"}
      </p>
      <button type="button" disabled={busy} className={button} onClick={() => void check(false)}>
        {busy
          ? "正在核对使用条件…"
          : report
            ? "重新检查使用条件"
            : purpose === "dependency"
              ? "核对依赖使用条件"
              : "开始使用"}
      </button>
      {report && (
        <>
          {report.activationRequired && (
            <div className="space-y-2 rounded border p-3">
              <p className="text-sm">
                新插件已安装，尚未启用。启用后将重新检查配置和使用入口；运行权限仍需另行确认。
              </p>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void check(false, true)}
              >
                启用新插件
              </button>
            </div>
          )}
          <p role="status" className="text-sm">
            {purpose === "dependency"
              ? "完成后请继续本页的模板准备，无需离开此流程。"
              : report.kind === "host-project"
                ? "此插件通过本地项目任务使用，下一步将直接打开已选好模板的创建表单。"
                : report.kind === "plugin-project"
                  ? "此插件通过项目流程使用，下一步将打开对应插件的项目入口。"
                  : "此插件用于聊天，下一步返回当前配置所对应的聊天。"}
          </p>
          {report.issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {report.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>{issue.message}</li>
              ))}
            </ul>
          )}
          {configuration && (
            <div className="space-y-2 rounded border p-3">
              <p className="text-sm font-medium">补齐当前聊天的插件配置与知识绑定</p>
              <FunctionUserConfig
                threadId={threadId}
                pluginId={pluginId}
                expectedWorkspace={workspace}
              />
              <p className="text-xs text-muted-foreground">
                保存后点击“重新检查使用条件”。新项目仍会按实际工作目录重新核对配置和权限。
              </p>
            </div>
          )}
          {report.kind === "chat" && !report.activationRequired && (
            <InstalledChatPluginUse input={input} report={report} purpose={purpose} />
          )}
          {purpose !== "dependency" && (
            <>
              <button
                type="button"
                disabled={busy || !report.canOpen}
                className={button}
                onClick={() => void check(true)}
              >
                {report.kind === "host-project"
                  ? "进入本地任务创建"
                  : report.kind === "plugin-project"
                    ? "进入项目创建"
                    : "返回原聊天使用上述入口"}
              </button>
              <p className="text-xs text-muted-foreground">
                进入表单不会创建项目、启动步骤或自动授权；填写并确认后才执行对应原生操作。
              </p>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
