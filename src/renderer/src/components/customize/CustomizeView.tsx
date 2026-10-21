import { isDevelopmentThreadMetadata } from "../../../../shared/mods/development-scope"
import { AssistantWorkbench } from "./AssistantWorkbench"
import { creatorEntryError, enterCreatorMode } from "./creator-mode-entry"
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
import { useDevelopmentCreatorMode } from "@/lib/use-development-mode"
import { cn } from "@/lib/utils"
import {
  sameSimpleAuthoringScope,
  type SimpleAuthoringPracticeIntent
} from "@/lib/simple-authoring-intent"
import { openBuiltinNavigation } from "@/lib/builtin-navigation"
import { consumePluginSettings, usePluginSettingsRequest } from "@/lib/plugin-settings-intent"
import { ConfigurationTargetPicker } from "./ConfigurationTargetPicker"
import {
  beginConfigurationTarget,
  configurationTargetValid,
  configurationWorkspace,
  useConfigurationTarget,
  captureConfigurationScope,
  goToConfigurationThread,
  supportsConfiguration,
  useConfigurationDraft
} from "@/lib/configuration-target"

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

type MenuGroupId = "basic" | "advanced" | "profile" | "creator" | "creatorAdvanced"

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
    label: "创造者模式",
    items: [{ tab: "assistant", label: "对话创作", icon: Sparkles }]
  },
  {
    id: "creatorAdvanced",
    label: "高级自定义",
    items: [
      { tab: "claw", label: "搭配管理", icon: Sparkles },
      { tab: "flows", label: "聊天任务模板", icon: GitBranch }
    ]
  },
  {
    id: "basic",
    label: "基础功能",
    items: [
      { tab: "mods", label: "灵件与使用设置", icon: Webhook },
      { tab: "general", label: "通用", icon: Settings2 },
      { tab: "appearance", label: "外观", icon: Palette },
      { tab: "skills", label: "技能", icon: Sparkles },
      { tab: "connectors", label: "连接工具", icon: Plug },
      { tab: "plugins", label: "插件", icon: Puzzle },
      { tab: "sandbox", label: "沙盒环境", icon: Shield }
    ]
  },
  {
    id: "advanced",
    label: "高级特性",
    items: [
      { tab: "expertTeam", label: "专家团", icon: Users },
      { tab: "evaluation", label: "效果测试", icon: Code2 },
      { tab: "heartbeat", label: "心跳监控", icon: HeartPulse },
      { tab: "memory", label: "记忆管理", icon: Brain },
      { tab: "taskMmd", label: "任务画布", icon: Network },
      { tab: "lsp", label: "Java 代码诊断", icon: Code2 },
      { tab: "evolution", label: "自优化", icon: GitBranch },
      { tab: "robot", label: "机器人管理", icon: Cpu },
      { tab: "hooks", label: "自动触发规则", icon: Webhook },
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
    section: "examples" | "create" | "installed"
    practice?: SimpleAuthoringPracticeIntent
  } | null>(null)
  const [practiceIntent, setPracticeIntent] = useState<SimpleAuthoringPracticeIntent>()
  const [creatorBusy, setCreatorBusy] = useState(false)
  const [creatorError, setCreatorError] = useState("")
  const creatorPending = useRef(false)
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
    accountRevision,
    customizeInitialTab,
    customizeInitialSection,
    pendingEvolution,
    currentThreadId: chatThreadId,
    threads
  } = useAppStore()
  const configurationTarget = useConfigurationTarget()
  useEffect(() => {
    const state = useAppStore.getState()
    const row = state.threads.find((item) => item.thread_id === state.currentThreadId)
    return beginConfigurationTarget({
      threadId: row && supportsConfiguration(row) ? row.thread_id : null,
      workspace: row && supportsConfiguration(row) ? configurationWorkspace(row) : null
    })
  }, [])
  const targetValid = configurationTarget && configurationTargetValid(configurationTarget, threads)
  const currentThreadId = configurationTarget?.threadId ?? null
  const chatWorkspacePath = configurationWorkspace(
    threads.find((row) => row.thread_id === chatThreadId)
  )
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
  const [expandedGroups, setExpandedGroups] = useState<Record<MenuGroupId, boolean>>(
    () =>
      Object.fromEntries(
        MENU_GROUPS.map((group) => [
          group.id,
          group.id === "creator" || group.id === "basic" ||
            group.items.some((item) => item.tab === activeTab)
        ])
      ) as Record<MenuGroupId, boolean>
  )
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
  const currentWorkspacePath = configurationTarget?.workspace ?? null
  useConfigurationDraft(
    { threadId: currentThreadId, workspace: currentWorkspacePath },
    false,
    creatorBusy
  )
  const creatorUnavailable =
    !currentThreadId || !currentWorkspacePath
      ? "请先在上方选择一段具有本地项目目录的聊天。"
      : !targetValid || !isDevelopmentThreadMetadata(currentThread?.metadata)
        ? "请在上方选择普通本地聊天，再进入创造者模式。"
        : undefined
  const creatorGuideMode = useDevelopmentCreatorMode(
    !creatorUnavailable && ["mods", "claw", "flows"].includes(activeTab) ? currentThreadId : null,
    !creatorUnavailable && ["mods", "claw", "flows"].includes(activeTab)
      ? currentWorkspacePath
      : null
  )
  const startCreator = async () => {
    if (creatorPending.current) return
    if (creatorUnavailable || !currentThreadId || !currentWorkspacePath) {
      setCreatorError(creatorUnavailable ?? "请先在上方选择一段具有本地项目目录的聊天。")
      return
    }
    const scope = { threadId: currentThreadId, workspace: currentWorkspacePath }
    const current = captureConfigurationScope(scope)
    const assertCurrent = () => {
      if (!mounted.current || !current()) throw Error("DEVELOPMENT_SCOPE_CHANGED")
    }
    creatorPending.current = true
    setCreatorBusy(true)
    setCreatorError("")
    try {
      await enterCreatorMode(
        window.api.mods,
        window.api.mods.development,
        currentThreadId,
        currentWorkspacePath,
        assertCurrent
      )
      assertCurrent()
      tourRef.current?.dismiss()
      goToConfigurationThread(scope, requestComposerFocus)
    } catch (error) {
      if (mounted.current) setCreatorError(creatorEntryError(error))
    } finally {
      creatorPending.current = false
      if (mounted.current) setCreatorBusy(false)
    }
  }
  const navigationScope = JSON.stringify([currentThreadId, currentWorkspacePath])
  const initialSectionRequest = useRef<string | null>(null)
  const [previousNavigationScope, setPreviousNavigationScope] = useState(navigationScope)
  if (previousNavigationScope !== navigationScope) {
    setPreviousNavigationScope(navigationScope)
    setPracticeIntent(undefined)
    setModsNavigation(null)
    setCreatorError("")
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
      (customizeInitialSection === "create" ||
        customizeInitialSection === "examples" ||
        customizeInitialSection === "installed")
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
        {["assistant", "mods", "claw", "flows", "evaluation"].includes(activeTab) && (
          <ConfigurationTargetPicker threads={threads} />
        )}
        <SparksTour
          key={JSON.stringify([
            accountRevision,
            currentThreadId,
            currentWorkspacePath,
            creatorGuideMode
          ])}
          ref={tourRef}
          onOpenChange={setTourOpen}
          activePage={activeTab}
          activeSection={tourModsSection}
          visible={creatorGuideMode}
          onPractice={(task) => {
            if (!currentThreadId) {
              setCreatorError(creatorUnavailable ?? "请先在上方选择一段具有本地项目目录的聊天。")
              return
            }
            if (task === "inspect") {
              openBuiltinNavigation("diff", {
                threadId: currentThreadId,
                workspace: currentWorkspacePath
              })
            } else {
              void startCreator()
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
        {creatorError && activeTab !== "assistant" && activeTab !== "mods" && (
          <p role="alert" className="shrink-0 border-b px-4 py-3 text-sm text-destructive">
            {creatorError}
          </p>
        )}
        <div
          className="flex min-w-0 min-h-0 flex-1"
          inert={
            tourOpen ||
            (["mods", "claw", "flows", "evaluation"].includes(activeTab) &&
              !!currentThreadId &&
              !targetValid)
          }
          aria-hidden={tourOpen || undefined}
        >
          {activeTab === "assistant" && (
            <AssistantWorkbench
              onStartCreator={() => void startCreator()}
              creatorBusy={creatorBusy}
              creatorUnavailable={creatorUnavailable}
              creatorError={creatorError}
              onNavigate={(tab, section) => {
                setActiveTab(tab)
                if (tab === "mods" && section)
                  setModsNavigation((previous) => ({
                    id: (previous?.id ?? 0) + 1,
                    scope: JSON.stringify([currentThreadId, currentWorkspacePath]),
                    section
                  }))
              }}
            />
          )}
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
              onStartCreator={() => void startCreator()}
              creatorBusy={creatorBusy}
              creatorUnavailable={creatorUnavailable}
              creatorError={creatorError}
              threadId={currentThreadId}
              workspaceHint={currentWorkspacePath}
              onReturnToChat={() => {
                goToConfigurationThread(
                  { threadId: currentThreadId, workspace: currentWorkspacePath },
                  requestComposerFocus
                )
              }}
              onOpenReuseThread={async (id) => {
                const scope = { threadId: currentThreadId, workspace: currentWorkspacePath }
                const current = captureConfigurationScope(scope)
                await useAppStore.getState().loadThreads()
                if (!mounted.current || !current()) return
                goToConfigurationThread(scope, requestComposerFocus, id)
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
              <MemoryPanel workspacePath={chatWorkspacePath} />
            ) : activeTab === "taskMmd" ? (
              <TaskMmdPanel currentThreadId={chatThreadId} threads={threads} />
            ) : activeTab === "evolution" ? (
              <EvolutionPanel />
            ) : activeTab === "robot" ? (
              <BuiltinRobotPanel />
            ) : activeTab === "lsp" ? (
              <LspPanel threadId={chatThreadId} />
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
