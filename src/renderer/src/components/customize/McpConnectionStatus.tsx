import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createLatestDisplayRead } from "@/lib/latest-display-read"
import { Button } from "@/components/ui/button"
import { useAppStore, isThreadDeletionPending, isThreadRetired } from "@/lib/store"
import {
  captureSurfaceNavigationScope,
  surfaceNavigationScopeCurrent
} from "@/lib/platform-surface-intent"
import type { McpRuntimeView } from "../../../../shared/mods/v2/mcp-connections"
import { openPluginSettings } from "@/lib/plugin-settings-intent"
import { openMcpConnectorSettings } from "@/lib/mcp-settings-intent"

const labels = {
  connecting: "正在连接",
  connected: "已连接",
  closing: "正在断开",
  closed: "已断开",
  failed: "连接失败",
  unknown: "清理结果待核对"
}

/** Observes only this chat's owned transports, not the legacy application's shared MCP pool. */
export function McpConnectionStatus({
  threadId,
  workspace,
  onChooseSources
}: {
  threadId: string
  workspace: string
  onChooseSources?: () => void
}) {
  const account = useAppStore((state) => state.accountRevision)
  const birth = useAppStore((state) => {
    const thread = state.threads.find((item) => item.thread_id === threadId)
    const metadata = thread?.metadata as Record<string, unknown> | undefined
    return JSON.stringify([
      thread?.created_at,
      metadata?.cmb_thread_incarnation,
      metadata?.workspacePath
    ])
  })
  const scope = useMemo(
    () => captureSurfaceNavigationScope(threadId, workspace),
    // Account and birth are part of the captured identity, even when props do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, birth, threadId, workspace]
  )
  const [view, setView] = useState<McpRuntimeView>()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const readerRef = useRef<ReturnType<typeof createLatestDisplayRead<McpRuntimeView>> | null>(null)
  const mutationUnconfirmed = useRef(false)
  const epoch = useRef(0)
  const mutation = useRef<symbol | undefined>(undefined)
  const current = () =>
    !!scope &&
    surfaceNavigationScopeCurrent(scope) &&
    !isThreadRetired(threadId) &&
    !isThreadDeletionPending(threadId)
  useLayoutEffect(() => {
    epoch.current++
    mutation.current = undefined
    mutationUnconfirmed.current = false
    setView(undefined)
    setError("")
    setBusy(false)
    return () => {
      epoch.current++
      mutation.current = undefined
    }
  }, [scope])
  const refresh = (clearError = true) => {
    if (clearError) mutationUnconfirmed.current = false
    if (current() && !mutation.current) readerRef.current?.refresh()
  }
  useEffect(() => {
    const reader = createLatestDisplayRead({
      read: () => window.api.mods.mcpConnections(threadId, workspace),
      publish: (next) => {
        if (!current() || mutation.current || next.workspace !== workspace) return
        setView(next)
        if (!mutationUnconfirmed.current) setError("")
      },
      failed: () => {
        if (current() && !mutation.current) setError("连接状态暂不可用，请刷新核对。")
      }
    })
    readerRef.current = reader
    refresh()
    const timer = setInterval(() => refresh(false), 2_000)
    return () => {
      clearInterval(timer)
      reader.close()
      if (readerRef.current === reader) readerRef.current = null
      epoch.current++
    }
    // Each mounted instance has an exact immutable account/thread/workspace scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])
  const disconnect = async (owner: string, server: string) => {
    if (!current() || mutation.current) return
    const token = Symbol("mcp-disconnect")
    readerRef.current?.invalidate()
    mutation.current = token
    setBusy(true)
    setError("")
    const revision = ++epoch.current
    try {
      const next = await window.api.mods.mcpDisconnect(threadId, { workspace, owner, server })
      if (current() && revision === epoch.current && next.workspace === workspace) setView(next)
    } catch {
      if (current() && revision === epoch.current) {
        mutationUnconfirmed.current = true
        setError("断开结果未确认，请刷新核对；不会重连或重试工具调用。")
      }
    } finally {
      if (mutation.current === token) {
        mutation.current = undefined
        if (current()) {
          setBusy(false)
          refresh(false)
        }
      }
    }
  }
  return (
    <section className="space-y-2 rounded-xl border p-4" aria-label="当前聊天的组件连接">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">当前聊天的组件连接</h3>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          刷新连接状态
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        这里只显示组件独立建立的连接。请在下方“连接工具”中明确选择来源，保存并应用搭配后，组件才可连接。普通任务结束不会断开；旧版应用共享连接仍由原流程管理。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {view?.connections.length === 0 && <p className="text-xs">当前没有组件连接。</p>}
      {view?.connections.map((connection) => (
        <div
          key={connection.server}
          className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs"
        >
          <span className="min-w-0 flex-1 break-all">
            {connection.component} · {connection.sourceId} · {labels[connection.state]} ·{" "}
            {connection.toolCount} 个工具
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (!current()) return
              if (connection.sourceId.startsWith("plugin:")) {
                const pluginId = connection.sourceId.slice(7).split("/")[0]
                openPluginSettings(pluginId)
              } else openMcpConnectorSettings(connection.sourceId, threadId, workspace)
            }}
          >
            查看来源设置
          </Button>
          {["connecting", "connected"].includes(connection.state) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void disconnect(connection.owner, connection.server)}
            >
              {connection.state === "connecting" ? "取消连接" : "断开连接"}
            </Button>
          )}
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          if (current()) useAppStore.getState().setShowCustomizeView(true, "connectors")
        }}
      >
        管理连接工具
      </Button>
      {onChooseSources && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (current()) onChooseSources()
          }}
        >
          选择本聊天的连接工具
        </Button>
      )}
    </section>
  )
}
