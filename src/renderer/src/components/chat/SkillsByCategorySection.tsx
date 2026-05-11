import React, { useCallback, useEffect, useMemo, useState } from "react"
import {
  Building2,
  ChevronDown,
  ChevronRight,
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

type SceneSkillTreeNode = {
  key: string
  label: string
  item?: SkillsByCategoryItem
  children: SceneSkillTreeNode[]
}

interface SkillsByCategorySectionProps {
  skills: SkillMetadata[]
  previewLimit: number
  onOpenMarketByCategory: (category: string) => void
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

function normalizeSceneSkillPathPart(value?: string): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()
}

function getSceneSkillTreePath(skill: SkillMetadata): string {
  const id = skill.id?.startsWith("plugin:") ? skill.id.split("/").slice(1).join("/") : skill.id
  return String(skill.relativePath || id || skill.name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
}

function buildSceneSkillTree(items: SkillsByCategoryItem[]): SceneSkillTreeNode[] {
  const root: SceneSkillTreeNode = { key: "root", label: "root", children: [] }
  const indexByNode = new WeakMap<SceneSkillTreeNode, Map<string, SceneSkillTreeNode>>()

  const getIndex = (node: SceneSkillTreeNode): Map<string, SceneSkillTreeNode> => {
    let index = indexByNode.get(node)
    if (!index) {
      index = new Map(node.children.map((child) => [normalizeSceneSkillPathPart(child.label), child]))
      indexByNode.set(node, index)
    }
    return index
  }

  for (const item of items) {
    const segments = getSceneSkillTreePath(item.skill).split("/").filter(Boolean)
    const fallbackSegments = segments.length > 0 ? segments : [item.skill.name]
    let current = root

    for (const segment of fallbackSegments) {
      const normalized = normalizeSceneSkillPathPart(segment)
      const childIndex = getIndex(current)
      let child = childIndex.get(normalized)
      if (!child) {
        child = { key: `${current.key}/${normalized}`, label: segment, children: [] }
        current.children.push(child)
        childIndex.set(normalized, child)
      }
      current = child
    }

    current.item = item
  }

  const sortNodes = (nodes: SceneSkillTreeNode[]): SceneSkillTreeNode[] =>
    [...nodes]
      .sort((a, b) => {
        const itemA = a.item
        const itemB = b.item
        if (itemA && itemB && itemA.isFeatured !== itemB.isFeatured) {
          return itemA.isFeatured ? -1 : 1
        }
        if (itemA && itemB && !itemA.isFeatured && !itemB.isFeatured && itemA.calls !== itemB.calls) {
          return itemB.calls - itemA.calls
        }
        const labelA = itemA?.label || a.label
        const labelB = itemB?.label || b.label
        return labelA.localeCompare(labelB, "zh-CN")
      })
      .map((node) => ({ ...node, children: sortNodes(node.children) }))

  return sortNodes(root.children)
}

function limitSceneSkillTreeTopLevel(
  nodes: SceneSkillTreeNode[],
  previewLimit: number
): SceneSkillTreeNode[] {
  if (previewLimit <= 0) return []
  return nodes.slice(0, previewLimit)
}

function countSceneSkillTreeItems(node: SceneSkillTreeNode): number {
  return (
    (node.item ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countSceneSkillTreeItems(child), 0)
  )
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

function SceneSkillButton({
  item,
  onUseSkillPrompt,
  onRequestInstall
}: {
  item: SkillsByCategoryItem
  onUseSkillPrompt: (skill: SkillMetadata, label?: string) => void
  onRequestInstall?: (item: SkillsByCategoryItem) => void
}): React.JSX.Element {
  const { skill, label, marketItem, isFeatured, isInstalled } = item

  return (
    <Tooltip key={marketItem.name}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            if (!isInstalled && onRequestInstall) {
              onRequestInstall(item)
              return
            }
            onUseSkillPrompt(skill, label)
          }}
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
                {label}
              </div>
            </div>
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <p className="max-w-xs break-words">{label}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function SceneSkillTreeGrid({
  items,
  previewLimit,
  onUseSkillPrompt,
  onRequestInstall
}: {
  items: SkillsByCategoryItem[]
  previewLimit: number
  onUseSkillPrompt: (skill: SkillMetadata, label?: string) => void
  onRequestInstall?: (item: SkillsByCategoryItem) => void
}): React.JSX.Element {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const tree = useMemo(
    () => limitSceneSkillTreeTopLevel(buildSceneSkillTree(items), previewLimit),
    [items, previewLimit]
  )
  const toggleNode = useCallback((nodeKey: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeKey)) next.delete(nodeKey)
      else next.add(nodeKey)
      return next
    })
  }, [])

  return (
    <SceneSkillTreeList
      nodes={tree}
      nested={false}
      expandedNodes={expandedNodes}
      onToggleNode={toggleNode}
      onUseSkillPrompt={onUseSkillPrompt}
      onRequestInstall={onRequestInstall}
    />
  )
}

function SceneSkillTreeList({
  nodes,
  nested,
  expandedNodes,
  onToggleNode,
  onUseSkillPrompt,
  onRequestInstall
}: {
  nodes: SceneSkillTreeNode[]
  nested: boolean
  expandedNodes: Set<string>
  onToggleNode: (nodeKey: string) => void
  onUseSkillPrompt: (skill: SkillMetadata, label?: string) => void
  onRequestInstall?: (item: SkillsByCategoryItem) => void
}): React.JSX.Element {
  return (
    <div className={nested ? "grid grid-cols-1 gap-1.5" : "grid grid-cols-4 gap-2"}>
      {nodes.map((node) => {
        const childrenExpanded = expandedNodes.has(node.key)
        const childCount = node.children.reduce(
          (sum, child) => sum + countSceneSkillTreeItems(child),
          0
        )

        return (
          <div key={node.key} className="min-w-0 space-y-1.5">
            {node.item ? (
              <SceneSkillButton
                item={node.item}
                onUseSkillPrompt={onUseSkillPrompt}
                onRequestInstall={onRequestInstall}
              />
            ) : (
              <button
                type="button"
                onClick={() => onToggleNode(node.key)}
                className="w-full rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-left hover:bg-muted/35"
              >
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {childrenExpanded ? (
                      <ChevronDown className="size-3 shrink-0" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{node.label}</span>
                  </span>
                  <span className="rounded border border-border/70 px-1.5 text-[10px]">
                    {childCount}
                  </span>
                </div>
              </button>
            )}

            {node.children.length > 0 && (
              <button
                type="button"
                onClick={() => onToggleNode(node.key)}
                className="flex min-h-7 w-full items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/15 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/30"
              >
                {childrenExpanded ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">子技能</span>
                <span className="rounded border border-border/70 px-1.5 text-[10px]">
                  {childCount}
                </span>
              </button>
            )}

            {node.children.length > 0 && childrenExpanded && (
              <div className="border-l border-border/60 pl-2">
                <SceneSkillTreeList
                  nodes={node.children}
                  nested
                  expandedNodes={expandedNodes}
                  onToggleNode={onToggleNode}
                  onUseSkillPrompt={onUseSkillPrompt}
                  onRequestInstall={onRequestInstall}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function SkillsByCategorySection({
  skills,
  previewLimit,
  onOpenMarketByCategory,
  onOpenMarketBySkill,
  onUseSkillPrompt
}: SkillsByCategorySectionProps): React.JSX.Element {
  const [marketSkillsLoading, setMarketSkillsLoading] = useState(true)
  const [marketSkillsData, setMarketSkillsData] = useState<SkillWithUsage[]>([])
  const [installPromptItem, setInstallPromptItem] = useState<SkillsByCategoryItem | null>(null)

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
    const pinnedItems: SkillsByCategoryItem[] = COMMON_PINNED_SKILLS.map(({ name, label, description }) => {
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
    })
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
                    onClick={() => onOpenMarketByCategory(primaryCategory)}
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
                            onOpenMarketByCategory(secondaryCategory || primaryCategory)
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
                    <SceneSkillTreeGrid
                      items={items}
                      previewLimit={previewLimit}
                      onUseSkillPrompt={onUseSkillPrompt}
                      onRequestInstall={setInstallPromptItem}
                    />
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
