import React, { useEffect, useMemo, useState } from "react"
import { Loader2, Zap, Wrench } from "lucide-react"
import type { SkillMetadata } from "@/types"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { getAllSkills, SCENE_CATEGORY_OPTIONS, type SkillWithUsage } from "@/lib/skill-data-service"
import type { MarketItem } from "../../api/market"

export interface SkillsByCategoryItem {
  skill: SkillMetadata
  label: string
  marketItem: MarketItem
  isFeatured: boolean
  calls: number
}

export type SkillsByCategoryMap = Map<string, Map<string, SkillsByCategoryItem[]>>

interface SkillsByCategorySectionProps {
  skills: SkillMetadata[]
  previewLimit: number
  onOpenMarketByCategory: (category: string) => void
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

const primaryCategoryOrder = new Map<string, number>()
const secondaryCategoryOrder = new Map<string, number>()
let cachedMarketSkillsData: SkillWithUsage[] | null = null
let marketSkillsRequestPromise: Promise<SkillWithUsage[]> | null = null

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

export function SkillsByCategorySection({
  skills,
  previewLimit,
  onOpenMarketByCategory,
  onUseSkillPrompt
}: SkillsByCategorySectionProps): React.JSX.Element {
  const [marketSkillsLoading, setMarketSkillsLoading] = useState(true)
  const [marketSkillsData, setMarketSkillsData] = useState<SkillWithUsage[]>([])

  useEffect(() => {
    let canceled = false

    const loadMarketSkills = async (): Promise<void> => {
      if (cachedMarketSkillsData) {
        setMarketSkillsData(cachedMarketSkillsData)
        setMarketSkillsLoading(false)
        return
      }
      setMarketSkillsLoading(true)
      const data = await loadMarketSkillsOnce()
      if (canceled) return
      setMarketSkillsData(data)
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
    const groups = new Map<string, Map<string, SkillsByCategoryItem[]>>()

    for (const item of marketSkillsData) {
      const localSkill = localSkillMap.get(item.name)
      const { primary, secondary } = splitCategory(item.category)
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
        isFeatured: item.featured === "精品",
        calls: item.calls ?? 0
      })
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
    const orderedPrimaryEntries = Array.from(groups.entries()).sort(([primaryA], [primaryB]) => {
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
  }, [marketSkillsData, skills])

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
        const primaryLevelItems = onlyPrimaryLevel ? (secondaryGroups.get("") || []) : []

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
                <Zap className="size-3 text-amber-500" />
                <span className={'text-black'}>{primaryCategory}</span>
              </div>
              {onlyPrimaryLevel && (
                <button
                  type="button"
                  onClick={() => onOpenMarketByCategory(primaryCategory)}
                  className="text-xs text-amber-600 hover:text-amber-700 transition-colors cursor-pointer"
                >
                  更多
                  {primaryLevelItems.length > previewLimit
                    ? `（+${primaryLevelItems.length - previewLimit}）`
                    : ""}
                </button>
              )}
            </div>
            {Array.from(secondaryGroups.entries()).map(([secondaryCategory, items]) => {
              const hideSecondaryHeader = onlyPrimaryLevel && !secondaryCategory
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
                        <div className="text-xs text-gray-700 dark:text-gray-300">{secondaryCategory}</div>
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          onOpenMarketByCategory(secondaryCategory || primaryCategory)
                        }
                        className="text-xs text-amber-600 hover:text-amber-700 transition-colors cursor-pointer"
                      >
                        更多
                        {items.length > previewLimit ? `（+${items.length - previewLimit}）` : ""}
                      </button>
                    </div>
                  )}
                  <div className="grid grid-cols-4 gap-2">
                    {items.slice(0, previewLimit).map(({ skill, label, marketItem, isFeatured }) => {
                      const displayLabel = label
                      return (
                        <Tooltip key={marketItem.name}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => onUseSkillPrompt(skill, label)}
                              className={
                                isFeatured
                                  ? "group w-full rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-left hover:bg-amber-100/70 hover:border-amber-300 transition-colors"
                                  : "group w-full rounded-xl border border-slate-300/90 dark:border-slate-600/85 bg-slate-50/70 dark:bg-slate-900/35 px-3 py-2 text-left shadow-[0_1px_0_rgba(15,23,42,0.05)] hover:bg-slate-100/95 dark:hover:bg-slate-800/55 hover:border-slate-400/95 dark:hover:border-slate-500/95 hover:shadow-[0_2px_8px_rgba(15,23,42,0.12)] transition-all"
                              }
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                {isFeatured ? (
                                  <div className="rounded-md border border-amber-200/80 p-1.5 text-amber-500 group-hover:text-amber-600 transition-colors">
                                    <Zap className="size-4" />
                                  </div>
                                ) : (
                                  <div className="rounded-md border border-slate-300/90 dark:border-slate-600/80 bg-white/80 dark:bg-slate-900/45 p-1.5 text-slate-500 dark:text-slate-300 group-hover:text-slate-700 dark:group-hover:text-slate-100 transition-colors">
                                    <Wrench className="size-4" />
                                  </div>
                                )}
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
    </TooltipProvider>
  )
}
