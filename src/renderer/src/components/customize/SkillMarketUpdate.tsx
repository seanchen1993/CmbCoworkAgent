import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import type { SkillMetadata } from "@/types"
import { marketApi } from "../../api/market"
import {
  isMarketVersionDifferent,
  MarketUpdateBadge,
  marketInstalledVersionStorage
} from "./MarketPanel/MarketUpdateBadge"

/**
 * 解析技能的“本地已安装版本”。
 * 优先读取 SKILL.md frontmatter 的 version，其次技能元信息里的 version，
 * 最后兜底查本地安装版本记录（历史版本记录以 orgSkill 存储兼容旧数据）。
 */
function resolveSkillLocalVersion(skill: SkillMetadata): string {
  return (
    skill.metadata?.version?.trim() ||
    skill.version ||
    marketInstalledVersionStorage.getVersion(skill.name, "orgSkill") ||
    ""
  )
}

interface SkillMarketUpdateProps {
  skill: SkillMetadata
  /** 市场远程版本；缺失时不展示更新提示 */
  marketVersion?: string | null
  /** 该技能是否在市场上有同名条目（用于决定是否展示“有更新”） */
  hasMarketEntry?: boolean
  /** 是否允许真正执行更新（应为市场安装、非本人上传、非组织级） */
  canUpdate?: boolean
  /** 更新成功后的回调（父组件用于刷新技能列表/清理选中态） */
  onUpdated?: () => void
  /** 展示形态：badge 用于列表行内的“有更新”提示，button 用于详情里的主操作 */
  variant?: "badge" | "button"
  disabled?: boolean
}

interface SkillMarketUpdateContextValue {
  /** 当前子树是否允许执行市场更新（仅在“我从应用市场安装的技能”区块内开启） */
  enabled: boolean
  onUpdated?: () => void
}

const SkillMarketUpdateContext = createContext<SkillMarketUpdateContextValue>({
  enabled: false
})

/**
 * 在支持更新的子树外层包裹，使子树内的 SkillMarketUpdate 自动获得
 * “可点击更新 + 成功后回调”，无需逐层向下传递 props。
 */
export function SkillMarketUpdateProvider({
  onUpdated,
  children
}: {
  onUpdated?: () => void
  children: ReactNode
}): React.JSX.Element {
  const value = useMemo(() => ({ enabled: true, onUpdated }), [onUpdated])
  return (
    <SkillMarketUpdateContext.Provider value={value}>{children}</SkillMarketUpdateContext.Provider>
  )
}

function useSkillMarketUpdateContext(): SkillMarketUpdateContextValue {
  return useContext(SkillMarketUpdateContext)
}

/**
 * 独立封装的“市场技能更新”组件：
 * - 自动对比本地版本与市场版本，仅在有更新时渲染；
 * - badge 形态：有“更新”提示并可点击触发更新（允许更新时）；
 * - button 形态：详情页的“更新到最新版本”主操作按钮；
 * - 内部自管“更新中”状态，更新流程：确认 → 删除旧版本 → 下载安装最新版 → 记录版本 → 回调。
 */
export function SkillMarketUpdate({
  skill,
  marketVersion,
  hasMarketEntry = false,
  canUpdate: canUpdateProp,
  onUpdated: onUpdatedProp,
  variant = "badge",
  disabled = false
}: SkillMarketUpdateProps): React.JSX.Element | null {
  const context = useSkillMarketUpdateContext()
  const canUpdate = canUpdateProp ?? context.enabled
  const onUpdated = onUpdatedProp ?? context.onUpdated
  const [isUpdating, setIsUpdating] = useState(false)

  const localVersion = useMemo(() => resolveSkillLocalVersion(skill), [skill])
  const updateAvailable = hasMarketEntry && isMarketVersionDifferent(localVersion, marketVersion)
  const normalizedMarketVersion = marketVersion?.trim() || ""

  const runUpdate = useCallback(async () => {
    if (isUpdating || !canUpdate || !normalizedMarketVersion) return
    if (!window.api?.skills?.delete) return
    if (
      !confirm(`确定要更新技能「${skill.name}」到最新版本吗？\n\n更新将覆盖当前已安装的本地版本。`)
    )
      return
    setIsUpdating(true)
    try {
      try {
        await window.api.skills.delete(skill.path)
      } catch (deleteError) {
        console.warn("[SkillMarketUpdate] Failed to delete existing skill for update:", deleteError)
      }
      const response = await marketApi.downloadItem(skill.name, "skill", false)
      if (response.success) {
        marketInstalledVersionStorage.setVersion(skill.name, "skill", normalizedMarketVersion)
        toast.success(`已为您更新「${skill.name}」到最新版本，请新开一个会话试试效果。`)
        onUpdated?.()
      } else {
        toast.error(response.error || "更新失败")
      }
    } catch (error) {
      console.error("[SkillMarketUpdate] Failed to update skill:", error)
      toast.error(error instanceof Error ? error.message : "更新失败")
    } finally {
      setIsUpdating(false)
    }
  }, [canUpdate, isUpdating, normalizedMarketVersion, onUpdated, skill])

  if (!updateAvailable) return null

  if (variant === "button") {
    return (
      <Button
        variant="default"
        size="sm"
        className="cursor-pointer h-7 gap-1.5 text-xs border-0 text-white hover:text-white bg-gradient-to-r from-emerald-500 to-teal-500 shadow-[0_6px_16px_rgba(16,185,129,0.35)] hover:from-emerald-400 hover:to-teal-400 hover:shadow-[0_8px_20px_rgba(16,185,129,0.45)] group shrink-0"
        onClick={() => void runUpdate()}
        disabled={disabled || isUpdating || !canUpdate}
      >
        <RefreshCw className={cn("size-3", isUpdating && "animate-spin")} />
        {isUpdating ? "更新中..." : "更新到最新版本"}
      </Button>
    )
  }

  if (canUpdate) {
    return (
      <span
        role="button"
        tabIndex={0}
        aria-disabled={isUpdating}
        title={isUpdating ? "正在更新到最新版本…" : "点击更新到最新版本"}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center rounded outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring",
          isUpdating && "pointer-events-none opacity-70"
        )}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void runUpdate()
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return
          e.preventDefault()
          e.stopPropagation()
          void runUpdate()
        }}
      >
        <MarketUpdateBadge
          typeLabel="技能"
          installedVersion={localVersion}
          currentVersion={normalizedMarketVersion}
          label={isUpdating ? "更新中…" : "有更新"}
          className="text-[10px] px-1.5 py-0"
        />
      </span>
    )
  }

  return (
    <MarketUpdateBadge
      typeLabel="技能"
      installedVersion={localVersion}
      currentVersion={normalizedMarketVersion}
      className="text-[10px] px-1.5 py-0"
    />
  )
}
