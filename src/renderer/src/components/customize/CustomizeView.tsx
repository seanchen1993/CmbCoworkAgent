import { useEffect, useState } from "react"
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  GitBranch,
  GitCommit,
  HeartPulse,
  Plug,
  Puzzle,
  Sparkles,
  ShoppingBag,
  Shield,
  Cpu,
  CircleUser,
  Webhook,
  Wrench,
  type LucideIcon
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { SkillsPanel } from "./SkillsPanel"
import { McpPanel } from "./McpPanel"
import { ScheduledPanel } from "./ScheduledPanel"
import { MemoryPanel } from "./MemoryPanel"
import { HeartbeatPanel } from "./HeartbeatPanel"
import { PluginsPanel } from "./PluginsPanel"
import { MarketPanel } from "./MarketPanel"
import { SandboxPanel } from "./SandboxPanel"
import { EvolutionPanel } from "./EvolutionPanel"
import { ChatXPanel } from "./ChatXPanel"
import { UserInfoPanel } from "./UserInfoPanel"
import { HooksPanel } from "./HooksPanel"
import { LspPanel } from "./LspPanel"
import { CodeExecToolsPanel } from "./CodeExecToolsPanel"
import { CommitPolicyPanel } from "./CommitPolicyPanel"

type CustomizeTab =
  | "skills"
  | "connectors"
  | "plugins"
  | "scheduled"
  | "heartbeat"
  | "memory"
  | "market"
  | "sandbox"
  | "evolution"
  | "chatx"
  | "userinfo"
  | "hooks"
  | "lsp"
  | "codeExecTools"
  | "commitPolicy"

type MenuGroupId = "basic" | "advanced" | "profile"

type MenuItem = {
  tab: CustomizeTab
  label: string
  icon: LucideIcon
  beta?: boolean
  truncate?: boolean
}

type MenuGroup = {
  id: MenuGroupId
  label: string
  items: MenuItem[]
}

const MENU_GROUPS: MenuGroup[] = [
  {
    id: "basic",
    label: "基础功能",
    items: [
      { tab: "skills", label: "技能", icon: Sparkles },
      { tab: "connectors", label: "MCP 连接器", icon: Plug },
      { tab: "plugins", label: "插件", icon: Puzzle },
      { tab: "scheduled", label: "定时任务", icon: Clock },
      { tab: "market", label: "应用市场", icon: ShoppingBag },
      { tab: "sandbox", label: "沙盒环境", icon: Shield, beta: true }
    ]
  },
  {
    id: "advanced",
    label: "高级特性",
    items: [
      { tab: "heartbeat", label: "心跳监控", icon: HeartPulse },
      { tab: "memory", label: "记忆管理", icon: Brain },
      { tab: "lsp", label: "Java LSP", icon: Code2, beta: true },
      { tab: "evolution", label: "自优化", icon: GitBranch, beta: true },
      { tab: "chatx", label: "机器人管理", icon: Cpu },
      { tab: "hooks", label: "钩子", icon: Webhook },
      { tab: "codeExecTools", label: "编程式工具调用", icon: Wrench, beta: true, truncate: true },
      { tab: "commitPolicy", label: "提交策略", icon: GitCommit }
    ]
  },
  {
    id: "profile",
    label: "个人信息",
    items: [{ tab: "userinfo", label: "个人信息", icon: CircleUser }]
  }
]

export function CustomizeView(): React.JSX.Element {
  const {
    setShowCustomizeView,
    customizeInitialTab,
    pendingEvolution,
    setPendingEvolution,
    currentThreadId
  } = useAppStore()
  const [activeTab, setActiveTab] = useState<CustomizeTab>(
    (customizeInitialTab as CustomizeTab) || "skills"
  )
  const [expandedGroups, setExpandedGroups] = useState<Record<MenuGroupId, boolean>>({
    basic: true,
    advanced: true,
    profile: true
  })

  useEffect(() => {
    if (customizeInitialTab) {
      setActiveTab(customizeInitialTab as CustomizeTab)
    }
  }, [customizeInitialTab])

  useEffect(() => {
    if (activeTab === "evolution" && pendingEvolution) {
      setPendingEvolution(false)
    }
  }, [activeTab, pendingEvolution, setPendingEvolution])

  const toggleGroup = (groupId: MenuGroupId): void => {
    setExpandedGroups((groups) => ({ ...groups, [groupId]: !groups[groupId] }))
  }

  const renderMenuItem = (item: MenuItem): React.JSX.Element => {
    const Icon = item.icon
    const isActive = activeTab === item.tab

    return (
      <button
        key={item.tab}
        className={cn(
          "cursor-pointer flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
          isActive ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
        )}
        onClick={() => setActiveTab(item.tab)}
      >
        <Icon className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{item.label}</span>
        {item.tab === "evolution" ? (
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {pendingEvolution && <span className="size-2 rounded-full bg-orange-500 shrink-0" />}
            {item.beta && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                Beta
              </span>
            )}
          </div>
        ) : item.beta ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
            Beta
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <div className="w-[200px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-9 p-0"
            onClick={() => setShowCustomizeView(false)}
          >
            <ArrowLeft className="size-6" strokeWidth={1} />
          </Button>
          <span className="text-base font-bold">自定义</span>
        </div>
        <nav className="min-h-0 flex-1 px-3 pb-3 space-y-3 overflow-y-auto">
          {MENU_GROUPS.map((group) => {
            const expanded = expandedGroups[group.id]

            return (
              <div key={group.id} className="space-y-1">
                <button
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm font-semibold transition-colors",
                    expanded
                      ? "bg-muted/70 text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  )}
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group.id)}
                >
                  {expanded ? (
                    <ChevronDown className="size-4 shrink-0" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 text-left">{group.label}</span>
                </button>
                {expanded && (
                  <div className="space-y-0.5 pl-2 border-l border-border/60 ml-3">
                    {group.items.map(renderMenuItem)}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      </div>

      {activeTab === "skills" ? (
        <SkillsPanel />
      ) : activeTab === "connectors" ? (
        <McpPanel />
      ) : activeTab === "plugins" ? (
        <PluginsPanel />
      ) : activeTab === "scheduled" ? (
        <ScheduledPanel />
      ) : activeTab === "heartbeat" ? (
        <HeartbeatPanel />
      ) : activeTab === "memory" ? (
        <MemoryPanel />
      ) : activeTab === "market" ? (
        <MarketPanel />
      ) : activeTab === "evolution" ? (
        <EvolutionPanel />
      ) : activeTab === "chatx" ? (
        <ChatXPanel />
      ) : activeTab === "lsp" ? (
        <LspPanel threadId={currentThreadId} />
      ) : activeTab === "sandbox" ? (
        <SandboxPanel />
      ) : activeTab === "userinfo" ? (
        <UserInfoPanel />
      ) : activeTab === "hooks" ? (
        <div className="flex flex-1 overflow-hidden">
          <HooksPanel />
        </div>
      ) : activeTab === "codeExecTools" ? (
        <div className="flex flex-1 overflow-hidden">
          <CodeExecToolsPanel />
        </div>
      ) : activeTab === "commitPolicy" ? (
        <CommitPolicyPanel />
      ) : null}
    </div>
  )
}
