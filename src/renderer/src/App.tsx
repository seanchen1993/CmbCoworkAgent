import { useEffect, useState, useCallback, useRef, useLayoutEffect } from "react"
import {
  Briefcase,
  Eye,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen
} from "lucide-react"
import { ThreadSidebar } from "@/components/sidebar/ThreadSidebar"
import { TabbedPanel } from "@/components/tabs"
import { RightPanel } from "@/components/panels/RightPanel"
import { KanbanView } from "@/components/kanban"
import { ClaudeCodePanel } from "@/components/customize/ClaudeCodePanel"
import { CustomizeView } from "@/components/customize/CustomizeView"
import { ResizeHandle } from "@/components/ui/resizable"
import { useAppStore } from "@/lib/store"
import { ThreadProvider } from "@/lib/thread-context"
import { initMMJ } from "../js/mmjUtils"
import { Toaster } from "sonner"
interface UserInfoConfig {
  sapId: '',//8
  ystId: '',//6
  userName: '',
  originOrgId: '',
  orgName: '',
  ystRefreshToken: '',
  ystCode: '',
  ystAccessToken: '',
}

async function migrateDisabledSkillsFromLocalStorage(): Promise<void> {
  try {
    const saved = localStorage.getItem("disabled-skills")
    if (!saved) return
    const parsed = JSON.parse(saved) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return
    const current = await window.api.skills.getDisabled()
    if (current.length === 0) {
      await window.api.skills.setDisabled(parsed.filter((s): s is string => typeof s === "string"))
    }
    localStorage.removeItem("disabled-skills")
  } catch { /* migration is best-effort */ }
}

const LEFT_MIN = 200
const LEFT_MAX = 400
const LEFT_DEFAULT = 280

const RIGHT_MIN = 250
const RIGHT_MAX = 1600
const RIGHT_DEFAULT = 300
const RIGHT_PREVIEW_EXPAND_VW = 0.35

function App(): React.JSX.Element {
  const {
    currentThreadId,
    loadThreads,
    createThread,
    mainView,
    sidebarCollapsed,
    toggleSidebar,
    rightPanelCollapsed,
    toggleRightPanel,
    setPendingEvolution
  } = useAppStore()
  const [isLoading, setIsLoading] = useState(true)
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT)
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT)
  const [rightModule, setRightModule] = useState<"work" | "preview" | "git">("work")
  const [previewFullscreen, setPreviewFullscreen] = useState(false)
  const [hasPendingGitDiff, setHasPendingGitDiff] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [bus, setBus] = useState(true)
  const autoOpenedGitForThreadRef = useRef<string | null>(null)
  const panelToggleBaseClass =
    "group inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 text-[11px] font-medium whitespace-nowrap transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-offset-0 active:scale-95"
  const moduleActiveClass = "text-status-warning bg-status-warning/15 border-status-warning/45 hover:bg-status-warning/20"
  const moduleInactiveClass = "text-foreground hover:bg-muted/45"
  const sidebarToggleText = sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"
  const rightPanelToggleText = rightPanelCollapsed ? "显示右侧面板" : "隐藏右侧面板"

  useEffect(() => {
    initUser()
  }, [])

  const initUser = () => {
    window.api.models.getUserInfo().then(user => {
        const userInfo = user || {} as UserInfoConfig
        if (userInfo.sapId) {
          fetch(`https://archguardservice.paas.${import.meta.env.VITE_LOGIN_PT}.cn/cowork/login-info`, {
              method: 'GET',
              headers: {
                  ystCode: userInfo.ystCode,
                  ystRefreshToken: userInfo.ystRefreshToken || '',
              }
          }).then(async res => {
              const result = await res.json()
              if (result.returnCode === 'SUC0000') {
                const resBody = result.body
                const pathName = resBody.pathName||''
                if(pathName.includes('零售客户经营开发团队')){
                  setBus(true)
                }else{
                  setBus(false)
                }
              } else{
                window.electron.openLoginPage()
              }
          })
        } else {
          window.electron.openLoginPage()
        }
    });
  };

  useEffect(() => {
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a'); // 找到点击的<a>标签
      if (link && link.href) {
        e.preventDefault(); // 阻止默认跳转
        window.electron.openExternal(link.href);
      }
    });
    initMMJ()
  }, []);

  // Track drag start widths
  const dragStartWidths = useRef<{ left: number; right: number } | null>(null)
  const previewCollapsedWidthRef = useRef<number | null>(null)

  // Set platform-specific titlebar insets and track zoom
  useLayoutEffect(() => {
    const platform = window.electron?.process?.platform

    const updateInsets = (zoom: number): void => {
      if (platform === "darwin") {
        const TRAFFIC_LIGHT_X = 16
        const TRAFFIC_LIGHT_WIDTH = 70
        const leftInset = Math.ceil((TRAFFIC_LIGHT_X + TRAFFIC_LIGHT_WIDTH) / zoom)
        document.documentElement.style.setProperty("--titlebar-inset-left", `${leftInset}px`)
        document.documentElement.style.setProperty("--titlebar-inset-right", "0px")
      } else if (platform === "win32") {
        const WIN_CONTROLS_WIDTH = 140
        const rightInset = Math.ceil(WIN_CONTROLS_WIDTH / zoom)
        document.documentElement.style.setProperty("--titlebar-inset-left", "0px")
        document.documentElement.style.setProperty("--titlebar-inset-right", `${rightInset}px`)
      }
    }

    // Set insets immediately with zoom=1 so they're never missing
    updateInsets(1)

    const updateZoom = (): void => {
      const detectedZoom = Math.round((window.outerWidth / window.innerWidth) * 100) / 100
      if (detectedZoom > 0.5 && detectedZoom < 3) {
        setZoomLevel(detectedZoom)

        const TRAFFIC_LIGHT_BOTTOM_SCREEN = 40
        const TITLEBAR_HEIGHT_CSS = 36
        const titlebarScreenHeight = TITLEBAR_HEIGHT_CSS * detectedZoom
        const extraPaddingScreen = Math.max(0, TRAFFIC_LIGHT_BOTTOM_SCREEN - titlebarScreenHeight)
        const extraPaddingCss = Math.round(extraPaddingScreen / detectedZoom)
        document.documentElement.style.setProperty("--sidebar-safe-padding", `${extraPaddingCss}px`)

        updateInsets(detectedZoom)
      }
    }

    updateZoom()
    window.addEventListener("resize", updateZoom)
    return () => window.removeEventListener("resize", updateZoom)
  }, [])

  const leftMinWidth = LEFT_MIN

  const handleLeftResize = useCallback(
    (totalDelta: number) => {
      if (!dragStartWidths.current) {
        dragStartWidths.current = { left: leftWidth, right: 0 }
      }
      const newWidth = dragStartWidths.current.left + totalDelta
      setLeftWidth(Math.min(LEFT_MAX, Math.max(leftMinWidth, newWidth)))
    },
    [leftWidth, leftMinWidth]
  )

  const handleRightResize = useCallback(
    (totalDelta: number) => {
      if (!dragStartWidths.current) {
        dragStartWidths.current = { left: leftWidth, right: rightWidth }
      }
      const newWidth = dragStartWidths.current.right - totalDelta
      setRightWidth(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, newWidth)))
    },
    [leftWidth, rightWidth]
  )

  const handlePreviewExpand = useCallback(() => {
    setRightWidth((prev) => {
      if (previewCollapsedWidthRef.current === null) {
        previewCollapsedWidthRef.current = prev
      }
      const target = Math.round(window.innerWidth * RIGHT_PREVIEW_EXPAND_VW)
      return Math.min(RIGHT_MAX, Math.max(prev, target))
    })
  }, [])

  const handlePreviewCollapse = useCallback(() => {
    if (previewCollapsedWidthRef.current !== null) {
      setRightWidth(previewCollapsedWidthRef.current)
      previewCollapsedWidthRef.current = null
    }
  }, [])

  const selectPreviewModule = useCallback(() => {
    if (rightModule === "preview") {
      toggleRightPanel()
    } else {
      if (rightPanelCollapsed) {
        toggleRightPanel()
      }
      setRightModule("preview")
      handlePreviewExpand()
    }
  }, [handlePreviewExpand, rightModule, rightPanelCollapsed, toggleRightPanel])

  const selectWorkModule = useCallback(() => {
    if (rightModule === "work") {
      toggleRightPanel()
    } else {
      if (rightPanelCollapsed) {
        toggleRightPanel()
      }
      setRightModule("work")
      handlePreviewCollapse()
    }
  }, [handlePreviewCollapse, rightModule, rightPanelCollapsed, toggleRightPanel])

  const selectGitModule = useCallback(() => {
    if (rightModule === "git") {
      toggleRightPanel()
    } else {
      if (rightPanelCollapsed) {
        toggleRightPanel()
      }
      setRightModule("git")
      handlePreviewExpand()
    }
  }, [handlePreviewExpand, rightModule, rightPanelCollapsed, toggleRightPanel])

  useEffect(() => {
    let cancelled = false

    const syncRightModuleByWorkspace = async (): Promise<void> => {
      if (!currentThreadId || mainView !== "thread") {
        setRightModule("work")
        handlePreviewCollapse()
        return
      }

      try {
        const summary = await window.api.workspace.getGitPanelSummary(currentThreadId)
        if (cancelled) return

        const isGitWorkspace = Boolean(summary.isGitRepo ?? summary.isWorktree)
        if (isGitWorkspace) {
          autoOpenedGitForThreadRef.current = currentThreadId
          setRightModule("git")
          handlePreviewExpand()
          return
        }

        setRightModule("work")
        handlePreviewCollapse()
      } catch {
        if (cancelled) return
        setRightModule("work")
        handlePreviewCollapse()
      }
    }

    void syncRightModuleByWorkspace()

    return () => {
      cancelled = true
    }
  }, [currentThreadId, mainView, handlePreviewCollapse, handlePreviewExpand])

  useEffect(() => {
    if (!currentThreadId || mainView !== "thread") {
      setHasPendingGitDiff(false)
      return
    }
    let cancelled = false

    const refreshSummary = async (): Promise<void> => {
      try {
        const summary = await window.api.workspace.getGitPanelSummary(currentThreadId)
        if (!cancelled) {
          const isGitWorkspace = Boolean(summary.isGitRepo ?? summary.isWorktree)
          setHasPendingGitDiff(Boolean(isGitWorkspace && summary.hasPendingDiff))
          if (isGitWorkspace && autoOpenedGitForThreadRef.current !== currentThreadId) {
            autoOpenedGitForThreadRef.current = currentThreadId
            setRightModule("git")
            handlePreviewExpand()
          }
        }
      } catch {
        if (!cancelled) setHasPendingGitDiff(false)
      }
    }

    refreshSummary()
    const timer = window.setInterval(refreshSummary, 3000)
    const cleanupFs = window.api.workspace.onFilesChanged((data) => {
      if (data.threadId === currentThreadId) {
        refreshSummary()
      }
    })

    return () => {
      cancelled = true
      window.clearInterval(timer)
      cleanupFs()
    }
  }, [currentThreadId, mainView, handlePreviewExpand])

  // Reset drag start on mouse up
  useEffect(() => {
    const handleMouseUp = (): void => {
      dragStartWidths.current = null
    }
    document.addEventListener("mouseup", handleMouseUp)
    return () => document.removeEventListener("mouseup", handleMouseUp)
  }, [])

  useEffect(() => {
    async function init(): Promise<void> {
      try {
        await migrateDisabledSkillsFromLocalStorage()
        await loadThreads()
        const threads = useAppStore.getState().threads
        if (threads.length === 0) {
          await createThread()
        }
      } catch (error) {
        console.error("Failed to initialize:", error)
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, [loadThreads, createThread])

  // Listen for skill-evolution threshold events — set badge on Evolution tab
  useEffect(() => {
    return window.api.optimizer.onAutoTriggered(() => {
      setPendingEvolution(true)
    })
  }, [setPendingEvolution])

  // Reload thread list when main process signals a change (e.g. scheduled task created a thread).
  // Only update the list without auto-selecting (which would navigate away from customize view).
  useEffect(() => {
    return window.api.threads.onThreadsChanged(async () => {
      try {
        const threads = await window.api.threads.list()
        useAppStore.setState({ threads })
      } catch (err) {
        console.error("[App] Failed to reload threads:", err)
      }
    })
  }, [])

  // Safety net: refresh thread list when the window regains focus.
  // On Windows, IPC messages sent while the window is minimized/background may be dropped.
  useEffect(() => {
    const onFocus = async (): Promise<void> => {
      try {
        const threads = await window.api.threads.list()
        useAppStore.setState({ threads })
      } catch {
        // ignore
      }
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">Initializing...</div>
      </div>
    )
  }

  if(!bus){
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground">目前仅供零售客户经营开发团队使用，暂不对外提供服务...,有任何疑问请联系 范雄</div>
      </div>
    )
  }

  return (
    <ThreadProvider>
      <div className="flex flex-col h-screen overflow-hidden bg-background">
        {/* Titlebar - logo centered, right panel toggle on right */}
        <div className="flex h-9 w-full shrink-0 app-drag-region items-center border-b border-border">
          {/* Left: sidebar toggle */}
          <div
            className="flex flex-1 h-9 min-w-0 items-center"
            style={{ marginLeft: "var(--titlebar-inset-left, 0px)" }}
          >
            {mainView !== "customize" && (
              <button
                type="button"
                className={`${panelToggleBaseClass} ${
                  sidebarCollapsed
                    ? "text-muted-foreground/90 hover:text-foreground hover:bg-muted/45"
                    : "text-foreground bg-muted/35 hover:bg-muted/50"
                }`}
                onClick={toggleSidebar}
                title={sidebarToggleText}
                aria-label={sidebarToggleText}
                aria-pressed={!sidebarCollapsed}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen
                    size={18}
                    className="shrink-0 text-muted-foreground/75 transition-transform group-hover:scale-[1.04]"
                    strokeWidth={1.6}
                  />
                ) : (
                  <PanelLeftClose
                    size={18}
                    className="shrink-0 text-muted-foreground/75 transition-transform group-hover:scale-[1.04]"
                    strokeWidth={1.6}
                  />
                )}
              </button>
            )}
          </div>
          {/* Center: logo + title */}
          <div
            style={{
              transform: `scale(${1 / zoomLevel})`,
              transformOrigin: "center center"
            }}
            className="flex flex-1 min-w-0 items-center justify-center gap-1.5"
          >
            <svg className="size-7 shrink-0" viewBox="0 0 120 120" fill="none" style={{ animation: 'lobster-sway-bounce 2.5s ease-in-out infinite' }}>
              <defs>
                <linearGradient id="title-lobster" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#ff4d4d"/>
                  <stop offset="100%" stopColor="#991b1b"/>
                </linearGradient>
              </defs>
              <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#title-lobster)"/>
              <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#title-lobster)"/>
              <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#title-lobster)"/>
              <g style={{ animation: 'antenna-left 2.5s ease-in-out infinite', transformOrigin: '45px 15px' }}>
                <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
              </g>
              <g style={{ animation: 'antenna-right 2.5s ease-in-out infinite 0.3s', transformOrigin: '75px 15px' }}>
                <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
              </g>
              <g style={{ animation: 'lobster-blink 4s ease-in-out infinite', transformOrigin: '60px 35px' }}>
                <circle cx="45" cy="35" r="6" fill="#050810"/>
                <circle cx="75" cy="35" r="6" fill="#050810"/>
                <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/>
                <circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
              </g>
            </svg>
            <span className="app-badge-name">CMBDev<span className="text-red-500">Claw</span></span>
          </div>
          {/* Right: right panel toggle */}
          <div
            className="flex flex-1 h-full items-center justify-end pl-1 gap-1"
          >
            {mainView === "thread" && (
              <>
                <button
                  type="button"
                  className={`${panelToggleBaseClass} ${
                    !rightPanelCollapsed && rightModule === "preview"
                      ? moduleActiveClass
                      : moduleInactiveClass
                  }`}
                  onClick={selectPreviewModule}
                  title="文件预览"
                  aria-label="文件预览"
                  aria-pressed={!rightPanelCollapsed && rightModule === "preview"}
                >
                  <Eye size={16} className="shrink-0" strokeWidth={1.8} />
                  <span>文件预览</span>
                </button>
                <button
                  type="button"
                  className={`${panelToggleBaseClass} ${
                    !rightPanelCollapsed && rightModule === "git"
                      ? moduleActiveClass
                      : hasPendingGitDiff
                        ? "text-foreground border-status-warning/40 hover:bg-muted/45"
                        : moduleInactiveClass
                  }`}
                  onClick={selectGitModule}
                  title="Git 操作"
                  aria-label="Git 操作"
                  aria-pressed={!rightPanelCollapsed && rightModule === "git"}
                >
                  <GitBranch size={16} className="shrink-0" strokeWidth={1.8} />
                  <span>Git 操作</span>
                </button>
                <button
                  type="button"
                  className={`${panelToggleBaseClass} ${
                    !rightPanelCollapsed && rightModule === "work"
                      ? moduleActiveClass
                      : moduleInactiveClass
                  }`}
                  onClick={selectWorkModule}
                  title="工作目录"
                  aria-label="工作目录"
                  aria-pressed={!rightPanelCollapsed && rightModule === "work"}
                >
                  <Briefcase size={16} className="shrink-0" strokeWidth={1.8} />
                  <span>工作目录</span>
                </button>
              </>
            )}
            {mainView !== "customize" && (
              <button
                type="button"
                className={`${panelToggleBaseClass} ${
                  rightPanelCollapsed
                    ? "text-muted-foreground/90 hover:text-foreground hover:bg-muted/45"
                    : "text-foreground bg-muted/35 hover:bg-muted/50"
                }`}
                onClick={toggleRightPanel}
                title={rightPanelToggleText}
                aria-label={rightPanelToggleText}
                aria-pressed={!rightPanelCollapsed}
              >
                {rightPanelCollapsed ? (
                  <PanelRightOpen
                    size={18}
                    className="shrink-0 text-muted-foreground/75 transition-transform group-hover:scale-[1.04]"
                    strokeWidth={1.6}
                  />
                ) : (
                  <PanelRightClose
                    size={18}
                    className="shrink-0 text-muted-foreground/75 transition-transform group-hover:scale-[1.04]"
                    strokeWidth={1.6}
                  />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Main content below titlebar */}
        {mainView === "customize" ? (
          <div className="flex flex-1 overflow-hidden bg-grid-subtle">
            <main className="flex flex-1 flex-col min-w-0 overflow-hidden">
              <CustomizeView />
            </main>
          </div>
        ) : mainView !== "claudecode" ? (
          <div className="relative flex flex-1 overflow-hidden bg-grid-subtle">
            {/* Left Sidebar */}
            {!sidebarCollapsed && (
              <>
                <div style={{ width: leftWidth }} className="shrink-0">
                  <ThreadSidebar />
                </div>
                <ResizeHandle onDrag={handleLeftResize} />
              </>
            )}

            {mainView === "kanban" ? (
              <main className="relative flex flex-1 flex-col min-w-0 overflow-hidden">
                <KanbanView />
              </main>
            ) : (
              <>
                {/* Center - Content Panel */}
                {!previewFullscreen && (
                  <main className="relative flex flex-1 flex-col min-w-0 overflow-hidden">
                    {currentThreadId ? (
                      <TabbedPanel threadId={currentThreadId} showTabBar={false} />
                    ) : (
                      <div className="flex flex-1 items-center justify-center text-muted-foreground">
                        选择或创建一个任务开始
                      </div>
                    )}
                  </main>
                )}
              </>
            )}

            {mainView === "thread" && !rightPanelCollapsed && (
              <>
                {!previewFullscreen && <ResizeHandle onDrag={handleRightResize} />}
                {/* Right Panel - floating style */}
                <div
                  style={previewFullscreen ? undefined : { width: rightWidth }}
                  className={previewFullscreen ? "flex-1 min-w-0 p-2 pl-0" : "shrink-0 p-2 pl-0"}
                >
                  <RightPanel
                    moduleMode={rightModule}
                    onRequestPreviewMode={selectPreviewModule}
                    onRequestGitMode={selectGitModule}
                    onRequestWorkMode={selectWorkModule}
                    onPreviewFullscreenChange={setPreviewFullscreen}
                  />
                </div>
              </>
            )}
          </div>
        ) : null}

        {/* Claude Code 面板始终挂载在所有条件分支外，CSS 控制显隐，不受 customize/thread 切换影响 */}
        <div className={mainView === "claudecode" ? "relative flex flex-1 overflow-hidden bg-grid-subtle" : "hidden"}>
          {/* claudecode 模式下也显示侧边栏 */}
          {mainView === "claudecode" && !sidebarCollapsed && (
            <>
              <div style={{ width: leftWidth }} className="shrink-0">
                <ThreadSidebar />
              </div>
              <ResizeHandle onDrag={handleLeftResize} />
            </>
          )}
          <main className="relative flex flex-1 flex-col min-w-0 overflow-hidden">
            <ClaudeCodePanel visible={mainView === "claudecode"} />
          </main>
        </div>
      </div>
      <Toaster position="top-center" richColors duration={2200} />
    </ThreadProvider>
  )
}

export default App
