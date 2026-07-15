import { useEffect, useRef, useState, useCallback } from "react"
import { Terminal as TerminalIcon, RotateCcw, Square, FolderOpen, Plus, X, Loader2, TriangleAlert, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
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
  hasContent: boolean
  ownsCreatingState: boolean // 只有 createSessionWithDir 创建的才为 true，表示该 session 持有 creating 锁
  restarting: boolean
  slowStarting: boolean // terminal.create() 超过 8s 尚未返回，在 overlay 显示"首次启动较慢"提示
  // #1 fix: 分离 DOM 级别的 cleanup 和 PTY/IPC 级别的 cleanup
  domCleanups: Array<() => void>
  ptyCleanups: Array<() => void>
}

let sessionCounter = 0
const MAX_TRY_OPEN_ATTEMPTS = 100
const PTY_STARTUP_TIMEOUT_MS = 15_000 // Claude Code CLI 冷启动约 8-10s，留有余量

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

  // 清理 PTY 相关的监听器
  const cleanupPty = useCallback((session: Session) => {
    session.ptyCleanups.forEach((fn) => fn())
    session.ptyCleanups = []
  }, [])

  // 释放 creating 锁（仅当 session 持有该锁时）
  // deps=[] 因为 setCreating 是 useState setter，引用永远稳定
  const releaseCreatingState = useCallback((session: Session) => {
    if (session.ownsCreatingState) {
      session.ownsCreatingState = false
      setCreating(false)
    }
  }, [])

  const startPty = useCallback(async (session: Session) => {
    const oldTermId = session.termId
    session.termId = null
    // 先清监听器再 dispose，防止 dispose 触发 onExit 写入残留文字（如 restart 场景）
    cleanupPty(session)
    if (oldTermId) {
      try { await window.api.terminal.dispose(oldTermId) }
      catch (e) { console.warn("[ClaudeCode] dispose failed in startPty, continuing with new PTY", e) }
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

    // 慢启动提示：主进程 terminal.create 在最坏情况下最长等 ~50s（20s host ready + 30s PTY create），
    // 8s 后还没返回，把 slowStarting 标记置 true，overlay 会切换到"首次启动较慢"文案。
    // 成功后清掉标记，不污染 xterm buffer（写 buffer 会在 overlay 撤销后变成脏历史）。
    const slowStartTimer = setTimeout(() => {
      if (!sessionsRef.current.has(session.id)) return
      session.slowStarting = true
      setSessionIds((prev) => [...prev]) // 触发重渲让 overlay 更新文案
    }, 8_000)
    let termId: string
    try {
      termId = await window.api.terminal.create({
        workDir: session.workDir || undefined,
        args: ["--allow-dangerously-skip-permissions"],
        cols: session.xterm.cols,
        rows: session.xterm.rows,
        claudeModelId: session.claudeModelId,
        syncSkills: session.syncSkills,
        syncMemory: session.syncMemory
      })
    } finally {
      clearTimeout(slowStartTimer)
      session.slowStarting = false
    }

    // #2 fix: 如果 await 期间 session 被关闭，dispose 新创建的 PTY
    if (!sessionsRef.current.has(session.id)) {
      window.api.terminal.dispose(termId).catch((e) => console.warn("[ClaudeCode] dispose orphan PTY failed:", e))
      releaseCreatingState(session) // P0 fix: 防止 creating 永久卡死
      return
    }
    session.termId = termId
    session.running = true

    const removeData = window.api.terminal.onData(termId, (data, bytes) => {
      if (!sessionsRef.current.has(session.id)) return
      session.xterm.write(data, () => {
        window.api.terminal.ack(termId, bytes)
      })
      // 首次收到数据时标记 hasContent，关闭 loading 遮罩
      if (!session.hasContent) {
        session.hasContent = true
        session.restarting = false
        releaseCreatingState(session)
        setSessionIds((prev) => [...prev])
        // 延迟 focus，此时 Claude Code 已初始化完毕能正确处理焦点报告，不会产生 ^[[I 乱码
        if (session.id === activeSessionIdRef.current) session.xterm.focus()
      }
    })
    session.ptyCleanups.push(removeData)

    const removeExit = window.api.terminal.onExit(termId, (code) => {
      if (!sessionsRef.current.has(session.id)) return
      // code 为 null 表示主进程 host 通信故障/spawn 失败强制 tear-down，没有真实退出码
      const exitMsg = code === null
        ? "[终端主机异常退出]"
        : `[进程已退出，代码: ${code}]`
      session.xterm.write(`\r\n\x1b[90m${exitMsg}\x1b[0m\r\n`)
      session.running = false
      session.restarting = false
      session.termId = null // 进程已退出，清零防止重启时多余 dispose
      if (!session.hasContent) {
        session.hasContent = true
        releaseCreatingState(session)
      }
      setSessionIds((prev) => [...prev])
    })
    session.ptyCleanups.push(removeExit)

    const onDataDisposable = session.xterm.onData((data) => {
      if (session.termId) window.api.terminal.write(session.termId, data)
    })
    session.ptyCleanups.push(() => onDataDisposable.dispose())

    const onResizeDisposable = session.xterm.onResize(({ cols, rows }) => {
      if (session.termId) window.api.terminal.resize(session.termId, cols, rows)
    })
    session.ptyCleanups.push(() => onResizeDisposable.dispose())

    fitTerminal(session)
    setSessionIds((prev) => [...prev])

    // 超时兜底：若 PTY_STARTUP_TIMEOUT_MS 内仍无输出，释放 creating 锁并关闭 loading 遮罩
    const creatingTimeout = setTimeout(() => {
      if (!sessionsRef.current.has(session.id)) return
      try {
        if (!session.hasContent) {
          session.xterm.write("\r\n\x1b[31m[启动超时，请检查环境或重启]\x1b[0m\r\n")
          session.hasContent = true
          session.restarting = false
          setSessionIds((prev) => [...prev])
        }
      } catch (e) {
        console.warn("[ClaudeCode] timeout handler write failed", e)
        if (!session.hasContent) {
          session.hasContent = true
          session.restarting = false
          setSessionIds((prev) => [...prev])
        }
      }
      releaseCreatingState(session)
    }, PTY_STARTUP_TIMEOUT_MS)
    session.ptyCleanups.push(() => clearTimeout(creatingTimeout))
  }, [fitTerminal, cleanupPty, releaseCreatingState])

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
        session.xterm.focus()
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
        running: false, workDir: dir, claudeModelId: resolvedModelId || undefined, syncSkills: syncSkillsRef.current, syncMemory: syncMemoryRef.current, hasContent: false, ownsCreatingState: true, restarting: false, slowStarting: false, domCleanups: [], ptyCleanups: []
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
          if (sessionsRef.current.has(session.id)) {
            session.xterm.write(`\r\n\x1b[31m[启动失败: ${err instanceof Error ? err.message : err}]\x1b[0m\r\n`)
            session.running = false
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
    if (!session) return
    sessionsRef.current.delete(id) // 立即删除作为互斥锁，防止并发二次进入 + 让其他回调的 guard 生效
    session.container.style.display = "none"
    setSessionIds((prev) => prev.filter((s) => s !== id))
    releaseCreatingState(session)

    // await 前同步切换 active session，避免 tab 消失后出现空白闪烁
    // 读 ref 而非闭包值，防快速连续关闭多 tab 时 activeSessionId 过时
    if (id === activeSessionIdRef.current) {
      setMountError(null)
      const remaining = [...sessionsRef.current.keys()]
      if (remaining.length > 0) switchSession(remaining[remaining.length - 1])
      else updateActiveSessionId(null)
    }

    cleanupPty(session)
    session.domCleanups.forEach((fn) => fn())
    const termId = session.termId
    session.termId = null
    if (termId) {
      try { await window.api.terminal.dispose(termId) }
      catch (e) { console.warn("[ClaudeCode] dispose failed in closeSession, continuing cleanup", e) }
    }
    session.xterm.dispose()
    session.container.remove()
  }, [switchSession, cleanupPty, releaseCreatingState, updateActiveSessionId])

  // 组件卸载时清理所有会话
  useEffect(() => {
    return () => {
      for (const session of sessionsRef.current.values()) {
        session.ptyCleanups.forEach((fn) => fn())
        session.domCleanups.forEach((fn) => fn())
        if (session.termId) window.api.terminal.dispose(session.termId).catch((e) => console.warn("[ClaudeCode] dispose failed in unmount", e))
        session.xterm.dispose()
        session.container.remove()
      }
      sessionsRef.current.clear()
    }
  }, [])

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
    if (!activeSession || activeSession.restarting) return
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
      if (sessionsRef.current.has(activeSession.id)) {
        activeSession.running = false
        activeSession.restarting = false
        activeSession.hasContent = true
        activeSession.xterm.write(`\r\n\x1b[31m[重启失败: ${err instanceof Error ? err.message : err}]\x1b[0m\r\n`)
        setSessionIds((prev) => [...prev])
      } else {
        activeSession.restarting = false // session 已销毁，仅清标志
      }
    }
  }, [activeSession, startPty])

  // #3 fix: handleStop 清理 PTY 监听器
  const handleStop = useCallback(async () => {
    if (activeSession?.restarting) return // restart 期间不允许 Stop，防止干掉新建的 PTY
    if (activeSession?.termId) {
      const termId = activeSession.termId
      activeSession.termId = null
      activeSession.running = false
      if (!activeSession.hasContent) {
        activeSession.hasContent = true
        releaseCreatingState(activeSession)
      }
      setSessionIds((prev) => [...prev]) // 立即刷新 UI（关闭 loading 遮罩 + 按钮从 Stop 变 Restart），不等 await dispose
      cleanupPty(activeSession) // 先清监听器，防止 dispose 期间 onExit 双写退出信息
      try { await window.api.terminal.dispose(termId) }
      catch (e) { console.warn("[ClaudeCode] dispose failed in handleStop, PTY may still be running", e) }
      // await 期间 session 可能已被 closeSession 销毁或被 Restart 重新启动
      if (sessionsRef.current.has(activeSession.id) && !activeSession.running && !activeSession.restarting) {
        activeSession.xterm.write("\r\n\x1b[90m[已停止]\x1b[0m\r\n")
      }
    }
  }, [activeSession, cleanupPty, releaseCreatingState])

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
                  <span>Windows 用户必须安装 Git Bash 和 Node.js (≥ 18)</span>
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
          {activeSession?.running && !activeSession.restarting ? (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleStop} title="停止">
              <Square className="size-3.5" />
            </Button>
          ) : activeSession?.hasContent ? (
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
                className="size-3.5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted"
                onClick={(e) => { e.stopPropagation(); closeSession(id) }}
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
