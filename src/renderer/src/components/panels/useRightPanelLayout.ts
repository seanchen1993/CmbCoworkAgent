import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { CSSProperties, RefObject } from "react"
import type { RightModule } from "@/lib/store"

const RIGHT_MIN = 250
const RIGHT_MAX = 1600
const RIGHT_DEFAULT = 300
const RIGHT_PREVIEW_EXPAND_VW = 0.35
const BROWSER_DEFAULT_WIDTH = "50%"
const BROWSER_FULLSCREEN_RIGHT_DEFAULT_PERCENT = 66.67
const BROWSER_FULLSCREEN_MIN_PANEL_PERCENT = 20
const BROWSER_FULLSCREEN_MAX_PANEL_PERCENT = 80

interface UseRightPanelLayoutOptions {
  rightModule: RightModule
}

interface RightPanelLayout {
  rightPanelSplitRef: RefObject<HTMLDivElement | null>
  rightPanelMainRef: RefObject<HTMLElement | null>
  rightPanelContainerRef: RefObject<HTMLDivElement | null>
  previewFullscreen: boolean
  browserFullscreen: boolean
  showRightResizeHandle: boolean
  mainClassName: string
  mainStyle?: CSSProperties
  panelClassName: string
  panelStyle?: CSSProperties
  handleRightResizeStart: () => void
  handleRightResize: (totalDelta: number) => void
  handleRightResizeEnd: () => void
  setPreviewFullscreen: (isFullscreen: boolean) => void
  setBrowserFullscreen: (isFullscreen: boolean) => void
}

export function useRightPanelLayout({ rightModule }: UseRightPanelLayoutOptions): RightPanelLayout {
  const rightPanelSplitRef = useRef<HTMLDivElement>(null)
  const rightPanelMainRef = useRef<HTMLElement>(null)
  const rightPanelContainerRef = useRef<HTMLDivElement>(null)
  const rightDragStartRef = useRef<number | null>(null)
  const browserFullscreenSplitStartRef = useRef<{ rightPercent: number; width: number } | null>(
    null
  )
  const previewCollapsedWidthRef = useRef<number | null>(null)

  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT)
  const [browserRightWidth, setBrowserRightWidth] = useState<number | null>(null)
  const [browserFullscreenRightPercent, setBrowserFullscreenRightPercent] = useState(
    BROWSER_FULLSCREEN_RIGHT_DEFAULT_PERCENT
  )
  const rightWidthRef = useRef(rightWidth)
  const browserRightWidthRef = useRef(browserRightWidth)
  const browserFullscreenRightPercentRef = useRef(browserFullscreenRightPercent)
  const [previewFullscreen, setPreviewFullscreen] = useState(false)
  const [browserFullscreen, setBrowserFullscreen] = useState(false)

  const isFullscreen = previewFullscreen || browserFullscreen
  const showRightResizeHandle = !previewFullscreen
  const mainClassName = browserFullscreen
    ? "relative flex min-w-0 flex-col overflow-hidden"
    : "relative flex flex-1 min-w-0 flex-col overflow-hidden"
  const mainStyle = browserFullscreen
    ? { flex: `${100 - browserFullscreenRightPercent} 1 0%` }
    : undefined
  const panelClassName = browserFullscreen
    ? "min-w-0"
    : isFullscreen
      ? "min-w-0 flex-1"
      : "shrink-0 pl-0"
  const panelStyle = browserFullscreen
    ? { flex: `${browserFullscreenRightPercent} 1 0%` }
    : isFullscreen
      ? undefined
      : {
          width:
            rightModule === "browser" ? (browserRightWidth ?? BROWSER_DEFAULT_WIDTH) : rightWidth
        }

  const applyNormalPanelWidth = useCallback((width: number | string) => {
    const panel = rightPanelContainerRef.current
    if (panel) panel.style.width = typeof width === "number" ? `${width}px` : width
  }, [])

  const applyBrowserFullscreenSplit = useCallback((rightPercent: number) => {
    const main = rightPanelMainRef.current
    const panel = rightPanelContainerRef.current
    if (main) main.style.flex = `${100 - rightPercent} 1 0%`
    if (panel) panel.style.flex = `${rightPercent} 1 0%`
  }, [])

  const handleRightResizeStart = useCallback(() => {
    rightDragStartRef.current = null
    browserFullscreenSplitStartRef.current = null
  }, [])

  const handleRightResizeEnd = useCallback(() => {
    if (browserFullscreen) {
      setBrowserFullscreenRightPercent(browserFullscreenRightPercentRef.current)
    } else if (rightModule === "browser") {
      setBrowserRightWidth(browserRightWidthRef.current)
    } else {
      setRightWidth(rightWidthRef.current)
    }
  }, [browserFullscreen, rightModule])

  const handleRightResize = useCallback(
    (totalDelta: number) => {
      if (browserFullscreen) {
        if (!browserFullscreenSplitStartRef.current) {
          browserFullscreenSplitStartRef.current = {
            rightPercent: browserFullscreenRightPercentRef.current,
            width: rightPanelSplitRef.current?.clientWidth || window.innerWidth
          }
        }
        const { rightPercent, width } = browserFullscreenSplitStartRef.current
        const nextPercent = rightPercent - (totalDelta / Math.max(1, width)) * 100
        const boundedPercent = Math.min(
          BROWSER_FULLSCREEN_MAX_PANEL_PERCENT,
          Math.max(BROWSER_FULLSCREEN_MIN_PANEL_PERCENT, nextPercent)
        )
        browserFullscreenRightPercentRef.current = boundedPercent
        applyBrowserFullscreenSplit(boundedPercent)
        return
      }

      if (rightDragStartRef.current === null) {
        rightDragStartRef.current =
          rightModule === "browser"
            ? (browserRightWidthRef.current ??
              (rightPanelSplitRef.current?.clientWidth || window.innerWidth) * 0.5)
            : rightWidthRef.current
      }
      const nextWidth = Math.min(
        RIGHT_MAX,
        Math.max(RIGHT_MIN, rightDragStartRef.current - totalDelta)
      )
      if (rightModule === "browser") {
        browserRightWidthRef.current = nextWidth
      } else {
        rightWidthRef.current = nextWidth
      }
      applyNormalPanelWidth(nextWidth)
    },
    [applyBrowserFullscreenSplit, applyNormalPanelWidth, browserFullscreen, rightModule]
  )

  const handlePreviewExpand = useCallback(() => {
    const previousWidth = rightWidthRef.current
    if (previewCollapsedWidthRef.current === null) {
      previewCollapsedWidthRef.current = previousWidth
    }
    const target = Math.round(window.innerWidth * RIGHT_PREVIEW_EXPAND_VW)
    rightWidthRef.current = Math.min(RIGHT_MAX, Math.max(previousWidth, target))
    applyNormalPanelWidth(rightWidthRef.current)
    setRightWidth(rightWidthRef.current)
  }, [applyNormalPanelWidth])

  const handlePreviewCollapse = useCallback(() => {
    if (previewCollapsedWidthRef.current === null) return
    rightWidthRef.current = previewCollapsedWidthRef.current
    applyNormalPanelWidth(rightWidthRef.current)
    setRightWidth(rightWidthRef.current)
    previewCollapsedWidthRef.current = null
  }, [applyNormalPanelWidth])

  useLayoutEffect(() => {
    if (rightModule === "work") {
      handlePreviewCollapse()
      return
    }
    if (rightModule === "browser") {
      applyNormalPanelWidth(browserRightWidthRef.current ?? BROWSER_DEFAULT_WIDTH)
      return
    }
    handlePreviewExpand()
  }, [applyNormalPanelWidth, handlePreviewCollapse, handlePreviewExpand, rightModule])

  useEffect(() => {
    const handleMouseUp = (): void => {
      rightDragStartRef.current = null
      browserFullscreenSplitStartRef.current = null
    }
    const handleWindowBlur = (): void => handleMouseUp()
    document.addEventListener("mouseup", handleMouseUp)
    window.addEventListener("blur", handleWindowBlur)
    return () => {
      document.removeEventListener("mouseup", handleMouseUp)
      window.removeEventListener("blur", handleWindowBlur)
    }
  }, [])

  return {
    rightPanelSplitRef,
    rightPanelMainRef,
    rightPanelContainerRef,
    previewFullscreen,
    browserFullscreen,
    showRightResizeHandle,
    mainClassName,
    mainStyle,
    panelClassName,
    panelStyle,
    handleRightResizeStart,
    handleRightResize,
    handleRightResizeEnd,
    setPreviewFullscreen,
    setBrowserFullscreen
  }
}
