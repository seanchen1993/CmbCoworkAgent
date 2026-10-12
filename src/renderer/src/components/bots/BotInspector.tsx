import type { BotTeachArm } from "../../../../shared/bot-teach"
import { useState, type ReactNode } from "react"
import { BookOpen, Brain, ChevronRight, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAppStore } from "@/lib/store"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import type { CoworkBot } from "../../../../shared/bot-types"
import { BotAvatar } from "./BotAvatar"
import { BotComputer } from "./BotComputer"
import { BotFiles } from "./BotFiles"
import { BotProfileInlineField } from "./BotProfileInlineEditor"
import { BotRoutineSummary } from "./BotRoutineSummary"
import type { BotRoutineOpenIntent } from "@/lib/bot-routine-toggle"
import { BotInspectorPanel } from "./BotInspectorPanel"

export type BotInspectorTab = "details" | "library" | "computer"
/** One stable panel for identity, files and computer; all actions retain their existing owners. */
export function BotInspector({
  bot,
  conversationId,
  threadRootId,
  teachArm,
  onTeachPrepared,
  cancelTeachPreparation,
  onComputerBackendChange,
  onExitAutoFocus,
  onFullScreenExitAutoFocus,
  tab,
  onTabChange,
  settings,
  resource,
  covered = false,
  routineDetail,
  showDownloads,
  close
}: {
  bot: CoworkBot
  conversationId: string
  threadRootId?: string
  teachArm?: BotTeachArm | null
  onTeachPrepared?(): void
  cancelTeachPreparation?(): void
  onComputerBackendChange?(backend: "browser" | "windows-native"): void
  onExitAutoFocus?(): void
  onFullScreenExitAutoFocus?(): void
  tab: BotInspectorTab
  onTabChange(tab: BotInspectorTab): void
  settings(): void
  resource(tab: "memory" | "skills" | "routines", intent?: BotRoutineOpenIntent): void
  covered?: boolean
  routineDetail?: ReactNode
  showDownloads?: () => void
  close(): void
}) {
  const [computerVisited, setComputerVisited] = useState(tab === "computer")
  const modelName = useAppStore(
    (state) => state.models.find((model) => model.id === bot.modelRef)?.name
  )
  const conversationName = useBotWorkspaceStore(
    (state) => state.snapshot?.conversations.find((item) => item.id === conversationId)?.name
  )
  const sharedWorkspace = useBotWorkspaceStore((state) => state.host?.sharedWorkspace)
  const workspacePath = bot.workspacePath ?? sharedWorkspace
  const workspaceLeaf = bot.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1)
  const workspaceName =
    !bot.workspacePath || bot.workspacePath === sharedWorkspace
      ? "共享工作目录"
      : workspaceLeaf && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(workspaceLeaf)
        ? "Bot 工作目录"
        : workspaceLeaf || bot.workspacePath
  const supportsTitle = useBotWorkspaceStore((state) =>
    state.host?.capabilities?.includes("bot-profile-title")
  )
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supportsUpdate = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("bot-update-receipts") ?? false
  )
  const computer = tab === "computer"
  // Retain the browser only after its first visit, before committing that render.
  if (computer && !computerVisited) setComputerVisited(true)
  return (
    <BotInspectorPanel
      name={bot.name}
      tab={routineDetail ? "routine" : tab}
      subview={Boolean(routineDetail)}
      covered={covered}
      close={close}
      expandRequest={teachArm}
      onExitAutoFocus={onExitAutoFocus}
      onFullScreenExitAutoFocus={onFullScreenExitAutoFocus}
    >
      {(expanded, expand) => (
        <>
          <div
            className="bot-inspector-base flex min-h-0 flex-1 flex-col"
            hidden={Boolean(routineDetail)}
            inert={Boolean(routineDetail) || covered}
          >
            <Tabs
              value={tab}
              onValueChange={(value) => onTabChange(value as BotInspectorTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="bot-computer-profile">
                <BotAvatar agentId={bot.id} size="xl" />
                <h3>
                  <BotProfileInlineField
                    key={`name:${bot.id}:${dataEpoch}`}
                    bot={bot}
                    dataEpoch={dataEpoch}
                    field="name"
                    enabled={supportsUpdate}
                  />
                </h3>
                {supportsTitle ? (
                  <BotProfileInlineField
                    key={`title:${bot.id}:${dataEpoch}`}
                    bot={bot}
                    dataEpoch={dataEpoch}
                    field="title"
                    enabled={supportsUpdate}
                  />
                ) : (
                  <span>{computer ? "专用工作浏览器" : "项目 Bot"}</span>
                )}
                <TabsList className="bot-inspector-tabs" aria-label="Bot 详情内容">
                  <TabsTrigger value="details">详情</TabsTrigger>
                  <TabsTrigger value="library">资料库</TabsTrigger>
                  <TabsTrigger value="computer">电脑</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent
                value="details"
                className="bot-inspector-content min-h-0 flex-1 overflow-y-auto"
              >
                <div className="space-y-6 px-6 py-4">
                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-medium text-muted-foreground">描述与职责</h4>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 rounded-full text-xs"
                        onClick={settings}
                      >
                        <Settings2 size={13} />
                        编辑
                      </Button>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {bot.instructions ||
                        "还没有指定职责。可以在对话中交办任务，也可以编辑长期工作要求。"}
                    </p>
                  </section>
                  <dl className="space-y-4 rounded-xl bg-muted/35 p-4 text-xs">
                    <div className="flex items-start justify-between gap-4">
                      <dt className="shrink-0 text-muted-foreground">模型</dt>
                      <dd className="min-w-0 break-words text-right">
                        {bot.modelRef ? modelName || "指定模型" : "应用默认模型"}
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <dt className="shrink-0 text-muted-foreground">工作目录</dt>
                      <dd className="min-w-0 truncate text-right" title={workspacePath}>
                        {workspaceName}
                      </dd>
                    </div>
                  </dl>
                  <BotRoutineSummary
                    key={`${bot.id}:${dataEpoch}`}
                    botId={bot.id}
                    dataEpoch={dataEpoch}
                    active={tab === "details" && !covered && !routineDetail}
                    open={(intent) => resource("routines", intent)}
                    manage={() => resource("routines")}
                  />
                  <div className="space-y-1">
                    {(
                      [
                        ["memory", "记忆", Brain],
                        ["skills", "技能", BookOpen]
                      ] as const
                    ).map(([value, label, Icon]) => (
                      <button
                        key={value}
                        type="button"
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-muted"
                        onClick={() => resource(value)}
                      >
                        <Icon size={16} className="text-muted-foreground" />
                        <span className="flex-1">{label}</span>
                        <ChevronRight size={14} className="text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                </div>
              </TabsContent>
              <TabsContent
                value="library"
                className="bot-inspector-content min-h-0 flex-1 overflow-y-auto"
              >
                <p className="px-5 pt-4 text-xs leading-relaxed text-muted-foreground">
                  {conversationName
                    ? `来自「${conversationName}」对话的附件与成果`
                    : "本对话的附件与成果"}
                </p>
                <BotFiles
                  key={conversationId}
                  conversationId={conversationId}
                  showDownloads={showDownloads}
                  active={tab === "library" && !covered && !routineDetail}
                  inline
                />
              </TabsContent>
              <TabsContent
                value="computer"
                forceMount={computerVisited || undefined}
                className="bot-inspector-computer min-h-0 flex-1 flex-col"
              >
                <BotComputer
                  botId={bot.id}
                  conversationId={conversationId}
                  threadRootId={threadRootId}
                  teachArm={teachArm}
                  onTeachPrepared={onTeachPrepared}
                  cancelTeachPreparation={cancelTeachPreparation}
                  onBackendChange={onComputerBackendChange}
                  name={bot.name}
                  expanded={expanded}
                  active={computer && !covered && !routineDetail}
                  onExpand={expand}
                />
              </TabsContent>
            </Tabs>
          </div>
          {routineDetail}
        </>
      )}
    </BotInspectorPanel>
  )
}
