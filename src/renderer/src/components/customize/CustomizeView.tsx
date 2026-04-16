import { useEffect, useState } from "react"
import { ArrowLeft, Brain, Clock, Code2, GitBranch, HeartPulse, Plug, Puzzle, Sparkles, ShoppingBag, Shield, Cpu, CircleUser, Webhook, Wrench } from "lucide-react"
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
        <nav className="px-3 space-y-0.5">
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "skills"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("skills")}
          >
            <Sparkles className="size-4 shrink-0" />
            技能
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "connectors"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("connectors")}
          >
            <Plug className="size-4 shrink-0" />
            MCP 连接器
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "plugins"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("plugins")}
          >
            <Puzzle className="size-4 shrink-0" />
            插件
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "scheduled"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("scheduled")}
          >
            <Clock className="size-4 shrink-0" />
            定时任务
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "heartbeat"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("heartbeat")}
          >
            <HeartPulse className="size-4 shrink-0" />
            心跳监控
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "memory"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("memory")}
          >
            <Brain className="size-4 shrink-0" />
            记忆管理
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "market"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("market")}
          >
            <ShoppingBag className="size-4 shrink-0" />
            应用市场
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "lsp"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("lsp")}
          >
            <Code2 className="size-4 shrink-0" />
            Java LSP
            <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Beta</span>
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "evolution"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("evolution")}
          >
            <GitBranch className="size-4 shrink-0" />
            自优化
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {pendingEvolution && <span className="size-2 rounded-full bg-orange-500 shrink-0" />}
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Beta</span>
            </div>
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "sandbox"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("sandbox")}
          >
            <Shield className="size-4 shrink-0" />
            沙盒环境
            <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Beta</span>
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "chatx"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("chatx")}
          >
            <Cpu className="size-4 shrink-0" />
            机器人管理
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "userinfo"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("userinfo")}
          >
            <CircleUser className="size-4 shrink-0" />
            个人信息
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "hooks"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("hooks")}
          >
            <Webhook className="size-4 shrink-0" />
            钩子
          </button>
          <button
            className={cn(
              "flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeTab === "codeExecTools"
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            )}
            onClick={() => setActiveTab("codeExecTools")}
          >
            <Wrench className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">编程式工具调用</span>
            <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Beta</span>
          </button>
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
      ) : null}
    </div>
  )
}
