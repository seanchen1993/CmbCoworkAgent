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
  actionLabel?: string
  disabled?: boolean
  onBusyChange?(busy: boolean): void
}) {
  const accountRevision = useAppStore((state) => state.accountRevision)
  const { threadId, workspace, pluginId, expected, purpose } = props
  const scope = [
    accountRevision,
    threadId,
    workspace,
    pluginId,
    expected.name,
    expected.version,
    expected.digest,
    purpose
  ]
  return <ScopedStartUse key={JSON.stringify(scope)} {...props} />
}
function ScopedStartUse({
  threadId,
  workspace,
  pluginId,
  expected,
  purpose,
  actionLabel,
  disabled = false,
  onBusyChange
}: Parameters<typeof InstalledPluginStartUse>[0]) {
  const [report, setReport] = useState<PluginStartUseReport>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [chatReady, setChatReady] = useState(false)
  const active = useRef(true)
  const lock = useRef(false)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      busyCallback.current?.(false)
    }
  }, [])
  const input: PluginStartUseInput = { threadId, expectedWorkspace: workspace, pluginId, expected }
  const start = async (openChat = false, inspectOnly = false) => {
    if (lock.current || !active.current || disabledRef.current) return
    lock.current = true
    setBusy(true)
    busyCallback.current?.(true)
    setError("")
    setChatReady(false)
    const account = useAppStore.getState().accountRevision
    const current = captureConfigurationScope({ threadId, workspace })
    const guard = () => {
      if (
        !active.current ||
        disabledRef.current ||
        useAppStore.getState().accountRevision !== account ||
        !current()
      )
        throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
    }
    let activationAttempted = false
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
      // A chat plugin opens its exact native consent form before any catalog mutation.
      let next = await window.api.plugins.prepareStartUse(actualInput)
      guard()
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
      if (next.kind !== "chat" && next.activationRequired && !inspectOnly) {
        activationAttempted = true
        next = await window.api.plugins.enableStartUse(pinnedInput)
        guard()
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
        !inspectOnly &&
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
      if (activationAttempted) window.dispatchEvent(new Event("mods:configuration-changed"))
      if (active.current) {
        setBusy(false)
        busyCallback.current?.(false)
      }
    }
  }
  const configuration = report?.issues.some(
    (issue) =>
      ["configuration", "knowledge"].includes(issue.code) && issue.resolution === "plugin-settings"
  )
  return (
    <section aria-label="已安装插件开始使用" className="space-y-3">
      {(!report || report.kind !== "chat" || error) && (
        <button
          type="button"
          disabled={busy || disabled}
          className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
          onClick={() => void start()}
        >
          {busy
            ? "正在打开…"
            : purpose === "dependency"
              ? "准备此依赖"
              : configuration
                ? "保存后继续"
                : (actionLabel ?? "开始使用")}
        </button>
      )}
      {report && (
        <>
          {purpose === "dependency" && (
            <p role="status" className="text-sm">
              {report.issues.length ? "请完成此依赖的设置。" : "依赖已准备，请继续制作。"}
            </p>
          )}
          {report.issues.some((issue) => report.kind !== "chat" || issue.code !== "permission") && (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {report.issues
                .filter((issue) => report.kind !== "chat" || issue.code !== "permission")
                .map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>{issue.message}</li>
                ))}
            </ul>
          )}
          {configuration && report.kind !== "chat" && (
            <div className="space-y-2 rounded border p-3">
              <p className="text-sm font-medium">填写后即可使用</p>
              <FunctionUserConfig
                threadId={threadId}
                pluginId={pluginId}
                expectedWorkspace={workspace}
                initiallyOpen
                onSaved={() => void start(false, true)}
              />
              <button
                className={button}
                disabled={busy || disabled}
                onClick={() => void start(false, true)}
              >
                重新检查
              </button>
            </div>
          )}
          {report.kind === "chat" && (
            <InstalledChatPluginUse
              input={input}
              report={report}
              purpose={purpose}
              disabled={disabled}
              onBusyChange={onBusyChange}
              onReportChange={setReport}
              onReadyChange={setChatReady}
            />
          )}
          {report.kind === "chat" &&
            purpose !== "dependency" &&
            report.canOpen &&
            chatReady &&
            !configuration && (
              <button
                type="button"
                className={button}
                disabled={busy || disabled}
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
