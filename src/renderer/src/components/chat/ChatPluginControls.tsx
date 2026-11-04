import { useEffect, useRef, useState } from "react"
import type { PluginMetadata } from "@/types"
import type { PluginStartUseReport } from "../../../../shared/plugin-start-use"
import { chatPluginCandidates } from "@/lib/chat-plugin-candidates"
import { captureConfigurationScope } from "@/lib/configuration-target"
import { useAppStore } from "@/lib/store"
import { InstalledChatPluginUse } from "../customize/InstalledChatPluginUse"
import { removeChatPlugin } from "@/lib/chat-plugin-selection"
import type { FunctionPluginStatus } from "../../../../shared/mods/v2/commands"
import { applyInstalledPluginUse, prepareInstalledPluginUse } from "@/lib/community-example-use"

export function ChatPluginControls({
  threadId,
  workspace,
  plugins,
  activeIds,
  sources = [],
  disabled
}: {
  threadId: string
  workspace: string
  plugins: readonly PluginMetadata[]
  activeIds: readonly string[]
  sources?: readonly FunctionPluginStatus[]
  disabled: boolean
}) {
  const account = useAppStore((state) => state.accountRevision)
  return (
    <ScopedControls
      key={JSON.stringify([account, threadId, workspace])}
      {...{ threadId, workspace, plugins, activeIds, sources, disabled }}
    />
  )
}

function ScopedControls({
  threadId,
  workspace,
  plugins,
  activeIds,
  sources = [],
  disabled
}: Parameters<typeof ChatPluginControls>[0]) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [report, setReport] = useState<PluginStartUseReport>()
  const live = useRef(true)
  const locked = useRef(false)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  async function change(plugin: PluginMetadata, enable: boolean) {
    if (locked.current || disabledRef.current) return
    locked.current = true
    setBusy(true)
    setError("")
    setReport(undefined)
    const scope = captureConfigurationScope({ threadId, workspace })
    const current = () => live.current && !disabledRef.current && scope()
    const context = {
      threadId,
      workspace,
      assertCurrent: () => {
        if (!current()) throw Error("聊天已变化，请重新打开。")
      }
    }
    try {
      const fresh = await window.api.plugins.prepareStartUse({
        threadId,
        expectedWorkspace: workspace,
        pluginId: plugin.id,
        expected: { name: plugin.name, version: plugin.version }
      })
      if (!current()) return
      if (fresh.kind !== "chat") throw Error("PROJECT_PLUGIN")
      if (enable) {
        const source = fresh.chat?.functionMod
        // Clicking Enable is sufficient for an already-authorized, configured source.
        // New grants, global switches and replacements still show the existing review form.
        if (source?.state === "ready" && !fresh.activationRequired && !fresh.issues.length) {
          const plan = await prepareInstalledPluginUse(
            window.api.mods,
            context,
            {
              pluginId: plugin.id,
              pluginName: source.name
            },
            plugin.name
          )
          context.assertCurrent()
          if (plan.target.digest !== source.digest) throw Error("聊天灵件版本已变化，请重新核对。")
          if (
            plan.snapshot.global &&
            plan.snapshot.status.enabled &&
            !plan.replacements.length &&
            plan.snapshot.status.functionMods?.find((item) => item.pluginId === plugin.id)
              ?.state === "ready"
          ) {
            const checked = await window.api.plugins.prepareStartUse({
              threadId,
              expectedWorkspace: workspace,
              pluginId: plugin.id,
              expected: fresh.identity
            })
            context.assertCurrent()
            if (
              checked.kind === "chat" &&
              !checked.activationRequired &&
              !checked.issues.length &&
              checked.chat?.functionMod?.state === "ready" &&
              checked.chat.functionMod.digest === source.digest
            ) {
              await applyInstalledPluginUse(window.api.mods, context, plan, () => {})
              window.dispatchEvent(new Event("mods:configuration-changed"))
              return
            }
            setReport(checked.kind === "chat" ? checked : undefined)
            if (checked.kind !== "chat") throw Error("PROJECT_PLUGIN")
            return
          }
        }
        setReport(fresh)
      } else {
        if (fresh.chat?.functionMod) {
          await removeChatPlugin(window.api.mods, context, plugin.id)
        } else {
          const result = await window.api.plugins.setEnabled(plugin.id, false)
          if (!result.success) throw Error("DISABLE_FAILED")
          useAppStore.getState().bumpPluginVersion()
        }
        window.dispatchEvent(new Event("mods:configuration-changed"))
      }
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error && cause.message === "PROJECT_PLUGIN"
            ? "这是项目插件，请在项目模式中使用。"
            : cause instanceof Error && /流程|组合|聊天|停用/.test(cause.message)
              ? cause.message
              : "未能更新灵件状态，请重试。"
        )
    } finally {
      locked.current = false
      if (live.current) setBusy(false)
    }
  }
  const candidates = chatPluginCandidates(plugins, sources)
  const functionIds = sources.map((source) => source.pluginId)
  const button = "rounded-md border px-2 py-1 text-xs disabled:opacity-50"
  return (
    <section aria-label="聊天灵件" className="space-y-3 rounded-xl border p-4">
      <h3 className="font-semibold">聊天灵件</h3>
      <p className="text-xs text-muted-foreground">
        灵件仅调整本聊天；传统技能、工具插件沿用全局开关。
      </p>
      {!candidates.length && (
        <p className="text-xs text-muted-foreground">暂无可用的非项目灵件。</p>
      )}
      {candidates.map((plugin) => (
        <div key={plugin.id} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-words">{plugin.name}</span>
            <div className="flex shrink-0 gap-1">
              {(!plugin.enabled || !activeIds.includes(plugin.id)) && (
                <button
                  className={button}
                  disabled={disabled || busy}
                  onClick={() => void change(plugin, true)}
                >
                  {plugin.enabled && !functionIds.includes(plugin.id) && !plugin.modCount
                    ? "配置使用"
                    : "启用"}
                </button>
              )}
              {plugin.enabled &&
                (activeIds.includes(plugin.id) ||
                  (!functionIds.includes(plugin.id) && !plugin.modCount)) && (
                  <button
                    className={button}
                    disabled={disabled || busy}
                    onClick={() => void change(plugin, false)}
                  >
                    停用
                  </button>
                )}
            </div>
          </div>
          {plugin.enabled && activeIds.includes(plugin.id) && (
            <p className="text-xs text-muted-foreground">本聊天已启用</p>
          )}
        </div>
      ))}
      {report && (
        <InstalledChatPluginUse
          key={JSON.stringify(report.identity)}
          input={{
            threadId,
            expectedWorkspace: workspace,
            pluginId: report.identity.pluginId,
            expected: report.identity
          }}
          report={report}
          disabled={disabled}
          onBusyChange={(value) => {
            locked.current = value
            setBusy(value)
          }}
          onReadyChange={(ready) => {
            if (ready) {
              setReport(undefined)
              useAppStore.getState().bumpPluginVersion()
            }
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
