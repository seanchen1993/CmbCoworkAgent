import React, { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Code2,
  Database,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Layers,
  LayoutTemplate,
  Notebook,
  Palette,
  Presentation,
  Search,
  Settings2,
  ShieldCheck,
  Clock
} from "lucide-react"
import type { SkillMetadata } from "@/types"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SkillsByCategorySection } from "./SkillsByCategorySection"
import { marketApi, type MarketItem } from "../../api/market"
import {
  buildMarketInstalledFlags,
  isMarketVersionDifferent,
  marketInstalledVersionStorage,
  MarketUpdateBadge
} from "@/components/customize/MarketPanel/MarketUpdateBadge"
import { DEFAULT_SCENE_CATEGORY, SCENE_CATEGORY_OPTIONS } from "@/lib/skill-data-service"
import { getSkillMetadataId, normalizeSkillId } from "@/lib/skill-ids"
import { groupWelcomeSkills } from "./skill-grouping"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

const MARKET_SKILLS_CACHE_TTL_MS = 10 * 60 * 1000
const FEATURED_INSTALL_RETRY_MS = 10 * 60 * 1000
const GOOD_SKILLS_PREVIEW_LIMIT = 4
const PROGRAMMING_SKILL_IDS = new Set([
  "security-review",
  "code-review-expert",
  "vercel-react-best-practices",
  "audit-website",
  "supabase-postgres-best-practices",
  "typescript-advanced-types",
  "api-design-principles",
  "architecture-patterns",
  "error-handling-patterns",
  "planning-with-files",
  "mcp-builder",
  "webapp-testing",
  "frontend-design"
])

interface MarketSkillsSnapshot {
  allSkills: MarketItem[]
  goodSkills: MarketItem[]
  fetchedAt: number
}

let marketSkillsSnapshot: MarketSkillsSnapshot | null = null
let marketSkillsRequest: Promise<MarketSkillsSnapshot> | null = null
let featuredSkillsInstallRequest: Promise<boolean> | null = null
// Re-check market versions periodically without re-downloading on every mount.
let lastFeaturedInstallAttemptAt = 0

async function loadMarketSkillsSnapshot(): Promise<MarketSkillsSnapshot> {
  const now = Date.now()
  if (marketSkillsSnapshot && now - marketSkillsSnapshot.fetchedAt < MARKET_SKILLS_CACHE_TTL_MS) {
    return marketSkillsSnapshot
  }

  if (!marketSkillsRequest) {
    marketSkillsRequest = marketApi
      .getSkills()
      .then((res) => {
        const allSkills = res?.data || []
        const snapshot = {
          allSkills,
          goodSkills: allSkills.filter((item) => item.featured === "精品"),
          fetchedAt: Date.now()
        }
        marketSkillsSnapshot = snapshot
        return snapshot
      })
      .finally(() => {
        marketSkillsRequest = null
      })
  }

  return marketSkillsRequest
}

async function installFeaturedSkills(
  goodSkills: MarketItem[]
): Promise<{ changed: boolean; hadFailure: boolean }> {
  if (goodSkills.length === 0) return { changed: false, hadFailure: false }

  console.log("Starting automatic installation of good skills...")
  let skillsMetadata = await window.api.skills.list()
  let changed = false
  let hadFailure = false

  for (const skill of goodSkills) {
    try {
      const skillName = skill.name || skill.id || ""

      if (!skillName) {
        console.error("Skill name is required for installation:", skill)
        continue
      }

      console.log(`Installing skill: ${skillName}`)
      const existingSkill = skillsMetadata.find((item) => item.name === skillName)

      // Install when missing, untracked, or out of date; otherwise preserve the
      // existing directory and avoid downloading on every session entry.
      const installedVersion = marketInstalledVersionStorage.getVersion(skillName, "skill")
      const shouldInstall =
        !existingSkill ||
        !installedVersion ||
        isMarketVersionDifferent(installedVersion, skill.version)

      if (!shouldInstall) {
        console.log(`Skill ${skillName} is already up to date, skipping install.`)
        continue
      }

      if (existingSkill) {
        console.log(`Deleting existing skill: ${existingSkill.path}`)
        try {
          await window.api.skills.delete(existingSkill.path)
          skillsMetadata = skillsMetadata.filter((item) => item.path !== existingSkill.path)
        } catch (deleteError) {
          console.warn(
            `Failed to delete existing skill ${skillName}, continuing with install:`,
            deleteError
          )
        }
      }

      const response = await marketApi.downloadItem(skillName, "skill", false)

      if (response.success) {
        marketInstalledVersionStorage.setVersion(skillName, "skill", skill.version)
        changed = true
        console.log(`Successfully installed skill: ${skillName}`)
      } else {
        hadFailure = true
        console.error(`Failed to install skill ${skillName}:`, response.error)
      }
    } catch (error) {
      hadFailure = true
      console.error(`Failed to install skill ${skill.name}:`, error)
    }
  }

  console.log("Finished automatic installation of good skills")
  return { changed, hadFailure }
}

async function installFeaturedSkillsOnce(goodSkills: MarketItem[]): Promise<boolean> {
  if (goodSkills.length === 0) return false
  if (featuredSkillsInstallRequest) return featuredSkillsInstallRequest

  const now = Date.now()
  if (
    lastFeaturedInstallAttemptAt !== 0 &&
    now - lastFeaturedInstallAttemptAt < FEATURED_INSTALL_RETRY_MS
  ) {
    return false
  }
  lastFeaturedInstallAttemptAt = now

  featuredSkillsInstallRequest = installFeaturedSkills(goodSkills)
    .then(({ changed }) => changed)
    .finally(() => {
      featuredSkillsInstallRequest = null
    })

  return featuredSkillsInstallRequest
}

type WelcomeSkillCard = {
  skill: SkillMetadata
  label: string
  icon: React.JSX.Element
  installedVersion?: string | null
  currentVersion?: string | null
  updateAvailable?: boolean
}

type WelcomeSkillSceneGroup = {
  category: string
  cards: WelcomeSkillCard[]
}

type WelcomeSkillTreeNode = {
  key: string
  label: string
  card?: WelcomeSkillCard
  children: WelcomeSkillTreeNode[]
}

function getSkillId(skill: SkillMetadata): string {
  const idSegments = getSkillMetadataId(skill).split("/").filter(Boolean)
  const fromId = idSegments.length > 0 ? idSegments[idSegments.length - 1] : undefined
  const fromPath = skill?.path?.replace(/\\/g, "/").split("/").slice(-2, -1)[0]
  return (fromId || fromPath || skill.name || "").toLowerCase()
}

function getSkillSummary(skill: SkillMetadata): string {
  const skillId = getSkillId(skill)

  if (skill.source === "user") {
    return skill.name || skillId || "自定义技能"
  }

  const summaryMap: Record<string, string> = {
    "algorithmic-art": "生成艺术图案",
    "brand-guidelines": "统一品牌风格",
    "canvas-design": "设计视觉海报",
    docx: "编辑 Word 文档",
    "doc-coauthoring": "协作撰写文档",
    "frontend-design": "设计前端界面",
    "internal-comms": "撰写内部沟通稿",
    "mcp-builder": "搭建 MCP 服务",
    pdf: "处理 PDF 文档",
    pptx: "制作演示文稿",
    "skill-creator": "创建新技能包",
    "slack-gif-creator": "制作 Slack 动图",
    "theme-factory": "应用主题风格",
    "web-app-testing": "测试 Web 应用",
    "webapp-testing": "测试 Web 应用",
    "web-artifacts-builder": "构建交互页面",
    xlsx: "处理表格数据",
    "security-review": "安全代码审查",
    "code-review-expert": "结构化代码审查",
    "vercel-react-best-practices": "React 最佳实践",
    "audit-website": "网站安全审计",
    "supabase-postgres-best-practices": "PostgreSQL 优化",
    "typescript-advanced-types": "TS 高级类型优化",
    "api-design-principles": "API 设计原则",
    "architecture-patterns": "架构模式设计",
    "error-handling-patterns": "错误处理模式",
    "planning-with-files": "文件驱动规划",
    "scheduler-assistant": "定时任务管理"
  }
  return summaryMap[skillId] || "完成专项任务"
}

function getSkillIcon(skill: SkillMetadata): React.JSX.Element {
  const iconMap: Record<string, React.JSX.Element> = {
    "algorithmic-art": <Palette className="size-4" />,
    "brand-guidelines": <Palette className="size-4" />,
    "canvas-design": <LayoutTemplate className="size-4" />,
    docx: <FileText className="size-4" />,
    "doc-coauthoring": <FileText className="size-4" />,
    "frontend-design": <LayoutTemplate className="size-4" />,
    "internal-comms": <FileText className="size-4" />,
    "mcp-builder": <Code2 className="size-4" />,
    pdf: <FileText className="size-4" />,
    pptx: <Presentation className="size-4" />,
    "skill-creator": <Settings2 className="size-4" />,
    "slack-gif-creator": <FlaskConical className="size-4" />,
    "theme-factory": <Palette className="size-4" />,
    "web-app-testing": <FlaskConical className="size-4" />,
    "webapp-testing": <FlaskConical className="size-4" />,
    "web-artifacts-builder": <LayoutTemplate className="size-4" />,
    xlsx: <FileSpreadsheet className="size-4" />,
    "security-review": <Code2 className="size-4" />,
    "code-review-expert": <Code2 className="size-4" />,
    "vercel-react-best-practices": <Code2 className="size-4" />,
    "audit-website": <ShieldCheck className="size-4" />,
    "supabase-postgres-best-practices": <Database className="size-4" />,
    "typescript-advanced-types": <Code2 className="size-4" />,
    "api-design-principles": <Layers className="size-4" />,
    "architecture-patterns": <Layers className="size-4" />,
    "error-handling-patterns": <AlertCircle className="size-4" />,
    "planning-with-files": <FileText className="size-4" />,
    "scheduler-assistant": <Clock className="size-4" />
  }
  return iconMap[getSkillId(skill)] || <Search className="size-4" />
}

function getWelcomeSkillTreePath(skill: SkillMetadata): string {
  const id = skill.id?.startsWith("plugin:") ? skill.id.split("/").slice(1).join("/") : skill.id
  return String(skill.relativePath || id || skill.name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
}

function buildWelcomeSkillTree(cards: WelcomeSkillCard[]): WelcomeSkillTreeNode[] {
  const root: WelcomeSkillTreeNode = { key: "root", label: "root", children: [] }
  const indexByNode = new WeakMap<WelcomeSkillTreeNode, Map<string, WelcomeSkillTreeNode>>()

  const getIndex = (node: WelcomeSkillTreeNode): Map<string, WelcomeSkillTreeNode> => {
    let index = indexByNode.get(node)
    if (!index) {
      index = new Map(node.children.map((child) => [normalizeSkillId(child.label), child]))
      indexByNode.set(node, index)
    }
    return index
  }

  for (const card of cards) {
    const segments = getWelcomeSkillTreePath(card.skill).split("/").filter(Boolean)
    const fallbackSegments = segments.length > 0 ? segments : [card.skill.name]
    let current = root

    for (const segment of fallbackSegments) {
      const normalized = normalizeSkillId(segment)
      const childIndex = getIndex(current)
      let child = childIndex.get(normalized)
      if (!child) {
        child = { key: `${current.key}/${normalized}`, label: segment, children: [] }
        current.children.push(child)
        childIndex.set(normalized, child)
      }
      current = child
    }

    current.card = card
  }

  const sortNodes = (nodes: WelcomeSkillTreeNode[]): WelcomeSkillTreeNode[] =>
    [...nodes]
      .sort((a, b) => {
        const labelA = a.card?.label || a.label
        const labelB = b.card?.label || b.label
        return labelA.localeCompare(labelB, "zh-CN")
      })
      .map((node) => ({ ...node, children: sortNodes(node.children) }))

  return sortNodes(root.children)
}

function countWelcomeSkillTreeCards(node: WelcomeSkillTreeNode): number {
  return (
    (node.card ? 1 : 0) +
    node.children.reduce((sum, child) => sum + countWelcomeSkillTreeCards(child), 0)
  )
}

function getWelcomeSkillTopLevelKey(skill: SkillMetadata): string {
  return normalizeSkillId(
    getWelcomeSkillTreePath(skill).split("/").filter(Boolean)[0] || skill.name
  )
}

function limitWelcomeSkillsByTopLevel(
  skills: SkillMetadata[],
  previewLimit: number
): SkillMetadata[] {
  if (previewLimit <= 0) return []
  const selectedRoots = new Set<string>()

  for (const skill of skills) {
    selectedRoots.add(getWelcomeSkillTopLevelKey(skill))
    if (selectedRoots.size >= previewLimit) break
  }

  return skills.filter((skill) => selectedRoots.has(getWelcomeSkillTopLevelKey(skill)))
}

function WelcomeSkillButton(props: {
  card: WelcomeSkillCard
  disabled?: boolean
  onUseSkill: (skill: SkillMetadata, label?: string) => void
  getSkillShowLabel: (name: string) => string
}): React.JSX.Element {
  const { card, disabled = false, onUseSkill, getSkillShowLabel } = props
  const label = getSkillShowLabel(card.label)

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onUseSkill(card.skill, card.label)
      }}
      className={cn(
        "group w-full rounded-xl border px-3 py-2 text-left transition-all",
        disabled
          ? "cursor-not-allowed border-border/70 bg-background/60 opacity-65"
          : "border-slate-300/90 bg-slate-50/70 shadow-[0_1px_0_rgba(15,23,42,0.05)] hover:border-slate-400/95 hover:bg-slate-100/95 hover:shadow-[0_2px_8px_rgba(15,23,42,0.12)] dark:border-slate-600/85 dark:bg-slate-900/35 dark:hover:border-slate-500/95 dark:hover:bg-slate-800/55"
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div
          className={cn(
            "rounded-md border p-1.5 transition-colors",
            disabled
              ? "border-border/70 bg-background/70 text-muted-foreground"
              : "border-slate-300/90 bg-white/80 text-slate-500 group-hover:text-slate-700 dark:border-slate-600/80 dark:bg-slate-900/45 dark:text-slate-300 dark:group-hover:text-slate-100"
          )}
        >
          {card.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <div
              className={cn(
                "min-w-0 flex-1 truncate whitespace-nowrap text-xs leading-5",
                disabled ? "text-muted-foreground line-through" : "text-foreground"
              )}
            >
              {label}
            </div>
            {card.updateAvailable && (
              <MarketUpdateBadge
                typeLabel="技能"
                installedVersion={card.installedVersion}
                currentVersion={card.currentVersion}
                className="px-1.5 py-0 text-[10px]"
              />
            )}
          </div>
        </div>
      </div>
    </button>
  )
}

function WelcomeSkillTree(props: {
  cards: WelcomeSkillCard[]
  disabled?: boolean
  onUseSkill: (skill: SkillMetadata, label?: string) => void
  getSkillShowLabel: (name: string) => string
}): React.JSX.Element {
  const { cards, disabled = false, onUseSkill, getSkillShowLabel } = props
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const tree = useMemo(() => buildWelcomeSkillTree(cards), [cards])
  const toggleNode = useCallback((nodeKey: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeKey)) next.delete(nodeKey)
      else next.add(nodeKey)
      return next
    })
  }, [])

  return (
    <WelcomeSkillTreeList
      nodes={tree}
      disabled={disabled}
      nested={false}
      expandedNodes={expandedNodes}
      onToggleNode={toggleNode}
      onUseSkill={onUseSkill}
      getSkillShowLabel={getSkillShowLabel}
    />
  )
}

function WelcomeSkillTreeList(props: {
  nodes: WelcomeSkillTreeNode[]
  disabled: boolean
  nested: boolean
  expandedNodes: Set<string>
  onToggleNode: (nodeKey: string) => void
  onUseSkill: (skill: SkillMetadata, label?: string) => void
  getSkillShowLabel: (name: string) => string
}): React.JSX.Element {
  const { nodes, disabled, nested, expandedNodes, onToggleNode, onUseSkill, getSkillShowLabel } =
    props

  return (
    <div className={nested ? "grid grid-cols-1 gap-1.5" : "grid grid-cols-2 gap-2 md:grid-cols-4"}>
      {nodes.map((node) => {
        const childrenExpanded = expandedNodes.has(node.key)
        const childCount = node.children.reduce(
          (sum, child) => sum + countWelcomeSkillTreeCards(child),
          0
        )

        return (
          <div key={node.key} className="min-w-0 space-y-1.5">
            {node.card ? (
              <WelcomeSkillButton
                card={node.card}
                disabled={disabled}
                onUseSkill={onUseSkill}
                getSkillShowLabel={getSkillShowLabel}
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
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                    {childCount}
                  </Badge>
                </div>
              </button>
            )}

            {node.children.length > 0 && (
              <button
                type="button"
                onClick={() => onToggleNode(node.key)}
                className="flex min-h-7 w-full items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/15 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/30"
              >
                {expandedNodes.has(node.key) ? (
                  <ChevronDown className="size-3 shrink-0" />
                ) : (
                  <ChevronRight className="size-3 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">子技能</span>
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  {childCount}
                </Badge>
              </button>
            )}

            {expandedNodes.has(node.key) && (
              <div className="border-l border-border/60 pl-2">
                <WelcomeSkillTreeList
                  nodes={node.children}
                  disabled={disabled}
                  nested
                  expandedNodes={expandedNodes}
                  onToggleNode={onToggleNode}
                  onUseSkill={onUseSkill}
                  getSkillShowLabel={getSkillShowLabel}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export interface WelcomeSkillsProps {
  skills: SkillMetadata[]
  skillsLoading: boolean
  enabledSkillsForSlash: SkillMetadata[]
  shouldShowWelcomeSkillTabs: boolean
  isLocalSkillDisabled: (skill: SkillMetadata) => boolean
  onSkillsInstalled: () => void | Promise<void>
  onUseSkillPrompt: (skill: SkillMetadata, customPrompt?: string) => void
  onOpenMarketByCategory: (category: string) => void
  onOpenOrganizationSkillMarket: (skillName?: string) => void
  onOpenMarketBySkill: (skillName: string) => void
}

export function WelcomeSkills({
  skills,
  skillsLoading,
  enabledSkillsForSlash,
  shouldShowWelcomeSkillTabs,
  isLocalSkillDisabled,
  onSkillsInstalled,
  onUseSkillPrompt,
  onOpenMarketByCategory,
  onOpenOrganizationSkillMarket,
  onOpenMarketBySkill
}: WelcomeSkillsProps): React.JSX.Element | null {

  const [marketSkillsData, setMarketSkillsData] = useState<MarketItem[]>([])
  const [goodSkillsData, setGoodSkillsData] = useState<MarketItem[]>([])
  const [showAllProgrammingSkills, setShowAllProgrammingSkills] = useState(false)
  const [showAllCustomSkills, setShowAllCustomSkills] = useState(false)
  const instructionUrl = import.meta.env.VITE_INTRUCTION_URL

  const isProgrammingSkill = useCallback(
    (skill: SkillMetadata): boolean => PROGRAMMING_SKILL_IDS.has(getSkillId(skill)),
    []
  )

  const getSkillShowLabel = useCallback(
    (name: string): string => {
      const target = marketSkillsData.find(
        (item) => item.name === name || item.chinese_name === name
      )
      return target?.chinese_name || name || ""
    },
    [marketSkillsData]
  )

  const getTargetRemoteSkill = useCallback(
    (name: string): string => {
      const target = marketSkillsData.find(
        (item) => item.name === name || item.chinese_name === name
      )
      return target?.guidance || ""
    },
    [marketSkillsData]
  )

  const handleUseSkillPrompt = useCallback(
    (skill: SkillMetadata, label?: string): void => {
      onUseSkillPrompt(skill, label ? getTargetRemoteSkill(label) || undefined : undefined)
    },
    [getTargetRemoteSkill, onUseSkillPrompt]
  )

  const queryRemoteSkills = useCallback(async (): Promise<void> => {
    try {
      const { allSkills, goodSkills } = await loadMarketSkillsSnapshot()
      setMarketSkillsData(allSkills)
      setGoodSkillsData(goodSkills)

      const installed = await installFeaturedSkillsOnce(goodSkills)
      if (installed) {
        await onSkillsInstalled()
      }
    } catch (error) {
      console.error("Failed to query remote skills:", error)
    }
  }, [onSkillsInstalled])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void queryRemoteSkills()
    }, 0)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [queryRemoteSkills])

  const marketSkillCategoryByName = useMemo(() => {
    const categoryByName = new Map<string, string>()
    for (const item of marketSkillsData) {
      if (!item.category) continue
      categoryByName.set(item.name, item.category)
      if (item.chinese_name) categoryByName.set(item.chinese_name, item.category)
    }
    return categoryByName
  }, [marketSkillsData])

  const marketSkillUpdateByName = useMemo(() => {
    const updateByName = new Map<
      string,
      {
        installedVersion?: string
        currentVersion?: string | null
        updateAvailable: boolean
        displayName: string
      }
    >()

    for (const item of marketSkillsData) {
      const flags = buildMarketInstalledFlags(item, "skill", true)
      const updateInfo = {
        installedVersion: flags.installedVersion,
        currentVersion: item.version,
        updateAvailable: flags.updateAvailable,
        displayName: item.chinese_name || item.name
      }
      updateByName.set(item.name, updateInfo)
      if (item.chinese_name) updateByName.set(item.chinese_name, updateInfo)
    }

    return updateByName
  }, [marketSkillsData])

  const getSkillMarketUpdateInfo = useCallback(
    (skill: SkillMetadata) =>
      marketSkillUpdateByName.get(skill.name) ||
      (skill.relativePath ? marketSkillUpdateByName.get(skill.relativePath) : undefined) ||
      null,
    [marketSkillUpdateByName]
  )

  const { generalSkills, programmingSkills, enabledCustomSkills, disabledLocalSkills } = useMemo(
    () => groupWelcomeSkills(skills, goodSkillsData, isLocalSkillDisabled, isProgrammingSkill),
    [goodSkillsData, isLocalSkillDisabled, isProgrammingSkill, skills]
  )

  const programmingSkillCards = useMemo(() => {
    const source = showAllProgrammingSkills ? programmingSkills : programmingSkills.slice(0, 8)
    return source.map((skill) => ({
      skill,
      label: getSkillSummary(skill),
      icon: getSkillIcon(skill)
    }))
  }, [programmingSkills, showAllProgrammingSkills])

  const getSkillSceneCategory = useCallback(
    (skill: SkillMetadata): string => {
      const category =
        skill.metadata?.category ||
        marketSkillCategoryByName.get(skill.name) ||
        DEFAULT_SCENE_CATEGORY
      return category.trim() || DEFAULT_SCENE_CATEGORY
    },
    [marketSkillCategoryByName]
  )

  const buildWelcomeSkillGroups = useCallback(
    (sourceSkills: SkillMetadata[]): WelcomeSkillSceneGroup[] => {
      const groups = new Map<string, WelcomeSkillCard[]>()
      for (const skill of sourceSkills) {
        const category = getSkillSceneCategory(skill)
        const cards = groups.get(category) ?? []
        cards.push({
          skill,
          label: getSkillSummary(skill),
          icon: getSkillIcon(skill),
          ...getSkillMarketUpdateInfo(skill)
        })
        groups.set(category, cards)
      }

      const categoryOrder = new Map<string, number>(
        SCENE_CATEGORY_OPTIONS.map((category, index) => [category, index])
      )
      return [...groups.entries()]
        .sort(([categoryA], [categoryB]) => {
          const rankA = categoryOrder.get(categoryA) ?? Number.MAX_SAFE_INTEGER
          const rankB = categoryOrder.get(categoryB) ?? Number.MAX_SAFE_INTEGER
          return rankA === rankB ? categoryA.localeCompare(categoryB, "zh-CN") : rankA - rankB
        })
        .map(([category, cards]) => ({ category, cards }))
    },
    [getSkillMarketUpdateInfo, getSkillSceneCategory]
  )

  const enabledCustomSkillGroups = useMemo(() => {
    const source = showAllCustomSkills
      ? enabledCustomSkills
      : limitWelcomeSkillsByTopLevel(enabledCustomSkills, 8)
    return buildWelcomeSkillGroups(source)
  }, [buildWelcomeSkillGroups, enabledCustomSkills, showAllCustomSkills])

  const disabledCustomSkillGroups = useMemo(
    () => buildWelcomeSkillGroups(disabledLocalSkills),
    [buildWelcomeSkillGroups, disabledLocalSkills]
  )

  const customSkillUpdateCount = useMemo(
    () =>
      [...enabledCustomSkills, ...disabledLocalSkills].filter(
        (skill) => getSkillMarketUpdateInfo(skill)?.updateAvailable
      ).length,
    [disabledLocalSkills, enabledCustomSkills, getSkillMarketUpdateInfo]
  )

  const helpSceneSkillCards = useMemo(() => {
    const helpSceneSkillIds = new Set(["scheduler-assistant", "skill-creator"])
    return generalSkills
      .filter((skill) => helpSceneSkillIds.has(getSkillId(skill)))
      .map((skill) => ({
        skill,
        label: getSkillSummary(skill),
        icon: getSkillIcon(skill)
      }))
  }, [generalSkills])

  const handleCopyToClipboard = useCallback((text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        toast.success("已复制目标链接到剪切板，请在浏览器中打开查看")
      },
      (error) => {
        console.error("Failed to copy text: ", error)
        toast.error("复制失败，请重试")
      }
    )
  }, [])

  return (
    <div className="pb-8">
      {skillsLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">正在加载技能列表...</div>
      ) : skills.length === 0 ? null : (
        <div className="space-y-3">
          {programmingSkillCards.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium tracking-wider text-muted-foreground">
                编程场景
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {programmingSkillCards.map(({ skill, label, icon }) => (
                  <button
                    key={label + skill.path}
                    type="button"
                    onClick={() => handleUseSkillPrompt(skill)}
                    className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left transition-colors hover:border-border hover:bg-accent/35"
                  >
                    <div className="flex items-center gap-3">
                      <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground transition-colors group-hover:text-foreground">
                        {icon}
                      </div>
                      <div className="text-xs leading-5 text-foreground">{label}</div>
                    </div>
                  </button>
                ))}
              </div>
              {programmingSkills.length > 8 && (
                <button
                  type="button"
                  onClick={() => setShowAllProgrammingSkills((previous) => !previous)}
                  className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
                >
                  {showAllProgrammingSkills ? (
                    <>
                      <ChevronUp className="size-3.5" />
                      <span>收起</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown className="size-3.5" />
                      <span>展开更多（+{programmingSkills.length - 8}）</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {shouldShowWelcomeSkillTabs && (
            <Tabs defaultValue="skills-by-category" className="space-y-3">
              <TabsList className="grid h-9 w-full grid-cols-3">
                <TabsTrigger value="skills-by-category" className="text-xs">
                  场景技能
                </TabsTrigger>
                <TabsTrigger value="installed-skills" className="gap-1.5 text-xs">
                  我安装的技能
                  {customSkillUpdateCount > 0 && (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-teal-100 px-1 text-[10px] font-semibold leading-none text-teal-700 dark:bg-teal-900/40 dark:text-teal-200">
                      {customSkillUpdateCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="help" className="text-xs">
                  帮助
                </TabsTrigger>
              </TabsList>

              <TabsContent value="skills-by-category" className="mt-0">
                <SkillsByCategorySection
                  skills={enabledSkillsForSlash}
                  previewLimit={GOOD_SKILLS_PREVIEW_LIMIT}
                  onOpenMarketByCategory={onOpenMarketByCategory}
                  onOpenOrganizationSkillMarket={onOpenOrganizationSkillMarket}
                  onOpenMarketBySkill={onOpenMarketBySkill}
                  onUseSkillPrompt={handleUseSkillPrompt}
                />
              </TabsContent>

              <TabsContent value="installed-skills" className="mt-0 space-y-3">
                {enabledCustomSkillGroups.length > 0 ? (
                  <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/35 px-2 py-2 dark:border-emerald-900/40 dark:bg-emerald-950/10">
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-emerald-800 dark:text-emerald-200">
                      <span>已启用技能</span>
                      <Badge
                        variant="outline"
                        className="h-5 min-w-6 justify-center px-1.5 text-[10px]"
                      >
                        {enabledCustomSkills.length}
                      </Badge>
                    </div>
                    <div className="space-y-3">
                      {enabledCustomSkillGroups.map((group) => (
                        <div key={group.category} className="space-y-2">
                          <div className="text-xs font-medium tracking-wider text-muted-foreground">
                            {group.category}
                          </div>
                          <WelcomeSkillTree
                            cards={group.cards}
                            onUseSkill={handleUseSkillPrompt}
                            getSkillShowLabel={getSkillShowLabel}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="group w-full rounded-xl border border-slate-300/90 bg-slate-50/70 px-3 py-2 text-left shadow-[0_1px_0_rgba(15,23,42,0.05)] transition-all hover:border-slate-400/95 hover:bg-slate-100/95 hover:shadow-[0_2px_8px_rgba(15,23,42,0.12)] dark:border-slate-600/85 dark:bg-slate-900/35 dark:hover:border-slate-500/95 dark:hover:bg-slate-800/55"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="rounded-md border border-slate-300/90 bg-white/80 p-1.5 text-slate-500 transition-colors group-hover:text-slate-700 dark:border-slate-600/80 dark:bg-slate-900/45 dark:text-slate-300 dark:group-hover:text-slate-100">
                        <CircleAlert className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate whitespace-nowrap text-xs leading-5 text-foreground">
                          暂无
                        </div>
                      </div>
                    </div>
                  </button>
                )}

                {enabledCustomSkills.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setShowAllCustomSkills((previous) => !previous)}
                    className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
                  >
                    {showAllCustomSkills ? (
                      <>
                        <ChevronUp className="size-3.5" />
                        <span>收起</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown className="size-3.5" />
                        <span>展开更多（+{enabledCustomSkills.length - 8}）</span>
                      </>
                    )}
                  </button>
                )}

                {disabledLocalSkills.length > 0 && (
                  <details className="rounded-lg border border-border/70 bg-muted/20 px-2 py-2">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                      <span>已禁用技能</span>
                      <Badge
                        variant="outline"
                        className="h-5 min-w-6 justify-center px-1.5 text-[10px]"
                      >
                        {disabledLocalSkills.length}
                      </Badge>
                    </summary>
                    <div className="mt-2 space-y-2">
                      {disabledCustomSkillGroups.map((group) => (
                        <div key={group.category} className="space-y-2">
                          <div className="text-xs font-medium tracking-wider text-muted-foreground/80">
                            {group.category}
                          </div>
                          <WelcomeSkillTree
                            cards={group.cards}
                            disabled
                            onUseSkill={handleUseSkillPrompt}
                            getSkillShowLabel={getSkillShowLabel}
                          />
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </TabsContent>

              <TabsContent value="help" className="mt-0 space-y-2">
                {helpSceneSkillCards.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium tracking-wider text-muted-foreground">
                      通用场景
                    </div>
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                      {helpSceneSkillCards.map(({ skill, label, icon }) => (
                        <button
                          key={label + skill.path}
                          type="button"
                          onClick={() => handleUseSkillPrompt(skill)}
                          className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left transition-colors hover:border-border hover:bg-accent/35"
                        >
                          <div className="flex items-center gap-3">
                            <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground transition-colors group-hover:text-foreground">
                              {icon}
                            </div>
                            <div className="text-xs leading-5 text-foreground">{label}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="text-xs font-medium tracking-wider text-muted-foreground">帮助</div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <button
                    onClick={() => handleCopyToClipboard(instructionUrl)}
                    type="button"
                    className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left transition-colors hover:border-border hover:bg-accent/35"
                  >
                    <div className="flex items-center gap-3">
                      <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground transition-colors group-hover:text-foreground">
                        <Notebook size={14} />
                      </div>
                      <div className="text-xs leading-5 text-foreground">操作说明文档</div>
                    </div>
                  </button>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      )}
    </div>
  )
}
