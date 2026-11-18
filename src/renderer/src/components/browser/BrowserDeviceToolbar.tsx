import { type ReactNode } from "react"
import { Smartphone } from "lucide-react"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"

const DEVICE_VIEWPORTS = [
  { label: "响应式", width: 0, height: 0 },
  { label: "手机 · 375 × 667", width: 375, height: 667 },
  { label: "手机 · 390 × 844", width: 390, height: 844 },
  { label: "平板 · 768 × 1024", width: 768, height: 1024 },
  { label: "桌面 · 1280 × 720", width: 1280, height: 720 },
  { label: "桌面 · 1920 × 1080", width: 1920, height: 1080 }
] as const

export interface BrowserDeviceSettings {
  open: boolean
  width: number
  height: number
  scale?: number
}

interface BrowserDeviceToolbarProps {
  onSettingsChange: (settings: BrowserDeviceSettings) => void
  scale: number
  settings: BrowserDeviceSettings
  children: (toggle: ReactNode) => ReactNode
}

const TOOLBAR_BUTTON_CLASSNAME = "size-8 shrink-0 rounded-md transition-colors hover:bg-muted"

export function BrowserDeviceToolbar({
  onSettingsChange,
  scale,
  settings,
  children
}: BrowserDeviceToolbarProps): React.JSX.Element {
  const { open, width, height } = settings
  const preset = DEVICE_VIEWPORTS.some((item) => item.width === width && item.height === height)
    ? `${width}x${height}`
    : "0x0"
  const updateViewport = (nextViewport: { width: number; height: number }): void =>
    onSettingsChange({ open, ...nextViewport })

  return (
    <>
      {children(
        <IconPopoverButton
          className={TOOLBAR_BUTTON_CLASSNAME}
          icon={<Smartphone className="size-4" strokeWidth={1.8} />}
          popoverContent="切换设备工具栏"
          aria-label="切换设备工具栏"
          aria-pressed={open}
          onClick={() => {
            onSettingsChange({ ...settings, open: !open })
          }}
        />
      )}

      {open && (
        <div className="flex h-10 shrink-0 items-center justify-center gap-2 border-b border-border bg-white px-2">
          <select
            aria-label="设备尺寸"
            className="h-7 w-44 shrink-0 rounded-md border border-border bg-white px-2 text-xs text-foreground outline-none"
            value={preset}
            onChange={(event) => {
              const nextViewport = DEVICE_VIEWPORTS.find(
                (item) => `${item.width}x${item.height}` === event.target.value
              )
              if (!nextViewport) return
              updateViewport(nextViewport)
            }}
          >
            {DEVICE_VIEWPORTS.map((item) => (
              <option key={`${item.width}x${item.height}`} value={`${item.width}x${item.height}`}>
                {item.label}
              </option>
            ))}
          </select>
          <input
            aria-label="设备宽度"
            className="h-7 w-14 rounded-md border border-border bg-white px-1 text-center text-xs tabular-nums outline-none disabled:opacity-50"
            type="number"
            min={1}
            disabled={preset !== "0x0"}
            value={width || ""}
            placeholder="自动"
            onChange={(event) => {
              const width = event.target.value ? Math.max(1, Number(event.target.value)) : 0
              updateViewport({ width, height })
            }}
          />
          <span className="text-xs text-muted-foreground">×</span>
          <input
            aria-label="设备高度"
            className="h-7 w-14 rounded-md border border-border bg-white px-1 text-center text-xs tabular-nums outline-none disabled:opacity-50"
            type="number"
            min={1}
            disabled={preset !== "0x0"}
            value={height || ""}
            placeholder="自动"
            onChange={(event) => {
              const height = event.target.value ? Math.max(1, Number(event.target.value)) : 0
              updateViewport({ width, height })
            }}
          />
          <input
            aria-label="缩放比例"
            className="h-7 w-16 rounded-md border border-border bg-muted/30 px-1 text-center text-xs tabular-nums text-muted-foreground outline-none"
            readOnly
            value={`${scale.toFixed(2)}×`}
          />
        </div>
      )}
    </>
  )
}
