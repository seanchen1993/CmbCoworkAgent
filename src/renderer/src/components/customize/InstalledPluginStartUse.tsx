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
  const start = async (openChat = false) => {
    if (lock.current || !active.current) return
    lock.current = true
    setBusy(true)
    setError("")
    const account = useAppStore.getState().accountRevision
    const current = captureConfigurationScope({ threadId, workspace })
    try {
      const actualInput = {
        ...input,
        expected: report
          ? {
              name: report.identity.name,
              version: report.identity.version,
              digest: report.identity.digest
            }
          : expected
      }
      // One user action prepares the exact installation and opens its native use form.
      let next = await window.api.plugins.prepareStartUse(actualInput)
      if (!active.current) return
      if (useAppStore.getState().accountRevision !== account || !current())
        throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      const pinnedInput = {
        ...actualInput,
        expected: {
          name: next.identity.name,
          version: next.identity.version,
          digest: next.identity.digest
        }
      }
      if (
        next.identity.pluginId !== pluginId ||
        next.identity.name !== actualInput.expected.name ||
        next.identity.version !== actualInput.expected.version ||
        (actualInput.expected.digest && next.identity.digest !== actualInput.expected.digest)
      )
        throw Error("PLUGIN_START_USE_IDENTITY_CHANGED")
      if (next.activationRequired) {
        next = await window.api.plugins.enableStartUse(pinnedInput)
        if (!active.current) return
        if (useAppStore.getState().accountRevision !== account || !current())
          throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      }
      setReport(next)
      // Configuration belongs to this chat only when the native report says so.
      // Project-scoped setup remains in the destination project form.
      const needsConfiguration = next.issues.some(
        (issue) =>
          ["configuration", "knowledge"].includes(issue.code) &&
          issue.resolution === "plugin-settings"
      )
      if (
        purpose !== "dependency" &&
        (next.kind !== "chat" || openChat) &&
        next.canOpen &&
        !needsConfiguration
      )
        openPluginStartUse(pinnedInput, next)
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
    (issue) =>
      ["configuration", "knowledge"].includes(issue.code) && issue.resolution === "plugin-settings"
  )
  return (
    <section aria-label="已安装插件开始使用" className="space-y-3">
      <button
        type="button"
        disabled={busy}
        className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
        onClick={() => void start()}
      >
        {busy
          ? "正在打开…"
          : purpose === "dependency"
            ? "准备此依赖"
            : configuration
              ? "保存后继续"
              : "开始使用"}
      </button>
      {report && (
        <>
          {purpose === "dependency" && (
            <p role="status" className="text-sm">
              {report.issues.length ? "请完成此依赖的设置。" : "依赖已准备，请继续制作。"}
            </p>
          )}
          {report.issues.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {report.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>{issue.message}</li>
              ))}
            </ul>
          )}
          {configuration && (
            <div className="space-y-2 rounded border p-3">
              <p className="text-sm font-medium">填写后即可使用</p>
              <FunctionUserConfig
                threadId={threadId}
                pluginId={pluginId}
                expectedWorkspace={workspace}
                initiallyOpen
              />
            </div>
          )}
          {report.kind === "chat" && !report.activationRequired && (
            <InstalledChatPluginUse input={input} report={report} purpose={purpose} />
          )}
          {report.kind === "chat" &&
            purpose !== "dependency" &&
            report.canOpen &&
            !configuration && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void start(true)}
              >
                返回聊天
              </button>
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
