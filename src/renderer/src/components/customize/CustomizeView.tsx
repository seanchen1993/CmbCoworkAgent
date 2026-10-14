import { isDevelopmentThreadMetadata } from "../../../../shared/mods/development-scope"
import { AssistantWorkbench } from "./AssistantWorkbench"
import { SparksTour, type SparksTourHandle } from "./SparksTour"
import { useSettingsComposerReturn } from "./settings-return-focus"
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react"
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  ChevronRight,
  Code2,
  GitBranch,
  HeartPulse,
  Loader2,
  Network,
  Palette,
  Plug,
  Puzzle,
  Sparkles,
  Shield,
  Cpu,
  CircleUser,
  PawPrint,
  Settings2,
  Users,
  Webhook,
  Wrench,
  type LucideIcon
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  createPracticeIntent,
  sameSimpleAuthoringScope,
  type SimpleAuthoringPracticeIntent
} from "@/lib/simple-authoring-intent"
import { openBuiltinNavigation } from "@/lib/builtin-navigation"
import { consumePluginSettings, usePluginSettingsRequest } from "@/lib/plugin-settings-intent"

const SkillsPanel = lazy(() => import("./SkillsPanel").then((m) => ({ default: m.SkillsPanel })))
const GeneralPanel = lazy(() => import("./GeneralPanel").then((m) => ({ default: m.GeneralPanel })))
const AppearancePanel = lazy(() =>
  import("./AppearancePanel").then((m) => ({ default: m.AppearancePanel }))
)
const McpPanel = lazy(() => import("./McpPanel").then((m) => ({ default: m.McpPanel })))
const MemoryPanel = lazy(() => import("./MemoryPanel").then((m) => ({ default: m.MemoryPanel })))
const TaskMmdPanel = lazy(() => import("./TaskMmdPanel").then((m) => ({ default: m.TaskMmdPanel })))
const HeartbeatPanel = lazy(() =>
  import("./HeartbeatPanel").then((m) => ({ default: m.HeartbeatPanel }))
)
const PluginsPanel = lazy(() => import("./PluginsPanel").then((m) => ({ default: m.PluginsPanel })))
const ModsPanel = lazy(() => import("./ModsPanel").then((m) => ({ default: m.ModsPanel })))
const ClawPanel = lazy(() => import("./ClawPanel").then((m) => ({ default: m.ClawPanel })))
const FlowsPanel = lazy(() => import("./FlowsPanel").then((m) => ({ default: m.FlowsPanel })))
const EvaluationPanel = lazy(() =>
  import("./EvaluationPanel").then((m) => ({ default: m.EvaluationPanel }))
)
const SandboxPanel = lazy(() => import("./SandboxPanel").then((m) => ({ default: m.SandboxPanel })))
const EvolutionPanel = lazy(() =>
  import("./EvolutionPanel").then((m) => ({ default: m.EvolutionPanel }))
)
const BuiltinRobotPanel = lazy(() =>
  import("./BuiltinRobotPanel").then((m) => ({ default: m.BuiltinRobotPanel }))
)
const UserInfoPanel = lazy(() =>
  import("./UserInfoPanel").then((m) => ({ default: m.UserInfoPanel }))
)
const HooksPanel = lazy(() => import("./HooksPanel").then((m) => ({ default: m.HooksPanel })))
const LspPanel = lazy(() => import("./LspPanel").then((m) => ({ default: m.LspPanel })))
const CodeExecToolsPanel = lazy(() =>
  import("./CodeExecToolsPanel").then((m) => ({ default: m.CodeExecToolsPanel }))
)
const PetPanel = lazy(() => import("./PetPanel").then((m) => ({ default: m.PetPanel })))
const ExpertTeamPanel = lazy(() =>
  import("./ExpertTeamPanel").then((m) => ({ default: m.ExpertTeamPanel }))
)

type CustomizeTab =
  | "assistant"
  | "general"
  | "appearance"
  | "skills"
  | "connectors"
  | "plugins"
  | "mods"
  | "flows"
  | "claw"
  | "heartbeat"
  | "memory"
  | "taskMmd"
  | "sandbox"
  | "evolution"
  | "robot"
  | "userinfo"
  | "pet"
  | "hooks"
  | "lsp"
  | "codeExecTools"
  | "expertTeam"
  | "evaluation"

type MenuGroupId = "basic" | "advanced" | "profile" | "creator"

type MenuItem = {
  tab: CustomizeTab
  label: string
  icon: LucideIcon
  truncate?: boolean
}

type MenuGroup = {
  id: MenuGroupId
  label: string
  items: MenuItem[]
}

const MENU_GROUPS: MenuGroup[] = [
  {
    id: "creator",
    label: "自定义助手",
    items: [
      { tab: "assistant", label: "总览", icon: Settings2 },
      { tab: "mods", label: "添加功能", icon: Webhook },
      { tab: "claw", label: "助手组合", icon: Sparkles },
      { tab: "flows", label: "按步骤执行", icon: GitBranch },
      { tab: "evaluation", label: "效果测试", icon: Code2 }
    ]
  },
  {
    id: "basic",
    label: "基础功能",
    items: [
      { tab: "general", label: "通用", icon: Settings2 },
      { tab: "appearance", label: "外观", icon: Palette },
      { tab: "skills", label: "技能", icon: Sparkles },
      { tab: "connectors", label: "MCP 连接器", icon: Plug },
      { tab: "plugins", label: "插件", icon: Puzzle },
      { tab: "sandbox", label: "沙盒环境", icon: Shield }
    ]
  },
  {
    id: "advanced",
    label: "高级特性",
    items: [
      { tab: "expertTeam", label: "专家团", icon: Users },
      { tab: "heartbeat", label: "心跳监控", icon: HeartPulse },
      { tab: "memory", label: "记忆管理", icon: Brain },
      { tab: "taskMmd", label: "任务画布", icon: Network },
      { tab: "lsp", label: "Java LSP", icon: Code2 },
      { tab: "evolution", label: "自优化", icon: GitBranch },
      { tab: "robot", label: "机器人管理", icon: Cpu },
      { tab: "hooks", label: "钩子", icon: Webhook },
      { tab: "codeExecTools", label: "编程式工具调用", icon: Wrench, truncate: true }
    ]
  },
  {
    id: "profile",
    label: "个人信息",
    items: [
      { tab: "userinfo", label: "个人信息", icon: CircleUser },
      { tab: "pet", label: "宠物", icon: PawPrint }
    ]
  }
]

function CustomizePanelFallback(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/40">
            <Loader2 className="size-4 animate-spin text-primary" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">正在加载配置面板</p>
            <p className="text-xs text-muted-foreground">首次打开会稍等片刻</p>
          </div>
        </div>
        <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </div>
  )
}

/** Keep only visited authoring editors alive while navigating within this settings scope. */
function RetainedEditor({
  active,
  children,
  scroll = false
}: {
  active: boolean
  children: ReactNode
  scroll?: boolean
}): React.JSX.Element {
  const [visited, setVisited] = useState(active)
  if (active && !visited) setVisited(true)
  return (
    <div
      hidden={!active}
      inert={!active}
      className={cn(
        "min-w-0 min-h-0 flex-1",
        active ? "flex" : "hidden",
        scroll && "overflow-y-auto"
      )}
    >
      {(active || visited) && <Suspense fallback={<CustomizePanelFallback />}>{children}</Suspense>}
    </div>
  )
}

export function CustomizeView(): React.JSX.Element {
  const [tourOpen, setTourOpen] = useState(false)
  const tourRef = useRef<SparksTourHandle>(null)
  const [tourModsSection, setTourModsSection] = useState<"examples" | "create" | "installed">(
    "examples"
  )
  const [modsNavigation, setModsNavigation] = useState<{
    id: number
    scope: string
    section: "examples" | "create"
    practice?: SimpleAuthoringPracticeIntent
  } | null>(null)
  const [practiceIntent, setPracticeIntent] = useState<SimpleAuthoringPracticeIntent>()
  const requestComposerFocus = useSettingsComposerReturn()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const {
    setShowCustomizeView,
    customizeInitialTab,
    customizeInitialSection,
    pendingEvolution,
    currentThreadId,
    threads
  } = useAppStore()
  const [evaluationCandidate, setEvaluationCandidate] = useState<{
    threadId: string | null
    workspace: string | null
    digest: string
  } | null>(null)
  const [activeTab, setActiveTab] = useState<CustomizeTab>(
    customizeInitialTab === "commitPolicy"
      ? "skills"
      : (customizeInitialTab as CustomizeTab) || "general"
  )
  const pluginSettingsRequestId = usePluginSettingsRequest()?.id
  const pluginNavigationGeneration = useRef(0)
  useEffect(() => {
    const navigation = pluginNavigationGeneration
    const generation = ++navigation.current
    if (!pluginSettingsRequestId) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setActiveTab("plugins")
    })
    return () => {
      cancelled = true
      // Cancel only this view's request when it closes before the catalog resolves.
      // A replacement effect (including StrictMode replay) keeps its own request.
      queueMicrotask(() => {
        if (navigation.current === generation) {
          consumePluginSettings(pluginSettingsRequestId)
        }
      })
    }
  }, [pluginSettingsRequestId])
  const [expandedGroups, setExpandedGroups] = useState<Record<MenuGroupId, boolean>>(() => ({
    creator: true,
    basic: !MENU_GROUPS[0].items.some((item) => item.tab === activeTab),
    advanced: MENU_GROUPS[2].items.some((item) => item.tab === activeTab),
    profile: MENU_GROUPS[3].items.some((item) => item.tab === activeTab)
  }))
  useEffect(() => {
    let cancelled = false
    const group = MENU_GROUPS.find((entry) => entry.items.some((item) => item.tab === activeTab))
    queueMicrotask(() => {
      if (group && !cancelled) {
        setExpandedGroups((groups) => (groups[group.id] ? groups : { ...groups, [group.id]: true }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [activeTab])
  const currentThread = currentThreadId
    ? threads.find((thread) => thread.thread_id === currentThreadId)
    : null
  const currentWorkspacePath =
    typeof currentThread?.metadata?.workspacePath === "string"
      ? currentThread.metadata.workspacePath
      : null
  const navigationScope = JSON.stringify([currentThreadId, currentWorkspacePath])
  const initialSectionRequest = useRef<string | null>(null)
  const [previousNavigationScope, setPreviousNavigationScope] = useState(navigationScope)
  if (previousNavigationScope !== navigationScope) {
    setPreviousNavigationScope(navigationScope)
    setPracticeIntent(undefined)
    setModsNavigation(null)
  }

  useEffect(() => {
    if (!customizeInitialTab) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        setActiveTab(
          customizeInitialTab === "commitPolicy" ? "skills" : (customizeInitialTab as CustomizeTab)
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [customizeInitialTab])

  useEffect(() => {
    const section =
      customizeInitialTab === "mods" &&
      (customizeInitialSection === "create" || customizeInitialSection === "examples")
        ? customizeInitialSection
        : null
    const request = section ? JSON.stringify([customizeInitialTab, section]) : null
    if (initialSectionRequest.current === request) return
    if (!section) {
      initialSectionRequest.current = null
      return
    }
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      initialSectionRequest.current = request
      tourRef.current?.dismiss()
      setModsNavigation((previous) => ({
        id: (previous?.id ?? 0) + 1,
        scope: navigationScope,
        section
      }))
    })
    return () => {
      cancelled = true
    }
  }, [customizeInitialTab, customizeInitialSection, navigationScope])

  const toggleGroup = (groupId: MenuGroupId): void => {
    setExpandedGroups((groups) => ({ ...groups, [groupId]: !groups[groupId] }))
  }

  const renderMenuItem = (item: MenuItem): React.JSX.Element => {
    const Icon = item.icon
    const isActive = activeTab === item.tab

    return (
      <button
        key={item.tab}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "cursor-pointer flex items-center gap-3 w-full rounded-md px-2.5 py-1.5 text-sm transition-colors",
          isActive ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
        )}
        onClick={() => {
          tourRef.current?.dismiss()
          setActiveTab(item.tab)
        }}
      >
        <Icon className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{item.label}</span>
        {item.tab === "evolution" && pendingEvolution && (
          <span className="ml-auto size-2 shrink-0 rounded-full bg-orange-500" />
        )}
      </button>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background sm:flex-row">
      <div className="flex max-h-[35%] shrink-0 flex-col border-b border-border sm:max-h-none sm:w-[200px] sm:border-b-0 sm:border-r">
        <div className="p-3 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-9 p-0"
            aria-label="返回应用"
            onClick={() => setShowCustomizeView(false)}
          >
            <ArrowLeft className="size-6" strokeWidth={1} />
          </Button>
          <span className="text-base font-bold">返回应用</span>
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

      <div className="relative flex min-w-0 min-h-0 flex-1 flex-col">
        <SparksTour
          ref={tourRef}
          onOpenChange={setTourOpen}
          activePage={activeTab}
          activeSection={tourModsSection}
          visible={MENU_GROUPS[0].items.some((item) => item.tab === activeTab)}
          onPractice={(task, suggestedName) => {
            if (!currentThreadId) {
              setActiveTab(task === "create" ? "mods" : task === "combine" ? "claw" : "assistant")
              return
            }
            const intent = createPracticeIntent(task, {
              threadId: currentThreadId,
              workspace: currentWorkspacePath
            })
            if (suggestedName) intent.suggestedName = suggestedName
            if (task === "inspect") {
              openBuiltinNavigation("diff", intent.scope)
            } else if (task === "create") {
              setActiveTab("mods")
              setModsNavigation((previous) => ({
                id: (previous?.id ?? 0) + 1,
                scope: JSON.stringify([currentThreadId, currentWorkspacePath]),
                section: "create",
                practice: intent
              }))
            } else {
              setPracticeIntent(intent)
              setActiveTab("claw")
            }
          }}
          onNavigate={(page, section) => {
            setActiveTab(page)
            if (page === "mods" && section) {
              setModsNavigation((previous) => ({
                id: (previous?.id ?? 0) + 1,
                scope: JSON.stringify([currentThreadId, currentWorkspacePath]),
                section
              }))
            }
          }}
        />
        <div
          className="flex min-w-0 min-h-0 flex-1"
          inert={tourOpen}
          aria-hidden={tourOpen || undefined}
        >
          {activeTab === "assistant" && <AssistantWorkbench onNavigate={setActiveTab} />}
          <RetainedEditor
            key={JSON.stringify(["mods", currentThreadId, currentWorkspacePath])}
            active={activeTab === "mods"}
            scroll
          >
            <ModsPanel
              onSectionChange={setTourModsSection}
              active={activeTab === "mods"}
              navigationRequest={
                modsNavigation?.scope === JSON.stringify([currentThreadId, currentWorkspacePath])
                  ? modsNavigation
                  : undefined
              }
              developmentAllowed={isDevelopmentThreadMetadata(currentThread?.metadata)}
              threadId={currentThreadId}
              workspaceHint={currentWorkspacePath}
              onReturnToChat={() => {
                requestComposerFocus()
                setShowCustomizeView(false)
              }}
              onOpenReuseThread={async (id) => {
                await useAppStore.getState().loadThreads()
                const state = useAppStore.getState()
                const workspace =
                  state.threads.find((thread) => thread.thread_id === state.currentThreadId)
                    ?.metadata?.workspacePath ?? null
                if (
                  !mounted.current ||
                  !state.showCustomizeView ||
                  state.currentThreadId !== currentThreadId ||
                  workspace !== currentWorkspacePath
                )
                  return
                requestComposerFocus()
                // selectThread synchronously selects the thread and closes this overlay.
                // Do not close again after its promise settles: another settings session may open.
                await state.selectThread(id)
              }}
            />
          </RetainedEditor>
          <RetainedEditor
            key={JSON.stringify(["claw", currentThreadId, currentWorkspacePath])}
            active={activeTab === "claw"}
          >
            <ClawPanel
              threadId={currentThreadId}
              workspaceHint={currentWorkspacePath}
              practiceIntent={
                practiceIntent &&
                sameSimpleAuthoringScope(practiceIntent.scope, {
                  threadId: currentThreadId,
                  workspace: currentWorkspacePath
                })
                  ? practiceIntent
                  : undefined
              }
            />
          </RetainedEditor>
          <RetainedEditor
            key={JSON.stringify(["flows", currentThreadId, currentWorkspacePath])}
            active={activeTab === "flows"}
            scroll
          >
            <FlowsPanel
              threadId={currentThreadId}
              workspaceHint={currentWorkspacePath}
              onOpenMods={() => setActiveTab("mods")}
              initialDigest={
                evaluationCandidate?.threadId === currentThreadId &&
                evaluationCandidate?.workspace === currentWorkspacePath
                  ? evaluationCandidate.digest
                  : undefined
              }
            />
          </RetainedEditor>
          <Suspense fallback={<CustomizePanelFallback />}>
            {activeTab === "general" ? (
              <GeneralPanel targetSection={customizeInitialSection} />
            ) : activeTab === "appearance" ? (
              <AppearancePanel />
            ) : activeTab === "skills" ? (
              <SkillsPanel />
            ) : activeTab === "connectors" ? (
              <McpPanel />
            ) : activeTab === "plugins" ? (
              <div className="flex flex-1 min-w-0 min-h-0 overflow-hidden">
                <PluginsPanel />
              </div>
            ) : activeTab === "heartbeat" ? (
              <HeartbeatPanel />
            ) : activeTab === "memory" ? (
              <MemoryPanel workspacePath={currentWorkspacePath} />
            ) : activeTab === "taskMmd" ? (
              <TaskMmdPanel currentThreadId={currentThreadId} threads={threads} />
            ) : activeTab === "evolution" ? (
              <EvolutionPanel />
            ) : activeTab === "robot" ? (
              <BuiltinRobotPanel />
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
            ) : activeTab === "pet" ? (
              <PetPanel />
            ) : activeTab === "expertTeam" ? (
              <ExpertTeamPanel />
            ) : activeTab === "evaluation" ? (
              <EvaluationPanel
                threadId={currentThreadId}
                workspace={currentWorkspacePath}
                api={window.api.mods.evaluation}
                flowApi={window.api.mods}
                onOpenCandidate={(digest) => {
                  setEvaluationCandidate({
                    threadId: currentThreadId,
                    workspace: currentWorkspacePath,
                    digest
                  })
                  setActiveTab("flows")
                }}
              />
            ) : null}
          </Suspense>
        </div>
      </div>
    </div>
  )
}
