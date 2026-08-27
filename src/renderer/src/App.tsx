import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense
} from "react"
import {
  Briefcase,
  Eye,
  GitBranch,
  Globe2,
  GripVertical,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen
} from "lucide-react"
import { ThreadSidebar } from "@/components/sidebar/ThreadSidebar"
import { TabbedPanel } from "@/components/tabs"
import { RightPanel } from "@/components/panels/RightPanel"
import { WorkerStreamPanel } from "@/components/chat/WorkerStreamPanel"
import { SubagentStreamPanel } from "@/components/chat/SubagentStreamPanel"
import { WorkflowAgentStreamPanel } from "@/components/chat/WorkflowAgentStreamPanel"
const KanbanView = lazy(() =>
  import("@/components/kanban").then((m) => ({ default: m.KanbanView }))
)
const HarnessBoardView = lazy(() =>
  import("@/components/harness-board/HarnessBoardView").then((m) => ({ default: m.HarnessBoardView }))
)
const ClaudeCodePanel = lazy(() =>
  import("@/components/customize/ClaudeCodePanel").then((m) => ({ default: m.ClaudeCodePanel }))
)
const CustomizeView = lazy(() =>
  import("@/components/customize/CustomizeView").then((m) => ({ default: m.CustomizeView }))
)
const DashboardView = lazy(() =>
  import("@/components/dashboard/DashboardView").then((m) => ({ default: m.DashboardView }))
)
import { ResizeHandle } from "@/components/ui/resizable"
import { PetStateBridge } from "@/components/pet/PetStateBridge"
import { useBrowserViewLifecycle } from "@/components/browser/useBrowserViewLifecycle"
import { DEFAULT_BROWSER_CDP_CONFIG, useAppStore } from "@/lib/store"
import { ThreadProvider } from "@/lib/thread-context"
import { ElectronIPCTransport } from "@/lib/electron-transport"
import { initMMJ, updateMMJUserInfo } from "../js/mmjUtils"
import { toast, Toaster } from "sonner"
import { useShallow } from "zustand/react/shallow"
import { evolutionApi } from "@/api/evolution"
import {
  cloudEvolutionUpdateSignature,
  getCloudEvolutionPromptSignature,
  hasUnreadCloudEvolutionUpdates,
  markCloudEvolutionUpdatesSeen,
  markReviewCandidatesNotified,
  pendingCloudEvolutionUpdates,
  reviewableCandidates,
  setCloudEvolutionPromptSignature,
  unnotifiedReviewCandidates
} from "@/lib/evolution-notices"
import { useMyUploadedSkills } from "@/lib/use-my-uploaded-skills"
import {
  configureAppCatalogLoaders,
  ensureDisabledSkillsChangedInvalidationSource,
  ensureSkillsChangedInvalidationSource,
  revalidateSkillCatalog
} from "@/lib/app-catalog-cache"
import { loadPluginCatalogPages, loadSkillCatalogPages } from "@/lib/skill-plugin-catalog"
import { invalidateModelCatalogCache } from "@/lib/model-catalog-cache"

configureAppCatalogLoaders({
  skills: (key, isCurrent) =>
    loadSkillCatalogPages(key, "app-skill-catalog", isCurrent),
  plugins: (key, isCurrent) =>
    loadPluginCatalogPages(key, "app-plugin-catalog", isCurrent)
})
interface UserInfoConfig {
  sapId: string
  ystId: string
  userName: string
  originOrgId: string
  orgName: string
  pathName: string
  originPathId: string
  ystRefreshToken: string
  ystCode: string
  ystAccessToken: string
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
const LEFT_RESIZE_HANDLE_WIDTH = 6

const RIGHT_MIN = 250
const RIGHT_MAX = 1600
const RIGHT_DEFAULT = 300
const RIGHT_PREVIEW_EXPAND_VW = 0.35
const BROWSER_FULLSCREEN_RIGHT_DEFAULT_PERCENT = 66.67
const BROWSER_FULLSCREEN_MIN_PANEL_PERCENT = 20
const BROWSER_FULLSCREEN_MAX_PANEL_PERCENT = 80

interface WorkerSplitHandleProps {
  onDrag: (totalDelta: number) => void
}

function WorkerSplitHandle({ onDrag }: WorkerSplitHandleProps): React.JSX.Element {
  const startXRef = useRef(0)

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      startXRef.current = event.clientX
      let frame: number | null = null
      let latestDelta = 0

      const flushDrag = (): void => {
        frame = null
        onDrag(latestDelta)
      }

      const scheduleDrag = (delta: number): void => {
        latestDelta = delta
        if (frame === null) {
          frame = window.requestAnimationFrame(flushDrag)
        }
      }

      const handleMouseMove = (moveEvent: MouseEvent): void => {
        scheduleDrag(moveEvent.clientX - startXRef.current)
      }

      const handleMouseUp = (): void => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame)
          frame = null
          onDrag(latestDelta)
        }
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
    },
    [onDrag]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="拖动调整主对话和代理记录宽度"
      onMouseDown={handleMouseDown}
      className="group relative z-20 flex h-full w-5 shrink-0 cursor-col-resize select-none items-center justify-center border-x border-stone-300/70 bg-stone-100/55 shadow-[0_0_18px_rgba(120,113,108,0.12)] backdrop-blur transition-colors hover:border-stone-400/80 hover:bg-stone-200/45 dark:border-stone-700/70 dark:bg-stone-900/35 dark:hover:border-stone-500/80 dark:hover:bg-stone-800/45"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-stone-500/45 to-transparent" />
      <div className="relative flex h-12 w-3 items-center justify-center rounded-full border border-stone-300/80 bg-background text-stone-500 opacity-75 shadow-sm transition-all group-hover:scale-105 group-hover:border-stone-400 group-hover:text-stone-700 group-hover:opacity-100 dark:border-stone-700 dark:text-stone-400 dark:group-hover:text-stone-200">
        <GripVertical className="size-3" strokeWidth={2.2} />
      </div>
    </div>
  )
}

function AnimatedThreadSidebar({
  hidden,
  width,
  onResize
}: {
  hidden: boolean
  width: number
  onResize: (totalDelta: number) => void
}): React.JSX.Element {
  return (
    <div
      data-app-route-control
      aria-hidden={hidden}
      className={`flex shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-out ${
        hidden ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{ width: hidden ? 0 : width + LEFT_RESIZE_HANDLE_WIDTH }}
    >
      <div style={{ width }} className="shrink-0">
        <ThreadSidebar />
      </div>
      <ResizeHandle onDrag={onResize} />
    </div>
  )
}

function App(): React.JSX.Element {
  const {
    currentThreadId,
    loadThreads,
    loadDashboardAllowed,
    loadChatScrollSettings,
    loadModels,
    dashboardAllowed,
    createThread,
    mainView,
    sidebarCollapsed,
    toggleSidebar,
    rightPanelCollapsed,
    toggleRightPanel,
    rightPanelWorkRequest,
    rightModule,
    setRightModule,
    setBrowserCdpConfig,
    setPendingEvolution,
    workerFocusView,
    subagentFocusView,
    workflowAgentFocusView,
    setShowCustomizeView,
    setEvolutionTab,
    setCloudEvolutionUpdates,
    pluginVersion
  } = useAppStore(
    useShallow((state) => ({
      currentThreadId: state.currentThreadId,
      loadThreads: state.loadThreads,
      loadDashboardAllowed: state.loadDashboardAllowed,
      loadChatScrollSettings: state.loadChatScrollSettings,
      loadModels: state.loadModels,
      dashboardAllowed: state.dashboardAllowed,
      createThread: state.createThread,
      mainView: state.mainView,
      sidebarCollapsed: state.sidebarCollapsed,
      toggleSidebar: state.toggleSidebar,
      rightPanelCollapsed: state.rightPanelCollapsed,
      toggleRightPanel: state.toggleRightPanel,
      rightPanelWorkRequest: state.rightPanelWorkRequest,
      rightModule: state.rightModule,
      setRightModule: state.setRightModule,
      setBrowserCdpConfig: state.setBrowserCdpConfig,
      setPendingEvolution: state.setPendingEvolution,
      workerFocusView: state.workerFocusView,
      subagentFocusView: state.subagentFocusView,
      workflowAgentFocusView: state.workflowAgentFocusView,
      setShowCustomizeView: state.setShowCustomizeView,
      setEvolutionTab: state.setEvolutionTab,
      setCloudEvolutionUpdates: state.setCloudEvolutionUpdates,
      pluginVersion: state.pluginVersion
    }))
  )
  const { ownedSkillKeys } = useMyUploadedSkills()

  useEffect(() => {
    ensureSkillsChangedInvalidationSource((listener) => window.api.skills.onChanged(listener))
    ensureDisabledSkillsChangedInvalidationSource((listener) =>
      window.api.hooks.onChanged(listener)
    )
  }, [])

  useEffect(() => {
    void loadModels()
    return window.api.models.onChanged(() => {
      invalidateModelCatalogCache()
      void loadModels(true)
    })
  }, [loadModels])

  const [isLoading, setIsLoading] = useState(true)
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT)
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT)
  const [browserFullscreenRightPercent, setBrowserFullscreenRightPercent] = useState(
    BROWSER_FULLSCREEN_RIGHT_DEFAULT_PERCENT
  )
  const [workerSplitLeftPercent, setWorkerSplitLeftPercent] = useState(50)
  const [previewFullscreen, setPreviewFullscreen] = useState(false)
  const [browserFullscreen, setBrowserFullscreen] = useState(false)
  const [harnessSessionThreadId, setHarnessSessionThreadId] = useState<string | null>(null)
  const [pendingGitDiffByThread, setPendingGitDiffByThread] = useState<Record<string, boolean>>({})
  const [isGitWorkspaceByThread, setIsGitWorkspaceByThread] = useState<Record<string, boolean>>({})

  // Version and local-IP metadata belong to the application lifetime, not to a
  // ChatContainer. Keeping these listeners here avoids repeating IPC requests
  // and user-info refreshes every time a thread surface remounts.
  useEffect(() => {
    const { ipcRenderer } = window.electron
    const removeVersionListener = ipcRenderer.on("version", (version: unknown) => {
      if (typeof version !== "string" || !version) return
      localStorage.setItem("version", version)
      updateMMJUserInfo()
    })
    const removeIpListener = ipcRenderer.on("ip", (ip: unknown) => {
      if (typeof ip !== "string" || !ip) return
      localStorage.setItem("localIp", ip)
    })

    void Promise.allSettled([
      ipcRenderer.invoke("get-version").then((version: unknown) => {
        if (typeof version !== "string" || !version) return
        localStorage.setItem("version", version)
        updateMMJUserInfo()
      }),
      ipcRenderer.invoke("get-local-ip").then((ip: unknown) => {
        if (typeof ip !== "string" || !ip) return
        localStorage.setItem("localIp", ip)
        updateMMJUserInfo()
      })
    ])

    return () => {
      if (typeof removeVersionListener === "function") removeVersionListener()
      if (typeof removeIpListener === "function") removeIpListener()
    }
  }, [])

  const [zoomLevel, setZoomLevel] = useState(1)
  const [bus, setBus] = useState(true)
  const workerFocusTransportRef = useRef<ElectronIPCTransport | null>(null)
  // Delay loading ClaudeCodePanel code until user opens it once.
  // After first open, keep it mounted (hidden when inactive) to preserve sessions.
  const [claudeCodeMounted, setClaudeCodeMounted] = useState(false)
  const panelToggleBaseClass =
    "group inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 text-[11px] font-medium whitespace-nowrap transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-border focus-visible:ring-offset-0 active:scale-95"
  const moduleActiveClass = "text-status-warning bg-status-warning/15 border-status-warning/45 hover:bg-status-warning/20"
  const moduleInactiveClass = "text-foreground hover:bg-muted/45"
  const sidebarToggleText = sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"
  const rightPanelToggleText = rightPanelCollapsed ? "显示右侧面板" : "隐藏右侧面板"

  // Keep the route consumed by the expensive center/right surfaces atomic. A
  // task click updates the lightweight sidebar immediately, while React may
  // finish the old surface and yield before committing the new task/mode as a
  // single unit. In particular, the center must never render task B while the
  // right panel still reads task A from the global store.
  const selectedRenderRoute = useMemo(
    () => ({
      mainView,
      threadId: currentThreadId,
      harnessSessionThreadId,
      workerFocusView,
      subagentFocusView,
      workflowAgentFocusView
    }),
    [
      currentThreadId,
      harnessSessionThreadId,
      mainView,
      subagentFocusView,
      workerFocusView,
      workflowAgentFocusView
    ]
  )
  const renderedRoute = useDeferredValue(selectedRenderRoute)
  const renderRoutePending = renderedRoute !== selectedRenderRoute
  const renderedMainView = renderedRoute.mainView
  const renderedThreadId = renderedRoute.threadId
  const renderedHarnessSessionThreadId = renderedRoute.harnessSessionThreadId
  const isRightPanelFullscreen = previewFullscreen || browserFullscreen
  const showRightResizeHandle = !previewFullscreen
  const fullscreenMainClassName = browserFullscreen
    ? "relative flex min-w-0 flex-col overflow-hidden"
    : "relative flex flex-1 min-w-0 flex-col overflow-hidden"
  const fullscreenMainStyle = browserFullscreen
    ? { flex: `${100 - browserFullscreenRightPercent} 1 0%` }
    : undefined
  const fullscreenRightPanelClassName = browserFullscreen
    ? "min-w-0"
    : isRightPanelFullscreen
      ? "min-w-0 flex-1"
      : "shrink-0 pl-0"
  const fullscreenRightPanelStyle = browserFullscreen
    ? { flex: `${browserFullscreenRightPercent} 1 0%` }
    : isRightPanelFullscreen
      ? undefined
      : { width: rightWidth }
  const isThreadWorkerFocusActive =
    renderedMainView === "thread" &&
    Boolean(
      renderedThreadId && renderedRoute.workerFocusView?.threadId === renderedThreadId
    )
  const isHarnessWorkerFocusActive =
    renderedMainView === "harness" &&
    Boolean(
      renderedHarnessSessionThreadId &&
        renderedRoute.workerFocusView?.threadId === renderedHarnessSessionThreadId
    )
  const isWorkerFocusActive = isThreadWorkerFocusActive || isHarnessWorkerFocusActive
  const isThreadSubagentFocusActive =
    renderedMainView === "thread" &&
    Boolean(
      renderedThreadId && renderedRoute.subagentFocusView?.threadId === renderedThreadId
    )
  const isHarnessSubagentFocusActive =
    renderedMainView === "harness" &&
    Boolean(
      renderedHarnessSessionThreadId &&
        renderedRoute.subagentFocusView?.threadId === renderedHarnessSessionThreadId
    )
  const isSubagentFocusActive = isThreadSubagentFocusActive || isHarnessSubagentFocusActive
  const isThreadWorkflowAgentFocusActive =
    renderedMainView === "thread" &&
    Boolean(
      renderedThreadId &&
        renderedRoute.workflowAgentFocusView?.threadId === renderedThreadId
    )
  const isHarnessWorkflowAgentFocusActive =
    renderedMainView === "harness" &&
    Boolean(
      renderedHarnessSessionThreadId &&
        renderedRoute.workflowAgentFocusView?.threadId === renderedHarnessSessionThreadId
    )
  const isWorkflowAgentFocusActive =
    isThreadWorkflowAgentFocusActive || isHarnessWorkflowAgentFocusActive
  const isAgentFocusActive =
    isWorkerFocusActive || isSubagentFocusActive || isWorkflowAgentFocusActive
  const isHarnessAgentFocusActive =
    isHarnessWorkerFocusActive || isHarnessSubagentFocusActive || isHarnessWorkflowAgentFocusActive

  useEffect(() => {
    if (!workerFocusView?.threadId || !workerFocusView.workerThreadId) return

    const threadId = workerFocusView.threadId
    const workerThreadId = workerFocusView.workerThreadId
    const focusToken =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    let cancelled = false
    const transport = new ElectronIPCTransport()
    workerFocusTransportRef.current = transport

    const unsubscribe = window.api.agent.onCoordinatorWorkerStream(threadId, (event) => {
      if (workerFocusTransportRef.current !== transport) return
      const messages = transport.convertFocusedCoordinatorWorkerIPCEvent(event, threadId)
      if (messages.length > 0) {
        useAppStore
          .getState()
          .appendWorkerFocusMessages(workerThreadId, messages, {
            orderedSnapshot:
              event.mode === "values" && (event.valuesSnapshotKind ?? "full") === "full"
          })
      }
    })

    void (async () => {
      try {
        await window.api.agent.setCoordinatorWorkerStreamFocus(threadId, workerThreadId, {
          focusToken
        })
        if (cancelled) {
          await window.api.agent.setCoordinatorWorkerStreamFocus(threadId, null, {
            expectedWorkerThreadId: workerThreadId,
            expectedFocusToken: focusToken
          })
          return
        }
        await window.api.agent.getCoordinatorWorkers(threadId)
      } catch (error) {
        console.warn("[WorkerFocusStream] Failed to bind worker stream:", error)
      }
    })()

    return () => {
      cancelled = true
      if (workerFocusTransportRef.current === transport) {
        workerFocusTransportRef.current = null
      }
      unsubscribe()
      void window.api.agent.setCoordinatorWorkerStreamFocus(threadId, null, {
        expectedWorkerThreadId: workerThreadId,
        expectedFocusToken: focusToken
      })
    }
  }, [workerFocusView?.threadId, workerFocusView?.workerThreadId])

  // NOTE: the workflow subagent tool-stream capture (subscribe + buffer + main-side
  // "viewing interest" registration) lives in WorkflowRunPanel, gated by that panel's
  // mount lifecycle — so the tap does work ONLY while a run is actually on screen.

  const initUser = () => {
    window.api.models.getUserInfo().then(user => {
        const userInfo = user || {} as UserInfoConfig
        if (userInfo.sapId) {
          const headers: Record<string, string> = {
              ystRefreshToken: userInfo.ystRefreshToken || '',
          }
          if (userInfo.ystCode) headers.ystCode = userInfo.ystCode
          fetch(`https://archguardservice.paas.${import.meta.env.VITE_LOGIN_PT}.cn/cowork/login-info`, {
              method: 'GET',
              headers
          }).then(async res => {
              const result = await res.json()
              if (result.returnCode === 'SUC0000') {
                const resBody = result.body
                setBus(true)
                await window.api.models.upsertUserInfo({
                    sapId: resBody.sapId,//8
                    ystId: resBody.ystId,//6
                    userName: resBody.userName,
                    originOrgId: resBody.originOrgId,
                    orgName: resBody.orgName,
                    pathName: resBody.pathName,
                    originPathId: resBody.originPathId,
                    ystRefreshToken: resBody.ystRefreshToken,
                    ystCode: userInfo.ystCode,
                    ystIdToken:resBody.ystIdToken,
                    ystAccessToken: resBody.ystAccessToken
                })
                await loadDashboardAllowed()
              } else if (result.returnCode === 'BIZ9000'){
                setBus(false)
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
    initUser()
  }, []);

  // Track drag start widths
  const dragStartWidths = useRef<{ left: number; right: number } | null>(null)
  const rightPanelSplitRef = useRef<HTMLDivElement>(null)
  const workerSplitRef = useRef<HTMLDivElement>(null)
  const workerSplitStartRef = useRef<{ leftPercent: number; width: number } | null>(null)
  const browserFullscreenSplitStartRef = useRef<{ rightPercent: number; width: number } | null>(
    null
  )
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
      if (browserFullscreen) {
        if (!browserFullscreenSplitStartRef.current) {
          browserFullscreenSplitStartRef.current = {
            rightPercent: browserFullscreenRightPercent,
            width: rightPanelSplitRef.current?.clientWidth || window.innerWidth
          }
        }
        const { rightPercent, width } = browserFullscreenSplitStartRef.current
        const nextPercent = rightPercent - (totalDelta / Math.max(1, width)) * 100
        setBrowserFullscreenRightPercent(
          Math.min(
            BROWSER_FULLSCREEN_MAX_PANEL_PERCENT,
            Math.max(BROWSER_FULLSCREEN_MIN_PANEL_PERCENT, nextPercent)
          )
        )
        return
      }
      if (!dragStartWidths.current) {
        dragStartWidths.current = { left: leftWidth, right: rightWidth }
      }
      const newWidth = dragStartWidths.current.right - totalDelta
      setRightWidth(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, newWidth)))
    },
    [browserFullscreen, browserFullscreenRightPercent, leftWidth, rightWidth]
  )

  const handleWorkerSplitResize = useCallback(
    (totalDelta: number) => {
      if (!workerSplitStartRef.current) {
        workerSplitStartRef.current = {
          leftPercent: workerSplitLeftPercent,
          width: workerSplitRef.current?.clientWidth || window.innerWidth
        }
      }
      const { leftPercent, width } = workerSplitStartRef.current
      const nextPercent = leftPercent + (totalDelta / Math.max(1, width)) * 100
      setWorkerSplitLeftPercent(Math.min(70, Math.max(30, nextPercent)))
    },
    [workerSplitLeftPercent]
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
    setRightModule("preview")
  }, [setRightModule])

  const selectWorkModule = useCallback(() => {
    setRightModule("work")
  }, [setRightModule])

  const selectBrowserModule = useCallback(() => {
    setRightModule("browser")
  }, [setRightModule])

  useEffect(() => {
    if (rightPanelWorkRequest?.target !== "systemConstraints") return
    setRightModule("work")
  }, [rightPanelWorkRequest, setRightModule])

  useEffect(() => {
    if (rightModule === "work") {
      handlePreviewCollapse()
      return
    }
    handlePreviewExpand()
  }, [handlePreviewCollapse, handlePreviewExpand, rightModule])

  const setThreadPendingGitDiff = useCallback((threadId: string, pending: boolean) => {
    setPendingGitDiffByThread((prev) => {
      if (prev[threadId] === pending) return prev
      return { ...prev, [threadId]: pending }
    })
  }, [])

  const handleThreadGitStatusChange = useCallback((threadId: string, isGit: boolean) => {
    setIsGitWorkspaceByThread((prev) => {
      if (prev[threadId] === isGit) return prev
      return { ...prev, [threadId]: isGit }
    })
  }, [])

  const handleHarnessActiveSessionThreadChange = useCallback((threadId: string | null) => {
    setHarnessSessionThreadId((prev) => (prev === threadId ? prev : threadId))
  }, [])

  const activeRightPanelThreadId =
    mainView === "harness" ? harnessSessionThreadId : currentThreadId
  const renderedRightPanelThreadId =
    renderedMainView === "harness"
      ? renderedHarnessSessionThreadId
      : renderedThreadId
  const isActiveRightPanelThreadGit = activeRightPanelThreadId
    ? Boolean(isGitWorkspaceByThread[activeRightPanelThreadId])
    : false
  const hasPendingGitDiff = activeRightPanelThreadId
    ? Boolean(pendingGitDiffByThread[activeRightPanelThreadId] && isActiveRightPanelThreadGit)
    : false
  const renderedHasPendingGitDiff = renderedRightPanelThreadId
    ? Boolean(
        pendingGitDiffByThread[renderedRightPanelThreadId] &&
          isGitWorkspaceByThread[renderedRightPanelThreadId]
      )
    : false
  const showRightPanelModuleControls =
    mainView === "thread" || (mainView === "harness" && Boolean(harnessSessionThreadId))

  useBrowserViewLifecycle({
    currentThreadId,
    harnessSessionThreadId,
    mainView,
    rightPanelCollapsed,
    isAgentFocusActive
  })

  const selectGitModule = useCallback(() => {
    if (activeRightPanelThreadId) {
      setThreadPendingGitDiff(activeRightPanelThreadId, false)
    }
    setRightModule("git")
  }, [activeRightPanelThreadId, setRightModule, setThreadPendingGitDiff])

  const dismissGitChangeNotice = useCallback(() => {
    if (!activeRightPanelThreadId) return
    setThreadPendingGitDiff(activeRightPanelThreadId, false)
  }, [activeRightPanelThreadId, setThreadPendingGitDiff])

  const rightModuleRef = useRef(rightModule)
  const previousActiveRightPanelThreadIdRef = useRef<string | null>(activeRightPanelThreadId)
  const previousMainViewRef = useRef(mainView)
  rightModuleRef.current = rightModule

  useEffect(() => {
    const previousActiveRightPanelThreadId = previousActiveRightPanelThreadIdRef.current
    const previousMainView = previousMainViewRef.current
    previousActiveRightPanelThreadIdRef.current = activeRightPanelThreadId
    previousMainViewRef.current = mainView

    const shouldPreserveCurrentModule =
      rightModuleRef.current === "browser" &&
      (mainView === "thread" || mainView === "harness") &&
      previousMainView === mainView &&
      Boolean(previousActiveRightPanelThreadId) &&
      Boolean(activeRightPanelThreadId) &&
      previousActiveRightPanelThreadId !== activeRightPanelThreadId

    if (!shouldPreserveCurrentModule) {
      // Keep right panel behavior predictable when entering thread-like views and for
      // non-browser module switches between threads.
      setRightModule("work")
    }

    try {
      // 主应用已经处于打开/查看状态，清空宠物完成任务提醒队列。
      window.api.pet.clearCompletedTasks()
    } catch (error) {
      console.warn("[App] Failed to clear pet completed tasks:", error)
    }

  }, [activeRightPanelThreadId, mainView, setRightModule])

  useEffect(() => {
    if (mainView !== "harness") {
      setHarnessSessionThreadId(null)
    }
  }, [mainView])

  useEffect(() => {
    if (mainView !== "harness" || !workerFocusView?.threadId) return
    if (!harnessSessionThreadId || workerFocusView.threadId !== harnessSessionThreadId) {
      useAppStore.getState().closeWorkerFocusView()
    }
  }, [harnessSessionThreadId, mainView, workerFocusView?.threadId])

  useEffect(() => {
    if (mainView !== "harness" || !subagentFocusView?.threadId) return
    if (!harnessSessionThreadId || subagentFocusView.threadId !== harnessSessionThreadId) {
      useAppStore.getState().closeSubagentFocusView()
    }
  }, [harnessSessionThreadId, mainView, subagentFocusView?.threadId])

  // Same harness-session drop guard for the workflow-agent focus (parity with worker/subagent
  // above): switching the harness board to a different session/project must not leave a stale
  // workflowAgentFocusView that re-opens the old tool-stream panel when you return to this session.
  useEffect(() => {
    if (mainView !== "harness" || !workflowAgentFocusView?.threadId) return
    if (!harnessSessionThreadId || workflowAgentFocusView.threadId !== harnessSessionThreadId) {
      useAppStore.getState().closeWorkflowAgentFocusView()
    }
  }, [harnessSessionThreadId, mainView, workflowAgentFocusView?.threadId])

  useEffect(() => {
    if (mainView === "claudecode") {
      setClaudeCodeMounted(true)
    }
  }, [mainView])

  useEffect(() => {
    const cleanupFs = window.api.workspace.onFilesChanged((data) => {
      // One physical-workspace event can affect many tasks. Fold every badge
      // update into one React state transaction; ThreadProvider owns the one
      // shared file-tree invalidation/scan.
      setPendingGitDiffByThread((previous) => {
        let next = previous
        for (const threadId of data.threadIds) {
          // Keep current behavior: when the user is already viewing this task's
          // Git panel, do not raise a redundant notice for it.
          if (rightModule === "git" && threadId === activeRightPanelThreadId) continue
          if (previous[threadId] === true) continue
          if (next === previous) next = { ...previous }
          next[threadId] = true
        }
        return next
      })
    })

    return cleanupFs
  }, [activeRightPanelThreadId, rightModule])

  // Reset drag start on mouse up
  useEffect(() => {
    const handleMouseUp = (): void => {
      dragStartWidths.current = null
      workerSplitStartRef.current = null
      browserFullscreenSplitStartRef.current = null
    }
    document.addEventListener("mouseup", handleMouseUp)
    return () => document.removeEventListener("mouseup", handleMouseUp)
  }, [])

  useEffect(() => {
    async function init(): Promise<void> {
      try {
        await migrateDisabledSkillsFromLocalStorage()
        const [, , loadedBrowserCdpConfig] = await Promise.all([
          loadThreads(),
          loadDashboardAllowed(),
          window.api.browser.getCdpConfig().catch((error: unknown) => {
            console.error("Failed to load Browser CDP config during initialization:", error)
            return DEFAULT_BROWSER_CDP_CONFIG
          })
        ])
        setBrowserCdpConfig(loadedBrowserCdpConfig)
        const threads = useAppStore.getState().threads
        if (threads.length === 0) {
          await createThread()
        }
        void loadChatScrollSettings()
      } catch (error) {
        console.error("Failed to initialize:", error)
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, [loadThreads,setBrowserCdpConfig, loadDashboardAllowed, loadChatScrollSettings, createThread])

  useEffect(() => {
    let cancelled = false

    const checkOptimizedSkillUpdates = async (): Promise<void> => {
      try {
        const installedSkills = (await revalidateSkillCatalog(pluginVersion)).localSkills
        const updates = await evolutionApi.listAvailableUpdates(installedSkills)
        if (cancelled) return

        setCloudEvolutionUpdates(updates)
        setPendingEvolution(hasUnreadCloudEvolutionUpdates(updates))

        const pendingUpdates = pendingCloudEvolutionUpdates(updates)
        if (pendingUpdates.length === 0) return

        const signature = cloudEvolutionUpdateSignature(pendingUpdates)
        if (!signature || signature === getCloudEvolutionPromptSignature()) return
        setCloudEvolutionPromptSignature(signature)

        const updateItem = pendingUpdates[0]
        const message =
          pendingUpdates.length === 1
            ? `「${updateItem.skill_name}」有云端自进化版本可用`
            : `有 ${pendingUpdates.length} 个云端自进化版本可用`
        toast.info(message, {
          duration: 8000,
          action: {
            label: "查看候选",
            onClick: () => {
              markCloudEvolutionUpdatesSeen(pendingUpdates)
              setPendingEvolution(false)
              setEvolutionTab("candidates")
              setShowCustomizeView(true, "evolution")
            }
          }
        })
      } catch (error) {
        console.warn("[SkillUpdatePrompt] failed to check optimized skill updates:", error)
      }
    }

    void checkOptimizedSkillUpdates()
    const timer = window.setInterval(() => void checkOptimizedSkillUpdates(), 30 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [
    pluginVersion,
    setCloudEvolutionUpdates,
    setEvolutionTab,
    setPendingEvolution,
    setShowCustomizeView
  ])

  // 「待审批发布」提醒：本分支把进化审批权限放开给个人后，技能创建者需要被
  // 提醒自己上传的技能跑出了优化候选、正等待其审批发布。仅面向个人，管理员不在此提醒范围内。
  useEffect(() => {
    let cancelled = false

    const checkPendingReviewCandidates = async (): Promise<void> => {
      try {
        // 个人只有上传过技能才可能拥有可审批候选；无技能时直接跳过拉取。
        if (ownedSkillKeys.size === 0) return

        const awaiting = await evolutionApi.listCandidates("awaiting_review", 50)
        if (cancelled) return

        const reviewable = reviewableCandidates(awaiting, ownedSkillKeys)
        // 只对「从未通知过」的新候选提醒，保证每条候选只发一次。
        const fresh = unnotifiedReviewCandidates(reviewable)
        if (fresh.length === 0) return
        markReviewCandidatesNotified(fresh)

        setPendingEvolution(true)

        const first = fresh[0]
        const message =
          fresh.length === 1
            ? `「${first.skill_name}」有 Skill 优化候选待审批发布`
            : `有 ${fresh.length} 个 Skill 优化候选待审批发布`
        toast.info(message, {
          duration: 8000,
          action: {
            label: "去审批",
            onClick: () => {
              setEvolutionTab("review")
              setShowCustomizeView(true, "evolution")
            }
          }
        })
      } catch (error) {
        console.warn("[SkillReviewPrompt] failed to check pending review candidates:", error)
      }
    }

    void checkPendingReviewCandidates()
    const timer = window.setInterval(() => void checkPendingReviewCandidates(), 30 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [ownedSkillKeys, setEvolutionTab, setPendingEvolution, setShowCustomizeView])

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
        await useAppStore.getState().loadThreads()
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
        await useAppStore.getState().loadThreads()
        window.api.pet.clearCompletedTasks()
      } catch {
        // ignore
      }
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [])

  if (isLoading) {
    return (
      <>
        <div className="flex h-screen items-center justify-center bg-background">
          <div className="text-muted-foreground">Initializing...</div>
        </div>
      </>
    )
  }

  if(!bus){
    return (
      <>
        <div className="flex h-screen items-center justify-center bg-background">
          <div className="text-muted-foreground">目前仅供零售客户经营开发团队使用，暂不对外提供服务...,有任何疑问请联系 范雄</div>
        </div>
      </>
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
            {mainView !== "customize" && !isAgentFocusActive && (
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
            {showRightPanelModuleControls && !isAgentFocusActive && (
              <>
                <button
                  type="button"
                  className={`${panelToggleBaseClass} ${
                    rightModule === "preview"
                      ? moduleActiveClass
                      : moduleInactiveClass
                  }`}
                  onClick={selectPreviewModule}
                  title="文件预览"
                  aria-label="文件预览"
                  aria-pressed={rightModule === "preview"}
                >
                  <Eye size={16} className="shrink-0" strokeWidth={1.8} />
                  <span>文件预览</span>
                </button>
                <button
                  type="button"
                  className={`${panelToggleBaseClass} ${
                    rightModule === "git"
                      ? moduleActiveClass
                      : hasPendingGitDiff
                        ? "text-foreground border-status-warning/40 hover:bg-muted/45"
                        : moduleInactiveClass
                  }`}
                  onClick={selectGitModule}
                  title="Git 面板"
                  aria-label="Git 面板"
                  aria-pressed={rightModule === "git"}
                >
                  <GitBranch size={16} className="shrink-0" strokeWidth={1.8} />
                  <span>Git 面板</span>
                </button>
                <button
                  type="button"
                  className={`${panelToggleBaseClass} ${
                    rightModule === "browser"
                      ? moduleActiveClass
                      : moduleInactiveClass
                  }`}
                  onClick={selectBrowserModule}
                  title="内置浏览器"
                  aria-label="内置浏览器"
                  aria-pressed={rightModule === "browser"}
                >
                  <Globe2 size={16} className="shrink-0" strokeWidth={1.8} />
                  <span>浏览器</span>
                </button>
                <button
                  type="button"
                  className={`${panelToggleBaseClass} ${
                    rightModule === "work"
                      ? moduleActiveClass
                      : moduleInactiveClass
                  }`}
                  onClick={selectWorkModule}
                  title="工作目录"
                  aria-label="工作目录"
                  aria-pressed={rightModule === "work"}
                >
                  <Briefcase size={16} className="shrink-0" strokeWidth={1.8} />
                  <span>工作目录</span>
                </button>
              </>
            )}
            {mainView !== "customize" && !isAgentFocusActive && (
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

        {/*
          Main content below titlebar. The lightweight sidebar remains above the
          transition shield so rapid A -> B -> C navigation can supersede stale
          hydration; stale center/right controls cannot mutate the previous task.
        */}
        <div
          className="relative flex min-h-0 flex-1 overflow-hidden"
          aria-busy={renderRoutePending}
          onKeyDownCapture={(event) => {
            if (!renderRoutePending) return
            const target = event.target
            if (target instanceof Element && target.closest("[data-app-route-control]")) return
            event.preventDefault()
            event.stopPropagation()
          }}
        >
        {renderedMainView === "customize" ? (
          <div className="flex flex-1 overflow-hidden bg-grid-subtle">
            <main className="flex flex-1 flex-col min-w-0 overflow-hidden">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}>
                <CustomizeView />
              </Suspense>
            </main>
          </div>
        ) : renderedMainView !== "claudecode" &&
          renderedMainView !== "dashboard" &&
          renderedMainView !== "harness" ? (
          <div
            ref={rightPanelSplitRef}
            className="relative flex flex-1 overflow-hidden bg-grid-subtle"
          >
            {/* Left Sidebar */}
            {!sidebarCollapsed && !isAgentFocusActive && (
              <AnimatedThreadSidebar
                hidden={browserFullscreen}
                width={leftWidth}
                onResize={handleLeftResize}
              />
            )}

            {renderedMainView === "kanban" ? (
              <main className="relative flex flex-1 flex-col min-w-0 overflow-hidden">
                <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}>
                  <KanbanView />
                </Suspense>
              </main>
            ) : (
              <>
                {/* Center - Content Panel */}
                {isAgentFocusActive ? (
                  <main
                    ref={workerSplitRef}
                    className="relative flex flex-1 min-w-0 overflow-hidden bg-grid-subtle"
                  >
                    <section
                      className="flex min-w-0 flex-col overflow-hidden"
                      style={{ width: `${workerSplitLeftPercent}%` }}
                    >
                      {renderedThreadId ? (
                        <TabbedPanel
                          threadId={renderedThreadId}
                          showTabBar={false}
                          hasPendingGitDiffNotice={renderedHasPendingGitDiff && rightModule !== "git"}
                          onRequestOpenGitPanel={selectGitModule}
                          onDismissGitChangeNotice={dismissGitChangeNotice}
                          onThreadGitStatusChange={handleThreadGitStatusChange}
                        />
                      ) : (
                        <div className="flex flex-1 items-center justify-center text-muted-foreground">
                          选择或创建一个任务开始
                        </div>
                      )}
                    </section>
                    <WorkerSplitHandle onDrag={handleWorkerSplitResize} />
                    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      {isWorkflowAgentFocusActive ? (
                        <WorkflowAgentStreamPanel />
                      ) : isWorkerFocusActive ? (
                        <WorkerStreamPanel />
                      ) : (
                        <SubagentStreamPanel />
                      )}
                    </section>
                  </main>
                ) : !previewFullscreen && (
                  <main className={fullscreenMainClassName} style={fullscreenMainStyle}>
                    {renderedThreadId ? (
                      <TabbedPanel
                        threadId={renderedThreadId}
                        showTabBar={false}
                        hasPendingGitDiffNotice={renderedHasPendingGitDiff && rightModule !== "git"}
                        onRequestOpenGitPanel={selectGitModule}
                        onDismissGitChangeNotice={dismissGitChangeNotice}
                        onThreadGitStatusChange={handleThreadGitStatusChange}
                      />
                    ) : (
                      <div className="flex flex-1 items-center justify-center text-muted-foreground">
                        选择或创建一个任务开始
                      </div>
                    )}
                  </main>
                )}
              </>
            )}

            {renderedMainView === "thread" && !rightPanelCollapsed && !isAgentFocusActive && (
              <>
                {showRightResizeHandle && <ResizeHandle onDrag={handleRightResize} />}
                {/* Right Panel - floating style */}
                <div
                  style={fullscreenRightPanelStyle}
                  className={fullscreenRightPanelClassName}
                >
                  <RightPanel
                    threadId={renderedThreadId}
                    moduleMode={rightModule}
                    onRequestPreviewMode={selectPreviewModule}
                    onRequestWorkMode={selectWorkModule}
                    onRequestBrowserMode={selectBrowserModule}
                    onPreviewFullscreenChange={setPreviewFullscreen}
                    onBrowserFullscreenChange={setBrowserFullscreen}
                  />
                </div>
              </>
            )}
          </div>
        ) : null}

        {/* Dashboard 面板 */}
        {renderedMainView === "dashboard" && dashboardAllowed === true && (
          <div className="relative flex flex-1 overflow-hidden bg-grid-subtle">
            {!sidebarCollapsed && (
              <>
                <div
                  data-app-route-control
                  style={{ width: leftWidth }}
                  className="relative z-[60] shrink-0"
                >
                  <ThreadSidebar />
                </div>
                <ResizeHandle onDrag={handleLeftResize} />
              </>
            )}
            <main className="relative flex flex-1 flex-col min-w-0 overflow-hidden">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}>
                <DashboardView />
              </Suspense>
            </main>
          </div>
        )}

        {/* Harness Board 面板 */}
        {renderedMainView === "harness" && (
          <div
            ref={isHarnessAgentFocusActive ? workerSplitRef : rightPanelSplitRef}
            className="relative flex flex-1 overflow-hidden bg-grid-subtle"
          >
            {!sidebarCollapsed && !isHarnessAgentFocusActive && (
              <AnimatedThreadSidebar
                hidden={browserFullscreen}
                width={leftWidth}
                onResize={handleLeftResize}
              />
            )}
            <main
              key="harness-main"
              style={
                isHarnessAgentFocusActive
                  ? { width: `${workerSplitLeftPercent}%` }
                  : fullscreenMainStyle
              }
              className={
                previewFullscreen && renderedHarnessSessionThreadId && !rightPanelCollapsed && !isHarnessAgentFocusActive
                  ? "hidden"
                  : isHarnessAgentFocusActive
                    ? "relative flex min-w-0 flex-col overflow-hidden"
                    : fullscreenMainClassName
              }
            >
              <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}>
                <HarnessBoardView
                  hasPendingGitDiffNotice={renderedHasPendingGitDiff && rightModule !== "git"}
                  onRequestOpenGitPanel={selectGitModule}
                  onDismissGitChangeNotice={dismissGitChangeNotice}
                  onThreadGitStatusChange={handleThreadGitStatusChange}
                  onActiveSessionThreadChange={handleHarnessActiveSessionThreadChange}
                />
              </Suspense>
            </main>
            {isHarnessAgentFocusActive && (
              <>
                <WorkerSplitHandle onDrag={handleWorkerSplitResize} />
                <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  {isHarnessWorkflowAgentFocusActive ? (
                    <WorkflowAgentStreamPanel />
                  ) : isHarnessWorkerFocusActive ? (
                    <WorkerStreamPanel />
                  ) : (
                    <SubagentStreamPanel />
                  )}
                </section>
              </>
            )}
            {renderedHarnessSessionThreadId && !rightPanelCollapsed && !isHarnessAgentFocusActive && (
              <>
                {showRightResizeHandle && <ResizeHandle onDrag={handleRightResize} />}
                <div
                  style={fullscreenRightPanelStyle}
                  className={fullscreenRightPanelClassName}
                >
                  <RightPanel
                    threadId={renderedHarnessSessionThreadId}
                    moduleMode={rightModule}
                    showSystemConstraints={renderedMainView === "harness"}
                    onRequestPreviewMode={selectPreviewModule}
                    onRequestWorkMode={selectWorkModule}
                    onRequestBrowserMode={selectBrowserModule}
                    onPreviewFullscreenChange={setPreviewFullscreen}
                    onBrowserFullscreenChange={setBrowserFullscreen}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* Claude Code 面板：首次进入时再加载代码；之后保持挂载，切换视图时仅隐藏。 */}
        {(claudeCodeMounted || renderedMainView === "claudecode") && (
          <div className={renderedMainView === "claudecode" ? "relative flex flex-1 overflow-hidden bg-grid-subtle" : "hidden"}>
            {/* claudecode 模式下也显示侧边栏 */}
            {renderedMainView === "claudecode" && !sidebarCollapsed && (
              <>
                <div
                  data-app-route-control
                  style={{ width: leftWidth }}
                  className="relative z-[60] shrink-0"
                >
                  <ThreadSidebar />
                </div>
                <ResizeHandle onDrag={handleLeftResize} />
              </>
            )}
            <main className="relative flex flex-1 flex-col min-w-0 overflow-hidden">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}>
                <ClaudeCodePanel visible={renderedMainView === "claudecode"} />
              </Suspense>
            </main>
          </div>
        )}
        {renderRoutePending && (
          <div
            className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-background/20 backdrop-blur-[1px]"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/90 px-3 py-2 text-xs text-muted-foreground shadow-sm">
              <Loader2 className="size-3.5 animate-spin" />
              正在切换任务…
            </div>
          </div>
        )}
        </div>
      </div>
      <PetStateBridge />
      <Toaster position="top-center" richColors duration={2200} />
    </ThreadProvider>
  )
}

export default App
