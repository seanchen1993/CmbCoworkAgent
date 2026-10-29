import { useCallback, useEffect, useRef, useState } from "react"
import type { ModWorkspaceStatus } from "../../../../shared/mods/types"
import { normalizeWorkspacePathKey } from "../../../../shared/workspace-path"
import { Button } from "@/components/ui/button"
import { captureConfigurationScope } from "@/lib/configuration-target"
import { useAppStore } from "@/lib/store"
import { prepareDevelopmentCreation } from "./development-creation-setup"

type View = {
  scope: string
  global: boolean
  status: ModWorkspaceStatus | null
  error: string
}

/** Reuses the two existing switches, never source approval or a separate creator setting. */
export function ModsUsageSetup({
  threadId,
  workspaceHint,
  active = true
}: {
  threadId: string | null
  workspaceHint?: string | null
  active?: boolean
}) {
  const accountRevision = useAppStore((state) => state.accountRevision)
  const scope = JSON.stringify([accountRevision, threadId, workspaceHint, active])
  const latest = useRef(scope)
  latest.current = scope
  const mounted = useRef(false)
  const reading = useRef(0)
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState({ scope: "", text: "" })
  const [view, setView] = useState<View>({ scope: "", global: false, status: null, error: "" })
  const isCurrent = useCallback(
    () =>
      mounted.current &&
      latest.current === scope &&
      useAppStore.getState().accountRevision === accountRevision,
    [scope, accountRevision]
  )
  const refresh = useCallback(async () => {
    if (!active || !threadId || !workspaceHint) return undefined
    const version = ++reading.current
    try {
      const [global, status] = await Promise.all([
        window.api.mods.globalEnabled(),
        window.api.mods.status(threadId)
      ])
      if (!isCurrent() || version !== reading.current) return undefined
      if (normalizeWorkspacePathKey(status.workspace) !== normalizeWorkspacePathKey(workspaceHint))
        throw Error("聊天的项目目录已变化，请重新选择聊天后核对。")
      setView({ scope, global, status, error: "" })
      return { global, status }
    } catch (error) {
      if (isCurrent() && version === reading.current)
        setView({
          scope,
          global: false,
          status: null,
          error: error instanceof Error ? error.message : "无法读取灵件设置，请重新读取。"
        })
    }
    return undefined
  }, [active, threadId, workspaceHint, isCurrent, scope])
  useEffect(() => {
    mounted.current = true
    const readEpoch = reading
    const update = () => {
      if (!running.current) void refresh()
    }
    update()
    window.addEventListener("mods:configuration-changed", update)
    const stop = active ? window.api.mods.onConfigurationChanged(update) : undefined
    return () => {
      mounted.current = false
      ++readEpoch.current
      stop?.()
      window.removeEventListener("mods:configuration-changed", update)
    }
  }, [active, refresh])
  if (!active || !threadId || !workspaceHint) return null
  const current = view.scope === scope ? view : null
  const enabled = !!current?.global && !!current.status?.enabled
  const enable = async () => {
    if (running.current || !current?.status || current.status.recovery) return
    const assertTarget = captureConfigurationScope({ threadId, workspace: workspaceHint })
    const assertCurrent = () => {
      if (!isCurrent() || !assertTarget()) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    }
    running.current = true
    setBusy(true)
    setNotice({ scope, text: "" })
    try {
      await prepareDevelopmentCreation(window.api.mods, threadId, workspaceHint, assertCurrent)
      assertCurrent()
      const confirmed = await refresh()
      assertCurrent()
      if (!confirmed?.global || !confirmed.status.enabled || confirmed.status.recovery)
        throw Error("DEVELOPMENT_SETTINGS_DISABLED")
      setNotice({
        scope,
        text: "已开启应用及当前项目目录的灵件。请继续核对每项灵件的权限与使用范围；任务尚未开始。"
      })
    } catch (error) {
      if (isCurrent())
        setNotice({
          scope,
          text:
            error instanceof Error && error.message === "DEVELOPMENT_SETUP_PARTIAL"
              ? "部分开关已开启，尚未完成。请重新读取实际设置，再明确重试；不会恢复旧批准。"
              : "未完成开启。请核对当前聊天、项目目录和账号后重新读取；权限恢复问题需按设置中的说明处理。"
        })
    } finally {
      running.current = false
      if (mounted.current) {
        setBusy(false)
        window.dispatchEvent(new Event("mods:configuration-changed"))
      }
    }
  }
  return (
    <section
      aria-label="当前项目灵件使用"
      className="space-y-3 rounded-xl border bg-muted/20 p-4 text-sm"
    >
      <h3 className="font-medium">当前项目灵件使用</h3>
      <p className="break-all text-xs text-muted-foreground">
        项目目录：{workspaceHint}（同目录聊天共用）
      </p>
      {current?.status ? (
        <>
          <p className="text-xs">
            应用灵件：{current.global ? "已开启" : "已关闭"} · 当前项目目录：
            {current.status.enabled ? "已开启" : "已关闭"}
          </p>
          {current.status.recovery ? (
            <p role="alert">权限设置需要恢复，请到“插件”查看恢复说明。</p>
          ) : !enabled ? (
            <>
              <p className="text-xs leading-6 text-muted-foreground">
                开启应用会恢复其他已经批准的灵件；当前项目目录的开关由同目录聊天共用。
                保留回答保护设置，不批准新源码或权限、不改变原插件启停，也不自动开始任务。
              </p>
              <Button disabled={busy} onClick={() => void enable()}>
                启用应用和当前项目灵件
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              开关已开启；每项灵件仍须按原入口核对精确源码、权限和使用范围。
            </p>
          )}
        </>
      ) : current?.error ? (
        <p role="alert">{current.error}</p>
      ) : (
        <p role="status">正在读取灵件使用设置…</p>
      )}
      {current?.error || current?.status?.recovery ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
          重新读取灵件设置
        </Button>
      ) : null}
      {notice.scope === scope && notice.text && (
        <p role="status" className="text-xs">
          {notice.text}
        </p>
      )}
    </section>
  )
}
