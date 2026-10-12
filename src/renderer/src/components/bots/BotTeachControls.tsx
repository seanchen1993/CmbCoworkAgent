import { BotDomainError } from "../../../../shared/bot-types"
import { botApi } from "@/lib/bot-api"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Check, Circle, Loader2, Pause, Play, Square, Trash2, History, X } from "lucide-react"
import { BotTeachHistory } from "./BotTeachHistory"
import { BOT_USER_SKILLS_CAPABILITY } from "../../../../shared/bot-skill-library"
import { Button } from "@/components/ui/button"
import type { BotBrowserFrame } from "../../../../shared/bot-computer"
import type { BotNativeDesktopFrame } from "../../../../shared/bot-native-desktop"
import type {
  BotTeachSession,
  BotTeachArm,
  BotTeachStartInput,
  BotTeachRetryInput
} from "../../../../shared/bot-teach"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"

type BotTeachControlsProps = {
  active: boolean
  botId: string
  conversationId: string
  threadRootId?: string
  arm?: BotTeachArm | null
  onPrepared?(): void
  cancelPreparation?(): void
  backend?: "browser" | "windows-native"
  frame: BotBrowserFrame | BotNativeDesktopFrame | null
  refresh(): Promise<void>
  onRecordingPhase?(
    phase: "recording" | "paused" | "finalizing" | null,
    backend?: "browser" | "windows-native"
  ): void
}

export function BotTeachControls(props: BotTeachControlsProps) {
  const epoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  return (
    <BotTeachController
      key={JSON.stringify([
        props.botId,
        props.conversationId,
        props.threadRootId,
        epoch,
        props.backend ?? "browser"
      ])}
      {...props}
    />
  )
}

function BotTeachController({
  active,
  botId,
  conversationId,
  threadRootId,
  arm,
  onPrepared,
  cancelPreparation,
  frame,
  backend = "browser",
  refresh,
  onRecordingPhase
}: BotTeachControlsProps) {
  const preparationDescription = useId()
  const botName = useBotWorkspaceStore(
    (state) => state.snapshot?.bots.find((bot) => bot.id === botId)?.name ?? "Bot"
  )
  const [session, setSession] = useState<BotTeachSession | null>(null)
  const [statusKnown, setStatusKnown] = useState(false)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const userSkills = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_USER_SKILLS_CAPABILITY) ?? false
  )
  const [now, setNow] = useState(Date.now())
  const [history, setHistory] = useState(false)
  const alive = useRef(true),
    locked = useRef(false),
    startRequest = useRef<BotTeachStartInput | null>(null)
  const revision = useRef(0)
  const retryRequest = useRef<BotTeachRetryInput | null>(null)
  const prepared = useRef(onPrepared)
  prepared.current = onPrepared
  const polling = useRef(false)
  const controls = useRef<HTMLDivElement>(null)
  const historyTrigger = useRef<HTMLButtonElement>(null)
  const currentActive = useRef(active)
  useLayoutEffect(() => {
    currentActive.current = active
  }, [active])
  const actionFocus = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const trigger = actionFocus.current
    if (!busy || !active || history) actionFocus.current = null
    const surface = controls.current
    if (
      !trigger ||
      !active ||
      history ||
      !alive.current ||
      !surface?.isConnected ||
      surface.closest('[inert], [hidden], [aria-hidden="true"]') ||
      !surface.getClientRects().length ||
      document.activeElement !== document.body
    )
      return
    if (
      [...document.querySelectorAll<HTMLElement>('[data-cmb-modal-dialog="true"]')].some(
        (dialog) =>
          !dialog.contains(surface) &&
          !dialog.closest('[inert], [hidden], [aria-hidden="true"]') &&
          dialog.getClientRects().length > 0
      )
    ) {
      actionFocus.current = null
      return
    }
    // Disabling/replacing the action button can leave focus on body. Keep
    // Escape inside this controller's existing panel throughout the request.
    const target =
      trigger.isConnected &&
      surface.contains(trigger) &&
      !trigger.matches(":disabled") &&
      !trigger.closest('[inert], [hidden], [aria-hidden="true"]') &&
      trigger.getClientRects().length
        ? trigger
        : surface
    target.focus({ preventScroll: true })
  }, [active, busy, history])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!active) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const current = revision.current
      if (!polling.current) {
        polling.current = true
        try {
          const value = await botApi.teachStatus(botId)
          if (!disposed && current === revision.current && !locked.current) {
            setSession(value)
            setStatusKnown(true)
            setNow(Date.now())
            if (value?.startNonce && value.startNonce === startRequest.current?.nonce) {
              startRequest.current = null
              setError(null)
              prepared.current?.()
            }
          }
        } catch (failure) {
          if (!disposed && current === revision.current)
            setError(failure instanceof Error ? failure.message : "无法读取示范状态")
        } finally {
          polling.current = false
        }
      }
      if (!disposed) {
        timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [botId, active])
  const action = async (operation: () => Promise<BotTeachSession>) => {
    if (locked.current) return
    const focused = document.activeElement
    actionFocus.current =
      focused instanceof HTMLElement && controls.current?.contains(focused) ? focused : null
    locked.current = true
    revision.current++
    setBusy(true)
    setError(null)
    try {
      const value = await operation()
      if (alive.current) {
        setSession(value)
        await refresh()
      }
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "示范操作失败")
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  const sessionBackend = session?.backend ?? "browser"
  const belongsHere = sessionBackend === backend
  const recordingAnywhere = session && ["recording", "paused", "finalizing"].includes(session.phase)
  const recording = belongsHere && recordingAnywhere
  const recordingPhase = recordingAnywhere
    ? (session.phase as "recording" | "paused" | "finalizing")
    : null
  const recordingBackend = session ? sessionBackend : backend
  useLayoutEffect(() => {
    if (!statusKnown) return
    onRecordingPhase?.(recordingPhase, recordingBackend)
    // Only this source may retire its phase; another controller's initial/hidden
    // state must not unlock a durable recording on the other backend.
    return () => onRecordingPhase?.(null, recordingBackend)
  }, [onRecordingPhase, recordingPhase, statusKnown, recordingBackend])
  const ownsControl = frame?.control === "human" && frame.controlOwner === "self"
  const learning = belongsHere && session && ["queued", "learning"].includes(session.phase)
  const seconds = session
    ? Math.max(0, Math.floor(((session.endedAt ?? now) - session.startedAt) / 1000))
    : 0
  return (
    <div
      ref={controls}
      tabIndex={-1}
      className="bot-teach-controls px-4 py-2"
      aria-label="示范学习"
      data-recording={recording || undefined}
      data-preparing={(Boolean(arm) && !recording && !learning) || undefined}
    >
      {history && (
        <BotTeachHistory
          key={botId}
          botId={botId}
          close={() => setHistory(false)}
          onCloseAutoFocus={(event) => {
            // This dialog is opened by an existing toolbar button rather than
            // a DialogTrigger. Restore that same controller's live button.
            event.preventDefault()
            const trigger = historyTrigger.current
            if (
              !alive.current ||
              !currentActive.current ||
              !trigger?.isConnected ||
              trigger.disabled ||
              trigger.closest('[inert], [hidden], [aria-hidden="true"]') ||
              !trigger.getClientRects().length ||
              document.activeElement !== document.body ||
              [...document.querySelectorAll<HTMLElement>('[data-cmb-modal-dialog="true"]')].some(
                (dialog) =>
                  !dialog.closest('[inert], [hidden], [aria-hidden="true"]') &&
                  dialog.getClientRects().length > 0
              )
            )
              return
            trigger.focus({ preventScroll: true })
          }}
        />
      )}
      <div className="bot-teach-control-row flex flex-wrap items-center gap-2">
        <Button
          ref={historyTrigger}
          size="icon"
          variant="ghost"
          className="bot-teach-history size-7"
          aria-label="查看示范记录"
          onClick={() => setHistory(true)}
        >
          <History size={14} />
        </Button>
        {recording ? (
          <>
            <span
              className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium"
              role="status"
            >
              <Circle
                size={9}
                className={
                  session.phase === "recording"
                    ? "fill-destructive text-destructive"
                    : "fill-muted-foreground text-muted-foreground"
                }
              />
              {session.phase === "paused"
                ? "录制已暂停"
                : session.phase === "finalizing"
                  ? "正在保存"
                  : "正在录制示范"}
              <span className="font-mono tabular-nums text-muted-foreground">
                {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
              </span>
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={session.phase === "paused" ? "继续录制" : "暂停录制"}
              disabled={busy || !ownsControl || session.phase === "finalizing"}
              onClick={() =>
                void action(() =>
                  botApi.teachPause({ id: session.id, paused: session.phase !== "paused" })
                )
              }
            >
              {session.phase === "paused" ? <Play size={14} /> : <Pause size={14} />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !ownsControl || session.phase === "finalizing"}
              onClick={() => void action(() => botApi.teachStop({ id: session.id, save: true }))}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />}{" "}
              保存并学习
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="丢弃录制"
              disabled={busy || !ownsControl || session.phase === "finalizing"}
              onClick={() => void action(() => botApi.teachStop({ id: session.id, save: false }))}
            >
              <Trash2 size={14} />
            </Button>
          </>
        ) : learning ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 size={14} className="animate-spin" />{" "}
            正在理解示范并整理技能，可回到对话查看进展
          </span>
        ) : (
          <>
            {arm && (
              <p id={preparationDescription} className="bot-teach-preparation-copy">
                录制你执行任务的过程。<span className="font-medium text-foreground">{botName}</span>{" "}
                会学习这些步骤，之后可以自行再次执行。
                {userSkills &&
                  "技能保存到我的技能库，其他 Bot 也可使用；录制和聊天仍仅此 Bot 可见。"}
              </p>
            )}
            <Button
              size="sm"
              variant={arm ? "destructive" : "ghost"}
              className={arm ? "bot-teach-preparation-start" : undefined}
              aria-describedby={arm ? preparationDescription : undefined}
              title={userSkills ? "学习后保存到我的技能库，供本机个人工作区的 Bot 共用" : undefined}
              disabled={
                busy ||
                !active ||
                !statusKnown ||
                !frame ||
                Boolean(recordingAnywhere) ||
                (backend === "windows-native" && !ownsControl) ||
                frame.control === "handoff" ||
                (frame.control === "human" && !ownsControl)
              }
              onClick={() => {
                if (
                  !frame ||
                  !statusKnown ||
                  !active ||
                  recordingAnywhere ||
                  (backend === "windows-native" && !ownsControl)
                )
                  return
                void action(async () => {
                  if (!startRequest.current) {
                    const state = useBotWorkspaceStore.getState()
                    const conversation = state.snapshot?.conversations.find(
                      (item) => item.id === conversationId
                    )
                    if (!conversation || !conversation.members.includes(botId))
                      throw new Error("请重新打开当前 Bot 的对话后开始示范")
                    if (
                      arm &&
                      ((arm.backend ?? "browser") !== backend ||
                        arm.botId !== botId ||
                        arm.conversationId !== conversationId ||
                        arm.threadRootId !== threadRootId ||
                        arm.dataEpoch !== state.snapshot?.dataEpoch ||
                        arm.viewId !== state.selected ||
                        arm.conversationRevision !== conversation.revision)
                    )
                      throw new Error("示范准备的对话已变化，请重新选择")
                    if (("backend" in frame ? frame.backend : "browser") !== backend)
                      throw new Error("示范画面来源已变化，请重新观察")
                    startRequest.current = {
                      ...(userSkills ? { skillScope: "user" as const } : {}),
                      expectedDataEpoch: state.snapshot?.dataEpoch ?? "initial",
                      botId,
                      conversationId,
                      conversationRevision: conversation.revision,
                      ...(threadRootId ? { threadRootId } : {}),
                      nonce: crypto.randomUUID(),
                      target: {
                        ...(backend === "windows-native" ? { backend } : {}),
                        botId: frame.botId,
                        generation: frame.generation,
                        controlEpoch: frame.controlEpoch,
                        viewId: frame.viewId,
                        control: frame.control,
                        ...(frame.taskRunId ? { taskRunId: frame.taskRunId } : {})
                      }
                    }
                  }
                  try {
                    const value = await botApi.teachStart(startRequest.current)
                    startRequest.current = null
                    if (alive.current) prepared.current?.()
                    return value
                  } catch (failure) {
                    // These are admission rejections. An uncertain transport failure
                    // retains the entire original request for exact nonce recovery.
                    if (
                      failure instanceof BotDomainError &&
                      [
                        "data_epoch",
                        "teach_scope",
                        "revision_conflict",
                        "thread_unavailable",
                        "invalid_input",
                        "stale_target",
                        "computer_owned_elsewhere"
                      ].includes(failure.code)
                    )
                      startRequest.current = null
                    throw failure
                  }
                })
              }}
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Circle
                  size={13}
                  aria-hidden="true"
                  className={arm ? "bot-teach-preparation-dot" : undefined}
                />
              )}
              {startRequest.current ? "核对原录制请求" : arm ? "开始录制" : "示范给 Bot"}
            </Button>
            {arm && cancelPreparation && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="bot-teach-preparation-cancel"
                aria-label="取消准备"
                title="取消准备"
                disabled={busy}
                onClick={cancelPreparation}
              >
                <X size={16} aria-hidden="true" />
              </Button>
            )}
            {belongsHere && session?.phase === "ready" && (
              <span className="bot-teach-ready-note flex items-center gap-1 text-xs text-muted-foreground">
                <Check size={13} /> 技能已保存，可在技能中查看或试跑
              </span>
            )}
          </>
        )}
      </div>
      {recording && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          仅录制此 Bot 的{backend === "windows-native" ? "当前工作应用" : "浏览器"}，无声音，最长 10
          分钟。输入敏感信息前请暂停。
        </p>
      )}
      {belongsHere && session?.phase === "failed" && session.video && (
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void action(async () => {
              if (!retryRequest.current) {
                const state = useBotWorkspaceStore.getState()
                const conversation = state.snapshot?.conversations.find(
                  (item) => item.id === session.conversationId
                )
                if (!conversation) throw new Error("原示范对话已不可用")
                retryRequest.current = {
                  expectedDataEpoch: state.snapshot?.dataEpoch ?? "initial",
                  id: session.id,
                  revision: session.revision,
                  conversationRevision: conversation.revision,
                  nonce: crypto.randomUUID()
                }
              }
              const value = await botApi.teachRetry(retryRequest.current)
              retryRequest.current = null
              return value
            })
          }}
        >
          重新学习这段示范
        </Button>
      )}
      {(error || (belongsHere && session?.error)) && (
        <p className="mt-2 text-xs leading-relaxed text-destructive" role="alert">
          {error || session?.error}
        </p>
      )}
    </div>
  )
}
