import React, { useEffect, useMemo, useState } from "react"
import {
  Building2,
  Code2,
  Layers3,
  Loader2,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Zap,
  Wrench
} from "lucide-react"
import type { SkillMetadata } from "@/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { getAllSkills, SCENE_CATEGORY_OPTIONS, type SkillWithUsage } from "@/lib/skill-data-service"
import type { MarketItem } from "../../api/market"
import { getMockOrgSkillMarketResponse, orgSkillMarketApi } from "../../api/org-skill-market"

export interface SkillsByCategoryItem {
  skill: SkillMetadata
  label: string
  marketItem: MarketItem
  isInstalled: boolean
  isFeatured: boolean
  isCertified: boolean
  calls: number
}

export type SkillsByCategoryMap = Map<string, Map<string, SkillsByCategoryItem[]>>

interface SkillsByCategorySectionProps {
  skills: SkillMetadata[]
  previewLimit: number
  onOpenMarketByCategory: (category: string) => void
  onOpenOrganizationSkillMarket: () => void
  onOpenMarketBySkill: (skillName: string) => void
  onUseSkillPrompt: (skill: SkillMetadata, label?: string) => void
}

function splitCategory(category?: string): { primary: string; secondary: string } {
  if (!category) return { primary: "精品技能", secondary: "" }
  const parts = category
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return { primary: "精品技能", secondary: "" }
  if (parts.length === 1) return { primary: parts[0], secondary: "" }
  return { primary: parts[0], secondary: parts.slice(1).join("/") }
}

function getCategoryKey(primary: string, secondary: string): string {
  return secondary ? `${primary}/${secondary}` : primary
}

const ORGANIZATION_CATEGORY = "组织级技能"
const COMMON_CATEGORY = "通用场景"
const LEGACY_RESEARCH_CATEGORY = "研发场景"
const categoryIconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  治理类场景: ShieldCheck,
  研发类场景: Code2,
  组织级技能: Building2,
  通用场景: Sparkles,
  精品技能: Zap
}
const COMMON_PINNED_SKILLS = [
  {
    name: "scheduler-assistant",
    label: "定时任务管理",
    description: "创建、修改和管理定时提醒或周期任务。"
  },
  {
    name: "skill-creator",
    label: "创建新技能包",
    description: "创建一个新的技能包，并生成结构、说明和示例。"
  }
] as const
const primaryCategoryOrder = new Map<string, number>()
const secondaryCategoryOrder = new Map<string, number>()
let cachedMarketSkillsData: SkillWithUsage[] | null = null
let marketSkillsRequestPromise: Promise<SkillWithUsage[]> | null = null
let cachedOrganizationSkillsData: MarketItem[] | null = null
let organizationSkillsRequestPromise: Promise<MarketItem[]> | null = null

SCENE_CATEGORY_OPTIONS.forEach((category, index) => {
  const { primary, secondary } = splitCategory(category)
  if (!primaryCategoryOrder.has(primary)) {
    primaryCategoryOrder.set(primary, index)
  }
  secondaryCategoryOrder.set(getCategoryKey(primary, secondary), index)
})

async function loadMarketSkillsOnce(): Promise<SkillWithUsage[]> {
  if (cachedMarketSkillsData) return cachedMarketSkillsData
  if (marketSkillsRequestPromise) return marketSkillsRequestPromise

  marketSkillsRequestPromise = (async () => {
    try {
      const skillRes = await getAllSkills()
      if (skillRes.success && skillRes.data) {
        cachedMarketSkillsData = skillRes.data
      } else {
        console.warn(
          `[SkillsByCategorySection] getAllSkills failed, use empty list. error=${skillRes.error || "unknown"}`
        )
        cachedMarketSkillsData = []
      }
      return cachedMarketSkillsData
    } catch (error) {
      console.error("[SkillsByCategorySection] Failed to load skills:", error)
      cachedMarketSkillsData = []
      return cachedMarketSkillsData
    } finally {
      marketSkillsRequestPromise = null
    }
  })()

  return marketSkillsRequestPromise
}

async function loadOrganizationSkillsOnce(): Promise<MarketItem[]> {
  if (cachedOrganizationSkillsData) return cachedOrganizationSkillsData
  if (organizationSkillsRequestPromise) return organizationSkillsRequestPromise

  organizationSkillsRequestPromise = (async () => {
    try {
      const response = await orgSkillMarketApi.getOrgSkills(1, 4)
      if (!response.success || !response.data) {
        throw new Error(response.error || "组织级技能加载失败")
      }
      cachedOrganizationSkillsData = response.data.slice(0, 4)
      return cachedOrganizationSkillsData
    } catch (error) {
      console.error("[SkillsByCategorySection] Failed to load organization skills:", error)
      const mockResponse = getMockOrgSkillMarketResponse(1, 4)
      cachedOrganizationSkillsData = mockResponse.data?.slice(0, 4) ?? []
      return cachedOrganizationSkillsData
    } finally {
      organizationSkillsRequestPromise = null
    }
  })()

  return organizationSkillsRequestPromise
}

export function SkillsByCategorySection({
  skills,
  previewLimit,
  onOpenMarketByCategory,
  onOpenOrganizationSkillMarket,
  onOpenMarketBySkill,
  onUseSkillPrompt
}: SkillsByCategorySectionProps): React.JSX.Element {
  const [marketSkillsLoading, setMarketSkillsLoading] = useState(true)
  const [marketSkillsData, setMarketSkillsData] = useState<SkillWithUsage[]>([])
  const [organizationSkillsData, setOrganizationSkillsData] = useState<MarketItem[]>([])
  const [installPromptItem, setInstallPromptItem] = useState<SkillsByCategoryItem | null>(null)

  useEffect(() => {
    let canceled = false

    const loadMarketSkills = async (): Promise<void> => {
      setMarketSkillsLoading(true)
      const [data, orgSkills] = await Promise.all([
        loadMarketSkillsOnce(),
        loadOrganizationSkillsOnce()
      ])
      if (canceled) return
      setMarketSkillsData(data)
      setOrganizationSkillsData(orgSkills)
      setMarketSkillsLoading(false)
    }

    void loadMarketSkills()
    return () => {
      canceled = true
    }
  }, [])

  const skillsByCategory = useMemo(() => {
    const localSkillMap = new Map(
      skills.filter((skill) => skill.source === "user").map((skill) => [skill.name, skill])
    )
    const allSkillMap = new Map(skills.map((skill) => [skill.name, skill]))
    const groups = new Map<string, Map<string, SkillsByCategoryItem[]>>()

    for (const item of marketSkillsData) {
      const localSkill = localSkillMap.get(item.name)
      const { primary, secondary } = splitCategory(item.category)
      const isOrganizationSkill = primary === ORGANIZATION_CATEGORY
      if (primary === LEGACY_RESEARCH_CATEGORY) continue
      if (!isOrganizationSkill && item.featured !== "精品" && item.tag !== "认证") continue

      if (!groups.has(primary)) groups.set(primary, new Map())
      const secondaryGroups = groups.get(primary)!
      if (!secondaryGroups.has(secondary)) secondaryGroups.set(secondary, [])
      secondaryGroups.get(secondary)!.push({
        skill: localSkill ?? {
          name: item.name,
          description: item.description || "",
          path: item.filename || item.name,
          source: "user"
        },
        label: item.chinese_name || item.name,
        marketItem: item,
        isInstalled: !!localSkill,
        isFeatured: item.featured === "精品",
        isCertified: item.tag === "认证",
        calls: item.calls ?? 0
      })
    }

    const organizationGroups =
      groups.get(ORGANIZATION_CATEGORY) ?? new Map<string, SkillsByCategoryItem[]>()
    const organizationItems: SkillsByCategoryItem[] = organizationSkillsData.map((item) => {
      const localSkill = localSkillMap.get(item.name)
      return {
        skill: localSkill ?? {
          name: item.name,
          description: item.description || "",
          path: item.filename || item.name,
          source: "user"
        },
        label: item.chinese_name || item.name,
        marketItem: item,
        isInstalled: !!localSkill,
        isFeatured: false,
        isCertified: false,
        calls: 0
      }
    })
    organizationGroups.set("", organizationItems)
    if (organizationItems.length > 0) {
      groups.set(ORGANIZATION_CATEGORY, organizationGroups)
    }

    groups.forEach((secondaryGroups) => {
      secondaryGroups.forEach((items) => {
        items.sort((a, b) => {
          if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1
          if (!a.isFeatured && !b.isFeatured) {
            return b.calls - a.calls || a.label.localeCompare(b.label, "zh-CN")
          }
          return a.label.localeCompare(b.label, "zh-CN")
        })
      })
    })

    const commonGroups = groups.get(COMMON_CATEGORY) ?? new Map<string, SkillsByCategoryItem[]>()
    const commonPrimaryItems = commonGroups.get("") ?? []
    const pinnedNames = new Set<string>(COMMON_PINNED_SKILLS.map((skill) => skill.name))
    const pinnedItems: SkillsByCategoryItem[] = COMMON_PINNED_SKILLS.map(
      ({ name, label, description }) => {
        const skill = allSkillMap.get(name) ?? {
          name,
          description,
          path: `skills/${name}`,
          source: "project" as const
        }

        return {
          skill,
          label,
          marketItem: {
            name,
            chinese_name: label,
            description,
            filename: skill.path,
            category: COMMON_CATEGORY,
            created_at: ""
          },
          isInstalled: true,
          isFeatured: false,
          isCertified: false,
          calls: 0
        }
      }
    )
    commonGroups.set(
      "",
      pinnedItems.concat(
        commonPrimaryItems.filter((item) => !pinnedNames.has(item.marketItem.name))
      )
    )
    groups.set(COMMON_CATEGORY, commonGroups)

    const orderedPrimaryEntries = Array.from(groups.entries()).sort(([primaryA], [primaryB]) => {
      if (primaryA === COMMON_CATEGORY && primaryB !== COMMON_CATEGORY) return 1
      if (primaryB === COMMON_CATEGORY && primaryA !== COMMON_CATEGORY) return -1
      const orderA = primaryCategoryOrder.get(primaryA) ?? Number.MAX_SAFE_INTEGER
      const orderB = primaryCategoryOrder.get(primaryB) ?? Number.MAX_SAFE_INTEGER
      if (orderA !== orderB) return orderA - orderB
      return primaryA.localeCompare(primaryB, "zh-CN")
    })

    return new Map(
      orderedPrimaryEntries.map(([primary, secondaryGroups]) => {
        const orderedSecondaryEntries = Array.from(secondaryGroups.entries()).sort(
          ([secondaryA], [secondaryB]) => {
            const orderA =
              secondaryCategoryOrder.get(getCategoryKey(primary, secondaryA)) ??
              Number.MAX_SAFE_INTEGER
            const orderB =
              secondaryCategoryOrder.get(getCategoryKey(primary, secondaryB)) ??
              Number.MAX_SAFE_INTEGER
            if (orderA !== orderB) return orderA - orderB
            return secondaryA.localeCompare(secondaryB, "zh-CN")
          }
        )
        return [primary, new Map(orderedSecondaryEntries)]
      })
    )
  }, [marketSkillsData, organizationSkillsData, skills])

  if (marketSkillsLoading) {
    return (
      <div className="rounded-xl border border-border/60 bg-background/80 px-4 py-8">
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span>场景技能加载中...</span>
        </div>
      </div>
    )
  }

  if (skillsByCategory.size === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-background/70 px-4 py-6 text-center text-sm text-muted-foreground">
        暂无场景技能
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={250}>
      <div className="space-y-0">
        {Array.from(skillsByCategory.entries()).map(([primaryCategory, secondaryGroups], index) => {
          const onlyPrimaryLevel = secondaryGroups.size === 1 && secondaryGroups.has("")
          const primaryLevelItems = onlyPrimaryLevel ? secondaryGroups.get("") || [] : []
          const showAllPrimaryItems = primaryCategory === ORGANIZATION_CATEGORY
          const CategoryIcon = categoryIconMap[primaryCategory] ?? Layers3

          return (
            <div
              key={primaryCategory}
              className={`space-y-2.5 py-4 ${index > 0 ? "pt-5" : "pt-0"} last:pb-0`}
            >
              {index > 0 && (
                <div className="h-px bg-gradient-to-r from-transparent via-slate-400/90 to-transparent dark:via-slate-500/85 -mt-2 mb-4" />
              )}
              <div className="text-xs text-muted-foreground font-medium tracking-wider flex items-center justify-between gap-1">
                <div className="flex items-center gap-1">
                  <CategoryIcon className="size-3 text-amber-500" />
                  <span className={"text-black"}>{primaryCategory}</span>
                </div>
                {onlyPrimaryLevel && (
                  <button
                    type="button"
                    onClick={() =>
                      primaryCategory === ORGANIZATION_CATEGORY
                        ? onOpenOrganizationSkillMarket()
                        : onOpenMarketByCategory(primaryCategory)
                    }
                    className="text-xs text-amber-600 hover:text-amber-700 transition-colors cursor-pointer"
                  >
                    更多
                    {!showAllPrimaryItems && primaryLevelItems.length > previewLimit
                      ? `（+${primaryLevelItems.length - previewLimit}）`
                      : ""}
                  </button>
                )}
              </div>
              {Array.from(secondaryGroups.entries()).map(([secondaryCategory, items]) => {
                const hideSecondaryHeader = onlyPrimaryLevel && !secondaryCategory
                const showAllItems = primaryCategory === ORGANIZATION_CATEGORY
                const visibleItems = showAllItems ? items : items.slice(0, previewLimit)
                return (
                  <div
                    key={`${primaryCategory}/${secondaryCategory || "__no_secondary__"}`}
                    className="space-y-2"
                  >
                    {!hideSecondaryHeader && (
                      <div
                        className={`flex items-center px-1 ${secondaryCategory ? "justify-between" : "justify-end"}`}
                      >
                        {secondaryCategory ? (
                          <div className="text-xs text-gray-700 dark:text-gray-300">
                            {secondaryCategory}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          onClick={() =>
                            primaryCategory === ORGANIZATION_CATEGORY
                              ? onOpenOrganizationSkillMarket()
                              : onOpenMarketByCategory(secondaryCategory || primaryCategory)
                          }
                          className="text-xs text-amber-600 hover:text-amber-700 transition-colors cursor-pointer"
                        >
                          更多
                          {!showAllItems && items.length > previewLimit
                            ? `（+${items.length - previewLimit}）`
                            : ""}
                        </button>
                      </div>
                    )}
                    <div className="grid grid-cols-4 gap-2">
                      {visibleItems.map((item) => {
                        const { skill, label, marketItem, isInstalled, isFeatured, isCertified } =
                          item
                        const tags = [isFeatured ? "精品" : "", isCertified ? "认证" : ""].filter(
                          Boolean
                        )
                        const displayLabel = label
                        return (
                          <Tooltip key={marketItem.name}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!isInstalled) {
                                    setInstallPromptItem(item)
                                    return
                                  }
                                  onUseSkillPrompt(skill, label)
                                }}
                                className="group relative w-full rounded-xl border border-slate-300/90 dark:border-slate-600/85 bg-slate-50/70 dark:bg-slate-900/35 px-3 py-2 text-left shadow-[0_1px_0_rgba(15,23,42,0.05)] hover:bg-slate-100/95 dark:hover:bg-slate-800/55 hover:border-slate-400/95 dark:hover:border-slate-500/95 hover:shadow-[0_2px_8px_rgba(15,23,42,0.12)] transition-all"
                              >
                                {tags.length > 0 && (
                                  <div className="absolute right-1 top-1 flex flex-col items-end gap-0.5">
                                    {tags.map((tag) => (
                                      <span
                                        key={tag}
                                        className={
                                          tag === "精品"
                                            ? "relative rounded-sm border border-amber-200 bg-amber-50 px-0.5 text-[9px] leading-3 text-amber-700 hover:z-10 hover:after:absolute hover:after:left-full hover:after:top-1/2 hover:after:ml-1.5 hover:after:-translate-y-1/2 hover:after:whitespace-nowrap hover:after:rounded-md hover:after:border hover:after:border-slate-200 hover:after:bg-popover hover:after:px-2 hover:after:py-1 hover:after:text-[11px] hover:after:leading-none hover:after:text-popover-foreground hover:after:shadow-md hover:after:content-['团队级']"
                                            : "relative rounded-sm border border-emerald-200 bg-emerald-50 px-0.5 text-[9px] leading-3 text-emerald-700 hover:z-10 hover:after:absolute hover:after:left-full hover:after:top-1/2 hover:after:ml-1.5 hover:after:-translate-y-1/2 hover:after:whitespace-nowrap hover:after:rounded-md hover:after:border hover:after:border-slate-200 hover:after:bg-popover hover:after:px-2 hover:after:py-1 hover:after:text-[11px] hover:after:leading-none hover:after:text-popover-foreground hover:after:shadow-md hover:after:content-['室组级']"
                                        }
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                <div
                                  className={`flex items-center gap-2 min-w-0 ${tags.length > 0 ? "pr-8" : ""}`}
                                >
                                  <div className="rounded-md border border-slate-300/90 dark:border-slate-600/80 bg-white/80 dark:bg-slate-900/45 p-1.5 text-slate-500 dark:text-slate-300 group-hover:text-slate-700 dark:group-hover:text-slate-100 transition-colors">
                                    <Wrench className="size-4" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-xs text-foreground leading-5 truncate whitespace-nowrap">
                                      {displayLabel}
                                    </div>
                                  </div>
                                </div>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={6}>
                              <p className="max-w-xs break-words">{displayLabel}</p>
                            </TooltipContent>
                          </Tooltip>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <Dialog
        open={!!installPromptItem}
        onOpenChange={(open) => !open && setInstallPromptItem(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>安装技能</DialogTitle>
            <DialogDescription>
              {`技能「${installPromptItem?.label || installPromptItem?.marketItem.name || ""}」尚未安装。是否前往应用市场查看并安装？`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallPromptItem(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                const skillName = installPromptItem?.marketItem.name
                if (!skillName) return
                setInstallPromptItem(null)
                onOpenMarketBySkill(skillName)
              }}
            >
              <ShoppingBag className="mr-2 size-4" />
              去应用市场
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
