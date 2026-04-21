import React from "react"
import { Zap, Wrench } from "lucide-react"
import type { SkillMetadata } from "@/types"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { MarketItem } from "../../api/market"

export interface SkillsByCategoryItem {
  skill: SkillMetadata
  label: string
  marketItem: MarketItem
  isFeatured: boolean
}

export type SkillsByCategoryMap = Map<string, Map<string, SkillsByCategoryItem[]>>

interface SkillsByCategorySectionProps {
  skillsByCategory: SkillsByCategoryMap
  previewLimit: number
  onOpenMarketByCategory: (category: string) => void
  onUseSkillPrompt: (skill: SkillMetadata, label?: string) => void
  getSkillShowLabel: (label: string) => string
}

export function SkillsByCategorySection({
  skillsByCategory,
  previewLimit,
  onOpenMarketByCategory,
  onUseSkillPrompt,
  getSkillShowLabel
}: SkillsByCategorySectionProps): React.JSX.Element | null {
  if (skillsByCategory.size === 0) return null

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
                      const displayLabel = getSkillShowLabel(label)
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
