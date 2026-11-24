import { type RefObject, useCallback, useRef, useState } from "react"
import type { BrowserDeviceSize, BrowserDeviceViewport } from "../../../../shared/browser-types"
import type { BrowserDeviceSettings } from "./BrowserDeviceToolbar"

const DEVICE_PREVIEW_PADDING = 12

export interface BrowserDevicePreviewLayout {
  displayHeight: number
  displayLeft: number
  displayTop: number
  displayWidth: number
  metrics: BrowserDeviceViewport | null
}

export function useBrowserDevicePreview(onClose: () => void): {
  deviceFrameRef: RefObject<HTMLDivElement | null>
  applyViewport: (viewport: BrowserDeviceSize | undefined) => void
  getLayout: (rect: DOMRect) => BrowserDevicePreviewLayout
  getRecordingViewport: () => BrowserDeviceSize | undefined
  reset: () => void
  scale: number
  settings: BrowserDeviceSettings
  updateSettings: (settings: BrowserDeviceSettings) => void
} {
  const deviceFrameRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<BrowserDeviceSettings>({ open: false, width: 0, height: 0 })
  const lastDeviceFrameRef = useRef("")
  const lastDevicePreviewOpenRef = useRef(false)
  const lastViewportSizeRef = useRef<{ width: number; height: number } | null>(null)
  const scaleRef = useRef(1)
  const [settings, setSettings] = useState<BrowserDeviceSettings>({
    open: false,
    width: 0,
    height: 0
  })
  const [scale, setScale] = useState(1)

  const updateSettings = useCallback(
    (nextSettings: BrowserDeviceSettings) => {
      const closing = settingsRef.current.open && !nextSettings.open
      settingsRef.current = nextSettings
      setSettings(nextSettings)
      if (closing) onClose()
    },
    [onClose]
  )

  const applyViewport = useCallback((viewport: BrowserDeviceSize | undefined) => {
    if (!viewport) return
    const current = settingsRef.current
    const nextSettings =
      current.open &&
      current.width === viewport.width &&
      current.height === viewport.height &&
      current.scale === undefined
        ? current
        : { open: true, ...viewport, scale: undefined }
    // syncBounds can run before React commits the state update. Keep the
    // imperative layout source current so a visible toolbar and BrowserView
    // metrics cannot temporarily disagree.
    settingsRef.current = nextSettings
    setSettings(nextSettings)
  }, [])

  const reset = useCallback(() => {
    scaleRef.current = 1
    settingsRef.current = { open: false, width: 0, height: 0 }
    setScale(1)
    setSettings(settingsRef.current)
  }, [])

  const getLayout = useCallback((rect: DOMRect): BrowserDevicePreviewLayout => {
    const device = settingsRef.current
    const devicePreviewWasOpen = lastDevicePreviewOpenRef.current
    lastDevicePreviewOpenRef.current = device.open
    const previousViewportSize = lastViewportSizeRef.current
    const viewportSizeChanged = Boolean(
      previousViewportSize &&
      (Math.abs(previousViewportSize.width - rect.width) >= 1 ||
        Math.abs(previousViewportSize.height - rect.height) >= 1)
    )
    lastViewportSizeRef.current = { width: rect.width, height: rect.height }
    if (devicePreviewWasOpen && viewportSizeChanged && device.scale !== undefined) {
      const nextSettings = { ...device, scale: undefined }
      settingsRef.current = nextSettings
      setSettings(nextSettings)
    }

    const availableWidth = Math.max(0, rect.width - (device.open ? DEVICE_PREVIEW_PADDING * 2 : 0))
    const availableHeight = Math.max(
      0,
      rect.height - (device.open ? DEVICE_PREVIEW_PADDING * 2 : 0)
    )
    const deviceWidth = device.width || availableWidth
    const deviceHeight = device.height || availableHeight
    const calculatedScale =
      device.open && deviceWidth > 0 && deviceHeight > 0
        ? Math.min(1, availableWidth / deviceWidth, availableHeight / deviceHeight)
        : 1
    const nextScale =
      device.scale !== undefined && !viewportSizeChanged ? device.scale : calculatedScale
    if (Math.abs(scaleRef.current - nextScale) >= 0.001) {
      scaleRef.current = nextScale
      setScale(nextScale)
    }

    const displayWidth = device.open ? deviceWidth * nextScale : rect.width
    const displayHeight = device.open ? deviceHeight * nextScale : rect.height
    const displayLeft = rect.left + (rect.width - displayWidth) / 2
    const displayTop = rect.top + (rect.height - displayHeight) / 2
    const frameKey = `${displayWidth}:${displayHeight}:${device.open}`
    if (deviceFrameRef.current && lastDeviceFrameRef.current !== frameKey) {
      lastDeviceFrameRef.current = frameKey
      deviceFrameRef.current.style.width = `${displayWidth}px`
      deviceFrameRef.current.style.height = `${displayHeight}px`
      deviceFrameRef.current.style.opacity = device.open ? "1" : "0"
    }

    return {
      displayHeight,
      displayLeft,
      displayTop,
      displayWidth,
      metrics:
        device.open && (device.width > 0 || device.height > 0)
          ? { width: deviceWidth, height: deviceHeight, scale: nextScale }
          : null
    }
  }, [])

  const getRecordingViewport = useCallback(() => {
    const device = settingsRef.current
    return device.open && device.width > 0 && device.height > 0
      ? { width: device.width, height: device.height }
      : undefined
  }, [])

  return {
    deviceFrameRef,
    applyViewport,
    getLayout,
    getRecordingViewport,
    reset,
    scale,
    settings,
    updateSettings
  }
}
