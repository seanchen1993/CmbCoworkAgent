import { useEffect, useState } from "react"
import { ArrowLeft, Brain, Clock, HeartPulse, Plug, Puzzle, Sparkles, ShoppingBag, Shield, Webhook } from "lucide-react"
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
import { HooksPanel } from "./HooksPanel"

type CustomizeTab = "skills" | "connectors" | "plugins" | "scheduled" | "heartbeat" | "memory" | "market" | "hooks" | "sandbox"

export function CustomizeView(): React.JSX.Element {
  const { setShowCustomizeView, customizeInitialTab } = useAppStore()
  const [activeTab, setActiveTab] = useState<CustomizeTab>(
    (customizeInitialTab as CustomizeTab) || "skills"
  )

  useEffect(() => {
    if (customizeInitialTab) {
      setActiveTab(customizeInitialTab as CustomizeTab)
    }
  }, [customizeInitialTab])

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
      ) : activeTab === "hooks" ? (
        <HooksPanel />
      ) : activeTab === "sandbox" ? (
        <SandboxPanel />
      ) : null}
    </div>
  )
}
