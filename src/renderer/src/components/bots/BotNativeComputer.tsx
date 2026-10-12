import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  AppWindow,
  Check,
  ChevronDown,
  Hand,
  ListTree,
  Loader2,
  LockKeyhole,
  Monitor,
  RefreshCw
} from "lucide-react"
import { botApi } from "@/lib/bot-api"
import { botErrorNotice, type BotErrorNotice } from "@/lib/bot-error-notice"
import { BotErrorNoticeBody } from "./BotErrorNoticeBody"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotTeachControls } from "./BotTeachControls"
import type { BotTeachArm } from "../../../../shared/bot-teach"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { BotMaskedSecretForm } from "./BotSecretInput"
import {
  botNativeDesktopTarget,
  type BotNativeDesktopSecretDestination,
  type BotNativeDesktopSemanticAction,
  type BotNativeDesktopFrame,
  type BotNativeDesktopTarget,
  type NativeDesktopElement,
  type NativeDesktopObservation
} from "../../../../shared/bot-native-desktop"
import {
  appendNativeDragPoint,
  NATIVE_MESSAGE_DRAG_DURATION_MS,
  NATIVE_MESSAGE_DRAG_SAMPLE_MS,
  nativeMessageKey,
  nativeTextSelectionShortcut,
  nativeCommittedMessageText,
  nativeMessagePoint,
  sameNativeClick,
  type NativeMessageAction,
  type NativeClick
} from "./native-message-input"

interface BotNativeComputerProps {
  botId: string
  name: string
  conversationId: string
  threadRootId?: string
  teachArm?: BotTeachArm | null
  onTeachPrepared?(): void
  cancelTeachPreparation?(): void
  onRecordingPhase?(
    phase: "recording" | "paused" | "finalizing" | null,
    backend?: "browser" | "windows-native"
  ): void
  expanded: boolean
  active: boolean
  onExpand?(): void
  onBrowser?(): void
  onReturnControl?(target: BotNativeDesktopTarget): Promise<void>
}

type Control = BotNativeDesktopTarget &
  Pick<BotNativeDesktopFrame, "controlOwner" | "controlOwnerConnected">
type WindowChoice = Awaited<ReturnType<typeof botApi.nativeComputerWindows>>[number]
type Current = {
  target: Control
  windows: WindowChoice[]
  frame: BotNativeDesktopFrame | null
  observation: NativeDesktopObservation | null
}
const identity = (target: Control) =>
  JSON.stringify([
    target.botId,
    target.taskRunId,
    target.generation,
    target.controlEpoch,
    target.control,
    target.viewId,
    target.controlOwner
  ])
const ticket = (frame: BotNativeDesktopFrame) => `${identity(frame)}:${frame.frameSeq}`
type NativeErrorNotice = BotErrorNotice & { originalMessage?: string }
interface NativeDragGesture {
  pointerId: number
  frame: BotNativeDesktopFrame
  epoch: number
  clientX: number
  clientY: number
  moved: boolean
  sampledAt: number
  path: { x: number; y: number }[]
  timer: ReturnType<typeof setTimeout>
}
function nativeErrorNotice(failure: unknown): NativeErrorNotice {
  const notice = botErrorNotice(failure, "工作应用操作未完成，请刷新画面后核对。")
  const code = notice.diagnostic?.code
  const message =
    code === "native_input_unavailable"
      ? "当前工作应用不支持此输入，可以查看应用控件或切换浏览器模式。"
      : code === "native_secret_required"
        ? "窗口包含敏感输入或无法安全核对，普通文字输入已停止。接管后可通过应用控件安全输入密码。"
        : /\p{Script=Han}/u.test(notice.message)
          ? notice.message
          : "工作应用操作未完成，请先核对画面。具体原因可在错误详情中查看。"
  return {
    ...notice,
    message,
    ...(message !== notice.message ? { originalMessage: notice.message } : {})
  }
}
const actionNames = {
  invoke: "执行",
  select: "选择",
  select_all_text: "全选文本",
  toggle: "切换",
  expand: "展开",
  collapse: "收起"
} as const

/** The Host owns the window and control lease. This view only retains the frame the user saw. */
export function BotNativeComputer({
  botId,
  name,
  conversationId,
  threadRootId,
  teachArm,
  onTeachPrepared,
  cancelTeachPreparation,
  onRecordingPhase,
  expanded,
  active,
  onExpand,
  onReturnControl,
  onBrowser
}: BotNativeComputerProps) {
  const documentVisible = useBotViewVisibility()
  const visible = active && documentVisible
  const [state, setState] = useState<Current | null>(null)
  const [recordingPhase, setRecordingPhase] = useState<
    "recording" | "paused" | "finalizing" | null
  >(null)
  const reportRecordingPhase = useCallback(
    (
      phase: "recording" | "paused" | "finalizing" | null,
      backend: "browser" | "windows-native" = "windows-native"
    ) => {
      setRecordingPhase(backend === "windows-native" ? phase : null)
      onRecordingPhase?.(phase, backend)
    },
    [onRecordingPhase]
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<NativeErrorNotice | null>(null)
  const [painted, setPainted] = useState<string | null>(null)
  const [semanticTicket, setSemanticTicket] = useState<string | null>(null)
  const [windowMenu, setWindowMenu] = useState(false)
  const [controlMenu, setControlMenu] = useState(false)
  const [transfer, setTransfer] = useState<Control | null>(null)
  const controlsRequested = useRef(false)
  const [selectedElement, setSelectedElement] = useState<string | null>(null)
  const [secret, setSecret] = useState<{
    target: Control
    destination: BotNativeDesktopSecretDestination
  } | null>(null)
  const [draft, setDraft] = useState("")
  const [messageDraft, setMessageDraft] = useState("")
  const messageComposition = useRef<{ owner: string; epoch: number; composing: boolean } | null>(
    null
  )
  const [gesturePending, setGesturePending] = useState(false)
  const [inputNotice, setInputNotice] = useState<string | null>(null)
  const picture = useRef<HTMLImageElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const expandedRef = useRef(expanded)
  const drag = useRef<NativeDragGesture | null>(null)
  const gesture = useRef<
    | (NativeClick & {
        frame: BotNativeDesktopFrame
        timer: ReturnType<typeof setTimeout>
      })
    | null
  >(null)
  const cancelGesture = useCallback((updateView = true) => {
    if (gesture.current) clearTimeout(gesture.current.timer)
    gesture.current = null
    const held = drag.current
    drag.current = null
    if (held) {
      clearTimeout(held.timer)
      const image = picture.current
      if (image?.hasPointerCapture(held.pointerId)) image.releasePointerCapture(held.pointerId)
    }
    if (updateView) setGesturePending(false)
  }, [])
  const root = useRef<HTMLDivElement>(null)
  const current = useRef<Current | null>(null)
  const alive = useRef(true)
  const isVisible = useRef(visible)
  const epoch = useRef(0)
  const frameEpoch = useRef(-1)
  const pending = useRef(false)
  const assertOwner = useCallback(
    (target: Control) => {
      if (target.backend !== "windows-native" || target.botId !== botId || target.taskRunId)
        throw new Error("工作应用与当前 Bot 不一致，请重新打开电脑。")
    },
    [botId]
  )
  const commit = useCallback(
    (next: Current) => {
      cancelGesture()
      if (!current.current || identity(current.current.target) !== identity(next.target)) {
        setSecret(null)
        setMessageDraft("")
        messageComposition.current = null
      }
      current.current = next
      frameEpoch.current = epoch.current
      setState(next)
    },
    [cancelGesture]
  )
  const refresh = useCallback(
    async (valid: () => boolean, options: { windows?: boolean; observe?: boolean } = {}) => {
      if (!valid()) return
      const target: Control = await botApi.nativeComputerOpen(botId)
      assertOwner(target)
      if (!valid()) return
      const previous = current.current
      const changed = !previous || identity(target) !== identity(previous.target)
      const windows =
        options.windows || changed ? await botApi.nativeComputerWindows(target) : previous.windows
      if (!valid()) return
      // Opening the worker is not choosing a window. Only an explicit selection may do that.
      const selected = windows.some((window) => window.viewId === target.viewId)
      if (!selected) {
        commit({ target, windows, frame: null, observation: null })
        setPainted(null)
        setSelectedElement(null)
        setDraft("")
        setMessageDraft("")
        return
      }
      if (changed) {
        commit({ target, windows, frame: null, observation: null })
        setPainted(null)
        setSelectedElement(null)
        setDraft("")
        setMessageDraft("")
        setControlMenu(false)
        controlsRequested.current = false
      }
      // UIA observation is an input preparation step, not a viewer refresh. A viewer
      // must not replace the Bot's semantic tokens or another client's input ticket.
      const mayObserve = target.control === "human" && target.controlOwner === "self"
      const observation =
        options.observe && controlsRequested.current && mayObserve
          ? await botApi.nativeComputerObserve(target)
          : changed
            ? null
            : (previous?.observation ?? null)
      if (!valid()) return
      const frame = await botApi.nativeComputerFrame(botId)
      assertOwner(frame)
      if (!valid()) return
      if (
        identity(frame) !== identity(target) ||
        (observation && JSON.stringify(frame.window) !== JSON.stringify(observation.window))
      )
        throw new Error("窗口或控制权已变化，请重新观察画面。")
      commit({ target: frame, windows, frame, observation })
      setSemanticTicket(
        options.observe && controlsRequested.current && mayObserve ? ticket(frame) : null
      )
    },
    [botId, assertOwner, commit]
  )
  const operation = useCallback(
    async (
      run?: (valid: () => boolean) => Promise<void>,
      options?: { windows?: boolean; observe?: boolean },
      quiet = false
    ) => {
      if (pending.current || !alive.current || !isVisible.current) return
      pending.current = true
      cancelGesture()
      const startedEpoch = epoch.current
      const valid = () => alive.current && isVisible.current && epoch.current === startedEpoch
      if (!quiet) setBusy(true)
      try {
        if (run) await run(valid)
        if (!valid()) return
        await refresh(valid, options)
        if (valid()) setError(null)
      } catch (failure) {
        if (valid()) {
          setPainted(null)
          setSecret(null)
          setError(nativeErrorNotice(failure))
        }
      } finally {
        pending.current = false
        if (alive.current) setBusy(false)
      }
    },
    [refresh, cancelGesture]
  )
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      cancelGesture(false)
      // Accepted RPCs settle in the Host; an unmount must not replay them or return the lease.
    }
  }, [cancelGesture])
  useLayoutEffect(() => {
    isVisible.current = visible
    cancelGesture()
    epoch.current++
    if (messageComposition.current?.composing) setMessageDraft("")
    messageComposition.current = null
    setPainted(null)
    setSemanticTicket(null)
    setSecret(null)
    if (visible) void operation(undefined, { windows: true })
    else {
      setWindowMenu(false)
      setControlMenu(false)
      controlsRequested.current = false
      setTransfer(null)
      setDraft("")
    }
  }, [visible, operation, cancelGesture])
  useLayoutEffect(() => {
    expandedRef.current = expanded
    if (!expanded) {
      if (messageComposition.current?.composing) setMessageDraft("")
      messageComposition.current = null
      cancelGesture()
      setSecret(null)
    }
  }, [expanded, cancelGesture])
  useEffect(() => {
    if (!visible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (disposed || !isVisible.current) return
      if (!pending.current && !gesture.current && !drag.current) {
        const displayed = current.current
        if (
          displayed?.frame?.control === "human" &&
          displayed.frame.controlOwner === "self" &&
          frameEpoch.current === epoch.current
        ) {
          // A new frame would consume the displayed input ticket. Check ownership only.
          pending.current = true
          const startedEpoch = epoch.current
          try {
            const next: Control = await botApi.nativeComputerOpen(botId)
            assertOwner(next)
            if (
              !disposed &&
              isVisible.current &&
              epoch.current === startedEpoch &&
              current.current === displayed &&
              identity(next) !== identity(displayed.target)
            ) {
              pending.current = false
              await operation(undefined, { windows: true, observe: true })
            }
          } catch (failure) {
            if (!disposed && epoch.current === startedEpoch) {
              setPainted(null)
              setSecret(null)
              setError(nativeErrorNotice(failure))
            }
          } finally {
            pending.current = false
          }
        } else await operation(undefined, undefined, true)
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1500)
    }
    timer = setTimeout(() => void poll(), 1500)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [visible, botId, assertOwner, operation])
  const frame = state?.frame ?? null
  const human = state?.target.control === "human" && state.target.controlOwner === "self"
  const otherHuman = state?.target.control === "human" && state.target.controlOwner !== "self"
  const inputReady = Boolean(
    human &&
    visible &&
    !busy &&
    !error &&
    frame &&
    state?.observation &&
    painted === ticket(frame) &&
    semanticTicket === ticket(frame) &&
    frame.inputTicketIssued
  )
  const preview = !expanded
  const messageReady = Boolean(
    expanded &&
    human &&
    visible &&
    !busy &&
    !error &&
    frame &&
    frame.inputTicketIssued &&
    frame.messageGeometryReady &&
    frame.sourceWidth &&
    frame.sourceHeight &&
    frame.sourceWidth <= 4096 &&
    frame.sourceHeight <= 4096 &&
    painted === ticket(frame)
  )
  const element = state?.observation?.elements.find((item) => item.id === selectedElement)
  const markImage = useCallback(
    (image: HTMLImageElement | null) => {
      if (
        image &&
        alive.current &&
        isVisible.current &&
        frameEpoch.current === epoch.current &&
        frame &&
        current.current?.frame === frame &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.currentSrc === frame.image
      )
        setPainted(ticket(frame))
    },
    [frame]
  )
  const send = (action: BotNativeDesktopSemanticAction) => {
    const displayed = frame
    if (!inputReady || !displayed || pending.current) return
    setPainted(null)
    setSemanticTicket(null)
    void operation(
      async (valid) => {
        if (!valid()) return
        await botApi.nativeComputerInput({
          target: displayed,
          input: { frameSeq: displayed.frameSeq, action }
        })
        if (valid()) setDraft("")
      },
      { observe: true }
    )
  }
  const sendMessage = useCallback(
    (action: NativeMessageAction, displayed = frame) => {
      if (
        !messageReady ||
        !displayed ||
        pending.current ||
        gesture.current ||
        drag.current ||
        !alive.current ||
        !isVisible.current ||
        !expandedRef.current ||
        frameEpoch.current !== epoch.current ||
        current.current?.frame !== displayed
      )
        return
      setPainted(null)
      setSemanticTicket(null)
      setInputNotice(null)
      void operation(async (valid) => {
        if (!valid()) return
        await botApi.nativeComputerInput({
          target: displayed,
          input: { frameSeq: displayed.frameSeq, action }
        })
        if (valid() && action.op === "message_keyboard" && action.text !== undefined)
          setMessageDraft((value) => (value === action.text ? "" : value))
      })
    },
    [messageReady, frame, operation]
  )
  const point = (clientX: number, clientY: number) => {
    const image = picture.current
    return image && frame
      ? nativeMessagePoint(clientX, clientY, image.getBoundingClientRect(), frame)
      : null
  }
  const click = (clientX: number, clientY: number, button: "left" | "right") => {
    if (!messageReady || !frame || !frame.capabilities.messagePointer || pending.current) return
    const position = point(clientX, clientY)
    if (!position) return
    const next = { ...position, ticket: ticket(frame), epoch: epoch.current }
    const first = gesture.current
    if (first) {
      cancelGesture()
      if (button === "left" && sameNativeClick(first, next)) {
        sendMessage(
          { op: "message_pointer", ...position, kind: "double_click", button, delta: 0 },
          first.frame
        )
      } else {
        // Commit only the first gesture. The second waits for a newly seen frame;
        // it cannot be queued or retargeted after the first effect.
        sendMessage(
          {
            op: "message_pointer",
            x: first.x,
            y: first.y,
            kind: "click",
            button: "left",
            delta: 0
          },
          first.frame
        )
        setInputNotice("画面正在更新，请核对后再点击。")
      }
      return
    }
    if (button === "right") {
      sendMessage({ op: "message_pointer", ...position, kind: "click", button, delta: 0 })
      return
    }
    setGesturePending(true)
    const held: NativeClick & {
      frame: BotNativeDesktopFrame
      timer: ReturnType<typeof setTimeout>
    } = {
      ...next,
      frame,
      timer: setTimeout(() => {
        if (gesture.current !== held) return
        gesture.current = null
        setGesturePending(false)
        if (held.epoch === epoch.current && current.current?.frame === held.frame)
          sendMessage(
            { op: "message_pointer", ...position, kind: "click", button, delta: 0 },
            held.frame
          )
      }, 300)
    }
    gesture.current = held
  }
  const imageRef = useCallback(
    (image: HTMLImageElement | null) => {
      picture.current = image
      markImage(image)
    },
    [markImage]
  )
  const beginDrag = (event: import("react").PointerEvent<HTMLImageElement>) => {
    if (
      !messageReady ||
      !frame ||
      !frame.capabilities.messagePointer ||
      event.button !== 0 ||
      drag.current ||
      pending.current
    )
      return
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
      setInputNotice("组合拖动暂不可用，请使用应用控件。")
      return
    }
    const start = point(event.clientX, event.clientY)
    if (!start) return
    event.preventDefault()
    if (gesture.current) clearTimeout(gesture.current.timer)
    event.currentTarget.parentElement?.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const held: NativeDragGesture = {
      pointerId: event.pointerId,
      frame,
      epoch: epoch.current,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      sampledAt: performance.now(),
      path: [start],
      timer: setTimeout(() => {
        if (drag.current !== held) return
        cancelGesture()
        setInputNotice("拖动时间过长，这次操作未发送。请分段拖动。")
      }, NATIVE_MESSAGE_DRAG_DURATION_MS)
    }
    drag.current = held
    setGesturePending(true)
  }
  const moveDrag = (event: import("react").PointerEvent<HTMLImageElement>) => {
    const held = drag.current
    if (!held || held.pointerId !== event.pointerId) return
    event.preventDefault()
    if (held.epoch !== epoch.current || current.current?.frame !== held.frame || !messageReady) {
      cancelGesture()
      return
    }
    if (Math.hypot(event.clientX - held.clientX, event.clientY - held.clientY) >= 5)
      held.moved = true
    if (!held.moved || performance.now() - held.sampledAt < NATIVE_MESSAGE_DRAG_SAMPLE_MS) return
    if (held.frame.capabilities.messageDrag !== true) {
      cancelGesture()
      setInputNotice("当前工作应用不支持拖动，请使用应用控件。")
      return
    }
    const next = point(event.clientX, event.clientY)
    const path = next && appendNativeDragPoint(held.path, next)
    if (!path) {
      cancelGesture()
      setInputNotice("拖动超出当前画面或路径过长，这次操作未发送。")
      return
    }
    held.path = path
    held.sampledAt = performance.now()
  }
  const finishDrag = (event: import("react").PointerEvent<HTMLImageElement>) => {
    const held = drag.current
    if (!held || held.pointerId !== event.pointerId) return
    event.preventDefault()
    drag.current = null
    clearTimeout(held.timer)
    if (event.currentTarget.hasPointerCapture(held.pointerId))
      event.currentTarget.releasePointerCapture(held.pointerId)
    setGesturePending(false)
    if (!messageReady || held.epoch !== epoch.current || current.current?.frame !== held.frame)
      return
    const end = point(event.clientX, event.clientY)
    if (!end) {
      cancelGesture()
      setInputNotice("拖动超出当前画面，这次操作未发送。")
      return
    }
    if (!held.moved && Math.hypot(event.clientX - held.clientX, event.clientY - held.clientY) < 5) {
      click(event.clientX, event.clientY, "left")
      return
    }
    const path =
      held.frame.capabilities.messageDrag === true ? appendNativeDragPoint(held.path, end) : null
    if (!path || path.length < 2) {
      cancelGesture()
      setInputNotice("拖动路径无法确认，这次操作未发送。")
      return
    }
    if (gesture.current) {
      // The previous click still owns this displayed frame. Commit it first;
      // this new drag must wait for the resulting frame rather than sharing a ticket.
      const previous = gesture.current
      cancelGesture()
      sendMessage(
        {
          op: "message_pointer",
          x: previous.x,
          y: previous.y,
          kind: "click",
          button: "left",
          delta: 0
        },
        previous.frame
      )
      setInputNotice("上次点击正在完成，请核对新画面后再拖动。")
      return
    }
    sendMessage(
      { op: "message_pointer", ...path[0], kind: "drag", button: "left", delta: 0, path },
      held.frame
    )
  }
  useEffect(() => {
    const image = picture.current
    if (!image || !expanded || !human || !visible || !frame?.capabilities.messagePointer) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!messageReady || gesture.current || drag.current || pending.current) return
      const position = nativeMessagePoint(
        event.clientX,
        event.clientY,
        image.getBoundingClientRect(),
        frame
      )
      if (!position || event.ctrlKey || event.metaKey || event.deltaY === 0) return
      const delta = Math.max(
        -1200,
        Math.min(
          1200,
          -Math.round(
            event.deltaY *
              (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? frame.sourceHeight! : 1)
          )
        )
      )
      if (delta)
        sendMessage({
          op: "message_pointer",
          ...position,
          kind: "wheel",
          button: "left",
          delta: delta
        })
    }
    image.addEventListener("wheel", wheel, { passive: false })
    return () => image.removeEventListener("wheel", wheel)
  }, [expanded, human, visible, messageReady, frame, sendMessage])
  const refreshTeach = useCallback(async () => {
    await operation(undefined, { windows: true })
  }, [operation])
  const chooseElement = (next: NativeDesktopElement) => {
    setSecret(null)
    setSelectedElement(next.id)
    setDraft(!next.password && !next.valueTruncated ? (next.value ?? "") : "")
  }
  const currentWindow = state?.windows.find((window) => window.viewId === state.target.viewId)
  const unavailable = busy || !state || state.target.control === "handoff"
  const status = human
    ? "你正在操作，Bot 已暂停输入"
    : otherHuman
      ? state?.target.controlOwnerConnected
        ? "另一客户端正在操作"
        : "控制端已断开，Bot 保持暂停"
      : state?.target.control === "handoff"
        ? "正在交接控制权"
        : currentWindow
          ? "Bot 控制中"
          : "选择一个工作应用"
  return (
    <div
      ref={root}
      className="bot-computer-content bot-native-computer flex min-h-0 flex-1 flex-col"
      data-preview={preview || undefined}
      data-expanded={expanded || undefined}
      data-recording-phase={recordingPhase ?? undefined}
    >
      <div className="bot-native-window-bar flex shrink-0 items-center gap-2 px-4 py-2">
        <Popover
          open={windowMenu && visible}
          onOpenChange={(open) => {
            setWindowMenu(open)
            if (open) void operation(undefined, { windows: true })
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="bot-native-window-trigger min-w-0 flex-1 justify-start rounded-xl shadow-none"
              disabled={busy}
            >
              <AppWindow size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">
                {currentWindow?.title || "选择工作应用"}
              </span>
              <ChevronDown size={13} className="shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            portalContainer={root.current}
            className="bot-native-window-menu rounded-xl p-1.5"
            align="start"
          >
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">此 Bot 的工作应用</p>
            <div className="max-h-64 overflow-y-auto">
              {state?.windows.map((window) => (
                <button
                  key={window.viewId}
                  type="button"
                  className="bot-native-window-option"
                  aria-pressed={window.viewId === state.target.viewId}
                  disabled={busy || !human}
                  title={human ? undefined : "接管后可选择工作应用"}
                  onClick={() => {
                    if (!human || pending.current) return
                    const target = state.target
                    setWindowMenu(false)
                    setControlMenu(false)
                    controlsRequested.current = false
                    setPainted(null)
                    void operation(
                      async (valid) => {
                        if (!valid()) return
                        assertOwner(
                          await botApi.nativeComputerSelect({ target, viewId: window.viewId })
                        )
                      },
                      { windows: true, observe: true }
                    )
                  }}
                >
                  <AppWindow size={14} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{window.title || "未命名窗口"}</span>
                  {window.viewId === state.target.viewId && (
                    <Check size={14} className="shrink-0" />
                  )}
                </button>
              ))}
              {!state?.windows.length && (
                <p role="status" className="px-2 py-4 text-center text-xs text-muted-foreground">
                  {busy ? "正在读取窗口…" : "尚无已打开的工作应用"}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 w-full justify-start rounded-lg text-xs"
              disabled={busy}
              onClick={() => void operation(undefined, { windows: true, observe: true })}
            >
              <RefreshCw size={13} />
              刷新窗口列表
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      <div
        ref={controls}
        tabIndex={-1}
        role="group"
        aria-label="工作应用操作控件"
        className="bot-computer-control flex shrink-0 flex-wrap items-center gap-2 px-4 py-2"
      >
        <Button
          variant="outline"
          size="sm"
          className="rounded-full shadow-none"
          disabled={unavailable}
          onClick={() => {
            if (!state || pending.current) return
            if (otherHuman) {
              setTransfer(state.target)
              return
            }
            const target = state.target
            setPainted(null)
            setControlMenu(false)
            controlsRequested.current = false
            void operation(
              async (valid) => {
                if (!valid()) return
                if (human && onReturnControl) await onReturnControl(target)
                else
                  assertOwner(
                    await (human
                      ? botApi.nativeComputerRelease(target)
                      : botApi.nativeComputerTake({ target }))
                  )
              },
              { observe: true }
            )
          }}
        >
          <Hand size={14} />
          {human
            ? onReturnControl
              ? "归还并继续"
              : "归还 Bot"
            : otherHuman
              ? "转移控制权"
              : "接管操作"}
        </Button>
        <span role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
          {status}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新工作应用画面"
          disabled={busy}
          onClick={() => {
            if (pending.current) return
            setPainted(null)
            void operation(undefined, { windows: true, observe: true })
          }}
        >
          {busy ? (
            <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw size={15} />
          )}
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="break-words border-b bg-destructive/5 p-3 text-xs text-destructive"
        >
          <BotErrorNoticeBody notice={error}>
            {human && frame?.capabilities.semanticInput && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (pending.current) return
                  setControlMenu(true)
                  controlsRequested.current = true
                  setPainted(null)
                  void operation(undefined, { observe: true })
                }}
              >
                查看应用控件
              </Button>
            )}
            {onBrowser && (
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(teachArm || recordingPhase)}
                onClick={onBrowser}
              >
                切换浏览器
              </Button>
            )}
          </BotErrorNoticeBody>
          {error.originalMessage && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px]">原始错误信息</summary>
              <p className="mt-1 whitespace-pre-wrap break-words text-[11px]">
                {error.originalMessage}
              </p>
            </details>
          )}
        </div>
      )}
      <BotTeachControls
        backend="windows-native"
        active={visible}
        botId={botId}
        conversationId={conversationId}
        threadRootId={threadRootId}
        arm={teachArm}
        onPrepared={onTeachPrepared}
        cancelPreparation={cancelTeachPreparation}
        frame={frame && painted === ticket(frame) ? frame : null}
        refresh={refreshTeach}
        onRecordingPhase={reportRecordingPhase}
      />
      <div className="bot-computer-stage min-h-0 flex-1 overflow-auto px-4 py-2">
        <div
          role={preview && onExpand ? "button" : expanded && human ? "application" : "img"}
          tabIndex={(preview && onExpand) || (expanded && human) ? 0 : -1}
          aria-label={
            preview && onExpand ? `展开 ${name} 的工作应用画面` : `${name} 的工作应用画面`
          }
          aria-busy={busy}
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
              preview &&
              onExpand &&
              !event.nativeEvent.isComposing &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault()
              onExpand()
            }
            if (!expanded || !human) return
            if (event.nativeEvent.isComposing) {
              setInputNotice("组合输入暂不可用，请在下方输入框批量发送文字。")
              return
            }
            if (
              event.key === "Escape" &&
              event.ctrlKey &&
              event.altKey &&
              !event.metaKey &&
              !event.shiftKey
            ) {
              event.preventDefault()
              event.stopPropagation()
              cancelGesture()
              const destination =
                controls.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
                controls.current
              destination?.focus({ preventScroll: true })
              return
            }
            event.preventDefault()
            event.stopPropagation()
            if (!frame?.capabilities.messageKeyboard) {
              setInputNotice("当前工作应用暂不支持按键输入，请查看应用控件或切换浏览器模式。")
              return
            }
            if (!messageReady || gesture.current || drag.current || pending.current) {
              setInputNotice("画面正在更新，这次按键未发送。请核对后使用下方输入框批量发送文字。")
              return
            }
            const action = nativeMessageKey(
              {
                key: event.key,
                isComposing: event.nativeEvent.isComposing,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                altGraph: event.getModifierState("AltGraph")
              },
              frame.capabilities.messageChords === true
            )
            if (action) sendMessage(action)
            else if (!["Shift", "Control", "Alt", "Meta"].includes(event.key))
              setInputNotice("此按键暂不可用；文字可通过下方输入框发送。")
          }}
        >
          {frame ? (
            <img
              ref={imageRef}
              src={frame.image}
              width={frame.width}
              height={frame.height}
              alt={frame.title || "Bot 工作应用画面"}
              draggable={false}
              className="block h-auto w-full select-none"
              style={{ touchAction: expanded && human ? "none" : "auto" }}
              onLoad={(event) => markImage(event.currentTarget)}
              onPointerDown={beginDrag}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={() => cancelGesture()}
              onLostPointerCapture={() => {
                if (drag.current) cancelGesture()
              }}
              onContextMenu={(event) => {
                if (!messageReady || !frame.capabilities.messagePointer) return
                event.preventDefault()
                click(event.clientX, event.clientY, "right")
              }}
              onError={() => {
                if (
                  alive.current &&
                  isVisible.current &&
                  frameEpoch.current === epoch.current &&
                  current.current?.frame === frame
                ) {
                  cancelGesture()
                  setPainted(null)
                  setError({ message: "画面加载失败，请刷新后重试" })
                }
              }}
            />
          ) : (
            <div className="bot-computer-blank">
              <Monitor size={32} strokeWidth={1.4} aria-hidden="true" />
              <span role="status">
                {busy
                  ? "正在连接工作应用…"
                  : error
                    ? "连接未完成，点击刷新重试"
                    : "选择窗口后查看画面"}
              </span>
            </div>
          )}
        </div>
      </div>
      {expanded && human && frame?.capabilities.messageKeyboard && (
        <form
          className="bot-native-message-input shrink-0 border-t px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            const composition = messageComposition.current
            if (
              !messageReady ||
              gesturePending ||
              !frame ||
              (composition &&
                (composition.owner !== identity(frame) || composition.epoch !== epoch.current))
            )
              return
            const action = nativeCommittedMessageText(messageDraft, composition?.composing === true)
            if (action) sendMessage(action)
          }}
        >
          <div className="flex items-center gap-2 rounded-2xl border bg-muted/30 p-1.5">
            <Input
              aria-label="工作应用文字"
              value={messageDraft}
              maxLength={4096}
              autoComplete="off"
              placeholder="输入文字"
              disabled={!messageReady || gesturePending}
              className="h-8 min-w-0 border-0 bg-transparent text-xs shadow-none"
              onCompositionStart={() => {
                if (!frame || !messageReady || current.current?.frame !== frame) return
                messageComposition.current = {
                  owner: identity(frame),
                  epoch: epoch.current,
                  composing: true
                }
              }}
              onCompositionEnd={() => {
                const composition = messageComposition.current
                if (
                  composition &&
                  current.current?.frame &&
                  composition.owner === identity(current.current.frame) &&
                  composition.epoch === epoch.current
                )
                  composition.composing = false
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229 ||
                    messageComposition.current?.composing)
                ) {
                  event.preventDefault()
                  event.stopPropagation()
                }
              }}
              onChange={(event) => {
                if (
                  !frame ||
                  !isVisible.current ||
                  !expandedRef.current ||
                  current.current?.frame !== frame ||
                  frameEpoch.current !== epoch.current
                )
                  return
                setMessageDraft(event.target.value)
              }}
            />
            <Button
              type="submit"
              size="sm"
              className="rounded-xl"
              disabled={!messageReady || gesturePending || !messageDraft}
            >
              发送
            </Button>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            密码请使用应用控件中的安全输入 · 操作后请核对画面
          </p>
        </form>
      )}
      {inputNotice && expanded && (
        <p role="status" className="shrink-0 px-4 text-center text-[11px] text-muted-foreground">
          {inputNotice}
        </p>
      )}
      <div className={`bot-native-caption shrink-0 px-4 py-3 ${preview ? "order-1" : ""}`}>
        <p className="truncate text-center text-[11px] text-muted-foreground">
          {preview ? `${name} 的屏幕` : frame?.title || "工作应用画面"}
        </p>
        {human && (
          <Popover
            open={controlMenu && visible}
            onOpenChange={(open) => {
              setSecret(null)
              setControlMenu(open)
              setSemanticTicket(null)
              setSelectedElement(null)
              controlsRequested.current = open
              if (open && !pending.current) {
                setPainted(null)
                void operation(undefined, { observe: true })
              } else {
                setSelectedElement(null)
                setDraft("")
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full rounded-xl shadow-none"
                disabled={busy || !frame?.capabilities.semanticInput}
              >
                <ListTree size={15} />
                应用控件
              </Button>
            </PopoverTrigger>
            <PopoverContent
              portalContainer={root.current}
              side="top"
              align="center"
              className="bot-native-controls-popover rounded-2xl p-3"
              onKeyDown={(event) => {
                const localEditable =
                  event.target instanceof Element &&
                  Boolean(
                    event.target.closest(
                      "input,textarea,[contenteditable]:not([contenteditable=false]),[role=textbox]"
                    )
                  )
                const action = nativeTextSelectionShortcut(
                  {
                    key: event.key,
                    isComposing: event.nativeEvent.isComposing,
                    ctrlKey: event.ctrlKey,
                    altKey: event.altKey,
                    metaKey: event.metaKey,
                    shiftKey: event.shiftKey,
                    altGraph: event.getModifierState("AltGraph")
                  },
                  element,
                  inputReady &&
                    !pending.current &&
                    frameEpoch.current === epoch.current &&
                    current.current?.frame === frame,
                  localEditable
                )
                if (action) {
                  event.preventDefault()
                  event.stopPropagation()
                  send(action)
                }
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium">应用控件</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="重新读取应用控件"
                  disabled={busy}
                  onClick={() => {
                    if (pending.current) return
                    setPainted(null)
                    void operation(undefined, { observe: true })
                  }}
                >
                  <RefreshCw size={13} />
                </Button>
              </div>
              <div className="bot-native-elements max-h-52 overflow-y-auto rounded-lg border">
                {state?.observation?.elements.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="bot-native-element"
                    aria-pressed={item.id === selectedElement}
                    disabled={busy || !item.enabled || item.offscreen}
                    onClick={() => chooseElement(item)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.name || item.controlType}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {item.controlType}
                        {item.password
                          ? " · 安全输入"
                          : !item.enabled
                            ? " · 不可用"
                            : item.offscreen
                              ? " · 当前不可见"
                              : ""}
                      </span>
                    </span>
                    {item.password && (
                      <LockKeyhole size={13} className="shrink-0 text-muted-foreground" />
                    )}
                  </button>
                ))}
                {!state?.observation?.elements.length && (
                  <p className="p-4 text-center text-xs text-muted-foreground">
                    {busy ? "正在观察控件…" : "当前窗口未提供可操作控件"}
                  </p>
                )}
              </div>
              {state?.observation?.truncated && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  仅显示本次观察到的部分控件。
                </p>
              )}
              {element && (
                <div className="mt-3 space-y-2">
                  <p className="truncate text-xs font-medium">
                    {element.name || element.controlType}
                  </p>
                  {!element.password && element.supportedActions.includes("select_all_text") && (
                    <p className="text-[11px] text-muted-foreground">
                      当前已选控件可用 Ctrl+A 全选文本
                    </p>
                  )}
                  {element.password ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-full rounded-lg"
                      disabled={!inputReady || !element.enabled || element.offscreen}
                      onClick={() => {
                        const target = current.current?.target
                        if (!target || !inputReady || pending.current) return
                        void operation(async (valid) => {
                          const destination = await botApi.nativeComputerPrepareSecret({
                            target: botNativeDesktopTarget.parse(target),
                            elementId: element.id
                          })
                          if (valid()) {
                            setControlMenu(false)
                            controlsRequested.current = false
                            setSecret({ target, destination })
                          }
                        })
                      }}
                    >
                      <LockKeyhole size={14} />
                      安全输入密码
                    </Button>
                  ) : (
                    <>
                      {element.supportedActions.includes("set_value") && (
                        <form
                          className="flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault()
                            if (!element.valueTruncated)
                              send({ op: "set_value", elementId: element.id, value: draft })
                          }}
                        >
                          <Input
                            aria-label="控件文本"
                            value={draft}
                            maxLength={16000}
                            autoComplete="off"
                            disabled={
                              !inputReady ||
                              !element.enabled ||
                              element.offscreen ||
                              element.valueTruncated
                            }
                            onChange={(event) => setDraft(event.target.value)}
                            className="h-8 min-w-0 text-xs"
                          />
                          <Button
                            type="submit"
                            size="sm"
                            disabled={
                              !inputReady ||
                              !element.enabled ||
                              element.offscreen ||
                              element.valueTruncated
                            }
                          >
                            设置
                          </Button>
                        </form>
                      )}
                      {element.valueTruncated && (
                        <p className="text-[11px] text-muted-foreground">
                          控件内容未完整读取，请重新观察后核对。
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {element.supportedActions
                          .filter(
                            (action): action is keyof typeof actionNames => action in actionNames
                          )
                          .map((action) => (
                            <Button
                              key={action}
                              variant="outline"
                              size="sm"
                              disabled={!inputReady || !element.enabled || element.offscreen}
                              onClick={() => send({ op: "invoke", elementId: element.id, action })}
                            >
                              {actionNames[action]}
                            </Button>
                          ))}
                      </div>
                      {element.supportedActions.includes("scroll") && (
                        <div className="flex flex-wrap gap-1.5">
                          {(
                            [
                              ["up", "向上"],
                              ["down", "向下"],
                              ["left", "向左"],
                              ["right", "向右"]
                            ] as const
                          ).map(([direction, label]) => (
                            <Button
                              key={direction}
                              variant="outline"
                              size="sm"
                              disabled={!inputReady || !element.enabled || element.offscreen}
                              onClick={() =>
                                send({
                                  op: "scroll",
                                  elementId: element.id,
                                  direction,
                                  amount: "small"
                                })
                              }
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                先核对画面，再操作应用提供的控件。
              </p>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {secret && visible && human && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !pending.current) setSecret(null)
          }}
        >
          <DialogContent
            className="max-w-md"
            onEscapeKeyDown={(event) => {
              if (pending.current) event.preventDefault()
            }}
            onPointerDownOutside={(event) => {
              if (pending.current) event.preventDefault()
            }}
          >
            <DialogHeader>
              <DialogTitle>安全输入密码</DialogTitle>
              <DialogDescription>仅填入选定的密码框，登录由你确认。</DialogDescription>
            </DialogHeader>
            <BotMaskedSecretForm
              key={secret.destination.token}
              embedded
              label="安全输入"
              disabled={busy || !human || !visible}
              destination={
                <>
                  <div className="truncate font-medium">{secret.destination.windowTitle}</div>
                  <div className="mt-1 truncate text-muted-foreground">
                    {secret.destination.field}
                  </div>
                </>
              }
              notice="仅填入此应用的密码控件，不提交表单。示范录制将暂停；密码不保存、不进入聊天或模型。"
              onSubmit={async (value) => {
                if (
                  pending.current ||
                  !alive.current ||
                  !isVisible.current ||
                  !current.current ||
                  identity(current.current.target) !== identity(secret.target)
                )
                  throw new Error("安全输入目标已变化")
                pending.current = true
                setBusy(true)
                const startedEpoch = epoch.current
                const valid = () =>
                  alive.current && isVisible.current && epoch.current === startedEpoch
                try {
                  await botApi.nativeComputerProvideSecret({
                    target: botNativeDesktopTarget.parse(secret.target),
                    token: secret.destination.token,
                    value
                  })
                  if (valid()) {
                    setSecret(null)
                    await refresh(valid)
                    setError(null)
                  }
                } catch (failure) {
                  if (valid()) {
                    setSecret(null)
                    setPainted(null)
                    setError(nativeErrorNotice(failure))
                  }
                  throw new Error("安全输入未完成")
                } finally {
                  pending.current = false
                  if (alive.current) setBusy(false)
                }
              }}
              onReject={async () => {
                setSecret(null)
              }}
            />
          </DialogContent>
        </Dialog>
      )}
      {transfer && visible && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setTransfer(null)
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>将工作应用控制权转到这里？</DialogTitle>
              <DialogDescription>
                原客户端将无法继续操作此窗口。转移后请先核对新画面。
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setTransfer(null)}>
                取消
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setPainted(null)
                  void operation(
                    async (valid) => {
                      if (!valid()) return
                      assertOwner(
                        await botApi.nativeComputerTake({ target: transfer, replaceHuman: true })
                      )
                      if (valid()) setTransfer(null)
                    },
                    { observe: true }
                  )
                }}
              >
                确认转移
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
