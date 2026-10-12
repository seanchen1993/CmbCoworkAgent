import { botApi } from "@/lib/bot-api"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { Bell, BellOff, LoaderCircle, RefreshCw } from "lucide-react"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { botErrorNotice, type BotErrorNotice } from "@/lib/bot-error-notice"
import { applyBotNotificationSettingReceipt } from "@/lib/bot-notification-projection"
import { pendingNotificationStore } from "@/lib/bot-notification-pending"
import type {
  BotNotificationChange,
  BotNotificationSettings
} from "../../../../shared/bot-notifications"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"

const rejected = new Set(["invalid_input", "not_found", "revision_conflict", "nonce_conflict"])
type SyncMode = "saved" | "conflict" | null
interface Feedback {
  tone: "info" | "error"
  notice: BotErrorNotice
  hint?: string
}

export function BotNotificationAction(props: { botId: string; dataEpoch: string }) {
  return <NotificationActionScope key={JSON.stringify([props.botId, props.dataEpoch])} {...props} />
}

function NotificationActionScope({ botId, dataEpoch }: { botId: string; dataEpoch: string }) {
  const preference = useBotWorkspaceStore((state) =>
    state.snapshot?.notificationSettings?.find((item) => item.botId === botId)
  )
  const [record, setRecord] = useState(() => pendingNotificationStore.inspect(botId, dataEpoch))
  const pending = record.kind === "valid" ? record.input : null
  const blocked = record.kind !== "valid" && record.kind !== "empty"
  const [retired, setRetired] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const ack = useRef<{
    input: BotNotificationChange
    setting?: BotNotificationSettings
    conflict?: Feedback
    mode: Exclude<SyncMode, null>
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncMode, setSyncMode] = useState<SyncMode>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const lifetime = useRef({ active: false, locked: false })
  useLayoutEffect(() => {
    const instance = lifetime.current
    instance.active = true
    return () => {
      instance.active = false
    }
  }, [])
  useEffect(() => {
    // A receipt can arrive after this menu was closed and another one opened.
    // The durable nonce, rather than an old mounted menu's state, owns retry.
    setRecord(pendingNotificationStore.inspect(botId, dataEpoch))
  }, [botId, dataEpoch, preference?.revision])
  const currentEpoch = () => useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch
  const live = () => lifetime.current.active && currentEpoch()
  const refreshRecord = () => {
    if (live()) setRecord(pendingNotificationStore.inspect(botId, dataEpoch))
  }

  const applyReceipt = (setting: BotNotificationSettings) => {
    useBotWorkspaceStore.setState((state) => {
      const snapshot = applyBotNotificationSettingReceipt(state.snapshot, dataEpoch, setting)
      return snapshot === state.snapshot ? state : { snapshot }
    })
  }
  const synchronize = async (mode: Exclude<SyncMode, null>, conflict?: Feedback) => {
    if (!live()) return
    try {
      await useBotWorkspaceStore.getState().refresh()
      if (!live()) return
      setSyncMode(null)
      setFeedback(
        conflict ?? {
          tone: "info",
          notice: { message: mode === "saved" ? "通知设置已保存" : "已重新读取通知设置" }
        }
      )
    } catch (error) {
      if (!live()) return
      setSyncMode(mode)
      setFeedback({
        tone: "error",
        notice: botErrorNotice(error, "通知状态同步失败，请重试"),
        hint:
          mode === "saved" ? "设置已保存，重试只会重新读取状态。" : "请重新读取最新设置后再修改。"
      })
    }
  }
  async function toggle() {
    const instance = lifetime.current
    if (!live() || instance.locked || retired) return
    instance.locked = true
    setBusy(true)
    const finish = async (confirmed: NonNullable<typeof ack.current>) => {
      // Same-epoch unmount may clear only the exact request. Restored records are retained.
      if (!currentEpoch()) return
      if (!pendingNotificationStore.acknowledge(confirmed.input)) {
        if (live()) {
          setFeedback({
            tone: "error",
            notice: { message: "操作结果已确认，本机记录尚未清除。" },
            hint: "重试只核对原记录，不会再次修改通知设置。"
          })
        }
        return
      }
      if (!live()) return
      ack.current = null
      setAcknowledged(false)
      refreshRecord()
      if (confirmed.setting) applyReceipt(confirmed.setting)
      setSyncMode(confirmed.mode)
      await synchronize(confirmed.mode, confirmed.conflict)
    }
    try {
      if (ack.current) {
        await finish(ack.current)
        return
      }
      if (syncMode) {
        await synchronize(syncMode)
        return
      }
      const present = pendingNotificationStore.inspect(botId, dataEpoch)
      if (present.kind !== "valid" && present.kind !== "empty") {
        setRecord(present)
        return
      }
      // Another menu may have saved a request after this menu mounted.
      if (present.kind === "valid" && !pending) {
        setRecord(present)
        setFeedback({ tone: "info", notice: { message: "请先核对上次通知设置请求。" } })
        return
      }
      const latest = useBotWorkspaceStore
        .getState()
        .snapshot?.notificationSettings?.find((item) => item.botId === botId)
      const input =
        present.kind === "valid"
          ? present.input
          : {
              botId,
              dataEpoch,
              revision: latest?.revision ?? 0,
              enabled: !(latest?.enabled ?? true),
              nonce: crypto.randomUUID()
            }
      pendingNotificationStore.remember(input)
      // Storage is synchronous, but an observed epoch change still revokes this dispatch.
      if (!live()) return
      refreshRecord()
      setFeedback(null)
      let setting: BotNotificationSettings
      try {
        setting = await botApi.changeNotifications(input)
      } catch (error) {
        if (!currentEpoch()) return
        const code = (error as { code?: string })?.code
        if (code === "data_epoch") {
          if (live()) {
            setRetired(true)
            setFeedback({
              tone: "error",
              notice: botErrorNotice(error, "工作区数据已恢复，请重新打开通知设置。原记录仍保留。")
            })
          }
          return
        }
        if (!code || !rejected.has(code)) {
          if (live())
            setFeedback({
              tone: "error",
              notice: botErrorNotice(error, "通知设置尚未确认，请重试"),
              hint: "重试将核对同一次请求。"
            })
          return
        }
        const confirmed = {
          input,
          mode: "conflict" as const,
          conflict: {
            tone: "error" as const,
            notice: botErrorNotice(error, "通知设置未修改")
          }
        }
        if (live()) {
          ack.current = confirmed
          setAcknowledged(true)
        }
        await finish(confirmed)
        return
      }
      if (
        setting.botId !== input.botId ||
        setting.revision !== input.revision + 1 ||
        setting.enabled !== input.enabled
      ) {
        if (live())
          setFeedback({
            tone: "error",
            notice: { message: "通知回执与原请求不一致，原记录仍保留。" },
            hint: "请核对同一次请求。"
          })
        return
      }
      if (!currentEpoch()) return
      const confirmed = { input, setting, mode: "saved" as const }
      if (live()) {
        ack.current = confirmed
        setAcknowledged(true)
      }
      await finish(confirmed)
    } catch (error) {
      if (live()) {
        refreshRecord()
        setFeedback({ tone: "error", notice: botErrorNotice(error, "无法保存或核对本机操作记录") })
      }
    } finally {
      instance.locked = false
      if (instance.active) setBusy(false)
    }
  }
  const enabled = preference?.enabled ?? true
  return (
    <div
      role="group"
      aria-label="Bot 通知设置"
      onKeyDown={(event) => {
        // Radix menus normally suppress Tab; details contain ordinary copy/input controls.
        if ((feedback || blocked) && event.key === "Tab") event.stopPropagation()
      }}
    >
      <Menu.Item
        disabled={busy || blocked || retired || !currentEpoch()}
        onSelect={(event) => {
          event.preventDefault()
          void toggle()
        }}
      >
        {busy ? (
          <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" />
        ) : syncMode || acknowledged ? (
          <RefreshCw size={15} />
        ) : enabled ? (
          <BellOff size={15} />
        ) : (
          <Bell size={15} />
        )}
        {busy
          ? syncMode
            ? "正在同步…"
            : "正在保存…"
          : acknowledged
            ? "核对已确认通知设置"
            : syncMode
              ? "重新读取通知设置"
              : pending
                ? "重试通知设置"
                : enabled
                  ? "关闭 Bot 通知"
                  : "开启 Bot 通知"}
      </Menu.Item>
      {blocked && (
        <div className="mx-1 my-1 max-w-72">
          <BotPendingSaveRecovery
            record={record}
            dataEpoch={dataEpoch}
            discard={(raw) => live() && pendingNotificationStore.discard(botId, dataEpoch, raw)}
            onRepaired={refreshRecord}
          />
        </div>
      )}
      {feedback && (
        <div
          className="mx-1 my-1 max-w-72 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2"
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          <BotErrorNoticeBody notice={feedback.notice} hint={feedback.hint} showRequestId />
        </div>
      )}
    </div>
  )
}
