import type { BotTeachArm } from "../../../../shared/bot-teach"
import { botApi } from "@/lib/bot-api"
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, Hand, Loader2, RefreshCw, Plus, X } from "lucide-react"
import { ArrowUp, Globe2, Keyboard, Monitor } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import type {
  BotBrowserFrame,
  BotBrowserTarget,
  BotHumanInput
} from "../../../../shared/bot-computer"
import { BOT_HUMAN_INPUT_LIMIT, BOT_HUMAN_INPUT_CHARACTERS } from "../../../../shared/bot-computer"
import type { BotRunAddress } from "../../../../shared/bot-run-history"
import { BotAvatar } from "./BotAvatar"
import { BotTeachControls } from "./BotTeachControls"
import { mapTeachPointer } from "../../../../shared/upstream/rakazo-teach-pointer"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BotNativeComputer } from "./BotNativeComputer"
import { BotNativeSelectPicker } from "./BotNativeSelectPicker"

interface BotComputerProps {
  botId: string
  conversationId: string
  threadRootId?: string
  teachArm?: BotTeachArm | null
  onTeachPrepared?(): void
  cancelTeachPreparation?(): void
  /** Server-resolved child address; omitted for the persistent Bot computer. */
  taskAddress?: BotRunAddress
  readOnly?: boolean
  name: string
  expanded: boolean
  active: boolean
  onExpand?(): void
  onBackendChange?(backend: "browser" | "windows-native"): void
  browserOnly?: boolean
  onReturnControl?(target: BotBrowserTarget): Promise<void>
}

type BrowserInput = Omit<BotHumanInput, "frameSeq" | "navigationEpoch" | "humanInputLease">
type HumanInputTicket = {
  target: BotBrowserTarget
  frameSeq: number
  navigationEpoch?: number
  leaseId: string
}
type PendingBrowserInput = {
  scope: string
  value: BrowserInput
  characters: number
  accepted?: () => void
  ticket?: HumanInputTicket
}

function inputTarget(frame: BotBrowserFrame): BotBrowserTarget {
  return {
    botId: frame.botId,
    ...(frame.taskRunId ? { taskRunId: frame.taskRunId } : {}),
    generation: frame.generation,
    controlEpoch: frame.controlEpoch,
    control: frame.control,
    viewId: frame.viewId
  }
}

function keyboardScope(frame: BotBrowserFrame): string | null {
  if (!Number.isSafeInteger(frame.navigationEpoch) || frame.navigationEpoch! < 0) return null
  return JSON.stringify([inputTarget(frame), frame.navigationEpoch])
}

function continuousScope(frame: BotBrowserFrame): string | null {
  const scope = keyboardScope(frame)
  return scope && frame.humanInputLease
    ? JSON.stringify([scope, frame.humanInputLease.id, frame.width, frame.height])
    : null
}

/** Retire frames and drafts when changing owner; late replies stay with the old surface. */
export function BotComputer(props: BotComputerProps) {
  const { botId, taskAddress } = props
  const hostId = useBotWorkspaceStore((state) => state.host?.hostId)
  const hostEpoch = useBotWorkspaceStore((state) => state.host?.dataEpoch)
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const owner = JSON.stringify([
    hostId,
    hostEpoch,
    dataEpoch,
    botId,
    taskAddress?.conversationId,
    taskAddress?.runId,
    taskAddress?.threadRootId
  ])
  return <BotComputerModes key={owner} {...props} />
}

type RecordingPhase = "recording" | "paused" | "finalizing" | null
type TeachBackend = "browser" | "windows-native"

function BotComputerModes(props: BotComputerProps) {
  const supportsNative =
    useBotWorkspaceStore(
      (state) => state.host?.capabilities?.includes("windows-native-computer") === true
    ) &&
    !props.taskAddress &&
    !props.browserOnly
  const hostId = useBotWorkspaceStore((state) => state.host?.hostId)
  const hostEpoch = useBotWorkspaceStore((state) => state.host?.dataEpoch)
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [selected, setSelected] = useState<"browser" | "native">("browser")
  const [nativeVisited, setNativeVisited] = useState(false)
  const [recording, setRecording] = useState<{
    backend: TeachBackend
    phase: RecordingPhase
  } | null>(null)
  const armed = props.teachArm
    ? props.teachArm.backend === "windows-native"
      ? "native"
      : "browser"
    : null
  const mode = !supportsNative
    ? "browser"
    : recording
      ? recording.backend === "windows-native"
        ? "native"
        : "browser"
      : (armed ?? selected)
  const reportRecording = useCallback((phase: RecordingPhase, backend: TeachBackend) => {
    setRecording((current) =>
      phase ? { backend, phase } : current?.backend === backend ? null : current
    )
    if (phase) setSelected(backend === "windows-native" ? "native" : "browser")
  }, [])
  const onBrowserRecordingPhase = useCallback(
    (phase: RecordingPhase, backend: TeachBackend = "browser") => reportRecording(phase, backend),
    [reportRecording]
  )
  const onNativeRecordingPhase = useCallback(
    (phase: RecordingPhase, backend: TeachBackend = "windows-native") =>
      reportRecording(phase, backend),
    [reportRecording]
  )
  const prepared = props.onTeachPrepared
  const onBrowserPrepared = useCallback(() => {
    setSelected("browser")
    prepared?.()
  }, [prepared])
  const onNativePrepared = useCallback(() => {
    setSelected("native")
    prepared?.()
  }, [prepared])
  return (
    <div className="bot-computer-modes flex min-h-0 flex-1 flex-col">
      {supportsNative && (
        <div className="bot-computer-mode-switch" role="group" aria-label="电脑类型">
          <button
            type="button"
            aria-pressed={mode === "browser"}
            disabled={Boolean(props.teachArm || recording)}
            title={props.teachArm || recording ? "先结束当前示范" : undefined}
            onClick={() => {
              setSelected("browser")
              props.onBackendChange?.("browser")
            }}
          >
            <Globe2 size={14} />
            浏览器
          </button>
          <button
            type="button"
            aria-pressed={mode === "native"}
            disabled={Boolean(props.teachArm || recording)}
            title={props.teachArm || recording ? "先结束当前示范" : undefined}
            onClick={() => {
              setNativeVisited(true)
              setSelected("native")
              props.onBackendChange?.("windows-native")
            }}
          >
            <Monitor size={14} />
            工作应用
          </button>
        </div>
      )}
      <div className="bot-computer-view flex min-h-0 flex-1 flex-col" hidden={mode !== "browser"}>
        <BotComputerSurface
          {...props}
          active={props.active && mode === "browser"}
          onRecordingPhase={onBrowserRecordingPhase}
          onTeachPrepared={onBrowserPrepared}
        />
      </div>
      {supportsNative && (nativeVisited || mode === "native") && (
        <div className="bot-computer-view flex min-h-0 flex-1 flex-col" hidden={mode !== "native"}>
          <BotNativeComputer
            key={JSON.stringify([hostId, hostEpoch, dataEpoch])}
            botId={props.botId}
            name={props.name}
            conversationId={props.conversationId}
            threadRootId={props.threadRootId}
            teachArm={props.teachArm}
            onTeachPrepared={onNativePrepared}
            cancelTeachPreparation={props.cancelTeachPreparation}
            onRecordingPhase={onNativeRecordingPhase}
            onBrowser={() => {
              if (props.teachArm || recording) return
              setSelected("browser")
              props.onBackendChange?.("browser")
            }}
            active={props.active && mode === "native"}
            expanded={props.expanded}
            onExpand={props.onExpand}
          />
        </div>
      )}
    </div>
  )
}

/** Human FIFO retains the source frame; continuous input never borrows an unseen frame ticket. */
function BotComputerSurface({
  botId,
  conversationId,
  threadRootId,
  teachArm,
  onTeachPrepared,
  cancelTeachPreparation,
  taskAddress,
  readOnly = false,
  name,
  expanded,
  active,
  onExpand,
  onReturnControl,
  onRecordingPhase
}: BotComputerProps & { onRecordingPhase?(phase: RecordingPhase, backend?: TeachBackend): void }) {
  const taskConversation = taskAddress?.conversationId
  const taskRunId = taskAddress?.runId
  const taskThread = taskAddress?.threadRootId
  const computerAddress = useMemo(
    () =>
      taskRunId && taskConversation
        ? {
            conversationId: taskConversation,
            runId: taskRunId,
            threadRootId: taskThread
          }
        : botId,
    [botId, taskConversation, taskRunId, taskThread]
  )
  const assertOwner = useCallback(
    (target: { botId: string; taskRunId?: string }) => {
      if (target.botId !== botId || target.taskRunId !== taskRunId)
        throw new Error("浏览器画面与当前任务不一致，请重新打开电脑。")
      if (
        "navigationEpoch" in target &&
        (!Number.isSafeInteger(target.navigationEpoch) || Number(target.navigationEpoch) < 0)
      )
        throw new Error("浏览器页面版本无效，请更新后台后重新打开电脑。")
    },
    [botId, taskRunId]
  )
  const documentVisible = useBotViewVisibility()
  const visible = active && documentVisible
  const [frame, setFrame] = useState<BotBrowserFrame | null>(null)
  const [recordingPhase, setRecordingPhase] = useState<
    "recording" | "paused" | "finalizing" | null
  >(null)
  const reportRecordingPhase = useCallback(
    (phase: RecordingPhase, backend: TeachBackend = "browser") => {
      setRecordingPhase(backend === "browser" ? phase : null)
      onRecordingPhase?.(phase, backend)
    },
    [onRecordingPhase]
  )
  const [paintedTicket, setPaintedTicket] = useState<string | null>(null)
  const paintedFrame = useRef<BotBrowserFrame | null>(null)
  const leaseSequence = useRef<{ id: string; next: number } | null>(null)
  const [transfer, setTransfer] = useState<BotBrowserFrame | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState(""),
    [text, setText] = useState("")
  const locked = useRef(false),
    alive = useRef(true),
    current = useRef<BotBrowserFrame | null>(null)
  const pendingInputs = useRef<PendingBrowserInput[]>([])
  const pendingCharacters = useRef(0)
  const activeCharacters = useRef(0)
  const inputScope = useRef<string | null>(null)
  const inputInFlight = useRef(false)
  const submittedDraft = useRef<string | null>(null)
  const [queued, setQueued] = useState(0)
  const [inputNotice, setInputNotice] = useState<string | null>(null)
  const inputRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputRefreshRunning = useRef(false)
  const inputRefreshNeeded = useRef(false)
  const [inputRefreshPending, setInputRefreshPending] = useState(false)
  const clearInputs = useCallback((notice?: string) => {
    pendingInputs.current.length = 0
    pendingCharacters.current = 0
    inputScope.current = null
    submittedDraft.current = null
    if (alive.current) {
      setQueued(0)
      if (notice) setInputNotice(notice)
    }
  }, [])
  const isVisible = useRef(visible)
  const polling = useRef(false)
  // Manual intent and each new observation retire older in-flight frames.
  const observation = useRef(0)
  const controls = useRef<HTMLDivElement>(null)
  const inputHintId = useId()
  const focusExitLabel =
    window.electron?.process.platform === "darwin" ? "⌃ + ⌥ + Esc" : "Ctrl + Alt + Esc"
  const refresh = useCallback(async () => {
    // An input may finish after closing the inspector or covering it with
    // settings. Its result must not start another hidden screenshot request.
    if (!alive.current || !isVisible.current) return
    const revision = ++observation.current
    try {
      const next = await botApi.computerFrame(computerAddress)
      assertOwner(next)
      if (alive.current && isVisible.current && observation.current === revision) {
        current.current = next
        setFrame(next)
        setError(null)
      }
    } catch (failure) {
      // A retired read cannot replace a newer control transfer with an old error.
      if (alive.current && isVisible.current && observation.current === revision) throw failure
    }
  }, [computerAddress, assertOwner])
  const requestInputRefresh = useCallback(() => {
    if (!alive.current || !isVisible.current) return
    inputRefreshNeeded.current = true
    setInputRefreshPending(true)
    if (inputRefreshRunning.current || inputRefreshTimer.current) return
    const schedule = () => {
      inputRefreshTimer.current = setTimeout(async () => {
        inputRefreshTimer.current = undefined
        if (!alive.current || !isVisible.current) {
          inputRefreshNeeded.current = false
          if (alive.current) setInputRefreshPending(false)
          return
        }
        // The next effect does not wait for a JPEG/decode round trip. A burst gets one final frame.
        if (locked.current || pendingInputs.current.length) return
        inputRefreshNeeded.current = false
        inputRefreshRunning.current = true
        try {
          await refresh()
        } catch (failure) {
          paintedFrame.current = null
          clearInputs("画面更新失败，请刷新后继续操作。")
          if (alive.current) setError(failure instanceof Error ? failure.message : "画面更新失败")
        } finally {
          inputRefreshRunning.current = false
          if (inputRefreshNeeded.current && alive.current && isVisible.current) schedule()
          else if (alive.current) setInputRefreshPending(false)
        }
      }, 50)
    }
    schedule()
  }, [refresh, clearInputs])
  const operation = useCallback(
    async (run: () => Promise<unknown>, isInput = false, continuous = false) => {
      if (locked.current) return
      if (!continuous) {
        // This operation owns its refresh. Retire a previous stream's deferred
        // timer before taking the lock, so it cannot leave "refresh needed" stuck.
        clearTimeout(inputRefreshTimer.current)
        inputRefreshTimer.current = undefined
        inputRefreshNeeded.current = false
        setInputRefreshPending(false)
      }
      if (!isInput) clearInputs(pendingInputs.current.length ? "已取消尚未发送的输入。" : undefined)
      locked.current = true
      inputInFlight.current = isInput
      observation.current++
      setBusy(true)
      try {
        await run()
        if (!continuous) await refresh()
      } catch (failure) {
        // Opening/refreshing is also an operation. A failed observation has
        // no input outcome to review; retain cancellation notices only when
        // an actual input failed or pending inputs were discarded.
        clearInputs(
          isInput || pendingInputs.current.length > 0
            ? "操作未确认，已取消尚未发送的输入，请核对画面后重试。"
            : undefined
        )
        paintedFrame.current = null
        // Rejected stale/foreign inputs must show the current owner and screen.
        await refresh().catch(() => {})
        if (alive.current) setError(failure instanceof Error ? failure.message : "电脑操作失败")
      } finally {
        locked.current = false
        inputInFlight.current = false
        activeCharacters.current = 0
        if (alive.current) setBusy(false)
        if (continuous) requestInputRefresh()
      }
    },
    [refresh, clearInputs, requestInputRefresh]
  )
  useLayoutEffect(() => {
    isVisible.current = visible
    observation.current++
    if (!visible) {
      clearInputs()
      clearTimeout(inputRefreshTimer.current)
      inputRefreshTimer.current = undefined
      inputRefreshNeeded.current = false
      setInputRefreshPending(false)
    }
    // Keep the same in-flight input lock and drafts across inspector tabs.
    // Observe again before accepting input when this screen becomes visible.
    if (visible)
      void operation(async () => {
        if (!current.current) assertOwner(await botApi.computerOpen(computerAddress))
      })
  }, [visible, operation, computerAddress, assertOwner, clearInputs])
  const dismissNativeSelect = useCallback(() => {
    const displayed = current.current
    if (
      displayed?.control !== "human" ||
      displayed.controlOwner !== "self" ||
      !displayed.nativeSelect
    )
      return
    void botApi
      .computerInput({
        target: inputTarget(displayed),
        input: {
          kind: "select_dismiss",
          frameSeq: displayed.frameSeq,
          selectToken: displayed.nativeSelect.token
        }
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!visible) dismissNativeSelect()
    return () => dismissNativeSelect()
  }, [visible, dismissNativeSelect])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearInputs()
      clearTimeout(inputRefreshTimer.current)
      inputRefreshTimer.current = undefined
      inputRefreshNeeded.current = false
    }
  }, [clearInputs])
  useEffect(() => {
    if (!visible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (disposed || !isVisible.current) return
      if (
        !locked.current &&
        !polling.current &&
        !inputRefreshRunning.current &&
        !inputRefreshNeeded.current
      ) {
        polling.current = true
        const displayed = current.current
        const revision = observation.current
        try {
          if (
            displayed?.control === "human" &&
            displayed.controlOwner === "self" &&
            !displayed.humanInputLease &&
            !displayed.humanInputPending
          ) {
            // A passive ownership check keeps the displayed human input ticket.
            const next = await botApi.computerOpen(computerAddress)
            assertOwner(next)
            if (
              !disposed &&
              !locked.current &&
              observation.current === revision &&
              current.current === displayed &&
              (next.generation !== displayed.generation ||
                next.controlEpoch !== displayed.controlEpoch ||
                next.controlOwner !== displayed.controlOwner)
            )
              await refresh()
          } else {
            // Watching must not disable takeover or animate the manual refresh.
            // One passive request may overlap one manual action; no poll queues.
            await refresh()
          }
        } catch (failure) {
          if (
            !disposed &&
            !locked.current &&
            (displayed?.control !== "human" ||
              displayed.controlOwner !== "self" ||
              observation.current === revision)
          )
            setError(failure instanceof Error ? failure.message : "电脑连接已断开")
        } finally {
          polling.current = false
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1500)
    }
    timer = setTimeout(() => void poll(), 1500)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [computerAddress, assertOwner, refresh, visible])
  const human = !readOnly && frame?.control === "human" && frame.controlOwner === "self"
  const otherHuman = !readOnly && frame?.control === "human" && frame.controlOwner === "other"
  const legacyHuman = !readOnly && frame?.control === "human" && !frame.controlOwner
  const preview = !human && !otherHuman && !legacyHuman && !expanded
  const frameTicket = frame
    ? JSON.stringify([
        frame.botId,
        frame.taskRunId,
        frame.generation,
        frame.controlEpoch,
        frame.viewId,
        frame.navigationEpoch,
        frame.frameSeq
      ])
    : null
  const frameReady = frameTicket !== null && paintedTicket === frameTicket
  const canDispatch = human && visible && !busy && frameReady && !frame?.humanInputPending
  const inputReady = canDispatch && queued === 0
  const continuousReady =
    human &&
    visible &&
    frame !== null &&
    !frame.humanInputPending &&
    paintedFrame.current !== null &&
    continuousScope(frame) !== null &&
    continuousScope(frame) === continuousScope(paintedFrame.current) &&
    (!locked.current || inputInFlight.current)
  const controlsReady = continuousReady || inputReady
  const markImageReady = useCallback(
    (image: HTMLImageElement | null) => {
      // React can commit a new ticket before its image has decoded. An unchanged
      // image may already be cached and never emit another load event.
      if (
        image &&
        frame &&
        current.current === frame &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.currentSrc === frame.image
      ) {
        paintedFrame.current = frame
        if (frame.humanInputLease) {
          const { id, nextSequence } = frame.humanInputLease
          leaseSequence.current =
            leaseSequence.current?.id === id
              ? { id, next: Math.max(leaseSequence.current.next, nextSequence) }
              : { id, next: nextSequence }
        }
        setPaintedTicket(frameTicket)
      }
    },
    [frame, frameTicket]
  )
  const sendInput = useCallback(
    async (
      displayed: BotBrowserFrame,
      value: BrowserInput,
      accepted?: () => void,
      ticket?: HumanInputTicket
    ) => {
      let humanInputLease: BotHumanInput["humanInputLease"]
      if (ticket) {
        const sequence = leaseSequence.current
        if (sequence?.id !== ticket.leaseId) throw new Error("连续输入已失效，请查看新画面后操作。")
        humanInputLease = { id: sequence.id, sequence: sequence.next++ }
      }
      await botApi.computerInput({
        target: ticket?.target ?? inputTarget(displayed),
        input: {
          ...value,
          ...(humanInputLease ? { humanInputLease } : {}),
          frameSeq: ticket?.frameSeq ?? displayed.frameSeq,
          ...((ticket ? ticket.navigationEpoch : displayed.navigationEpoch) === undefined
            ? {}
            : { navigationEpoch: ticket ? ticket.navigationEpoch : displayed.navigationEpoch })
        }
      })
      if (alive.current) accepted?.()
    },
    []
  )
  // Current Hosts authorize a bounded human stream on the actual painted document.
  // Older Hosts keep their per-frame keyboard FIFO; coordinates are never rebased.
  useLayoutEffect(() => {
    if (!human || !visible) {
      clearInputs()
      return
    }
    const pending = pendingInputs.current[0]
    const scope = frame && (pending?.ticket ? continuousScope(frame) : keyboardScope(frame))
    if (pending && (!frame || scope !== inputScope.current)) {
      clearInputs("页面或控制权已变化，已取消尚未发送的输入。")
      return
    }
    if (locked.current || !frame || (!pending?.ticket && !canDispatch)) return
    const next = pendingInputs.current.shift()
    if (!next) return
    if (next.scope !== scope) {
      clearInputs("页面已变化，已取消尚未发送的输入。")
      return
    }
    pendingCharacters.current -= next.characters
    activeCharacters.current = next.characters
    setQueued(pendingInputs.current.length)
    void operation(
      () => sendInput(frame, next.value, next.accepted, next.ticket),
      true,
      !!next.ticket
    )
  }, [human, visible, canDispatch, frame, queued, operation, sendInput, clearInputs])
  const input = (value: BrowserInput, accepted?: () => void) => {
    const displayed = continuousReady ? paintedFrame.current : frame
    if (!displayed || !human || !visible) return false
    if (displayed.humanInputPending) {
      setInputNotice("页面正在跳转，请等待新画面后操作。")
      return false
    }
    if (continuousReady && displayed.humanInputLease) {
      const scope = continuousScope(displayed)!
      if (
        inputScope.current !== null &&
        scope !== inputScope.current &&
        (locked.current || pendingInputs.current.length)
      ) {
        clearInputs("页面或控制权已变化，本次及待发送输入均已取消。")
        return false
      }
      const characters =
        (value.text?.length ?? 0) + (value.key?.length ?? 0) + (value.url?.length ?? 0)
      if (
        pendingInputs.current.length + Number(inputInFlight.current) >= BOT_HUMAN_INPUT_LIMIT ||
        pendingCharacters.current + activeCharacters.current + characters >
          BOT_HUMAN_INPUT_CHARACTERS
      ) {
        setInputNotice("待发送输入已满，本次输入未发送，请等待后重试。")
        return false
      }
      if (!locked.current && !pendingInputs.current.length) setInputNotice(null)
      inputScope.current = scope
      pendingInputs.current.push({
        scope,
        value,
        characters,
        accepted,
        ticket: {
          target: inputTarget(displayed),
          frameSeq: displayed.frameSeq,
          navigationEpoch: displayed.navigationEpoch,
          leaseId: displayed.humanInputLease.id
        }
      })
      pendingCharacters.current += characters
      setQueued(pendingInputs.current.length)
      return true
    }
    if (value.kind === "key" || value.kind === "text") {
      const scope = keyboardScope(displayed)
      if (scope === null) {
        if (!inputReady || locked.current) {
          setInputNotice("当前后台不支持连续输入，请等待画面更新后重试。")
          return false
        }
        setInputNotice(null)
        void operation(() => sendInput(displayed, value, accepted), true)
        return true
      }
      if (
        (!frameReady && !locked.current && !pendingInputs.current.length) ||
        (locked.current && (!inputInFlight.current || inputScope.current === null))
      ) {
        setInputNotice("画面正在更新，本次输入未发送，请稍后重试。")
        return false
      }
      if (
        inputScope.current !== null &&
        scope !== inputScope.current &&
        (locked.current || pendingInputs.current.length)
      ) {
        clearInputs("页面或控制权已变化，本次及待发送输入均已取消。")
        return false
      }
      const characters = value.text?.length ?? value.key?.length ?? 0
      if (
        pendingInputs.current.length + Number(inputInFlight.current) >= BOT_HUMAN_INPUT_LIMIT ||
        pendingCharacters.current + activeCharacters.current + characters >
          BOT_HUMAN_INPUT_CHARACTERS
      ) {
        setInputNotice("待发送输入已满，本次输入未发送，请等待后重试。")
        return false
      }
      if (!locked.current && !pendingInputs.current.length) {
        inputScope.current = scope
        setInputNotice(null)
      }
      pendingInputs.current.push({ scope, value, characters, accepted })
      pendingCharacters.current += characters
      setQueued(pendingInputs.current.length)
      return true
    }
    if (!inputReady || locked.current) {
      setInputNotice("输入仍在处理，本次操作未执行，请等待画面更新后重试。")
      return false
    }
    clearInputs()
    setInputNotice(null)
    inputScope.current =
      value.kind === "click" || value.kind === "scroll" ? keyboardScope(displayed) : null
    void operation(() => sendInput(displayed, value, accepted), true)
    return true
  }
  return (
    <div
      className="bot-computer-content flex min-h-0 flex-1 flex-col"
      data-preview={preview || undefined}
      data-expanded={expanded || undefined}
      data-recording-phase={recordingPhase ?? undefined}
    >
      <div
        ref={controls}
        role="group"
        tabIndex={-1}
        aria-label="电脑操作控件"
        className="bot-computer-control flex shrink-0 flex-wrap items-center gap-2 px-4 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            className="rounded-full shadow-none"
            disabled={busy || !frame || frame.control === "handoff"}
            onClick={() => {
              if (!frame) return
              if (otherHuman) {
                setTransfer(frame)
                return
              }
              void operation(() =>
                human || legacyHuman
                  ? onReturnControl
                    ? onReturnControl(frame)
                    : botApi.computerRelease(frame)
                  : botApi.computerTake({
                      ...frame,
                      conversationId: taskConversation ?? conversationId,
                      threadRootId: taskAddress ? taskThread : threadRootId
                    })
              )
            }}
          >
            <Hand size={14} />
            {human || legacyHuman
              ? onReturnControl
                ? "归还并继续"
                : "归还 Bot"
              : otherHuman
                ? "转移控制权"
                : "接管操作"}
          </Button>
        )}
        <span role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {readOnly
            ? "当前任务画面仅供查看"
            : human
              ? frame?.humanInputPending
                ? "页面正在跳转"
                : busy || queued || inputRefreshPending
                  ? `${inputInFlight.current ? "正在输入" : "正在更新画面"}${queued ? ` · 待发送 ${queued} 项` : ""}`
                  : "你正在操作，Bot 已暂停输入"
              : otherHuman
                ? frame.controlOwnerConnected
                  ? "另一客户端正在操作"
                  : "控制端已断开，Bot 保持暂停"
                : legacyHuman
                  ? "请归还控制权，以便更新后台"
                  : !frame
                    ? "正在连接"
                    : frame.control === "handoff"
                      ? "正在交接控制权"
                      : "Bot 控制中"}
        </span>
        {queued > 0 && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 rounded-full"
            aria-label="取消待发送输入"
            title="取消待发送输入"
            onClick={() => clearInputs("已取消尚未发送的输入；当前操作仍需核对。")}
          >
            <X size={14} />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          disabled={busy}
          aria-label="刷新画面"
          onClick={() => void operation(async () => {})}
        >
          {busy ? (
            <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw size={15} />
          )}
        </Button>
      </div>
      {transfer && !readOnly && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setTransfer(null)
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>将浏览器控制权转到这里？</DialogTitle>
              <DialogDescription>
                {taskAddress
                  ? "原客户端将无法继续操作此任务的浏览器。确认画面后可继续。"
                  : "原客户端将无法继续操作。若正在录制示范，录制会暂停，确认画面后可继续。"}
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setTransfer(null)}>
                取消
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await botApi.computerTake({
                      ...transfer,
                      conversationId: taskConversation ?? conversationId,
                      threadRootId: taskAddress ? taskThread : threadRootId,
                      replaceHuman: true
                    })
                    setTransfer(null)
                  })
                }
              >
                确认转移
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {!taskAddress && (
        <BotTeachControls
          active={visible}
          botId={botId}
          conversationId={conversationId}
          threadRootId={threadRootId}
          arm={teachArm}
          onPrepared={onTeachPrepared}
          cancelPreparation={cancelTeachPreparation}
          frame={frame}
          refresh={refresh}
          onRecordingPhase={reportRecordingPhase}
        />
      )}
      {frame && !preview && (
        <div className="bot-browser-tabs" aria-label="浏览器标签页">
          {frame.tabs.map((tab) => (
            <div
              key={tab.viewId}
              className="bot-browser-tab"
              data-active={tab.viewId === frame.viewId || undefined}
            >
              {readOnly ? (
                <span className="min-w-0 flex-1 truncate" title={tab.url}>
                  {tab.title || (tab.url === "about:blank" ? "新标签页" : tab.url)}
                </span>
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  aria-pressed={tab.viewId === frame.viewId}
                  aria-label={`切换标签页 ${tab.title || tab.url}`}
                  title={human ? tab.url : "接管后可切换标签页"}
                  disabled={!controlsReady}
                  onClick={() => input({ kind: "tab_select", viewId: tab.viewId })}
                >
                  {tab.title || (tab.url === "about:blank" ? "新标签页" : tab.url)}
                </button>
              )}
              {human && (
                <button
                  type="button"
                  aria-label={`关闭标签页 ${tab.title || tab.url}`}
                  disabled={!controlsReady}
                  onClick={() => input({ kind: "tab_close", viewId: tab.viewId })}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label="新建浏览器标签页"
              disabled={!controlsReady}
              onClick={() => input({ kind: "tab_new" })}
            >
              <Plus size={14} />
            </Button>
          )}
        </div>
      )}
      {!preview && readOnly && frame && (
        <div className="bot-browser-address flex shrink-0 items-center gap-2 px-4 py-2">
          <Globe2 size={14} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={frame.url}>
            {frame.url}
          </span>
        </div>
      )}
      {!preview && !readOnly && (
        <form
          className="bot-browser-address flex shrink-0 items-center gap-2 px-4 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            input({ kind: "navigate", url })
          }}
        >
          <Globe2 size={14} className="shrink-0 text-muted-foreground" />
          <Input
            aria-label="浏览器网址"
            className="h-8 min-w-0 rounded-lg border-0 bg-muted/50 text-xs shadow-none focus-visible:ring-1"
            placeholder={frame?.url || "输入 https:// 网址"}
            value={url}
            disabled={!controlsReady}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 rounded-full"
            aria-label="前往"
            title="前往"
            disabled={!controlsReady || !url}
          >
            <ArrowRight size={15} />
          </Button>
        </form>
      )}
      <div className="bot-computer-stage min-h-0 flex-1 overflow-auto px-4 py-2">
        <div
          tabIndex={human || (preview && onExpand) ? 0 : -1}
          role={preview && onExpand ? "button" : "application"}
          aria-busy={
            busy ||
            queued > 0 ||
            inputRefreshPending ||
            !frameReady ||
            Boolean(frame?.humanInputPending)
          }
          aria-label={
            preview && onExpand
              ? `展开 ${name} 的电脑画面`
              : readOnly
                ? `${name} 的浏览器画面，仅供查看`
                : "浏览器画面，接管后点击或按键操作"
          }
          aria-describedby={human ? inputHintId : undefined}
          aria-keyshortcuts={human ? "Control+Alt+Escape" : undefined}
          className="bot-computer-screen relative overflow-hidden bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={
            {
              aspectRatio: frame ? `${frame.width} / ${frame.height}` : "8 / 5",
              "--bot-screen-ratio": frame ? frame.width / frame.height : 1.6
            } as import("react").CSSProperties
          }
          onClick={() => {
            if (preview) onExpand?.()
          }}
          onKeyDown={(event) => {
            if (
              !event.nativeEvent.isComposing &&
              event.key === "Escape" &&
              event.ctrlKey &&
              event.altKey &&
              !event.metaKey &&
              !event.shiftKey
            ) {
              event.preventDefault()
              event.stopPropagation()
              const target =
                controls.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
              const focusTarget = target ?? controls.current
              focusTarget?.focus()
              return
            }
            if (
              preview &&
              onExpand &&
              !event.nativeEvent.isComposing &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault()
              event.stopPropagation()
              onExpand()
              return
            }
            if (
              !human ||
              !visible ||
              event.nativeEvent.isComposing ||
              event.key === "Process" ||
              ["Shift", "Control", "Alt", "Meta"].includes(event.key)
            )
              return
            event.preventDefault()
            const key = event.key === " " ? "Space" : event.key
            input({
              kind: "key",
              key: [
                ...(event.ctrlKey ? ["Control"] : []),
                ...(event.metaKey ? ["Meta"] : []),
                ...(event.altKey ? ["Alt"] : []),
                ...(event.shiftKey ? ["Shift"] : []),
                key
              ].join("+")
            })
          }}
        >
          {frame ? (
            <img
              ref={markImageReady}
              src={frame.image}
              width={frame.width}
              height={frame.height}
              onLoad={(event) => markImageReady(event.currentTarget)}
              onError={() => {
                if (current.current === frame) {
                  clearInputs("画面加载失败，已取消尚未发送的输入。")
                  setError("画面加载失败，请刷新后重试")
                }
              }}
              alt={frame.title || "Bot 浏览器画面"}
              draggable={false}
              className="block h-auto w-full select-none"
              onClick={(event) => {
                if (!human || !visible) return
                event.currentTarget.parentElement?.focus()
                const rect = event.currentTarget.getBoundingClientRect()
                input({
                  kind: "click",
                  ...mapTeachPointer(event.clientX, event.clientY, rect, frame)
                })
              }}
            />
          ) : (
            <div className="bot-computer-blank">
              {expanded ? (
                <BotAvatar agentId={botId} size="xl" state={busy ? "loading" : "idle"} />
              ) : (
                <Monitor size={32} strokeWidth={1.4} aria-hidden="true" />
              )}
              <span role="status">
                {busy ? "正在启动浏览器…" : error ? "连接未完成，点击刷新重试" : "尚无画面"}
              </span>
            </div>
          )}
          {human && visible && frame?.nativeSelect && (
            <BotNativeSelectPicker
              key={frame.nativeSelect.token}
              select={frame.nativeSelect}
              ready={controlsReady && frameReady}
              onSelect={(optionIndices) =>
                input({
                  kind: "select_option",
                  selectToken: frame.nativeSelect!.token,
                  optionIndices
                })
              }
              onDismiss={() =>
                input({
                  kind: "select_dismiss",
                  selectToken: frame.nativeSelect!.token
                })
              }
            />
          )}
          {(error || inputNotice) && (
            <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex justify-center">
              <p
                className={`max-w-full rounded-xl border px-3 py-2 text-xs shadow-sm ${error ? "border-destructive/30 bg-background text-destructive" : "border-border/70 bg-popover text-muted-foreground"}`}
                role="alert"
              >
                {error || inputNotice}
              </p>
            </div>
          )}
          {human && ((!continuousReady && busy) || !frameReady) && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60">
              <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                {error ? (
                  <Globe2 size={14} />
                ) : (
                  <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                )}
                {error ? "画面暂不可用" : inputInFlight.current ? "正在输入…" : "正在更新画面…"}
              </span>
            </div>
          )}
        </div>
      </div>
      <p
        id={inputHintId}
        className={`shrink-0 truncate py-3 text-center text-[11px] text-muted-foreground ${preview ? "order-1" : ""}`}
        title={frame?.url}
      >
        {preview
          ? `${name} 的屏幕`
          : readOnly
            ? `${name} 的最后画面`
            : "点击画面操作 · 中文与粘贴使用下方输入框"}
        {human && <span className="block">{focusExitLabel} 回到电脑控件</span>}
      </p>
      {human && (
        <div className="bot-browser-input border-t px-4 py-3">
          <form
            className="flex items-center gap-2 rounded-2xl border bg-muted/30 p-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (!text) return
              const submitted = text
              if (submittedDraft.current === submitted) return
              if (
                input({ kind: "text", text: submitted }, () => {
                  if (submittedDraft.current === submitted) submittedDraft.current = null
                  setText((draft) => (draft === submitted ? "" : draft))
                })
              )
                submittedDraft.current = submitted
            }}
          >
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 rounded-full"
                  aria-label="浏览器辅助按键"
                  title="滚动与辅助按键"
                >
                  <Keyboard size={17} />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto rounded-xl p-2" side="top" align="start">
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!controlsReady}
                    onClick={() => input({ kind: "scroll", deltaY: -600 })}
                  >
                    <ArrowLeft size={12} className="rotate-90" />
                    上滚
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!controlsReady}
                    onClick={() => input({ kind: "scroll", deltaY: 600 })}
                  >
                    <ArrowRight size={12} className="rotate-90" />
                    下滚
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!human || !visible}
                    onClick={() => input({ kind: "key", key: "Tab" })}
                  >
                    Tab
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!human || !visible}
                    onClick={() => input({ kind: "key", key: "Enter" })}
                  >
                    Enter
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <Input
              aria-label="向浏览器输入文本"
              className="h-8 min-w-0 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
              placeholder="输入或粘贴到网页…"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <Button
              type="submit"
              size="icon"
              className="size-8 shrink-0 rounded-full"
              aria-label="输入"
              title="发送到网页中的输入框"
              disabled={!human || !visible || !text || submittedDraft.current === text}
            >
              <ArrowUp size={16} />
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}
