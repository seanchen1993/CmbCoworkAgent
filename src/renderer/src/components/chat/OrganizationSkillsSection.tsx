import React, { useEffect, useMemo, useState } from "react"
import { Building2, ShoppingBag, Wrench } from "lucide-react"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { MarketItem } from "../../api/market"
import { getMockOrgSkillMarketResponse, orgSkillMarketApi } from "../../api/org-skill-market"
import type { SkillsByCategoryItem } from "./SkillsByCategorySection"

interface OrganizationSkillsSnapshot {
  items: MarketItem[]
  total: number
}

interface OrganizationSkillsSectionProps {
  skills: SkillMetadata[]
  showDivider: boolean
  onOpenOrganizationSkillMarket: (skillName?: string) => void
  onUseSkillPrompt: (skill: SkillMetadata, label?: string) => void
}

let cachedOrganizationSkillsData: OrganizationSkillsSnapshot | null = null
let organizationSkillsRequestPromise: Promise<OrganizationSkillsSnapshot> | null = null

async function loadOrganizationSkillsOnce(): Promise<OrganizationSkillsSnapshot> {
  if (cachedOrganizationSkillsData) return cachedOrganizationSkillsData
  if (organizationSkillsRequestPromise) return organizationSkillsRequestPromise

  organizationSkillsRequestPromise = (async () => {
    try {
      const response = await orgSkillMarketApi.getOrgSkills(1, 4)
      if (!response.success || !response.data) {
        throw new Error(response.error || "组织级技能加载失败")
      }
      const items = response.data.slice(0, 4)
      cachedOrganizationSkillsData = {
        items,
        total: response.total ?? items.length
      }
      return cachedOrganizationSkillsData
    } catch (error) {
      console.error("[OrganizationSkillsSection] Failed to load organization skills:", error)
      const mockResponse = getMockOrgSkillMarketResponse(1, 4)
      const items = mockResponse.data?.slice(0, 4) ?? []
      return {
        items,
        total: mockResponse.total ?? items.length
      }
    } finally {
      organizationSkillsRequestPromise = null
    }
  })()

  return organizationSkillsRequestPromise
}

export function OrganizationSkillsSection({
  skills,
  showDivider,
  onOpenOrganizationSkillMarket,
  onUseSkillPrompt
}: OrganizationSkillsSectionProps): React.JSX.Element | null {
  const [organizationSkillsData, setOrganizationSkillsData] = useState<MarketItem[]>([])
  const [organizationSkillsTotal, setOrganizationSkillsTotal] = useState(0)
  const [installPromptItem, setInstallPromptItem] = useState<SkillsByCategoryItem | null>(null)

  useEffect(() => {
    let canceled = false

    const loadOrganizationSkills = async (): Promise<void> => {
      const orgSkills = await loadOrganizationSkillsOnce()
      if (canceled) return
      setOrganizationSkillsData(orgSkills.items)
      setOrganizationSkillsTotal(orgSkills.total)
    }

    void loadOrganizationSkills()
    return () => {
      canceled = true
    }
  }, [])

  const organizationItems = useMemo<SkillsByCategoryItem[]>(() => {
    const localSkillMap = new Map(
      skills.filter((skill) => skill.source === "user").map((skill) => [skill.name, skill])
    )

    return organizationSkillsData.map((item) => {
      const localSkill = localSkillMap.get(item.name)
      return {
        skill: localSkill ?? {
          name: item.name,
          description: item.description || "",
          path: item.filename || item.name,
          source: "user",
          version: "v1.0.0"
        },
        label: item.chinese_name || item.name,
        marketItem: item,
        isInstalled: !!localSkill,
        isFeatured: false,
        isCertified: false,
        calls: 0
      }
    })
  }, [organizationSkillsData, skills])

  if (organizationItems.length === 0) return null

  const moreCount = Math.max(0, organizationSkillsTotal - organizationItems.length)

  return (
    <div className={`space-y-2.5 py-4 ${showDivider ? "pt-5" : "pt-0"} last:pb-0`}>
      {showDivider && (
        <div className="h-px bg-gradient-to-r from-transparent via-slate-400/90 to-transparent dark:via-border -mt-2 mb-4" />
      )}
      <div className="text-xs text-muted-foreground font-medium tracking-wider flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <Building2 className="size-3 text-amber-500" />
          <span className="text-foreground">组织级技能</span>
        </div>
        <button
          type="button"
          onClick={() => onOpenOrganizationSkillMarket()}
          className="cursor-pointer text-xs text-status-warning-foreground transition-colors hover:opacity-80"
        >
          更多{moreCount > 0 ? `（+${moreCount}）` : ""}
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {organizationItems.map((item) => {
          const { skill, label, marketItem, isInstalled } = item
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
                  className="group relative w-full rounded-xl border border-border bg-background-elevated px-3 py-2 text-left shadow-[0_1px_0_rgba(15,23,42,0.05)] dark:shadow-[0_1px_0_rgb(0_0_0_/_18%)] hover:bg-background-interactive hover:border-border-emphasis hover:shadow-[0_2px_8px_rgba(15,23,42,0.12)] transition-all"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="rounded-md border border-border bg-background-interactive p-1.5 text-muted-foreground transition-colors group-hover:text-foreground">
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
                onOpenOrganizationSkillMarket(skillName)
              }}
            >
              <ShoppingBag className="mr-2 size-4" />
              去应用市场
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
