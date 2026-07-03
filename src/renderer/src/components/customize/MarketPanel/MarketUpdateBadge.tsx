import type { ReactNode } from "react"
import { Zap } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { MarketItemType } from "../../../api/market"

const INSTALLED_VERSION_RECORDS_KEY = "marketplace_installed_version_records"

interface InstalledVersionRecord {
  name: string
  type: MarketItemType
  version: string
  installedAt: string
}

type InstalledVersionRecordMap = Partial<
  Record<MarketItemType, Record<string, InstalledVersionRecord>>
>

interface UpdateVersionTooltipProps {
  children: ReactNode
  typeLabel: string
  installedVersion?: string | null
  currentVersion?: string | null
}

interface MarketUpdateBadgeProps {
  typeLabel: string
  installedVersion?: string | null
  currentVersion?: string | null
  label?: string
  className?: string
}

export function normalizeMarketVersion(version?: string | null): string {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
}

export function isMarketVersionDifferent(
  localVersion?: string | null,
  remoteVersion?: string | null
): boolean {
  const normalizedLocal = normalizeMarketVersion(localVersion)
  const normalizedRemote = normalizeMarketVersion(remoteVersion)
  return Boolean(normalizedLocal && normalizedRemote && normalizedLocal !== normalizedRemote)
}

export const marketInstalledVersionStorage = {
  getRecords(): InstalledVersionRecordMap {
    try {
      const stored = localStorage.getItem(INSTALLED_VERSION_RECORDS_KEY)
      if (!stored) return {}
      const parsed = JSON.parse(stored)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  },

  getVersion(name: string, type: MarketItemType): string | null {
    const records = this.getRecords()
    return records[type]?.[name]?.version || null
  },

  setVersion(name: string, type: MarketItemType, version?: string | null): void {
    const normalizedVersion = normalizeMarketVersion(version)
    if (!name || !normalizedVersion) return

    try {
      const records = this.getRecords()
      const typeRecords = records[type] || {}
      typeRecords[name] = {
        name,
        type,
        version: normalizedVersion,
        installedAt: new Date().toISOString()
      }
      records[type] = typeRecords
      localStorage.setItem(INSTALLED_VERSION_RECORDS_KEY, JSON.stringify(records))
    } catch (error) {
      console.error("Failed to save installed version to localStorage:", error)
    }
  },

  removeVersion(name: string, type: MarketItemType): void {
    try {
      const records = this.getRecords()
      if (records[type]?.[name]) {
        delete records[type][name]
        localStorage.setItem(INSTALLED_VERSION_RECORDS_KEY, JSON.stringify(records))
      }
    } catch (error) {
      console.error("Failed to remove installed version from localStorage:", error)
    }
  }
}

export function buildMarketInstalledFlags(
  item: { name: string; version?: string | null },
  type: MarketItemType,
  installed: boolean
): { installed: boolean; installedVersion?: string; updateAvailable: boolean } {
  const installedVersion = installed
    ? marketInstalledVersionStorage.getVersion(item.name, type)
    : null
  return {
    installed,
    installedVersion: installedVersion || undefined,
    updateAvailable: installed && isMarketVersionDifferent(installedVersion, item.version)
  }
}

export function UpdateVersionTooltip({
  children,
  typeLabel,
  installedVersion,
  currentVersion
}: UpdateVersionTooltipProps) {
  const localVersion = installedVersion
    ? `v${normalizeMarketVersion(installedVersion)}`
    : "未知版本"
  const remoteVersion = currentVersion ? `v${normalizeMarketVersion(currentVersion)}` : "未知版本"

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          className="max-w-[260px] border-[#78d7cb] bg-[#f4fffc] px-3 py-2 text-[#0f766e] shadow-[rgba(15,118,110,0.16)_0px_8px_24px]"
        >
          <div className="space-y-0.5">
            <p className="text-[12px] font-medium">{typeLabel}有新版本</p>
            <p className="text-[11px] leading-relaxed">
              你安装的是 {localVersion}，目前是 {remoteVersion}，可更新安装。
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function MarketUpdateBadge({
  typeLabel,
  installedVersion,
  currentVersion,
  label = "有更新",
  className = "text-[11px] px-2.5 py-0.5"
}: MarketUpdateBadgeProps) {
  return (
    <UpdateVersionTooltip
      typeLabel={typeLabel}
      installedVersion={installedVersion}
      currentVersion={currentVersion}
    >
      <span
        className={`market-update-badge market-update-bounce inline-flex items-center gap-1 font-semibold shrink-0 ${className}`}
      >
        <Zap className="size-3" />
        {label}
      </span>
    </UpdateVersionTooltip>
  )
}
