import { useCallback, useEffect, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  DEFAULT_BROWSER_CDP_PORT,
  type BrowserCdpConfig
} from "../../../../shared/browser-types"

interface BrowserCdpConfigCardProps {
  className?: string
  description?: string
  onSaved?: (config: BrowserCdpConfig) => void
  title?: string
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseBrowserCdpPortInput(value: string): number {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) {
    throw new Error("CDP 端口必须是 1 到 65535 之间的整数")
  }

  const port = Number(normalized)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CDP 端口必须是 1 到 65535 之间的整数")
  }
  return port
}

export function BrowserCdpConfigCard({
  className,
  description = "在这里手动开启内置浏览器",
  onSaved,
  title = "控制配置"
}: BrowserCdpConfigCardProps): React.JSX.Element {
  const [cdpConfig, setCdpConfig] = useState<BrowserCdpConfig | null>(null)
  const [cdpPortInput, setCdpPortInput] = useState(String(DEFAULT_BROWSER_CDP_PORT))
  const [cdpPortError, setCdpPortError] = useState<string | null>(null)
  const [isSavingCdpConfig, setIsSavingCdpConfig] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.browser
      .getCdpConfig()
      .then((nextConfig) => {
        if (cancelled) return
        setCdpConfig(nextConfig)
        setCdpPortInput(String(nextConfig.port))
        setCdpPortError(null)
      })
      .catch((error) => {
        console.error(`[BrowserCdpConfigCard] Failed to load Browser CDP config: ${formatError(error)}`)
        if (cancelled) return
        const fallbackConfig: BrowserCdpConfig = {
          enabled: true,
          port: DEFAULT_BROWSER_CDP_PORT
        }
        setCdpConfig(fallbackConfig)
        setCdpPortInput(String(fallbackConfig.port))
        setCdpPortError(null)
        toast.error("读取浏览器 配置失败，已回退默认值")
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleCdpEnabledChange = useCallback((enabled: boolean) => {
    setCdpConfig((current) => (current ? { ...current, enabled } : current))
  }, [])

  const handleCdpPortChange = useCallback((value: string) => {
    setCdpPortInput(value)
    setCdpPortError((current) => (current ? null : current))
  }, [])

  const handleSaveCdpConfig = useCallback(async () => {
    if (!cdpConfig) return

    let port: number
    try {
      port = parseBrowserCdpPortInput(cdpPortInput)
      setCdpPortError(null)
    } catch (error) {
      const message = formatError(error)
      setCdpPortError(message)
      toast.error(message)
      return
    }

    setIsSavingCdpConfig(true)
    try {
      const saved = await window.api.browser.saveCdpConfig({
        enabled: cdpConfig.enabled,
        port
      })
      setCdpConfig(saved)
      setCdpPortInput(String(saved.port))
      setCdpPortError(null)
      onSaved?.(saved)
      toast.success("内置浏览器配置已保存，重启应用后生效", { duration: 8_000 })
    } catch (error) {
      console.error(`[BrowserCdpConfigCard] Failed to save Browser CDP config: ${formatError(error)}`)
      toast.error("保存内置浏览器配置失败")
    } finally {
      setIsSavingCdpConfig(false)
    }
  }, [cdpConfig, cdpPortInput, onSaved])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-stone-200/90 bg-white/90 shadow-[0_14px_38px_rgba(41,37,36,0.06)]",
        className
      )}
    >
      <div className="border-b border-stone-100 px-4 py-2">
        <p className="text-xs font-semibold text-stone-800">{title}</p>
        <p className="mt-0.5 text-[11px] text-stone-500">{description}</p>
      </div>

      <div className="space-y-4 px-4 py-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-stone-200/80 bg-stone-50/80 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-stone-800">
              启用内置浏览器 （{cdpConfig?.enabled ? '已启用' :'未启用'}）
            </p>
            <p className="mt-1 text-[11px] leading-4 text-stone-500">
              开启后，才能让Agent连接并操控当前内置浏览器。
            </p>
          </div>
          <Switch
            checked={cdpConfig?.enabled ?? true}
            disabled={!cdpConfig || isSavingCdpConfig}
            onCheckedChange={handleCdpEnabledChange}
          />
        </div>

        {/*暂不支持用户配置*/}
        {/*<div className="space-y-2">*/}
        {/*  <div className="flex items-center justify-between gap-3">*/}
        {/*    <label className="text-xs font-medium text-stone-800"> 端口</label>*/}
        {/*    <span className="text-[11px] text-stone-500">默认 {DEFAULT_BROWSER_CDP_PORT}</span>*/}
        {/*  </div>*/}
        {/*  <Input*/}
        {/*    value={cdpPortInput}*/}
        {/*    inputMode="numeric"*/}
        {/*    placeholder={String(DEFAULT_BROWSER_CDP_PORT)}*/}
        {/*    disabled={!cdpConfig || isSavingCdpConfig}*/}
        {/*    onChange={(event) => handleCdpPortChange(event.target.value)}*/}
        {/*  />*/}
        {/*  {cdpPortError ? (*/}
        {/*    <p className="text-[11px] text-rose-600">{cdpPortError}</p>*/}
        {/*  ) : (*/}
        {/*    <p className="text-[11px] text-stone-500">*/}
        {/*      {cdpConfig?.enabled*/}
        {/*        ? `保存后将监听 http://127.0.0.1:${cdpPortInput.trim() || DEFAULT_BROWSER_CDP_PORT}`*/}
        {/*        : "关闭后，Playwright MCP 将不再自动接管内置浏览器。"}*/}
        {/*    </p>*/}
        {/*  )}*/}
        {/*</div>*/}

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-4 text-stone-500">
           保存后需重启应用生效。
          </p>
          <Button
            type="button"
            size="sm"
            disabled={!cdpConfig || isSavingCdpConfig}
            onClick={handleSaveCdpConfig}
          >
            {isSavingCdpConfig ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <Check className="size-3.5" strokeWidth={1.8} />
            )}
            保存配置
          </Button>
        </div>
      </div>
    </div>
  )
}
