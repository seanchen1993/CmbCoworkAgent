import { useEffect, useRef, useState, useCallback } from "react"
import { Terminal as TerminalIcon, RotateCcw, Square, FolderOpen, Plus, X, Loader2, TriangleAlert, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import {
  PTY_CREATE_CANCELLED_MESSAGE,
  PTY_CREATE_TIMED_OUT_MESSAGE,
  PTY_DISPOSE_TIMED_OUT_MESSAGE,
  TERMINAL_ALREADY_ACTIVE_OR_SHUTTING_DOWN_SUBSTRING
} from "../../../../shared/pty-protocol"
import "@xterm/xterm/css/xterm.css"

interface Session {
  id: string
  termId: string | null
  xterm: Terminal
  fitAddon: FitAddon
  container: HTMLDivElement
  running: boolean
  workDir: string
  claudeModelId?: string
  syncSkills: boolean
  syncMemory: boolean
  hasReceivedOutput: boolean
  hasContent: boolean
  hasFocusedOnFirstOutput: boolean
  showedFirstOutputHint: boolean
  bufferedOutput: string
  pendingAckBytes: number
  flushTimer: ReturnType<typeof setTimeout> | null
  flushInFlight: Promise<void> | null
  flushStalled: boolean
  ownsCreatingState: boolean // 只有 createSessionWithDir 创建的才为 true，表示该 session 持有 creating 锁
  stopping: boolean
  closing: boolean
  restarting: boolean
  slowStarting: boolean // terminal.create() 超过 8s 尚未返回，在 overlay 显示"首次启动较慢"提示
  lastExitTermId: string | null
  lastClosedTermId: string | null
  startupFailureTermId: string | null
  timeoutRecoveredTermId: string | null
  createTimeoutDrainTermId: string | null
  lastExitCode: number | null | undefined
  pendingDisposeTermId: string | null
  closeDeferredStopTermId: string | null
  suppressExitMessageTermId: string | null
  // #1 fix: 分离 DOM、PTY 消息监听、PTY 交互监听三类 cleanup
  domCleanups: Array<() => void>
  ptyMessageCleanups: Array<() => void>
  ptyInteractiveCleanups: Array<() => void>
}

let sessionCounter = 0
const MAX_TRY_OPEN_ATTEMPTS = 100
const PTY_FIRST_OUTPUT_TIMEOUT_MS = 20_000
const XTERM_WRITE_BATCH_MS = 30
const STARTUP_EXIT_REPORTED_TAG = "[STARTUP_EXIT_REPORTED] "
const XTERM_WRITE_FALLBACK_TIMEOUT_MS = 1_000
const XTERM_WRITE_DRAIN_TIMEOUT_MS = 10_000

function unwrapIpcErrorMessage(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "")
}

function getErrorMessage(err: unknown): string {
  return unwrapIpcErrorMessage(err instanceof Error ? err.message : String(err))
}

function normalizePtyCreateErrorMessage(message: string): string {
  const normalized = unwrapIpcErrorMessage(message)
  if (normalized.includes(TERMINAL_ALREADY_ACTIVE_OR_SHUTTING_DOWN_SUBSTRING)) {
    return "终端仍在关闭中，请稍后重试"
  }
  return normalized
}

function createPendingTermId(sessionId: string): string {
  // 这个 id 会贯穿 renderer/main/pty-host 三段协议，必须保证每次 create 都生成新值，
  // 绝不能复用旧 id，否则旧 host/旧 PTY 的迟到消息可能污染新会话状态。
  return `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// 判断是否为打包环境
const isPackaged = !window.location.hostname.includes("localhost")

function createXterm(): { xterm: Terminal; fitAddon: FitAddon } {
  const xterm = new Terminal({
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
    theme: {
      background: "#faf9f6",
      foreground: "#1a1a1a",
      cursor: "#1a1a1a",
      selectionBackground: "#d4d0c8",
      black: "#1a1a1a",
      red: "#c4261d",
      green: "#2e7d32",
      yellow: "#f57f17",
      blue: "#1565c0",
      magenta: "#7b1fa2",
      cyan: "#00838f",
      white: "#b8b4ac",
      brightBlack: "#545454",
      brightRed: "#e05a50",
      brightGreen: "#4caf50",
      brightYellow: "#ff9800",
      brightBlue: "#42a5f5",
      brightMagenta: "#ab47bc",
      brightCyan: "#26c6da",
      brightWhite: "#8a8780"
    },
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    minimumContrastRatio: 4.5
    // #17: scrollbar: { width: 14 } 不是 xterm.js 有效选项，已移除
  })
  // Windows 兼容：Ctrl+V 粘贴、Ctrl+C 选中时复制
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !(e.metaKey || e.ctrlKey)) return true
    // Ctrl+V / Cmd+V → 交给浏览器原生粘贴
    if (e.key === "v") return false
    // Ctrl+C / Cmd+C → 有选中文本时复制，否则正常发送中断信号
    if (e.key === "c" && xterm.hasSelection()) {
      navigator.clipboard.writeText(xterm.getSelection()).catch(() => {})
      return false
    }
    return true
  })
  const fitAddon = new FitAddon()
  xterm.loadAddon(fitAddon)
  return { xterm, fitAddon }
}

export function ClaudeCodePanel({ visible }: { visible?: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef<Map<string, Session>>(new Map())
  const [sessionIds, setSessionIds] = useState<string[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const [models, setModels] = useState<Array<{ id: string; name: string; model: string }>>([])
  const [selectedModelId, setSelectedModelId] = useState<string>("")
  const [creating, setCreating] = useState(false)
  const [mountError, setMountError] = useState<string | null>(null)
  const [syncSkills, setSyncSkills] = useState(false)
  const [syncMemory, setSyncMemory] = useState(false)
  const syncSkillsRef = useRef(syncSkills)
  const syncMemoryRef = useRef(syncMemory)
  syncSkillsRef.current = syncSkills
  syncMemoryRef.current = syncMemory

  // 加载模型列表（仅打包环境）
  const refreshModels = useCallback((resetSelection = false) => {
    if (!isPackaged) return
    window.api.models.getCustomConfigs().then((configs) => {
      const list = configs.map((c) => ({
        id: c.id,
        name: c.name,
        model: c.model
      }))
      setModels(list)
      if (list.length === 0) {
        setSelectedModelId("")
      } else if (resetSelection || !selectedModelId || !list.some((m) => m.id === selectedModelId)) {
        setSelectedModelId(list[0].id)
      }
    }).catch(console.error)
  }, [selectedModelId])

  useEffect(() => {
    refreshModels(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 切到 Claude Code 页面时刷新模型列表
  useEffect(() => {
    if (visible) refreshModels()
  }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  const getSession = useCallback((id: string) => sessionsRef.current.get(id), [])
  const pendingResizeRef = useRef(false)

  const isVisible = useCallback(() => {
    return hostRef.current !== null && hostRef.current.offsetWidth > 0
  }, [])

  // 从 xterm 内部获取 cell 尺寸
  const getCellDimensions = useCallback((xterm: Terminal) => {
    const core = (xterm as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } })._core
    const w = core?._renderService?.dimensions?.css?.cell?.width
    const h = core?._renderService?.dimensions?.css?.cell?.height
    return w && h ? { width: w, height: h } : null
  }, [])

  // 计算目标 cols/rows
  const calcDimensions = useCallback((session: Session) => {
    const { container } = session
    if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return null
    const cell = getCellDimensions(session.xterm)
    if (!cell) return null
    const scrollbarWidth = 14
    return {
      cols: Math.max(Math.floor((container.offsetWidth - scrollbarWidth) / cell.width), 1),
      rows: Math.max(Math.floor(container.offsetHeight / cell.height), 1)
    }
  }, [getCellDimensions])

  // 完整 fit（rows + cols 一起）
  const fitTerminal = useCallback((session: Session) => {
    const dims = calcDimensions(session)
    if (!dims) {
      session.fitAddon.fit()
      return
    }
    if (session.xterm.cols !== dims.cols || session.xterm.rows !== dims.rows) {
      session.xterm.resize(dims.cols, dims.rows)
    }
  }, [calcDimensions]) // #9 fix: 加上 calcDimensions 依赖

  const mountXterm = useCallback((session: Session): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!hostRef.current) { resolve(false); return }
      for (const s of sessionsRef.current.values()) {
        s.container.style.display = s.id === session.id ? "" : "none"
      }
      hostRef.current.appendChild(session.container)

      // #6 fix: RAF 可取消
      let cancelled = false
      session.domCleanups.push(() => { cancelled = true })

      let attempts = 0
      const tryOpen = (): void => {
        if (cancelled) { resolve(false); return }
        attempts++
        if (attempts > MAX_TRY_OPEN_ATTEMPTS) {
          console.warn("[ClaudeCode] tryOpen exceeded max attempts, giving up")
          resolve(false)
          return
        }
        if (session.container.offsetWidth > 0 && session.container.offsetHeight > 0) {
          try {
            // #7 fix: 防止 xterm.open 重复调用
            if (!session.xterm.element) {
              session.xterm.open(session.container)
            }
            session.fitAddon.fit()

            // 加载 WebGL，完成后刷新维度
            try {
              const webgl = new WebglAddon()
              session.xterm.loadAddon(webgl)
              webgl.onContextLoss(() => {
                console.warn("[ClaudeCode] WebGL context lost, falling back to canvas")
                webgl.dispose()
              })
            } catch (e) {
              console.warn("[ClaudeCode] WebGL addon failed, using canvas renderer:", e)
            }

            // #18 fix: 合并为一次延迟 fit
            setTimeout(() => {
              try { if (!cancelled) fitTerminal(session) } catch (e) {
                console.warn("[ClaudeCode] fitTerminal in setTimeout failed", e)
              }
              resolve(!cancelled)
            }, 100)

            // #10 fix: ResizeObserver 绑定在 session.container 上而非 hostRef
            let colsTimer: ReturnType<typeof setTimeout> | null = null
            const resizeObserver = new ResizeObserver(() => {
              if (!sessionsRef.current.has(session.id)) return
              if (!isVisible()) {
                pendingResizeRef.current = true
                return
              }
              const dims = calcDimensions(session)
              if (!dims) return
              if (session.xterm.rows !== dims.rows) {
                session.xterm.resize(session.xterm.cols, dims.rows)
              }
              if (session.xterm.cols !== dims.cols) {
                if (colsTimer) clearTimeout(colsTimer)
                colsTimer = setTimeout(() => {
                  if (!sessionsRef.current.has(session.id)) return
                  const fresh = calcDimensions(session)
                  if (fresh && session.xterm.cols !== fresh.cols) {
                    session.xterm.resize(fresh.cols, session.xterm.rows)
                  }
                }, 100)
              }
            })
            resizeObserver.observe(session.container)
            session.domCleanups.push(() => {
              resizeObserver.disconnect()
              if (colsTimer) clearTimeout(colsTimer)
            })
          } catch (e) {
            console.error("[ClaudeCode] xterm.open/fit failed:", e)
            resolve(false) // 向调用方发信号，走失败清理路径
          }
        } else {
          requestAnimationFrame(tryOpen)
        }
      }
      requestAnimationFrame(tryOpen)
    })
  }, [fitTerminal, isVisible, calcDimensions]) // #9 fix: 完整依赖

  // 仅清理与当前 PTY 的本地交互绑定；保留 onData/onExit，避免 dispose 等待窗口吞掉迟到 exit。
  const cleanupPtyInteraction = useCallback((session: Session) => {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    session.ptyInteractiveCleanups.forEach((fn) => fn())
    session.ptyInteractiveCleanups = []
  }, [])

  // 完整清理 PTY 相关监听器
  const cleanupPty = useCallback((session: Session) => {
    cleanupPtyInteraction(session)
    session.ptyMessageCleanups.forEach((fn) => fn())
    session.ptyMessageCleanups = []
  }, [cleanupPtyInteraction])

  const waitForFlushDrain = useCallback(async (session: Session, flush: Promise<void>): Promise<"written" | "stalled"> => {
    if (session.flushStalled) {
      if (session.flushInFlight === flush) {
        session.flushInFlight = null
      }
      return "stalled"
    }
    return new Promise<"written" | "stalled">((resolve) => {
      let settled = false
      const finish = (result: "written" | "stalled"): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        session.flushStalled = true
        // 降级为 stalled 时，主动解除当前 session 上的串行锁，允许后续输出继续尝试新的 flush。
        // 注意：这里并不能取消已经投递给 xterm.write 的那次旧写入；若它之后才回调，
        // 仍可能带来迟到输出/迟到 ACK，这是当前实现仍然接受的残余限制。
        if (session.flushInFlight === flush) {
          session.flushInFlight = null
        }
        console.warn("[ClaudeCode] flush is still in flight, degrading state transition", {
          sessionId: session.id,
          termId: session.termId
        })
        finish("stalled")
      }, XTERM_WRITE_DRAIN_TIMEOUT_MS)
      void flush.then(
        () => finish("written"),
        () => finish("stalled")
      )
    })
  }, [])

  const flushBufferedOutput = useCallback(async (session: Session, termId: string): Promise<"written" | "stalled"> => {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    while (true) {
      if (session.flushInFlight) {
        const drainResult = await waitForFlushDrain(session, session.flushInFlight)
        if (drainResult === "stalled") return "stalled"
        continue
      }

      const data = session.bufferedOutput
      const ackBytes = session.pendingAckBytes
      if (!data) return "written"

      session.bufferedOutput = ""
      session.pendingAckBytes = 0

      let resolveFlush!: () => void
      let rejectFlush!: (err: unknown) => void
      const rawFlush = new Promise<void>((resolve, reject) => {
        resolveFlush = resolve
        rejectFlush = reject
      })
      const trackedFlush = rawFlush.finally(() => {
        if (session.flushInFlight === trackedFlush) {
          session.flushInFlight = null
        }
      })
      session.flushInFlight = trackedFlush
      session.flushStalled = false

      const warningTimer = setTimeout(() => {
        console.warn("[ClaudeCode] xterm.write callback is taking unusually long", {
          sessionId: session.id,
          termId,
          bytes: ackBytes
        })
      }, XTERM_WRITE_FALLBACK_TIMEOUT_MS)

      let flushSettled = false
      let flushTimedOut = false
      let ackDelivered = false
      const deliverAck = (): void => {
        if (ackDelivered || ackBytes <= 0) return
        ackDelivered = true
        window.api.terminal.ack(termId, ackBytes)
      }
      try {
        session.xterm.write(data, () => {
          if (flushSettled) return
          flushSettled = true
          clearTimeout(warningTimer)
          // 迟到的旧 write callback 只能收尾自己这次 flush，不能再回写 session 级 stalled 状态，
          // 否则会污染后续新 flush 的状态机。
          if (!flushTimedOut) {
            session.flushStalled = false
          }
          // 正常路径下继续把 ACK 对齐到 xterm.write callback；若这次 flush 已在超时分支
          // 里提前回账，则这里的迟到 callback 不再二次 ACK，避免把后续新数据也提前回账。
          deliverAck()
          resolveFlush()
        })
      } catch (err) {
        flushSettled = true
        clearTimeout(warningTimer)
        // xterm.write 连同步入队都失败了，这批数据还不能 ack；放回 buffer 等后续处理。
        ackDelivered = true
        session.bufferedOutput = data + session.bufferedOutput
        session.pendingAckBytes = ackBytes + session.pendingAckBytes
        rejectFlush(err)
      }

      const drainResult = await waitForFlushDrain(session, trackedFlush)
      if (drainResult === "stalled") {
        flushTimedOut = true
        // 一旦进入 stalled 降级，说明我们已经不再等待这次 callback 才推进后续 flush。
        // 这里直接回账，避免 host 侧 pendingBytes 永远挂着；而迟到 callback 只负责本次
        // flush 的本地收尾，不再重复 ACK。
        deliverAck()
      }
      if (drainResult === "stalled") return "stalled"
      continue
    }
  }, [waitForFlushDrain])

  const scheduleBufferedOutputFlush = useCallback((session: Session, termId: string) => {
    if (session.flushTimer) return
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null
      if (!sessionsRef.current.has(session.id) || session.termId !== termId) {
        if (session.pendingAckBytes > 0) window.api.terminal.ack(termId, session.pendingAckBytes)
        session.bufferedOutput = ""
        session.pendingAckBytes = 0
        return
      }
      void flushBufferedOutput(session, termId)
    }, XTERM_WRITE_BATCH_MS)
  }, [flushBufferedOutput])

  // 释放 creating 锁（仅当 session 持有该锁时）
  // deps=[] 因为 setCreating 是 useState setter，引用永远稳定
  const releaseCreatingState = useCallback((session: Session) => {
    if (session.ownsCreatingState) {
      session.ownsCreatingState = false
      setCreating(false)
    }
  }, [])

  const isDisposingTermHandoff = useCallback((session: Session, termId: string): boolean => {
    return session.pendingDisposeTermId === termId && session.termId === null
  }, [])

  const restoreRunningPtyBindings = useCallback((session: Session, termId: string): boolean => {
    if (!sessionsRef.current.has(session.id) || session.termId !== termId) {
      return false
    }
    if (session.ptyMessageCleanups.length > 0 && session.ptyInteractiveCleanups.length > 0) {
      return true
    }
    // timeout 恢复旧 PTY 时，上一轮 flush 可能留下 in-flight/stalled 状态。
    // 先把串行锁清掉，避免恢复后的第一波输出还要空等一个 10s drain 窗口。
    session.flushInFlight = null
    session.flushStalled = false
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }

    if (session.ptyMessageCleanups.length === 0) {
      const removeData = window.api.terminal.onData(termId, (data, bytes) => {
        if (!sessionsRef.current.has(session.id)) return
        if (isDisposingTermHandoff(session, termId)) {
          if (bytes > 0) window.api.terminal.ack(termId, bytes)
          return
        }
        if (
          !session.running &&
          session.termId === termId &&
          session.timeoutRecoveredTermId === termId &&
          session.ptyInteractiveCleanups.length > 0
        ) {
          session.running = true
          session.timeoutRecoveredTermId = null
          if (session.startupFailureTermId === termId) {
            session.startupFailureTermId = null
          }
          setSessionIds((prev) => [...prev])
        }
        session.hasReceivedOutput = true
        session.bufferedOutput += data
        session.pendingAckBytes += bytes
        if (session.running || session.createTimeoutDrainTermId === termId) {
          scheduleBufferedOutputFlush(session, termId)
        }
        if (session.running && !session.hasContent) {
          session.hasContent = true
          session.restarting = false
          releaseCreatingState(session)
          setSessionIds((prev) => [...prev])
        }
        if (session.running && !session.hasFocusedOnFirstOutput && session.id === activeSessionIdRef.current) {
          session.hasFocusedOnFirstOutput = true
          session.xterm.focus()
        }
      })
      session.ptyMessageCleanups.push(removeData)

      const removeExit = window.api.terminal.onExit(termId, (code) => {
        if (!sessionsRef.current.has(session.id)) return
        if (isDisposingTermHandoff(session, termId)) {
          session.lastExitTermId = termId
          session.lastExitCode = code
          if (session.timeoutRecoveredTermId === termId) {
            session.timeoutRecoveredTermId = null
          }
          if (session.createTimeoutDrainTermId === termId) {
            session.createTimeoutDrainTermId = null
          }
          session.pendingDisposeTermId = null
          return
        }
        if (session.termId !== null && session.termId !== termId) return
        session.lastExitTermId = termId
        session.lastExitCode = code
        if (session.timeoutRecoveredTermId === termId) {
          session.timeoutRecoveredTermId = null
        }
        if (session.createTimeoutDrainTermId === termId) {
          session.createTimeoutDrainTermId = null
        }
        session.running = false
        session.restarting = false
        if (session.termId === termId) session.termId = null
        if (!session.hasContent) {
          session.hasContent = true
          releaseCreatingState(session)
        }
        setSessionIds((prev) => [...prev])
        void flushBufferedOutput(session, termId).then((flushResult) => {
          if (!sessionsRef.current.has(session.id)) return
          if (session.termId !== null && session.termId !== termId) return
          const exitMsg = code === null
            ? "[终端主机异常退出]"
            : `[进程已退出，代码: ${code}]`
          if (flushResult === "written") {
            session.xterm.write(`\r\n\x1b[90m${exitMsg}\x1b[0m\r\n`)
          }
        })
      })
      session.ptyMessageCleanups.push(removeExit)

      const removeClosed = window.api.terminal.onClosed(termId, (reason) => {
        if (!sessionsRef.current.has(session.id)) return
        if (isDisposingTermHandoff(session, termId)) {
          session.lastClosedTermId = termId
          if (session.timeoutRecoveredTermId === termId) {
            session.timeoutRecoveredTermId = null
          }
          if (session.createTimeoutDrainTermId === termId) {
            session.createTimeoutDrainTermId = null
          }
          session.pendingDisposeTermId = null
          return
        }
        if (session.termId !== null && session.termId !== termId) return
        session.lastClosedTermId = termId
        if (session.timeoutRecoveredTermId === termId) {
          session.timeoutRecoveredTermId = null
        }
        if (session.createTimeoutDrainTermId === termId) {
          session.createTimeoutDrainTermId = null
        }
        session.running = false
        session.restarting = false
        session.stopping = false
        if (session.termId === termId) session.termId = null
        if (!session.hasContent) {
          session.hasContent = true
          releaseCreatingState(session)
        }
        setSessionIds((prev) => [...prev])
        void flushBufferedOutput(session, termId).then((flushResult) => {
          if (!sessionsRef.current.has(session.id)) return
          if (session.termId !== null && session.termId !== termId) return
          const closedMsg = reason === "disposed" ? "[终端已关闭]" : "[终端已失联]"
          if (flushResult === "written") {
            session.xterm.write(`\r\n\x1b[90m${closedMsg}\x1b[0m\r\n`)
          }
        })
      })
      session.ptyMessageCleanups.push(removeClosed)
    }

    if (session.ptyInteractiveCleanups.length === 0) {
      const onDataDisposable = session.xterm.onData((data) => {
        if (session.termId) window.api.terminal.write(session.termId, data)
      })
      session.ptyInteractiveCleanups.push(() => onDataDisposable.dispose())

      const onResizeDisposable = session.xterm.onResize(({ cols, rows }) => {
        if (session.termId) window.api.terminal.resize(session.termId, cols, rows)
      })
      session.ptyInteractiveCleanups.push(() => onResizeDisposable.dispose())
    }
    return true
  }, [flushBufferedOutput, isDisposingTermHandoff, releaseCreatingState, scheduleBufferedOutputFlush])

  const startPty = useCallback(async (session: Session) => {
    const oldTermId = session.termId
    let startupExitReported = false
    const oldHasReceivedOutput = session.hasReceivedOutput
    const oldHasFocusedOnFirstOutput = session.hasFocusedOnFirstOutput
    const oldShowedFirstOutputHint = session.showedFirstOutputHint
    session.lastExitTermId = null
    session.lastClosedTermId = null
    session.startupFailureTermId = null
    session.timeoutRecoveredTermId = null
    session.createTimeoutDrainTermId = null
    session.lastExitCode = undefined
    session.pendingDisposeTermId = oldTermId
    session.closeDeferredStopTermId = null
    session.suppressExitMessageTermId = null
    session.termId = null
    session.hasReceivedOutput = false
    session.hasFocusedOnFirstOutput = false
    session.showedFirstOutputHint = false
    session.stopping = false
    // restart 前先拆本地输入/resize/提示定时器，保留 onData/onExit 到 dispose 真正确认，
    // 避免旧 PTY 在等待窗口里自然退出时把最终 exit 事件吞掉。
    cleanupPtyInteraction(session)
    if (oldTermId) {
      await flushBufferedOutput(session, oldTermId)
      try {
        await window.api.terminal.dispose(oldTermId)
      }
      catch (e) {
        const isDisposeTimeout = getErrorMessage(e) === PTY_DISPOSE_TIMED_OUT_MESSAGE
        if (!sessionsRef.current.has(session.id)) {
          session.pendingDisposeTermId = null
          console.warn("[ClaudeCode] dispose failed in startPty after session closed", e)
          throw e
        }
        if (isDisposeTimeout) {
          session.pendingDisposeTermId = null
          const oldTermAlreadyClosed =
            session.lastExitTermId === oldTermId || session.lastClosedTermId === oldTermId
          if (oldTermAlreadyClosed) {
            session.termId = null
            session.running = false
            console.warn("[ClaudeCode] dispose timed out in startPty, but old PTY had already closed; continuing restart", e)
          } else {
            session.termId = oldTermId
            session.restarting = false
            session.hasContent = true
            session.hasReceivedOutput = oldHasReceivedOutput
            session.hasFocusedOnFirstOutput = oldHasFocusedOnFirstOutput
            session.showedFirstOutputHint = oldShowedFirstOutputHint
            const restored = restoreRunningPtyBindings(session, oldTermId)
            session.running = false
            session.timeoutRecoveredTermId = restored ? oldTermId : null
            if (!restored) {
              cleanupPty(session)
              session.termId = null
              session.running = false
              console.warn("[ClaudeCode] dispose timed out in startPty and old PTY bindings could not be restored", e)
              throw new Error("旧终端关闭超时，状态未知，请先停止或关闭当前会话后重试")
            }
            void flushBufferedOutput(session, oldTermId)
            console.warn("[ClaudeCode] dispose timed out in startPty, old PTY may still be running", e)
            throw new Error("旧终端未能在超时内关闭，请先停止或关闭当前会话后重试")
          }
        } else {
          session.pendingDisposeTermId = null
          cleanupPty(session)
          session.termId = null
          session.running = false
          session.timeoutRecoveredTermId = null
          session.restarting = false
          session.hasContent = true
          console.warn("[ClaudeCode] dispose failed in startPty and old PTY is no longer restorable", e)
          throw new Error("旧终端关闭失败且连接已失效，请重试")
        }
      }
      cleanupPty(session)
      session.pendingDisposeTermId = null
    }
    // restart 过程中 tab 可能已被关闭；这时不要再继续创建新的 PTY。
    if (!sessionsRef.current.has(session.id) || session.closing) {
      releaseCreatingState(session)
      return
    }
    // 旧 PTY 的 flush 可能已经进入 stalled，甚至仍有迟到中的 write callback。
    // 这里在同一 Session 切新 PTY 前显式丢弃旧的前端缓冲/flush 状态，
    // 避免新 PTY 继续等待旧 promise，或把旧数据按新 termId 去 ACK。
    session.flushInFlight = null
    session.flushStalled = false
    session.bufferedOutput = ""
    session.pendingAckBytes = 0
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }

    // restart 时用 escape 序列重置终端模式，再 clear 清屏
    // 不用 reset()——它会触发 canvas/WebGL 重绘产生黑色方块
    // 不用 \x1bc (RIS)——xterm.js 将其视为硬重置，同样可能触发重绘
    if (session.restarting) {
      session.xterm.write(
        "\x1b[?1004l" + // 禁用焦点报告 (DECSET 1004)
        "\x1b[?1049l" + // 退出 alternate screen buffer
        "\x1b[?25h" +   // 显示光标
        "\x1b[?1l" +    // 重置光标键模式
        "\x1b[?7h" +    // 启用自动换行
        "\x1b[0m" +     // 重置所有字符属性
        "\x1b[!p"        // DECSTR (Soft Terminal Reset) — 重置其余模式，不触发 canvas 重绘
      )
      session.xterm.clear()
    }

    // 慢启动提示：主进程 terminal.create 在最坏情况下最长可接近 ~110s（20s host ready + 90s PTY create），
    // 8s 后还没返回，把 slowStarting 标记置 true，overlay 会切换到"首次启动较慢"文案。
    // 成功后清掉标记，不污染 xterm buffer（写 buffer 会在 overlay 撤销后变成脏历史）。
    const slowStartTimer = setTimeout(() => {
      if (!sessionsRef.current.has(session.id)) return
      session.slowStarting = true
      setSessionIds((prev) => [...prev]) // 触发重渲让 overlay 更新文案
    }, 8_000)
    const termId = createPendingTermId(session.id)
    session.termId = termId

    const removeData = window.api.terminal.onData(termId, (data, bytes) => {
      if (!sessionsRef.current.has(session.id)) return
      if (isDisposingTermHandoff(session, termId)) {
        if (bytes > 0) window.api.terminal.ack(termId, bytes)
        return
      }
      if (
        !session.running &&
        session.termId === termId &&
        session.timeoutRecoveredTermId === termId &&
        session.ptyInteractiveCleanups.length > 0
      ) {
        session.running = true
        session.timeoutRecoveredTermId = null
        if (session.startupFailureTermId === termId) {
          session.startupFailureTermId = null
        }
        setSessionIds((prev) => [...prev])
      }
      const isFirstRealOutput = !session.hasReceivedOutput
      if (isFirstRealOutput && session.showedFirstOutputHint) {
        session.showedFirstOutputHint = false
      }
      session.hasReceivedOutput = true
      session.bufferedOutput += data
      session.pendingAckBytes += bytes
      // create 真完成前先只缓存，不要把首包提前 flush 到 xterm，
      // 否则又会回到“输出先出现，但 running / 输入绑定 / resize 绑定还没完成”的撕裂状态。
      if (session.running || session.createTimeoutDrainTermId === termId) {
        scheduleBufferedOutputFlush(session, termId)
      }
      // create 返回前先只缓存输出，不提前把会话切到 ready，避免 UI/输入绑定状态撕裂。
      if (session.running && !session.hasContent) {
        session.hasContent = true
        session.restarting = false
        releaseCreatingState(session)
        setSessionIds((prev) => [...prev])
      }
      // 只有 create 真完成后，真实首包才触发自动 focus，避免“已显示首包但输入绑定未完成”的竞态。
      if (session.running && !session.hasFocusedOnFirstOutput && session.id === activeSessionIdRef.current) {
        session.hasFocusedOnFirstOutput = true
        // 延迟 focus，此时 Claude Code 已初始化完毕能正确处理焦点报告，不会产生 ^[[I 乱码
        session.xterm.focus()
      }
    })
    session.ptyMessageCleanups.push(removeData)

    const removeExit = window.api.terminal.onExit(termId, (code) => {
      if (!sessionsRef.current.has(session.id)) return
      if (isDisposingTermHandoff(session, termId)) {
        session.lastExitTermId = termId
        session.lastExitCode = code
        if (session.timeoutRecoveredTermId === termId) {
          session.timeoutRecoveredTermId = null
        }
        if (session.createTimeoutDrainTermId === termId) {
          session.createTimeoutDrainTermId = null
        }
        session.pendingDisposeTermId = null
        return
      }
      // 这里故意在任何 await/then 之前同步打标，保证随后 terminal.create() 的 catch
      // 能识别“启动期 exit 已经被 onExit 处理过”，避免再追加一条重复的启动失败文案。
      if (!session.running) startupExitReported = true
      if (session.termId !== null && session.termId !== termId) return
      session.lastExitTermId = termId
      session.lastExitCode = code
      if (session.timeoutRecoveredTermId === termId) {
        session.timeoutRecoveredTermId = null
      }
      if (session.createTimeoutDrainTermId === termId) {
        session.createTimeoutDrainTermId = null
      }
      session.running = false
      session.restarting = false
      if (session.termId === termId) session.termId = null
      const shouldCleanupExitedTerm = session.termId === null
      if (!session.hasContent) {
        session.hasContent = true
        releaseCreatingState(session)
      }
      if (shouldCleanupExitedTerm) {
        cleanupPty(session)
      }
      setSessionIds((prev) => [...prev])
      void flushBufferedOutput(session, termId).then((flushResult) => {
        if (!sessionsRef.current.has(session.id)) return
        if (session.termId !== null && session.termId !== termId) return
        if (session.startupFailureTermId === termId) return
        if (session.suppressExitMessageTermId === termId) {
          session.suppressExitMessageTermId = null
          return
        }
        // code 为 null 表示主进程 host 通信故障/spawn 失败强制 tear-down，没有真实退出码
        const exitMsg = code === null
          ? "[终端主机异常退出]"
          : `[进程已退出，代码: ${code}]`
        if (flushResult === "written") {
          session.xterm.write(`\r\n\x1b[90m${exitMsg}\x1b[0m\r\n`)
        }
      })
    })
    session.ptyMessageCleanups.push(removeExit)

    const removeClosed = window.api.terminal.onClosed(termId, (reason) => {
      if (!sessionsRef.current.has(session.id)) return
      if (isDisposingTermHandoff(session, termId)) {
        session.lastClosedTermId = termId
        if (session.timeoutRecoveredTermId === termId) {
          session.timeoutRecoveredTermId = null
        }
        if (session.createTimeoutDrainTermId === termId) {
          session.createTimeoutDrainTermId = null
        }
        session.pendingDisposeTermId = null
        return
      }
      if (session.termId !== null && session.termId !== termId) return
      session.lastClosedTermId = termId
      if (session.timeoutRecoveredTermId === termId) {
        session.timeoutRecoveredTermId = null
      }
      if (session.createTimeoutDrainTermId === termId) {
        session.createTimeoutDrainTermId = null
      }
      session.running = false
      session.restarting = false
      session.stopping = false
      if (session.termId === termId) session.termId = null
      const shouldCleanupClosedTerm = session.termId === null
      if (!session.hasContent) {
        session.hasContent = true
        releaseCreatingState(session)
      }
      if (shouldCleanupClosedTerm) {
        cleanupPty(session)
      }
      setSessionIds((prev) => [...prev])
      void flushBufferedOutput(session, termId).then((flushResult) => {
        if (!sessionsRef.current.has(session.id)) return
        if (session.termId !== null && session.termId !== termId) return
        const closedMsg = reason === "disposed" ? "[终端已关闭]" : "[终端已失联]"
        if (flushResult === "written") {
          session.xterm.write(`\r\n\x1b[90m${closedMsg}\x1b[0m\r\n`)
        }
      })
    })
    session.ptyMessageCleanups.push(removeClosed)

    try {
      await window.api.terminal.create({
        id: termId,
        workDir: session.workDir || undefined,
        args: ["--allow-dangerously-skip-permissions"],
        cols: session.xterm.cols,
        rows: session.xterm.rows,
        claudeModelId: session.claudeModelId,
        syncSkills: session.syncSkills,
        syncMemory: session.syncMemory
      })
    } catch (err) {
      // 启动期若 PTY 先 exit，onExit 会先把 session.termId 清成 null；
      // 这里仍需要把这次 startPty 挂上的消息/交互监听完整拆掉，避免每次启动失败
      // 都残留一组 onData/onExit/onClosed 监听器。
      const isCreateTimeout = getErrorMessage(err) === PTY_CREATE_TIMED_OUT_MESSAGE
      const shouldCleanupFailedStart =
        !isCreateTimeout && (session.termId === termId || (startupExitReported && session.termId === null))
      if (shouldCleanupFailedStart) {
        cleanupPty(session)
        await flushBufferedOutput(session, termId)
        if (session.termId === termId) session.termId = null
        session.running = false
      }
      if (isCreateTimeout && session.termId === termId) {
        // create 超时后 main 会异步补发 dispose；这里仅保留 termId 和消息监听，
        // 让后续迟到的 exit/closed 还能落回这个 session。
        // 注意：此时 PTY 已进入后台清理流程，不能把 stdin/resize 交互重新挂回，
        // 否则用户会看到一个“能输入但其实正在被 kill”的假在线终端。
        session.running = false
        session.timeoutRecoveredTermId = null
        session.createTimeoutDrainTermId = termId
      }
      if (startupExitReported) {
        throw new Error(
          `${STARTUP_EXIT_REPORTED_TAG}${getErrorMessage(err)}`
        )
      }
      throw err
    } finally {
      clearTimeout(slowStartTimer)
      session.slowStarting = false
    }

    // create 返回前 PTY 可能已退出/已被关闭，只有当前 termId 仍有效时才继续后续初始化。
    if (!sessionsRef.current.has(session.id) || session.termId !== termId) {
      cleanupPty(session)
      try { await window.api.terminal.dispose(termId) }
      catch (e) { console.warn("[ClaudeCode] dispose orphan PTY failed after create race", e) }
      releaseCreatingState(session)
      return
    }
    session.running = true
    session.timeoutRecoveredTermId = null
    session.createTimeoutDrainTermId = null

    // 软兜底：PTY 已创建成功，但长时间既无输出也未退出时，撤掉 loading/restarting 遮罩，
    // 避免“静默挂住”把界面一直锁死。这里不写“启动超时”，只给一个中性提示。
    const firstOutputTimeout = setTimeout(() => {
      if (!sessionsRef.current.has(session.id) || session.termId !== termId || session.hasContent) return
      session.xterm.write("\r\n\x1b[90m[Claude Code 已启动，但暂未收到输出，可稍候或手动重启]\x1b[0m\r\n")
      session.showedFirstOutputHint = true
      session.hasContent = true
      session.restarting = false
      releaseCreatingState(session)
      setSessionIds((prev) => [...prev])
    }, PTY_FIRST_OUTPUT_TIMEOUT_MS)
    session.ptyInteractiveCleanups.push(() => clearTimeout(firstOutputTimeout))

    const onDataDisposable = session.xterm.onData((data) => {
      if (session.termId) window.api.terminal.write(session.termId, data)
    })
    session.ptyInteractiveCleanups.push(() => onDataDisposable.dispose())

    const onResizeDisposable = session.xterm.onResize(({ cols, rows }) => {
      if (session.termId) window.api.terminal.resize(session.termId, cols, rows)
    })
    session.ptyInteractiveCleanups.push(() => onResizeDisposable.dispose())

    if (session.hasReceivedOutput) {
      // 首包可能早于 create 返回；等到 running=true 且本地输入/resize 监听都挂好后，
      // 再把缓存的真实输出 flush 到 xterm，避免重新引入启动期时序竞态。
      void flushBufferedOutput(session, termId)
      if (!session.hasContent) {
        session.hasContent = true
        session.restarting = false
        releaseCreatingState(session)
      }
      if (!session.hasFocusedOnFirstOutput && session.id === activeSessionIdRef.current) {
        session.hasFocusedOnFirstOutput = true
        session.xterm.focus()
      }
    }

    fitTerminal(session)
    setSessionIds((prev) => [...prev])

  }, [fitTerminal, cleanupPty, cleanupPtyInteraction, releaseCreatingState, flushBufferedOutput, scheduleBufferedOutputFlush, restoreRunningPtyBindings])

  // 同步更新 ref，让 async 函数中读到最新值
  const updateActiveSessionId = useCallback((id: string | null) => {
    activeSessionIdRef.current = id
    setActiveSessionId(id)
  }, [])

  const switchSession = useCallback((id: string) => {
    updateActiveSessionId(id)
    setMountError(null)
    for (const s of sessionsRef.current.values()) {
      s.container.style.display = s.id === id ? "" : "none"
    }
    const session = sessionsRef.current.get(id)
    if (session) {
      requestAnimationFrame(() => {
        if (!sessionsRef.current.has(id) || id !== activeSessionIdRef.current) return
        fitTerminal(session)
        if (
          session.hasFocusedOnFirstOutput ||
          (session.hasReceivedOutput && session.running) ||
          (session.showedFirstOutputHint && session.running)
        ) {
          session.xterm.focus()
        }
      })
    }
  }, [fitTerminal])

  const createSessionWithDir = useCallback(async () => {
    setCreating(true)
    // 刷新模型列表和选择目录并行发起
    let dir: string | null = null
    let resolvedModelId: string = selectedModelId
    try {
      [dir, resolvedModelId] = await Promise.all([
        window.api.terminal.selectDir(),
        isPackaged ? window.api.models.getCustomConfigs().then((configs) => {
          const list = configs.map((c) => ({ id: c.id, name: c.name, model: c.model }))
          setModels(list)
          const valid = list.some((m) => m.id === selectedModelId)
          if (!valid) {
            const fallback = list.length > 0 ? list[0].id : ""
            setSelectedModelId(fallback)
            return fallback
          }
          return selectedModelId
        }).catch((e) => { console.warn("[ClaudeCode] Failed to load model configs:", e); return selectedModelId }) : Promise.resolve(selectedModelId)
      ])
    } catch (err) {
      console.error("[ClaudeCode] Failed to initialize session:", err)
      setCreating(false)
      setMountError(`启动失败: ${err instanceof Error ? err.message : err}`)
      return
    }
    if (!dir) { setCreating(false); return } // session 未创建，无 ownsCreatingState，直接重置

    let id: string
    let session: Session
    try {
      id = `session-${++sessionCounter}`
      const { xterm, fitAddon } = createXterm()
      const container = document.createElement("div")
      container.style.position = "absolute"
      container.style.top = "0"
      container.style.left = "0"
      container.style.right = "0"
      container.style.bottom = "0"
      container.style.overflow = "hidden"

      session = {
        id, termId: null, xterm, fitAddon, container,
        running: false, workDir: dir, claudeModelId: resolvedModelId || undefined, syncSkills: syncSkillsRef.current, syncMemory: syncMemoryRef.current, hasReceivedOutput: false, hasContent: false, hasFocusedOnFirstOutput: false, showedFirstOutputHint: false, bufferedOutput: "", pendingAckBytes: 0, flushTimer: null, flushInFlight: null, flushStalled: false, ownsCreatingState: true, stopping: false, closing: false, restarting: false, slowStarting: false, lastExitTermId: null, lastClosedTermId: null, startupFailureTermId: null, timeoutRecoveredTermId: null, createTimeoutDrainTermId: null, lastExitCode: undefined, pendingDisposeTermId: null, closeDeferredStopTermId: null, suppressExitMessageTermId: null, domCleanups: [], ptyMessageCleanups: [], ptyInteractiveCleanups: []
      }
    } catch (err) {
      console.error("[ClaudeCode] Failed to create session:", err)
      setCreating(false)
      setMountError(`会话创建失败: ${err instanceof Error ? err.message : err}`)
      return
    }

    sessionsRef.current.set(id, session)
    setSessionIds((prev) => [...prev, id])
    updateActiveSessionId(id)

    // P3 fix: 用 cancelled flag 防止组件卸载后仍创建 PTY
    let cancelled = false
    session.domCleanups.push(() => { cancelled = true })

    // 等 React 渲染完毕且 hostRef 可用后再挂载
    let hostAttempts = 0
    const waitForHost = (): void => {
      if (cancelled) { releaseCreatingState(session); return }
      hostAttempts++
      if (!hostRef.current) {
        if (hostAttempts > MAX_TRY_OPEN_ATTEMPTS) {
          console.warn("[ClaudeCode] hostRef never became available, cleaning up")
          session.domCleanups.forEach((fn) => fn())
          session.xterm.dispose()
          session.container.remove()
          sessionsRef.current.delete(id)
          setSessionIds((prev) => prev.filter((s) => s !== id))
          const remaining = [...sessionsRef.current.keys()]
          if (remaining.length > 0) {
            switchSession(remaining[remaining.length - 1])
          } else {
            updateActiveSessionId(null)
          }
          releaseCreatingState(session)
          setMountError("终端容器初始化超时，请重试")
          return
        }
        requestAnimationFrame(waitForHost)
        return
      }
      mountXterm(session).then((mounted) => {
        if (cancelled || !mounted) {
          // 挂载失败：清理空会话
          if (!mounted && !cancelled) {
            session.domCleanups.forEach((fn) => fn())
            session.xterm.dispose()
            session.container.remove()
            sessionsRef.current.delete(id)
            setSessionIds((prev) => prev.filter((s) => s !== id))
            const remaining = [...sessionsRef.current.keys()]
            if (remaining.length > 0) {
              switchSession(remaining[remaining.length - 1])
            } else {
              updateActiveSessionId(null)
            }
            setMountError("终端挂载失败，请重试")
          }
          releaseCreatingState(session)
          return
        }
        startPty(session).then(() => {
          // focus 在 onData 首次数据到达时触发，不在这里提前 focus（防 ^[[I 乱码）
          if (cancelled) releaseCreatingState(session)
        }).catch((err) => {
          console.error("[ClaudeCode] PTY creation failed:", err)
          // await 期间 session 可能已被 closeSession 销毁
          const msg = normalizePtyCreateErrorMessage(getErrorMessage(err))
          if (
            sessionsRef.current.has(session.id) &&
            msg !== PTY_CREATE_CANCELLED_MESSAGE &&
            !msg.startsWith(STARTUP_EXIT_REPORTED_TAG)
          ) {
            const isRecoverableCreateTimeout =
              msg === PTY_CREATE_TIMED_OUT_MESSAGE &&
              session.termId !== null &&
              session.timeoutRecoveredTermId === session.termId
            if (session.termId) {
              void flushBufferedOutput(session, session.termId)
              if (!session.running && session.timeoutRecoveredTermId !== session.termId) {
                session.startupFailureTermId = session.termId
              }
            }
            session.xterm.write(
              isRecoverableCreateTimeout
                ? "\r\n\x1b[33m[启动超时，正在等待终端最终状态...]\x1b[0m\r\n"
                : `\r\n\x1b[31m[启动失败: ${msg}]\x1b[0m\r\n`
            )
            session.hasContent = true
            setSessionIds((prev) => [...prev])
          }
          releaseCreatingState(session)
        })
      }).catch((err) => {
        console.error("[ClaudeCode] Terminal mount failed:", err)
        session.domCleanups.forEach((fn) => fn()) // 确保 ResizeObserver 等被清理
        session.xterm.dispose()
        session.container.remove()
        sessionsRef.current.delete(id)
        setSessionIds((prev) => prev.filter((s) => s !== id))
        const remaining = [...sessionsRef.current.keys()]
        if (remaining.length > 0) {
          switchSession(remaining[remaining.length - 1])
        } else {
          updateActiveSessionId(null)
        }
        releaseCreatingState(session)
        setMountError(`终端挂载异常: ${err instanceof Error ? err.message : err}`)
      })
    }
    requestAnimationFrame(waitForHost)
  }, [mountXterm, startPty, switchSession, selectedModelId, releaseCreatingState])

  // #16 fix: switchSession 从 setState 回调中移出
  const closeSession = useCallback(async (id: string) => {
    const session = sessionsRef.current.get(id)
    if (!session || session.closing) return
    session.closing = true
    setSessionIds((prev) => [...prev])
    // restart 交接窗口里，当前 termId 会先置 null，旧 PTY 临时挂在 pendingDisposeTermId。
    // 关闭标签时要把这条“还在关闭中的旧 PTY”也视为当前关闭目标，避免直接删 tab 留下后台会话。
    const termId = session.termId ?? session.pendingDisposeTermId
    const wasStopping = session.stopping
    if (!wasStopping) {
      session.stopping = true
      session.running = false
      setSessionIds((prev) => [...prev])
      releaseCreatingState(session)

      cleanupPtyInteraction(session)
      if (termId) await flushBufferedOutput(session, termId)
    }
    if (termId) {
      try {
        await window.api.terminal.dispose(termId)
      } catch (e) {
        const isDisposeTimeout = getErrorMessage(e) === PTY_DISPOSE_TIMED_OUT_MESSAGE
        if (wasStopping && sessionsRef.current.has(session.id) && session.termId === termId) {
          session.closing = false
          session.hasContent = true
          if (isDisposeTimeout) {
            session.closeDeferredStopTermId = termId
            session.xterm.write("\r\n\x1b[31m[关闭未完成，终端仍在停止中，可稍后重试关闭]\x1b[0m\r\n")
          } else {
            session.closeDeferredStopTermId = null
          }
          setSessionIds((prev) => [...prev])
          console.warn("[ClaudeCode] closeSession is deferring dispose failure handling to handleStop", e)
          return
        }
        const termAlreadyClosed =
          session.lastExitTermId === termId || session.lastClosedTermId === termId
        const canRecoverUnknownSession =
          sessionsRef.current.has(session.id) &&
          !termAlreadyClosed &&
          (session.termId === termId || session.termId === null)
        if (isDisposeTimeout && canRecoverUnknownSession) {
          if (session.termId === null) {
            session.termId = termId
          }
          session.pendingDisposeTermId = null
          session.hasContent = true
          const restored = restoreRunningPtyBindings(session, termId)
          session.running = false
          session.timeoutRecoveredTermId = restored ? termId : null
          session.closeDeferredStopTermId = null
          if (restored) {
            void flushBufferedOutput(session, termId)
          }
          session.closing = false
          session.stopping = false
          session.restarting = false
          session.xterm.write(
            restored
              ? "\r\n\x1b[31m[关闭超时，终端可能仍在运行，请重试关闭]\x1b[0m\r\n"
              : "\r\n\x1b[31m[关闭超时，终端状态未知，请重试关闭]\x1b[0m\r\n"
          )
          setSessionIds((prev) => [...prev])
          console.warn("[ClaudeCode] dispose timed out in closeSession, keeping session visible", e)
          return
        }
        if (canRecoverUnknownSession) {
          cleanupPty(session)
          session.termId = null
          session.pendingDisposeTermId = null
          session.running = false
          session.timeoutRecoveredTermId = null
          session.closeDeferredStopTermId = null
          session.hasContent = true
          session.closing = false
          session.stopping = false
          session.restarting = false
          session.xterm.write("\r\n\x1b[31m[关闭失败，终端已失联，可再次关闭标签页]\x1b[0m\r\n")
          setSessionIds((prev) => [...prev])
          console.warn("[ClaudeCode] dispose failed in closeSession, keeping disconnected session visible", e)
          return
        }
        console.warn("[ClaudeCode] dispose failed in closeSession after session changed/closed", e)
      }
    }

    cleanupPty(session)
    sessionsRef.current.delete(id)
    session.container.style.display = "none"
    setSessionIds((prev) => prev.filter((s) => s !== id))

    // 等真正确认关闭后再切换 active session，避免把仍可能活着的会话提前从 UI 中抹掉。
    if (id === activeSessionIdRef.current) {
      setMountError(null)
      const remaining = [...sessionsRef.current.keys()]
      if (remaining.length > 0) switchSession(remaining[remaining.length - 1])
      else updateActiveSessionId(null)
    }

    session.domCleanups.forEach((fn) => fn())
    session.termId = null
    session.xterm.dispose()
    session.container.remove()
  }, [switchSession, cleanupPtyInteraction, flushBufferedOutput, releaseCreatingState, restoreRunningPtyBindings, updateActiveSessionId])

  // 组件卸载时清理所有会话
  useEffect(() => {
    return () => {
      for (const session of sessionsRef.current.values()) {
        cleanupPty(session)
        session.bufferedOutput = ""
        session.pendingAckBytes = 0
        session.domCleanups.forEach((fn) => fn())
        const termIdsToDispose = new Set<string>()
        if (session.termId) termIdsToDispose.add(session.termId)
        if (session.pendingDisposeTermId) termIdsToDispose.add(session.pendingDisposeTermId)
        for (const termId of termIdsToDispose) {
          window.api.terminal.dispose(termId).catch((e) => console.warn("[ClaudeCode] dispose failed in unmount", e))
        }
        session.xterm.dispose()
        session.container.remove()
      }
      sessionsRef.current.clear()
    }
  }, [cleanupPty])

  // 面板从隐藏变为可见时，flush 积攒的 resize
  useEffect(() => {
    if (!hostRef.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && pendingResizeRef.current) {
        pendingResizeRef.current = false
        const active = activeSessionId ? sessionsRef.current.get(activeSessionId) : null
        if (active) fitTerminal(active)
      }
    })
    observer.observe(hostRef.current)
    return () => observer.disconnect()
  }, [activeSessionId, fitTerminal])

  const activeSession = activeSessionId ? getSession(activeSessionId) : null

  const handleRestart = useCallback(async () => {
    if (!activeSession || activeSession.restarting || activeSession.stopping) return
    activeSession.restarting = true
    activeSession.running = false
    setMountError(null)
    activeSession.hasContent = false
    setSessionIds((prev) => [...prev]) // 显示 loading 遮罩
    try {
      await startPty(activeSession)
      // focus 在 onData 首次数据到达时触发
    } catch (err) {
      // await 期间 session 可能已被 closeSession 销毁
      const msg = normalizePtyCreateErrorMessage(getErrorMessage(err))
      if (
        sessionsRef.current.has(activeSession.id) &&
        msg !== PTY_CREATE_CANCELLED_MESSAGE &&
        !msg.startsWith(STARTUP_EXIT_REPORTED_TAG)
      ) {
        const isRecoverableCreateTimeout =
          msg === PTY_CREATE_TIMED_OUT_MESSAGE &&
          activeSession.termId !== null &&
          activeSession.timeoutRecoveredTermId === activeSession.termId
        if (activeSession.termId) {
          void flushBufferedOutput(activeSession, activeSession.termId)
          if (!activeSession.running && activeSession.timeoutRecoveredTermId !== activeSession.termId) {
            activeSession.startupFailureTermId = activeSession.termId
          }
        }
        activeSession.restarting = false
        activeSession.hasContent = true
        activeSession.xterm.write(
          isRecoverableCreateTimeout
            ? "\r\n\x1b[33m[重启超时，正在等待终端最终状态...]\x1b[0m\r\n"
            : `\r\n\x1b[31m[重启失败: ${msg}]\x1b[0m\r\n`
        )
        setSessionIds((prev) => [...prev])
      } else {
        activeSession.restarting = false // session 已销毁，仅清标志
      }
    }
  }, [activeSession, startPty])

  // #3 fix: handleStop 清理 PTY 监听器
  const handleStop = useCallback(async () => {
    if (activeSession?.restarting || activeSession?.stopping) return // stop/restart 期间都不允许再次 Stop
    if (activeSession?.termId) {
      const termId = activeSession.termId
      activeSession.stopping = true
      activeSession.running = false
      if (!activeSession.hasContent) {
        activeSession.hasContent = true
        releaseCreatingState(activeSession)
      }
      setSessionIds((prev) => [...prev]) // 立即刷新 UI（关闭 loading 遮罩 + 按钮从 Stop 变 Restart），不等 await dispose
      cleanupPtyInteraction(activeSession) // 保留 onData/onExit 到 dispose 真收尾，避免等待窗口吞掉 exit
      const flushResult = await flushBufferedOutput(activeSession, termId)
      let disposeLostSession = false
      let timeoutRestored = false
      try {
        await window.api.terminal.dispose(termId)
        if (activeSession.termId === termId) activeSession.termId = null
      } catch (e) {
        const isDisposeTimeout = getErrorMessage(e) === PTY_DISPOSE_TIMED_OUT_MESSAGE
        const closeDeferredToStop = activeSession.closeDeferredStopTermId === termId
        if (sessionsRef.current.has(activeSession.id) && activeSession.termId === termId) {
          if (!isDisposeTimeout) {
            disposeLostSession = true
            activeSession.termId = null
            activeSession.hasContent = true
            activeSession.suppressExitMessageTermId = termId
            if (!closeDeferredToStop) {
              activeSession.xterm.write("\r\n\x1b[31m[停止时终端已失联]\x1b[0m\r\n")
            }
          } else if (isDisposeTimeout) {
            activeSession.hasContent = true
            const restored = restoreRunningPtyBindings(activeSession, termId)
            activeSession.running = false
            activeSession.timeoutRecoveredTermId = restored ? termId : null
            timeoutRestored = restored
            if (restored) {
              void flushBufferedOutput(activeSession, termId)
            }
            if (!closeDeferredToStop) {
              activeSession.xterm.write(
                restored
                  ? "\r\n\x1b[31m[停止超时，终端可能仍在运行，可重试停止或关闭标签页]\x1b[0m\r\n"
                  : "\r\n\x1b[31m[停止超时，终端状态未知，可重试停止或关闭标签页]\x1b[0m\r\n"
              )
            }
          }
        } else {
          console.warn("[ClaudeCode] dispose failed in handleStop after session changed/closed", e)
        }
      }
      // closeSession 可能在同一次 dispose promise 上先完成并把 session 从 UI/Map 中移除。
      // 这种情况下不要再继续 cleanup / 改 stopping / 写终端提示，避免对已脱离 UI 的
      // session 做第二轮收尾。
      if (!sessionsRef.current.has(activeSession.id)) {
        return
      }
      if ((!activeSession.running || activeSession.termId === null || disposeLostSession) && !timeoutRestored) {
        cleanupPty(activeSession)
      }
      activeSession.closeDeferredStopTermId = null
      activeSession.stopping = false
      setSessionIds((prev) => [...prev]) // 刷新工具栏按钮，确保 stopping=false 及时反映到 UI
      // await 期间 session 可能已被 closeSession 销毁或被 Restart 重新启动
      if (
        sessionsRef.current.has(activeSession.id) &&
        activeSession.termId === null &&
        !activeSession.running &&
        !activeSession.restarting &&
        !disposeLostSession &&
        activeSession.lastExitTermId !== termId &&
        activeSession.lastClosedTermId !== termId &&
        activeSession.lastExitCode !== null &&
        flushResult === "written"
      ) {
        // 这里由 handleStop 自己补一条“已停止”兜底提示；
        // 若同一个 term 的 late onExit 随后才到，抑制它的退出文案，避免双写。
        activeSession.suppressExitMessageTermId = termId
        activeSession.xterm.write("\r\n\x1b[90m[已停止]\x1b[0m\r\n")
      }
    }
  }, [activeSession, cleanupPtyInteraction, flushBufferedOutput, releaseCreatingState, restoreRunningPtyBindings])

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* 没有会话时显示欢迎页（覆盖在终端视图上，避免 DOM 树切换导致高度闪动） */}
      {sessionIds.length === 0 && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-6 bg-background">
          <div className="flex flex-col items-center gap-3">
            <svg viewBox="0 0 9 8" width="64" height="64" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges" style={{ imageRendering: "pixelated", display: "block" }}>
              <rect x="1" y="0" width="7" height="1" fill="#E8907A"/>
              <rect x="0" y="1" width="9" height="1" fill="#E8907A"/>
              <rect x="0" y="2" width="9" height="1" fill="#E8907A"/>
              <rect x="2" y="2" width="1" height="1" fill="#5C2315"/>
              <rect x="6" y="2" width="1" height="1" fill="#5C2315"/>
              <rect x="0" y="3" width="9" height="1" fill="#E8907A"/>
              <rect x="0" y="4" width="9" height="1" fill="#D4786A"/>
              <rect x="0" y="5" width="9" height="1" fill="#D4786A"/>
              <rect x="1" y="6" width="3" height="1" fill="#C06858"/>
              <rect x="5" y="6" width="3" height="1" fill="#C06858"/>
              <rect x="1" y="7" width="3" height="1" fill="#B05848"/>
              <rect x="5" y="7" width="3" height="1" fill="#B05848"/>
            </svg>
            <h3 className="text-lg font-semibold text-foreground/80">Claude Code</h3>
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              点击下方按钮选择项目目录，Claude Code 将在该目录下启动。<br />
              你可以通过顶部 Tab 栏新建多个会话，每个会话对应不同的项目目录。
            </p>
            <div className="rounded-xl border border-border/60 divide-y divide-border/60 text-xs text-muted-foreground">
              <div className="flex items-center gap-2 px-4 py-2">
                <TriangleAlert className="size-3.5 shrink-0 text-amber-400" />
                <span>会话仅在本次运行期间有效，重启应用后需重新创建</span>
              </div>
              {window.electron.process.platform === "win32" && (
                <div className="flex items-center gap-2 px-4 py-2">
                  <TriangleAlert className="size-3.5 shrink-0 text-amber-400" />
                  <span>Windows 用户必须安装 Git Bash 和 Node.js (18.18+ / 20.4+ / ≥ 21)</span>
                </div>
              )}
              <div className="flex items-center gap-2 px-4 py-2">
                <TriangleAlert className="size-3.5 shrink-0 text-amber-400" />
                <span>按 {window.electron.process.platform === "win32" ? "Alt+M" : "Shift+Tab"} 切换到 bypass permissions 模式可跳过确认弹窗</span>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-center gap-3 w-full max-w-md">
            {/* 液态玻璃配置面板 */}
            <div className="w-full rounded-2xl border border-[rgba(0,0,0,0.06)] bg-[rgba(255,255,255,0.5)] backdrop-blur-xl shadow-[0_2px_12px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.8)] overflow-hidden">
              {/* 模型选择行 */}
              {isPackaged && models.length > 0 && (
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-[rgba(0,0,0,0.04)]">
                  <span className="text-xs text-muted-foreground/60">模型</span>
                  <div className="relative inline-flex items-center">
                    <select
                      value={selectedModelId}
                      onChange={(e) => setSelectedModelId(e.target.value)}
                      className="appearance-none h-7 pl-3 pr-7 rounded-lg border-none bg-transparent text-xs text-foreground/70 focus:outline-none cursor-pointer hover:text-foreground/90 transition-colors"
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}{m.model !== m.name ? ` · ${m.model}` : ""}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-muted-foreground/40" />
                  </div>
                </div>
              )}
              {/* 开关行 */}
              {[
                { label: "注入 CMBDevClaw 技能", checked: syncSkills, onChange: setSyncSkills },
                { label: "注入 CMBDevClaw 记忆", checked: syncMemory, onChange: setSyncMemory }
              ].map(({ label, checked, onChange }, i, arr) => (
                <div key={label} className={cn("flex items-center justify-between px-4 py-2.5", i < arr.length - 1 && "border-b border-[rgba(0,0,0,0.04)]")}>
                  <span className="text-xs text-muted-foreground/60">{label}</span>
                  <button
                    type="button"
                    onClick={() => onChange(!checked)}
                    className={cn(
                      "relative w-[38px] h-[22px] rounded-full transition-all duration-300 ease-out cursor-pointer",
                      checked ? "bg-[#34C759]" : "bg-[#e9e9ea]"
                    )}
                  >
                    <span className={cn(
                      "absolute top-[2px] size-[18px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.15),0_1px_1px_rgba(0,0,0,0.06)] transition-all duration-300 ease-out",
                      checked ? "left-[18px]" : "left-[2px]"
                    )} />
                  </button>
                </div>
              ))}
            </div>
            {/* 启动按钮 */}
            <Button onClick={() => { setMountError(null); createSessionWithDir() }} className="gap-2 w-full max-w-xs" disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" />}
              {creating ? "正在启动..." : "选择工作目录并启动"}
            </Button>
            {mountError && (
              <p className="text-xs text-destructive">{mountError}</p>
            )}
          </div>
        </div>
      )}
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-primary" />
          <h2 className="text-sm font-bold">Claude Code</h2>
        </div>
        <div className="flex items-center gap-1">
          {activeSession && (
            <span className="text-[11px] text-muted-foreground mr-1">
              {activeSession.workDir.split(/[\\/]/).pop() || activeSession.workDir}
            </span>
          )}
          {(activeSession?.running || (activeSession?.termId !== null && activeSession?.timeoutRecoveredTermId === activeSession?.termId)) &&
          !activeSession?.restarting && !activeSession?.stopping ? (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleStop} title="停止">
              <Square className="size-3.5" />
            </Button>
          ) : activeSession?.hasContent && !activeSession?.stopping ? (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleRestart} title="重启">
              <RotateCcw className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* 会话 Tab 栏 */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-muted/30 overflow-x-auto">
        {sessionIds.map((id, i) => {
          const s = getSession(id)
          return (
            <div
              key={id}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded text-xs cursor-pointer transition-colors group",
                id === activeSessionId
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
              onClick={() => switchSession(id)}
            >
              <span className={cn("size-1.5 rounded-full", s?.running ? "bg-green-500" : "bg-muted-foreground/40")} />
              <span>{s?.workDir.split(/[\\/]/).pop() || `会话 ${i + 1}`}</span>
              <button
                className="size-3.5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={(e) => { e.stopPropagation(); closeSession(id) }}
                disabled={!!s?.closing}
              >
                <X className="size-2.5" />
              </button>
            </div>
          )
        })}
        <button
          className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={() => { setMountError(null); createSessionWithDir() }}
          title="新建会话"
          disabled={creating}
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {/* 挂载错误提示 */}
      {mountError && (
        <div className="flex items-center justify-between px-3 py-1 bg-destructive/10 border-b border-destructive/20">
          <p className="text-xs text-destructive">{mountError}</p>
          <button className="text-xs text-destructive/60 hover:text-destructive" onClick={() => setMountError(null)}>✕</button>
        </div>
      )}

      {/* 终端容器 */}
      <div ref={hostRef} className="flex-1 min-h-0 overflow-hidden" style={{ position: "relative", backgroundColor: "#faf9f6" }}>
        {activeSession && !activeSession.hasContent && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-4" style={{ backgroundColor: "#faf9f6" }}>
            {/* Claude Code 像素吉祥物 - 逐帧行走动画 */}
            <div className="claude-mascot-container">
              <svg width="66" height="60" viewBox="0 0 11 10" xmlns="http://www.w3.org/2000/svg" style={{ shapeRendering: "crispEdges" }}>
                {/* 耳朵 */}
                <rect x="0" y="0" width="1" height="2" fill="#D77757"/>
                <rect x="1" y="0" width="1" height="1" fill="#D77757"/>
                <rect x="9" y="0" width="1" height="2" fill="#D77757"/>
                <rect x="8" y="0" width="1" height="1" fill="#D77757"/>
                {/* 身体 */}
                <rect x="1" y="1" width="8" height="6" fill="#D77757"/>
                <rect x="0" y="2" width="10" height="4" fill="#D77757"/>
                {/* 眼睛 */}
                <rect x="3" y="3" width="1" height="2" fill="#1a1a1a"/>
                <rect x="6" y="3" width="1" height="2" fill="#1a1a1a"/>
                {/* 腿 - 帧1 */}
                <g className="legs-frame1">
                  <rect x="1" y="7" width="1" height="2" fill="#C86F4A"/>
                  <rect x="3" y="7" width="1" height="2" fill="#C86F4A"/>
                  <rect x="6" y="7" width="1" height="2" fill="#C86F4A"/>
                  <rect x="8" y="7" width="1" height="2" fill="#C86F4A"/>
                </g>
                {/* 腿 - 帧2 */}
                <g className="legs-frame2">
                  <rect x="1" y="7" width="1" height="1" fill="#C86F4A"/>
                  <rect x="0" y="8" width="1" height="1" fill="#C86F4A"/>
                  <rect x="4" y="7" width="1" height="2" fill="#C86F4A"/>
                  <rect x="5" y="7" width="1" height="2" fill="#C86F4A"/>
                  <rect x="9" y="7" width="1" height="1" fill="#C86F4A"/>
                  <rect x="10" y="8" width="1" height="1" fill="#C86F4A"/>
                </g>
                {/* 尾巴 */}
                <rect x="10" y="4" width="1" height="1" fill="#888"/>
              </svg>
            </div>
            <span className="text-xs text-muted-foreground/50">{activeSession?.slowStarting ? "首次启动可能较慢，请稍候..." : activeSession?.restarting ? "正在重启 Claude Code..." : "正在启动 Claude Code..."}</span>
            <style>{`
              .claude-mascot-container {
                animation: mascot-hop 0.5s ease-in-out infinite;
              }
              @keyframes mascot-hop {
                0%, 100% { transform: translateY(0) rotate(0deg); }
                30% { transform: translateY(-4px) rotate(-2deg); }
                60% { transform: translateY(-4px) rotate(2deg); }
              }
              .legs-frame1 {
                animation: frame1-toggle 0.5s steps(1) infinite;
              }
              .legs-frame2 {
                animation: frame2-toggle 0.5s steps(1) infinite;
              }
              @keyframes frame1-toggle {
                0%   { opacity: 1; }
                50%  { opacity: 0; }
              }
              @keyframes frame2-toggle {
                0%   { opacity: 0; }
                50%  { opacity: 1; }
              }
            `}</style>
          </div>
        )}
      </div>
    </div>
  )
}
