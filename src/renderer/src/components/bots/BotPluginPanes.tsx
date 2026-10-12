import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { botApi } from "@/lib/bot-api"
import { useEffect, useMemo, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FunctionPanes, type FunctionPaneTransport } from "../chat/FunctionPanes"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import {
  acknowledgePendingPluginPane,
  inspectPendingPluginPane,
  discardPendingPluginPane,
  rememberPendingPluginPane
} from "@/lib/bot-plugin-pane-pending"
import {
  botPluginSessionKey,
  isBotPluginPresentationAction,
  type BotPluginPaneAction,
  type BotPluginPaneAddress,
  type BotPluginPaneView
} from "../../../../shared/bot-plugin-panes"

const empty: BotPluginPaneView = { sessionId: null, revision: 0, busy: false, panes: [] }

/** Same validated Cmb renderer; execution goes exclusively to the Bot Host. */
export function BotPluginPanes({
  address,
  dataEpoch
}: {
  address: BotPluginPaneAddress
  dataEpoch: string
}) {
  const viewVisible = useBotViewVisibility()
  const observing = useRef(viewVisible)
  observing.current = viewVisible
  const scope = botPluginSessionKey(address)
  const authority = useRef({ scope, dataEpoch })
  authority.current = { scope, dataEpoch }
  const [record, setRecord] = useState(() => inspectPendingPluginPane(address, dataEpoch))
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const [pending, setPending] = useState(() => (record.kind === "valid" ? record.input : null))
  const acknowledged = useRef<{ input: BotPluginPaneAction; rejected?: unknown } | null>(null)
  const [checking, setChecking] = useState(false)
  const [hasPanes, setHasPanes] = useState(false)
  const [error, setError] = useState("")
  const pendingRef = useRef(pending)
  const mounted = useRef(true)
  const view = useRef(empty)
  const running = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const transport = useMemo(() => {
    let pendingView: Promise<BotPluginPaneView["panes"]> | undefined
    const currentEpoch = () =>
      (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === dataEpoch
    const inScope = () =>
      authority.current.scope === scope && authority.current.dataEpoch === dataEpoch
    const live = () => mounted.current && inScope() && currentEpoch()
    const restoredError = () => new Error("数据已恢复或视图已切换，请重新打开插件面板。")
    const listeners = new Set<(event: { threadId: string }) => void>()
    const notify = () => {
      if (!observing.current || !live()) return
      for (const listener of listeners) listener({ threadId: scope })
    }
    const finish = (input: BotPluginPaneAction) => {
      if (!currentEpoch()) return
      if (!acknowledgePendingPluginPane(input, dataEpoch)) {
        if (live()) setError("面板操作结果已确认，本机记录尚未清除。核对只处理原记录。")
        return false
      }
      acknowledged.current = null
      if (live()) {
        setRecord(inspectPendingPluginPane(address, dataEpoch))
        pendingRef.current = null
        setPending(null)
      }
      return true
    }
    const submit = async (input: BotPluginPaneAction): Promise<void> => {
      if (!live()) throw restoredError()
      const current = inspectPendingPluginPane(address, dataEpoch)
      if (current.kind !== "empty" && current.kind !== "valid") {
        setRecord(current)
        throw new Error("请先核对并归档本机面板操作记录。")
      }
      if (isBotPluginPresentationAction(input)) {
        await botApi.pluginPaneAction(input)
        if (!live()) throw restoredError()
        notify()
        return
      }
      if (
        running.current ||
        (pendingRef.current && pendingRef.current.action.intentId !== input.action.intentId)
      )
        throw new Error("上一项操作尚未确认，请先核对进度。")
      running.current = true
      if (live()) {
        setChecking(true)
        setError("")
      }
      try {
        if (acknowledged.current) {
          const receipt = acknowledged.current
          if (receipt.input.action.intentId !== input.action.intentId)
            throw new Error("上一项操作结果已确认，请先核对此条记录。")
          if (!finish(receipt.input))
            throw new Error("面板操作结果已确认，本机记录尚未清除。核对只处理原记录。")
          if (receipt.rejected) throw receipt.rejected
          notify()
          return
        }
        rememberPendingPluginPane(input, dataEpoch)
        if (live()) setRecord(inspectPendingPluginPane(address, dataEpoch))
        pendingRef.current = input
        if (!live()) throw restoredError()
        setPending(input)
        const receipt = await botApi.pluginPaneAction(input)
        if (!currentEpoch()) throw restoredError()
        const runId = receipt.runIds[0]
        if (!runId) throw new Error("未收到面板操作记录，请核对原请求。")
        if (!live()) return
        void useBotWorkspaceStore
          .getState()
          .refresh()
          .catch(() => {})
        while (live()) {
          const result = await botApi.runHistory({
            conversationId: address.conversationId,
            threadRootId: address.threadRootId,
            runId,
            limit: 1
          })
          if (!currentEpoch()) throw restoredError()
          if (result.run.status === "succeeded") {
            acknowledged.current = { input }
            if (!finish(input))
              throw new Error("面板操作结果已确认，本机记录尚未清除。核对只处理原记录。")
            notify()
            return
          }
          if (["failed", "cancelled", "needs_review"].includes(result.run.status)) {
            const failure = new Error(result.run.error || "面板操作未完成，请查看任务记录。")
            acknowledged.current = { input, rejected: failure }
            if (!finish(input))
              throw new Error("面板操作结果已确认，本机记录尚未清除。核对只处理原记录。")
            throw failure
          }
          if (!live()) return
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      } catch (cause) {
        if (live()) setRecord(inspectPendingPluginPane(address, dataEpoch))
        const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : ""
        if (
          [
            "plugin_pane_stale",
            "plugin_pane_scope",
            "plugin_pane_busy",
            "not_found",
            "invalid_input",
            "nonce_conflict"
          ].includes(code)
        ) {
          if (currentEpoch()) acknowledged.current = { input, rejected: cause }
          if (!finish(input)) {
            if (live()) setRecord(inspectPendingPluginPane(address, dataEpoch))
            throw cause
          }
        }
        if (live())
          setError(cause instanceof Error ? cause.message : "操作结果尚未确认，请核对原请求。")
        throw cause
      } finally {
        running.current = false
        if (mounted.current && inScope()) setChecking(false)
        notify()
      }
    }
    return {
      submit,
      notify,
      async panes() {
        if (!observing.current || !live()) return []
        if (pendingView) return pendingView
        const read = botApi.pluginPanes(address).then(
          (value) => {
            if (!observing.current || !live()) return []
            view.current = value
            setHasPanes(value.panes.length > 0)
            if (value.error) setError(value.error)
            return value.panes
          },
          (error: unknown) => {
            if (!observing.current || !live()) return []
            throw error
          }
        )
        pendingView = read.finally(() => {
          pendingView = undefined
        })
        return pendingView
      },
      async paneAct(_thread, action) {
        if (!view.current.sessionId) throw new Error("面板已关闭，请重新打开。")
        await submit({ ...address, sessionId: view.current.sessionId, target: "pane", action })
      },
      async clientAct(_thread, action) {
        const pane = view.current.panes.find((p) => p.key === action.pane)
        if (!view.current.sessionId || !pane) throw new Error("面板已关闭，请重新打开。")
        await submit({
          ...address,
          sessionId: view.current.sessionId,
          target: "client",
          generation: pane.generation,
          action
        })
      },
      onCardsChanged(listener) {
        listeners.add(listener)
        const stop = useBotWorkspaceStore.subscribe((next, previous) => {
          if (observing.current && live() && next.snapshot?.cursor !== previous.snapshot?.cursor)
            listener({ threadId: scope })
        })
        return () => {
          stop()
          listeners.delete(listener)
        }
      }
    } satisfies FunctionPaneTransport & {
      submit(input: BotPluginPaneAction): Promise<void>
      notify(): void
    }
    // The parent keys this component by full address and data epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, dataEpoch])

  useEffect(() => {
    if (!viewVisible) return
    transport.notify()
  }, [viewVisible, transport])

  useEffect(() => {
    if (!viewVisible || !hasPanes) return
    const timer = setInterval(transport.notify, 500)
    return () => clearInterval(timer)
  }, [viewVisible, hasPanes, transport])

  return (
    <div data-bot-plugin-panes={address.botId}>
      {error && (
        <p role="alert" className="mb-2 px-1 text-xs leading-relaxed text-destructive">
          {error}
        </p>
      )}
      {blocked && (
        <BotPendingSaveRecovery
          record={record}
          dataEpoch={dataEpoch}
          operationLabel="面板操作"
          discard={(raw) => discardPendingPluginPane(address, dataEpoch, raw)}
          onRepaired={() => {
            acknowledged.current = null
            pendingRef.current = null
            setPending(null)
            setRecord(inspectPendingPluginPane(address, dataEpoch))
            setError("")
          }}
        />
      )}
      {pending && !checking && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">上一项面板操作的结果尚未确认。</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void transport.submit(pending).catch(() => {})}
          >
            <RefreshCw size={13} />
            核对进度
          </Button>
        </div>
      )}
      <FunctionPanes
        threadId={scope}
        transport={transport}
        disabled={blocked || Boolean(pending)}
      />
    </div>
  )
}
