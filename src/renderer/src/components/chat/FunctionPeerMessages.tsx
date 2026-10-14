import { withModsChatScope } from "../../lib/mods-chat-scope"
import { useEffect, useState } from "react"
import { invalidateModsGlobalEnabled, readModsGlobalEnabled } from "../../lib/mods-global-enabled"
import type { FunctionPeerRecord, FunctionPeerStatus } from "../../../../shared/mods/v2/peer"

const labels: Record<FunctionPeerStatus, string> = {
  queued: "等待模型读取",
  processing: "模型读取中",
  delivered: "模型已读取",
  uncertain: "读取结果不确定，不会自动重试",
  interrupted: "任务已结束，未继续投递"
}

export const FunctionPeerMessages = withModsChatScope(FunctionPeerMessagesSurface)

function FunctionPeerMessagesSurface({ threadId }: { threadId: string }): React.JSX.Element | null {
  const [records, setRecords] = useState<FunctionPeerRecord[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    let revision = 0
    setRecords([])
    setError(false)
    const refresh = async () => {
      const current = ++revision
      let enabled = false
      try {
        enabled = await readModsGlobalEnabled()
        if (!active || current !== revision) return
        if (!enabled) {
          setRecords([])
          setError(false)
          return
        }
        const value = await window.api.mods.peerMessages(threadId)
        if (active && current === revision) {
          setRecords(value)
          setError(false)
        }
      } catch {
        if (active && current === revision) setError(enabled)
      }
    }
    void refresh()
    const unsubscribe = window.api.mods.onPeerMessagesChanged((event) => {
      if (event.threadId === threadId) void refresh()
    })
    const reset = () => {
      invalidateModsGlobalEnabled()
      ++revision
      setRecords([])
      setError(false)
      void refresh()
    }
    const stopConfiguration = window.api.mods.onConfigurationChanged(reset)
    window.addEventListener("mods:configuration-changed", reset)
    return () => {
      active = false
      unsubscribe()
      stopConfiguration()
      window.removeEventListener("mods:configuration-changed", reset)
    }
  }, [threadId])
  if (!records.length && !error) return null
  return (
    <details className="max-w-3xl mx-auto rounded border p-2 text-xs" data-function-peer-messages>
      <summary className="cursor-pointer">协作消息 · {records.length} 条</summary>
      <p className="text-muted-foreground my-2">
        插件与智能体之间的消息，不代表你的指令或工具授权。仅发送到正在运行的任务。
      </p>
      {error && <p role="status">协作记录暂时无法读取。</p>}
      <ol className="space-y-2 max-h-64 overflow-auto">
        {records.map((record) => (
          <li key={record.id} className="rounded border p-2">
            <p>
              {record.plugin} · {record.fromAgentId} → {record.agentId}
            </p>
            <p className="text-muted-foreground">{labels[record.status]}</p>
            <p className="whitespace-pre-wrap break-words">{record.text}</p>
          </li>
        ))}
      </ol>
    </details>
  )
}
