import { BotConversation } from "./BotConversation"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { botErrorMessage } from "@/lib/bot-error-message"
import { botCreateShortcut } from "@/lib/bot-create-shortcut"
import { BotGroupAvatar } from "./BotGroupAvatar"
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent } from "react"
import {
  Archive,
  CircleAlert,
  ChevronRight,
  Loader2,
  ListTree,
  MoreHorizontal,
  PanelRight,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  Trash2,
  UsersRound,
  X
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { CustomModelDialog } from "@/components/chat/CustomModelDialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { useAppStore } from "@/lib/store"
import { useThreadContext, useThreadStateSummaries } from "@/lib/thread-context"
import {
  privateBotTasksByBot,
  botTaskPreview,
  botConversationState,
  botFileRefreshKey
} from "@/lib/bot-task-view"
import {
  botPinnedConversationIds,
  botPinDropTarget,
  botSidebarDropPatch,
  orderBotConversations,
  type BotSidebarDrag,
  type BotSidebarDrop
} from "@/lib/bot-sidebar-view"
import { groupDraftKey, sendGroupDraft, useBotGroupDrafts } from "@/lib/bot-group-drafts"
import {
  restoreBotConversationDraft,
  saveBotConversationDraft,
  pruneBotConversationDrafts
} from "@/lib/bot-conversation-draft"
import { validateNewChatFiles } from "@/lib/bot-new-chat-files"
import {
  botChatRecipientKey,
  materializeBotChatRecipients,
  type BotChatRecipient
} from "@/lib/bot-chat-recipients"
import { BotDraftSender, queueBotChatDraft } from "@/lib/bot-draft-sender"
import { BotStorefrontIcon } from "./BotStorefrontIcon"
import { botGroupBrowserScope, BOT_REQUEST_RECEIPT_LIMIT } from "../../../../shared/bots/contracts"
import type {
  BotClient,
  BotDefinition,
  BotTask,
  BotGroup,
  CreateBotInput
} from "../../../../shared/bots/contracts"
import { BotAvatar } from "./BotAvatar"
import { BotRuntimeAvatar } from "./BotRuntimeAvatar"
import { botActiveTaskCreatedAt } from "@/lib/bot-avatar-mood"
import { BotAppearancePicker, BotAvatarEditor } from "./BotAppearancePicker"
import { createBotAppearance } from "../../../../shared/bots/appearance"
import { BotDeleteDialog } from "./BotDeleteDialog"
import { BotMemoryPanel } from "./BotMemoryPanel"
import { BotSchedulePanel } from "./BotSchedulePanel"
import { BotGroupEditor } from "./BotGroupEditor"
import { BotNameInput } from "./BotNameInput"
import { BotGroupMembers } from "./BotGroupMembers"
import { BotGroupConversation } from "./BotGroupConversation"
import { BotDetailsPane } from "./BotDetailsPane"
import { BotNewChat } from "./BotNewChat"
import { BotSectionEditor } from "./BotSectionEditor"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem
} from "@/components/ui/context-menu"
import { BotRowMenu } from "./BotRowMenu"
import { BotConversationList } from "./BotConversationList"
import { BotProfileLabel } from "./BotProfileLabel"
import { BotBrowserPanel } from "./BotBrowserPanel"
import { BotFilesPanel } from "./BotFilesPanel"
import { useBots } from "./use-bots"
import { useBotReadState } from "./use-bot-read-state"
import { localBotClient } from "./client"
import { botWorkClient } from "@/lib/bot-work-client"
import { useBotWorks } from "./use-bot-works"
import { BotWorkPanel } from "./BotWorkPanel"
import { BotImChannelDialog } from "./BotImChannelDialog"
import { BotMockChannelDialog } from "./BotMockChannelDialog"
import { botChatAccent } from "@/lib/bot-chat-accent"
import { BotWorkspaceMenu } from "./BotWorkspaceMenu"
import { BotPanelDivider } from "./BotPanelDivider"
import {
  useBotViewStore,
  DEFAULT_BOT_VIEW,
  clampBotPanelWidth,
  createBotNewChatDraft
} from "./view-store"
import "./bots.css"

const COLORS = ["#ed2040", "#168bea", "#ffb800", "#9a65ee", "#37b897", "#f07e4a"]
const PENDING_NEW_CHAT_RECIPIENT =
  "这位 Bot 正在创建，请等待原创建结果后再重试。文字和附件仍可编辑。"
const STATE_LABELS: Record<BotTask["state"], string> = {
  queued: "等待执行",
  running: "正在处理",
  waiting_user: "等待你确认",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "已中断",
  superseded: "已由新消息接续",
  outcome_unknown: "需要核对结果"
}

function BotEditor({
  bot,
  client,
  createBot,
  onClose,
  onSaved,
  returnFocusTo,
  nameOnly = false,
  initialName = ""
}: {
  bot: BotDefinition | null
  client: BotClient
  createBot?(input: CreateBotInput): Promise<BotDefinition>
  onClose(): void
  onSaved(bot: BotDefinition): void
  returnFocusTo?: HTMLElement | null
  nameOnly?: boolean
  initialName?: string
}) {
  const models = useAppStore((state) => state.models)
  const trigger = useRef(returnFocusTo ?? document.activeElement)
  const [input, setInput] = useState<CreateBotInput>(
    () =>
      bot ?? {
        name: initialName,
        instructions: "",
        ...createBotAppearance(),
        modelRef: null
      }
  )
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const creating = !bot && !nameOnly
  const settingsId = useId()
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    lock.current = true
    setSaving(true)
    setError(null)
    try {
      const saved = bot
        ? await client.update({
            ...input,
            id: bot.id,
            expectedVersion: bot.version,
            archived: bot.archived
          })
        : await (createBot ? createBot(input) : client.create(input))
      onSaved(saved)
    } catch (cause) {
      setError(botErrorMessage(cause))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !saving) onClose()
        }}
      >
        <DialogContent
          className={`bot-editor flex max-h-[calc(100dvh-3rem)] flex-col sm:max-w-[440px]${creating ? " bot-create-dialog" : ""}`}
          onCloseAutoFocus={(event) => {
            if (!(trigger.current instanceof HTMLElement) || !trigger.current.isConnected) return
            event.preventDefault()
            trigger.current.focus({ preventScroll: true })
          }}
        >
          <DialogHeader className={creating ? "bot-create-heading" : undefined}>
            <DialogTitle>{nameOnly ? "重命名 Bot" : bot ? "编辑 Bot" : "创建新 Bot"}</DialogTitle>
            <DialogDescription className={creating ? "sr-only" : undefined}>
              {nameOnly ? "修改名称不会改变对话和工作资料。" : "为 Bot 起个名字，告诉它负责什么。"}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={submit}
            className={
              creating ? "bot-create-form" : "min-h-0 space-y-5 overflow-y-auto overscroll-contain"
            }
          >
            <div className={creating ? "bot-create-body" : "space-y-5"}>
              {!nameOnly && (
                <div
                  className={
                    creating ? "bot-create-avatar" : "flex flex-col items-center gap-4 py-2"
                  }
                >
                  <BotAvatar
                    color={input.color}
                    shape={input.shape}
                    size={creating ? 96 : 90}
                    idleAnimation={creating}
                  />
                  {!creating && (
                    <BotAppearancePicker
                      value={input}
                      disabled={saving}
                      onChange={(appearance) => setInput((value) => ({ ...value, ...appearance }))}
                    />
                  )}
                </div>
              )}
              <label className={creating ? "bot-field bot-create-name" : "bot-field"}>
                <span className={creating ? "sr-only" : undefined}>Bot 名称</span>
                <input
                  required
                  maxLength={80}
                  autoFocus
                  disabled={saving}
                  value={input.name}
                  onChange={(event) =>
                    setInput((value) => ({ ...value, name: event.target.value }))
                  }
                  placeholder={creating ? "给你的 Bot 起个名字" : "例如：研发搭档"}
                />
              </label>
              {creating && (
                <>
                  <BotAppearancePicker
                    value={input}
                    disabled={saving}
                    onChange={(appearance) => setInput((value) => ({ ...value, ...appearance }))}
                  />
                  <button
                    type="button"
                    className="bot-create-advanced"
                    aria-expanded={advanced}
                    aria-controls={settingsId}
                    disabled={saving}
                    onClick={() => setAdvanced((value) => !value)}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                    更多设置
                  </button>
                </>
              )}
              {!nameOnly && (!creating || advanced) && (
                <div id={creating ? settingsId : undefined} className="space-y-5">
                  <label className="bot-field">
                    职责
                    <textarea
                      rows={3}
                      maxLength={8000}
                      disabled={saving}
                      value={input.instructions}
                      onChange={(event) =>
                        setInput((value) => ({ ...value, instructions: event.target.value }))
                      }
                      placeholder="描述它擅长什么、如何与你合作…"
                    />
                  </label>
                  <label className="bot-field">
                    模型
                    <Select
                      value={input.modelRef ?? "default"}
                      disabled={saving}
                      onValueChange={(modelRef) =>
                        setInput((value) => ({
                          ...value,
                          modelRef: modelRef === "default" ? null : modelRef
                        }))
                      }
                    >
                      <SelectTrigger aria-label="模型" className="h-11 rounded-xl shadow-none">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
                        <SelectItem value="default">使用默认模型</SelectItem>
                        {models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.name}
                          </SelectItem>
                        ))}
                        {input.modelRef && !models.some((model) => model.id === input.modelRef) && (
                          <SelectItem value={input.modelRef}>当前模型（未连接）</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </label>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-4"
                    disabled={saving}
                    onClick={() => setModelSettingsOpen(true)}
                  >
                    管理模型与 API 配置
                  </button>
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter className={creating ? "bot-create-footer" : undefined}>
              <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
                取消
              </Button>
              <Button
                type="submit"
                className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/90"
                disabled={saving || !input.name.trim()}
              >
                {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                {saving && creating ? "创建中…" : bot ? "保存" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <CustomModelDialog
        open={modelSettingsOpen}
        selectedModelId={input.modelRef ?? undefined}
        onModelSaved={(modelRef) => setInput((current) => ({ ...current, modelRef }))}
        onOpenChange={(open) => {
          setModelSettingsOpen(open)
          if (!open) void useAppStore.getState().loadModels(true)
        }}
      />
    </>
  )
}

function GroupBrowser({
  group,
  bots,
  client
}: {
  group: BotGroup
  bots: BotDefinition[]
  client: BotClient
}) {
  const [memberId, setMemberId] = useState(group.memberIds[0])
  const members = group.memberIds
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot): bot is BotDefinition => Boolean(bot && !bot.deleting))
  const member = members.find((bot) => bot.id === memberId) ?? members[0]
  if (!member)
    return <p className="p-5 text-sm text-muted-foreground">添加群成员后即可查看工作页面。</p>
  const scope = botGroupBrowserScope(group.id, member.id)
  return (
    <>
      <div className="px-5 pt-4">
        <Select value={member.id} onValueChange={setMemberId}>
          <SelectTrigger aria-label="查看成员浏览器" className="rounded-xl shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
            {members.map((bot) => (
              <SelectItem key={bot.id} value={bot.id}>
                {bot.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <BotBrowserPanel key={scope} botId={scope} client={client} />
    </>
  )
}

function GroupFiles({
  group,
  bots,
  client,
  tasks
}: {
  group: BotGroup
  bots: BotDefinition[]
  client: BotClient
  tasks: BotTask[]
}) {
  const member =
    bots.find((bot) => group.memberIds.includes(bot.id) && !bot.deleting && !bot.archived) ??
    bots.find((bot) => group.memberIds.includes(bot.id) && !bot.deleting)
  return (
    <BotFilesPanel
      key={`${group.id}:${member?.id ?? ""}`}
      bot={member}
      group={group}
      peers={bots}
      client={client}
      refreshKey={botFileRefreshKey(tasks)}
    />
  )
}

export function BotsWorkspace({ client = localBotClient() }: { client?: BotClient }) {
  return <BotWorkspaceForHost key={client.hostId} client={client} />
}

function BotWorkspaceForHost({ client }: { client: BotClient }) {
  const { snapshot, error, retry } = useBots(client)
  const [profileName, setProfileName] = useState("")
  useEffect(() => {
    let disposed = false
    let generation = 0
    const refresh = () => {
      const current = ++generation
      void window.api.models
        .getUserInfo()
        .then((user) => {
          if (!disposed && current === generation)
            setProfileName(
              user?.sapId && typeof user.userName === "string" ? user.userName.trim() : ""
            )
        })
        .catch(() => {
          if (!disposed && current === generation) setProfileName("")
        })
    }
    const unsubscribe = window.electron.onNotifyMsg(refresh)
    refresh()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  const words = profileName.split(/\s+/u)
  const userInitials = (
    words.length > 1
      ? words.slice(0, 2).map((word) => Array.from(word)[0])
      : Array.from(profileName).slice(0, 2)
  )
    .join("")
    .toUpperCase()
  useEffect(() => {
    if (snapshot) {
      useBotGroupDrafts.getState().prune(
        client.hostId,
        snapshot.groups.map((group) => group.id)
      )
      try {
        pruneBotConversationDrafts(
          client.hostId,
          snapshot.bots.map((bot) => bot.id)
        )
      } catch {
        // A future authoritative snapshot retries cleanup; editing remains available.
      }
    }
  }, [client.hostId, snapshot?.groups, snapshot?.bots])
  const view = useBotViewStore((state) => state.hosts[client.hostId] ?? DEFAULT_BOT_VIEW)
  const updateView = (patch: Partial<typeof view>) =>
    useBotViewStore.getState().update(client.hostId, patch)
  const { groupId, showArchived, detailOpen, detailTab } = view
  // Old service routes are view preferences, never local Bot identities.
  const legacySelection =
    view.selectedId === "service-expert-conversation" ||
    view.selectedId?.startsWith("service-expert-conversation:")
  const selectedId = legacySelection ? null : view.selectedId
  const setSelectedId = (selectedId: string | null) => updateView({ selectedId })
  const setGroupId = (groupId: string | null) => updateView({ groupId })
  const setShowArchived = (showArchived: boolean) => updateView({ showArchived })
  const detailTriggerRef = useRef<HTMLButtonElement>(null)
  const setDetailOpen = (detailOpen: boolean) => {
    if (!detailOpen && document.activeElement?.closest(".bot-details")) {
      detailTriggerRef.current?.focus({ preventScroll: true })
    }
    updateView({ detailOpen })
  }
  const setDetailTab = (detailTab: typeof view.detailTab) => updateView({ detailTab })
  const [query, setQuery] = useState("")
  const [showHidden, setShowHidden] = useState(false)
  const [suppressedRead, setSuppressedRead] = useState<string | null>(null)
  const sectionFocus = useRef(false)
  const [sectionEditor, setSectionEditor] = useState<{
    id?: string
    botId?: string
    name?: string
  } | null>(null)
  const [sidebarDrag, setSidebarDrag] = useState<{
    hostId: string
    item: BotSidebarDrag
  } | null>(null)
  const sidebarDragging = sidebarDrag?.item
  const [sidebarDrop, setSidebarDrop] = useState<BotSidebarDrop | null>(null)
  const clearSidebarDrag = () => {
    setSidebarDrag(null)
    setSidebarDrop(null)
  }
  useEffect(() => {
    clearSidebarDrag()
  }, [client.hostId])
  const hiddenIds = view.hiddenBotIds ?? []
  const hiddenGroupIds = view.hiddenGroupIds ?? []
  const pinnedGroupIds = view.pinnedGroupIds ?? []
  const sections = view.sections ?? []
  const [searchOpen, setSearchOpen] = useState(false)
  const groupActionQuery = query.trim().toLocaleLowerCase()
  const showCreateGroupAction =
    searchOpen &&
    !showArchived &&
    Boolean(groupActionQuery) &&
    ["创建群聊", "新建群聊", "new group chat", "group", "chat", "room", "bots", "people"].some(
      (keyword) => keyword.includes(groupActionQuery)
    )
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [newChat, setNewChat] = useState(false)
  const [initialNewChatDraft] = useState(
    () => useBotViewStore.getState().newChatDrafts[client.hostId] ?? createBotNewChatDraft()
  )
  const newChatState = useBotViewStore(
    (state) => state.newChatDrafts[client.hostId] ?? initialNewChatDraft
  )
  const updateNewChatDraft = (patch: Partial<typeof newChatState>) => {
    const state = useBotViewStore.getState()
    state.updateNewChat(client.hostId, {
      ...(state.newChatDrafts[client.hostId] ?? initialNewChatDraft),
      ...patch
    })
  }
  const newChatRecipients = newChatState.recipients
  const setNewChatRecipients = (
    value: BotChatRecipient[] | ((previous: BotChatRecipient[]) => BotChatRecipient[])
  ) => {
    const current = useBotViewStore.getState().newChatDrafts[client.hostId] ?? initialNewChatDraft
    updateNewChatDraft({
      recipients: typeof value === "function" ? value(current.recipients) : value
    })
  }
  const newChatDraft = newChatState.text
  const newChatDraftRef = useRef(newChatDraft)
  const newChatFiles = newChatState.files
  const newChatFilesRef = useRef(newChatFiles)
  const newChatTransfer = initialNewChatDraft.transfer
  const editNewChatFiles = (files: File[]) => {
    try {
      validateNewChatFiles(files)
      newChatFilesRef.current = files
      updateNewChatDraft({ files })
      newChatTransfer.current.keep(files)
      setNewChatError(null)
    } catch (cause) {
      setNewChatError(botErrorMessage(cause))
    }
  }
  const editNewChatDraft = (value: string) => {
    newChatDraftRef.current = value
    updateNewChatDraft({ text: value })
  }
  const newChatBusy = newChatState.busy
  const setNewChatBusy = (busy: boolean) => updateNewChatDraft({ busy })
  const [newChatError, setNewChatError] = useState<string | null>(null)
  const newChatAttempt = initialNewChatDraft.attempt
  const creatingChat = initialNewChatDraft.creating
  const createdChatGroup = initialNewChatDraft.group
  const createdChatRecipients = initialNewChatDraft.createdRecipients
  const pendingChatRecipients = initialNewChatDraft.pendingRecipients
  const privateChatRecipient = initialNewChatDraft.privateRecipient
  const newChatCreateIntent = useRef<{
    intent: "draft" | "send"
    recipientKey: string
  } | null>(null)
  const threadContext = useThreadContext()
  useEffect(
    () => () => {
      newChatAttempt.current++
      const state = useBotViewStore.getState()
      const draft = state.newChatDrafts[client.hostId]
      if (
        draft &&
        !draft.busy &&
        !draft.text &&
        !draft.files.length &&
        !draft.recipients.length &&
        !draft.pendingRecipients.current.size &&
        !draft.createdRecipients.current.size
      )
        state.updateNewChat(client.hostId, undefined)
    },
    []
  )
  const closeNewChat = () => {
    newChatAttempt.current++
    setNewChat(false)
  }
  const [groupEditor, setGroupEditor] = useState<BotGroup | "new" | null>(null)
  const groupEditorTrigger = useRef<HTMLElement | null>(null)
  const openGroupEditor = (group: BotGroup | "new", trigger?: HTMLElement | null) => {
    groupEditorTrigger.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setGroupEditor(group)
  }
  const selectedGroup = snapshot?.groups.find((group) => group.id === groupId) ?? null
  const [deleting, setDeleting] = useState<BotDefinition | null>(null)
  const [deletingGroup, setDeletingGroup] = useState<BotGroup | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<BotGroup | null>(null)
  const [renaming, setRenaming] = useState<BotDefinition | null>(null)
  const [editor, setEditor] = useState<BotDefinition | "new" | null>(null)
  const [newBotName, setNewBotName] = useState("")
  const [imBot, setImBot] = useState<BotDefinition | null>(null)
  const [mockBot, setMockBot] = useState<BotDefinition | null>(null)
  const editorTrigger = useRef<HTMLElement | null>(null)
  const profileMenuTrigger = useRef<HTMLButtonElement | null>(null)
  const newConversationTrigger = useRef<HTMLButtonElement | null>(null)
  const openNewChat = useCallback(() => {
    if (creatingChat.current) return
    newChatAttempt.current++
    setNewChat(true)
    setNewChatError(null)
  }, [])
  useEffect(() => {
    const create = (event: KeyboardEvent) => {
      const action = botCreateShortcut(event)
      if (!action) return
      const state = useAppStore.getState()
      const trigger = newConversationTrigger.current
      if (
        state.mainView !== "bots" ||
        state.showCustomizeView ||
        !trigger?.isConnected ||
        trigger.disabled ||
        trigger.closest("[inert]") ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return
      event.preventDefault()
      if (action === "bot") trigger.click()
      else if (!document.querySelector(".bot-new-chat")) openNewChat()
    }
    document.addEventListener("keydown", create)
    return () => document.removeEventListener("keydown", create)
  }, [openNewChat])
  const newMenuTransfersFocus = useRef(false)
  const createNewChatRecipient = async (input: CreateBotInput, key: string) => {
    const pending = pendingChatRecipients.current
    const completed = createdChatRecipients.current
    if (pending.has(key)) throw new Error(PENDING_NEW_CHAT_RECIPIENT)
    const operation = client.create(input)
    pending.set(key, operation)
    // Retain this preparation even for an empty source while the editor is unmounted.
    updateNewChatDraft({})
    try {
      const bot = await operation
      if (bot.hostId !== client.hostId) throw new Error("创建结果不属于当前主机，请核对后重试。")
      completed.set(key, bot)
      return bot
    } finally {
      if (pending.get(key) === operation) pending.delete(key)
    }
  }
  const openBotEditor = (bot: BotDefinition, trigger?: HTMLElement | null) => {
    newChatAttempt.current++
    newChatCreateIntent.current = null
    editorTrigger.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setEditor(bot)
  }
  const openNewBot = (
    name = "",
    trigger?: HTMLElement | null,
    intent: "draft" | "send" | null = null
  ) => {
    newChatAttempt.current++
    editorTrigger.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setNewBotName(name)
    const recipientKey = botChatRecipientKey({ kind: "new", name })
    if (intent && pendingChatRecipients.current.has(recipientKey)) {
      setNewChatError(PENDING_NEW_CHAT_RECIPIENT)
      return
    }
    const prepared = intent ? createdChatRecipients.current.get(recipientKey) : undefined
    if (prepared) {
      newChatCreateIntent.current = null
      setNewChatRecipients([{ kind: "bot", id: prepared.id }])
      privateChatRecipient.current = prepared
      void selectNewChat(`bot:${prepared.id}`, undefined, intent === "send", prepared)
      return
    }
    newChatCreateIntent.current = intent ? { intent, recipientKey } : null
    setEditor("new")
  }
  const visible = useMemo(
    () =>
      (snapshot?.bots ?? []).filter(
        (bot) =>
          bot.archived === showArchived &&
          (showArchived || query.trim() || hiddenIds.includes(bot.id) === showHidden) &&
          `${bot.name} ${bot.label ?? ""}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())
      ),
    [snapshot?.bots, showArchived, query, view.hiddenBotIds, showHidden]
  )
  const pinnedIds = view.pinnedBotIds ?? []
  const pinnedBots = pinnedIds.flatMap((id) => {
    const bot = visible.find((candidate) => candidate.id === id && !candidate.archived)
    return bot ? [bot] : []
  })
  const selected = selectedGroup
    ? null
    : selectedId
      ? (snapshot?.bots.find((bot) => bot.id === selectedId) ?? null)
      : (visible[0] ?? null)
  useEffect(() => {
    if (!legacySelection || !snapshot) return
    useBotViewStore.getState().update(client.hostId, { selectedId: visible[0]?.id ?? null })
  }, [client.hostId, legacySelection, snapshot, visible])
  const mainActivityByConversation = useMemo(
    () => new Map((snapshot?.activities ?? []).map((item) => [`${item.kind}:${item.id}`, item])),
    [snapshot?.activities]
  )
  const activityByConversation = useMemo(() => {
    const result = new Map(mainActivityByConversation)
    for (const work of snapshot?.workActivity ?? []) {
      const key = `bot:${work.botId}`,
        main = result.get(key)
      result.set(key, {
        kind: "bot",
        id: work.botId,
        version: main?.version ?? 0,
        updatedAt: Math.max(main?.updatedAt ?? 0, work.updatedAt),
        preview: work.updatedAt > (main?.updatedAt ?? 0) ? work.preview : (main?.preview ?? ""),
        unread: Boolean(main?.unread || work.unread)
      })
    }
    return result
  }, [mainActivityByConversation, snapshot?.workActivity])
  const tasksByBot = useMemo(
    () => privateBotTasksByBot(snapshot?.bots ?? [], snapshot?.tasks ?? []),
    [snapshot?.bots, snapshot?.tasks]
  )
  const threadSummaries = useThreadStateSummaries()
  const tasksByThread = useMemo(() => {
    const result = new Map<string, BotTask[]>()
    for (const task of snapshot?.tasks ?? []) {
      const entries = result.get(task.threadId) ?? []
      entries.push(task)
      result.set(task.threadId, entries)
    }
    return result
  }, [snapshot?.tasks])
  const activeWorkId = selected ? (view.activeWorkIdByBot?.[selected.id] ?? null) : null
  const works = useBotWorks(client, selected?.id, activeWorkId, snapshot?.revision ?? 0)
  const selectedWork = activeWorkId && works.selected?.id === activeWorkId ? works.selected : null
  const selectedThreadId = activeWorkId
    ? (selectedWork?.threadId ?? "")
    : (selected?.threadId ?? "")
  const conversationClient = useMemo(
    () => (selectedWork ? botWorkClient(client, selectedWork) : client),
    [client, selectedWork?.id, selectedWork?.threadId]
  )
  const selectWork = (id: string | null) => {
    if (!selected) return
    const prefs = useBotViewStore.getState().hosts[client.hostId]
    updateView({ activeWorkIdByBot: { ...prefs?.activeWorkIdByBot, [selected.id]: id } })
  }
  const tasks = selected ? (tasksByThread.get(selectedThreadId) ?? []) : []
  const selectedState = botConversationState(
    tasks,
    selected ? threadSummaries[selectedThreadId] : undefined,
    Boolean(selected && snapshot?.backgroundThreads?.includes(selectedThreadId))
  )
  const selectedConversationKey = selectedGroup
    ? `group:${selectedGroup.id}`
    : activeWorkId
      ? `work:${activeWorkId}`
      : `bot:${selected?.id}`
  useEffect(() => {
    setSuppressedRead(null)
  }, [selectedConversationKey, newChat])
  useBotReadState(
    client,
    newChat || suppressedRead === selectedConversationKey
      ? undefined
      : activeWorkId
        ? selectedWork?.activity
        : mainActivityByConversation.get(selectedConversationKey)
  )
  const carryGroupDraft = async (
    group: BotGroup,
    isCurrent: () => boolean,
    replacePrepared = false,
    preparedMembers?: readonly BotDefinition[]
  ) => {
    const text = newChatDraftRef.current
    const key = groupDraftKey(client.hostId, group.id)
    // New chat can target a group before its conversation has mounted after restart.
    useBotGroupDrafts.getState().restore(key)
    const current = useBotGroupDrafts.getState().drafts[key]
    if (current?.storageError && !replacePrepared) throw new Error(current.storageError)
    if (current?.sending) throw new Error("群聊消息正在发送，请稍后重试。")
    const files = newChatFilesRef.current
    const member = (preparedMembers ?? snapshot?.bots ?? []).find(
      (bot) =>
        bot.hostId === client.hostId &&
        group.memberIds.includes(bot.id) &&
        !bot.archived &&
        !bot.deleting
    )
    if (files.length && !member) throw new Error("群聊中没有可用于添加附件的成员")
    const attachments = member
      ? await newChatTransfer.current.retain(
          client,
          member.id,
          group.id,
          files,
          replacePrepared ? [] : (current?.attachments ?? []),
          isCurrent
        )
      : []
    if (!isCurrent()) return
    if (useBotGroupDrafts.getState().drafts[key]?.revision !== current?.revision)
      throw new Error("群聊草稿已变化，请重试。")
    if (!text.trim() && !attachments.length) return
    useBotGroupDrafts.getState().edit(key, {
      text: replacePrepared
        ? text
        : current?.text.trim() && text.trim()
          ? `${current.text}\n\n${text}`
          : current?.text || text,
      attachments: replacePrepared ? attachments : [...(current?.attachments ?? []), ...attachments]
    })
    const storageError = useBotGroupDrafts.getState().drafts[key]?.storageError
    if (storageError) throw new Error(storageError)
  }
  const clearNewChatDraft = () => {
    editNewChatDraft("")
    editNewChatFiles([])
    newChatTransfer.current.clear()
    setNewChatRecipients([])
    createdChatRecipients.current = new Map()
    createdChatGroup.current = null
    privateChatRecipient.current = null
  }
  const addNewChatRecipient = (recipient: BotChatRecipient) => {
    const key = botChatRecipientKey(recipient)
    if (creatingChat.current || newChatRecipients.some((item) => botChatRecipientKey(item) === key))
      return
    if (newChatRecipients.length >= 8) {
      setNewChatError("一次最多选择 8 个 Bot。")
      return
    }
    setNewChatRecipients((items) =>
      items.some((item) => botChatRecipientKey(item) === key) || items.length >= 8
        ? items
        : [...items, recipient]
    )
    setNewChatError(null)
    createdChatGroup.current = null
    privateChatRecipient.current = null
  }
  const selectNewChat = async (
    value: string,
    createdGroup?: BotGroup,
    send = false,
    createdBot?: BotDefinition
  ) => {
    if (creatingChat.current) return
    if (
      value === "recipients" &&
      newChatRecipients.some(
        (recipient) =>
          recipient.kind === "new" &&
          pendingChatRecipients.current.has(botChatRecipientKey(recipient))
      )
    ) {
      setNewChatError(PENDING_NEW_CHAT_RECIPIENT)
      return
    }
    const onlyRecipient = newChatRecipients.length === 1 ? newChatRecipients[0] : undefined
    if (
      value === "recipients" &&
      onlyRecipient?.kind === "bot" &&
      privateChatRecipient.current?.id === onlyRecipient.id
    ) {
      value = `bot:${onlyRecipient.id}`
      createdBot = privateChatRecipient.current
    }
    if (
      value === "recipients" &&
      newChatRecipients.length === 1 &&
      newChatRecipients[0].kind === "new"
    ) {
      const recipient = newChatRecipients[0]
      const prepared = createdChatRecipients.current.get(botChatRecipientKey(recipient))
      if (!prepared) {
        openNewBot(recipient.name, undefined, send ? "send" : "draft")
        return
      }
      value = `bot:${prepared.id}`
      createdBot = prepared
    }
    creatingChat.current = true
    const attempt = ++newChatAttempt.current
    setNewChatBusy(true)
    setNewChatError(null)
    try {
      let preparedGroup = false
      let preparedMembers: BotDefinition[] | undefined
      if (value === "recipients") {
        const recipients = await materializeBotChatRecipients(
          client,
          newChatRecipients,
          snapshot?.bots ?? [],
          createdChatRecipients.current,
          () => attempt === newChatAttempt.current
        )
        preparedMembers = recipients
        const names = recipients.map((bot) => bot.name)
        const name = names.join("、")
        createdGroup =
          createdChatGroup.current ??
          (await client.saveGroup({
            name: name.length <= 120 ? name : `${names[0]}等 ${names.length} 位 Bot`,
            memberIds: recipients.map((bot) => bot.id)
          }))
        createdChatGroup.current = createdGroup
        if (attempt !== newChatAttempt.current) return
        value = `group:${createdGroup.id}`
        preparedGroup = true
      }
      if (value.startsWith("group:")) {
        const group = createdGroup ?? snapshot?.groups.find((item) => item.id === value.slice(6))
        if (!group) throw new Error("群聊已不可用")
        await carryGroupDraft(
          group,
          () => attempt === newChatAttempt.current,
          preparedGroup,
          preparedMembers
        )
        if (attempt !== newChatAttempt.current) return
        if (send) {
          // Ownership passes to the existing persistent group draft before any network call.
          clearNewChatDraft()
          await sendGroupDraft(client, group)
        }
        if (attempt !== newChatAttempt.current) return
        setGroupId(group.id)
        updateView({
          hiddenGroupIds: (
            useBotViewStore.getState().hosts[client.hostId]?.hiddenGroupIds ?? []
          ).filter((id) => id !== group.id)
        })
      } else {
        const bot =
          createdBot ??
          snapshot?.bots.find(
            (item) => item.id === value.slice(4) && !item.archived && !item.deleting
          )
        if (
          !bot ||
          bot.id !== value.slice(4) ||
          bot.hostId !== client.hostId ||
          bot.archived ||
          bot.deleting
        )
          throw new Error("Bot 已不可用")
        if (attempt !== newChatAttempt.current) return
        // Explicit first sends must reach the durable inbox before opening can start a greeting.
        // BotConversation opens after handoff; the original user enqueue suppresses introduction.
        if (!send) await client.open(bot.id)
        if (attempt !== newChatAttempt.current) return
        const restoreError = restoreBotConversationDraft(
          threadContext,
          client.hostId,
          bot.id,
          bot.threadId
        )
        if (restoreError) throw new Error(restoreError)
        const attachments = await newChatTransfer.current.retain(
          client,
          bot.id,
          undefined,
          newChatFilesRef.current,
          send ? [] : threadContext.getThreadState(bot.threadId).draftAttachments,
          () => attempt === newChatAttempt.current
        )
        if (attempt !== newChatAttempt.current) return
        const text = newChatDraftRef.current
        const actions = threadContext.getThreadActions(bot.threadId)
        if (send) {
          if (
            threadContext.getThreadState(bot.threadId).queuedMessages.length >=
            BOT_REQUEST_RECEIPT_LIMIT
          )
            throw new Error("待发送消息过多，请先处理已有消息。")
          const draft = queueBotChatDraft(actions, text, attachments)
          clearNewChatDraft()
          await new BotDraftSender(
            client,
            bot.id,
            actions,
            (error) => {
              if (error) toast.error(error)
            },
            () => {}
          ).send(draft)
          if (attempt !== newChatAttempt.current) return
        } else {
          const current = threadContext.getThreadState(bot.threadId)
          if (text.trim())
            actions.setDraftInput(
              current.draftInput.trim() ? `${current.draftInput}\n\n${text}` : text
            )
          if (attachments.length)
            actions.setDraftAttachments([...current.draftAttachments, ...attachments])
          const saveError = saveBotConversationDraft(
            threadContext,
            client.hostId,
            bot.id,
            bot.threadId
          )
          if (saveError) {
            // The source still owns these bytes if the target could not persist them.
            actions.setDraftInput(current.draftInput)
            actions.setDraftAttachments(current.draftAttachments)
            throw new Error(saveError)
          }
        }
        setSelectedId(bot.id)
        setGroupId(null)
        updateView({
          activeWorkIdByBot: {
            ...useBotViewStore.getState().hosts[client.hostId]?.activeWorkIdByBot,
            [bot.id]: null
          }
        })
        updateView({
          hiddenBotIds: (
            useBotViewStore.getState().hosts[client.hostId]?.hiddenBotIds ?? []
          ).filter((id) => id !== bot.id)
        })
      }
      if (attempt !== newChatAttempt.current) return
      setShowHidden(false)
      setShowArchived(false)
      setDetailOpen(false)
      clearNewChatDraft()
      createdChatRecipients.current.clear()
      createdChatGroup.current = null
      privateChatRecipient.current = null
      setNewChat(false)
    } catch (cause) {
      if (attempt === newChatAttempt.current) setNewChatError(botErrorMessage(cause))
    } finally {
      creatingChat.current = false
      setNewChatBusy(false)
    }
  }
  const togglePin = (id: string, kind: "bot" | "group" = "bot") => {
    const prefs = useBotViewStore.getState().hosts[client.hostId] ?? DEFAULT_BOT_VIEW
    const pinKey = kind === "bot" ? "pinnedBotIds" : "pinnedGroupIds"
    const hiddenKey = kind === "bot" ? "hiddenBotIds" : "hiddenGroupIds"
    const pinned = (prefs[pinKey] ?? []).includes(id)
    const patch = botSidebarDropPatch(
      prefs,
      { kind, id, pinned },
      pinned ? { kind: "agent-list" } : { kind: "pin-grid" },
      snapshot?.groups.map((group) => group.id)
    )
    if (patch)
      updateView({ ...patch, [hiddenKey]: (prefs[hiddenKey] ?? []).filter((item) => item !== id) })
  }
  const copyConversationId = async (bot: BotDefinition) => {
    try {
      if (bot.id === selected?.id && activeWorkId && !selectedWork)
        throw new Error("任务会话尚未读取，请重试后再复制。")
      await navigator.clipboard.writeText(bot.id === selected?.id ? selectedThreadId : bot.threadId)
      toast.success("已复制对话 ID")
    } catch (cause) {
      toast.error(botErrorMessage(cause))
    }
  }
  const moveToSection = (
    botId: string,
    sectionId: string | null,
    kind: "bot" | "group" = "bot"
  ) => {
    const prefs = useBotViewStore.getState().hosts[client.hostId] ?? DEFAULT_BOT_VIEW
    const patch = botSidebarDropPatch(
      prefs,
      { kind, id: botId, pinned: false },
      { kind: "section-body", id: sectionId }
    )
    if (patch) updateView(patch)
  }
  const setVisibility = (bot: BotDefinition) => {
    const current = useBotViewStore.getState().hosts[client.hostId]
    const hidden = current?.hiddenBotIds ?? []
    const restoring = hidden.includes(bot.id)
    updateView({
      hiddenBotIds: restoring ? hidden.filter((id) => id !== bot.id) : [...hidden, bot.id],
      ...(!restoring
        ? { pinnedBotIds: (current?.pinnedBotIds ?? []).filter((id) => id !== bot.id) }
        : {}),
      ...(!restoring && selected?.id === bot.id ? { selectedId: null } : {})
    })
  }
  const changeReadState = async (kind: "bot" | "group", id: string) => {
    const key = `${kind}:${id}`,
      activity = activityByConversation.get(key)
    if (!activity?.unread) setSuppressedRead(key)
    try {
      if (activity?.unread) {
        const main = mainActivityByConversation.get(key)
        const work =
          kind === "bot" ? snapshot?.workActivity?.find((item) => item.botId === id) : undefined
        await Promise.all([
          ...(main?.version ? [client.markRead(kind, id, main.version)] : []),
          ...(work?.version && client.works ? [client.works.markAllRead(id, work.version)] : [])
        ])
        setSuppressedRead((previous) => (previous === key ? null : previous))
      } else await client.markUnread(kind, id)
    } catch (cause) {
      setSuppressedRead((previous) => (previous === key ? null : previous))
      toast.error(botErrorMessage(cause))
    }
  }
  const createSection = (itemId: string, kind: "bot" | "group" = "bot") => {
    const field = kind === "bot" ? "botIds" : "groupIds"
    const current = useBotViewStore.getState().hosts[client.hostId]?.sections ?? []
    if (current.length >= 32) return
    const id = crypto.randomUUID(),
      name = "新建分组"
    updateView({
      sections: [
        ...current.map((section) => ({
          ...section,
          [field]: (section[field] ?? []).filter((item) => item !== itemId)
        })),
        { id, name, botIds: [], [field]: [itemId], collapsed: false }
      ]
    })
    setQuery("")
    setSectionEditor({ id, name })
  }
  const rowActions = (bot: BotDefinition) => ({
    bot,
    conversation: { hostId: client.hostId, id: bot.id, threadId: bot.threadId },
    pinned: pinnedIds.includes(bot.id),
    hidden: hiddenIds.includes(bot.id),
    unread: activityByConversation.get(`bot:${bot.id}`)?.unread ?? false,
    sections,
    onVisibility: () => setVisibility(bot),
    onReadState: () => {
      void changeReadState("bot", bot.id)
    },
    onMove: (id: string | null) => moveToSection(bot.id, id),
    onNewSection: () => createSection(bot.id),
    onPin: () => togglePin(bot.id),
    onRename: (trigger: HTMLElement | null) => {
      editorTrigger.current = trigger
      setRenaming(bot)
    },
    onArchive: () => {
      void archive(bot)
    },
    onDelete: (trigger: HTMLElement | null) => {
      editorTrigger.current = trigger
      setDeleting(bot)
    },
    onCopy: () => {
      void copyConversationId(bot)
    }
  })
  const archive = async (bot: BotDefinition) => {
    try {
      await client.update({
        ...bot,
        expectedVersion: bot.version,
        archived: !bot.archived
      })
      if (useBotViewStore.getState().hosts[client.hostId]?.selectedId === bot.id)
        setSelectedId(null)
    } catch (cause) {
      toast.error(botErrorMessage(cause))
    }
  }
  const groupActions = (group: BotGroup) => ({
    bot: group,
    conversation: { hostId: client.hostId, id: group.id },
    kind: "group" as const,
    pinned: pinnedGroupIds.includes(group.id),
    hidden: hiddenGroupIds.includes(group.id),
    sections,
    unread: activityByConversation.get(`group:${group.id}`)?.unread ?? false,
    onPin: () => togglePin(group.id, "group"),
    onRename: (trigger: HTMLElement | null) => {
      editorTrigger.current = trigger
      setRenamingGroup(group)
    },
    onDelete: (trigger: HTMLElement | null) => {
      editorTrigger.current = trigger
      setDeletingGroup(group)
    },
    onCopy: () => {
      void navigator.clipboard
        .writeText(group.id)
        .then(() => toast.success("已复制对话 ID"))
        .catch((cause) => toast.error(botErrorMessage(cause)))
    },
    onReadState: () => {
      void changeReadState("group", group.id)
    },
    onMove: (id: string | null) => moveToSection(group.id, id, "group"),
    onNewSection: () => createSection(group.id, "group"),
    onVisibility: () => {
      const prefs = useBotViewStore.getState().hosts[client.hostId]
      const hidden = prefs?.hiddenGroupIds ?? [],
        restoring = hidden.includes(group.id)
      updateView({
        hiddenGroupIds: restoring ? hidden.filter((id) => id !== group.id) : [...hidden, group.id],
        ...(!restoring
          ? { pinnedGroupIds: (prefs?.pinnedGroupIds ?? []).filter((id) => id !== group.id) }
          : {}),
        ...(!restoring && selectedGroup?.id === group.id ? { groupId: null } : {})
      })
    }
  })
  const visibleGroups = showArchived
    ? []
    : (snapshot?.groups ?? []).filter(
        (group) =>
          (query.trim() || hiddenGroupIds.includes(group.id) === showHidden) &&
          group.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      )
  const pinOrder = botPinnedConversationIds(
    view,
    snapshot?.groups.map((group) => group.id)
  )
  const ungroupedDropTarget: BotSidebarDrop =
    !showArchived && !showHidden && !query.trim() && sections.length
      ? { kind: "section-body", id: null }
      : { kind: "agent-list" }
  const pinnedConversations = pinOrder.flatMap<
    { kind: "bot"; value: BotDefinition } | { kind: "group"; value: BotGroup }
  >((key) => {
    const bot = pinnedBots.find((item) => `bot:${item.id}` === key)
    if (bot) return [{ kind: "bot" as const, value: bot }]
    const group = visibleGroups.find((item) => `group:${item.id}` === key)
    return group ? [{ kind: "group" as const, value: group }] : []
  })
  const startSidebarDrag = (event: DragEvent, item: BotSidebarDrag) => {
    event.stopPropagation()
    setSidebarDrag({ hostId: client.hostId, item })
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("application/x-cmb-bot-sidebar", `${item.kind}:${item.id}`)
  }
  const sidebarDropAllowed = (event: DragEvent, target: BotSidebarDrop) => {
    const source = sidebarDrag
    if (
      !source ||
      source.hostId !== client.hostId ||
      !event.dataTransfer.types.includes("application/x-cmb-bot-sidebar")
    )
      return false
    if (source.item.kind === "section") return target.kind === "section"
    return (
      target.kind === "pin-grid" ||
      target.kind === "section-body" ||
      (source.item.pinned && target.kind === "agent-list")
    )
  }
  const overSidebar = (event: DragEvent, target: BotSidebarDrop) => {
    if (!sidebarDropAllowed(event, target)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = "move"
    setSidebarDrop((previous) =>
      JSON.stringify(previous) === JSON.stringify(target) ? previous : target
    )
  }
  const dropSidebar = (event: DragEvent, target: BotSidebarDrop) => {
    if (!sidebarDropAllowed(event, target)) return
    event.preventDefault()
    event.stopPropagation()
    const source = sidebarDrag!.item
    if (
      event.dataTransfer.getData("application/x-cmb-bot-sidebar") !== `${source.kind}:${source.id}`
    ) {
      clearSidebarDrag()
      return
    }
    const exists =
      source.kind === "section"
        ? true
        : source.kind === "bot"
          ? snapshot?.bots.some((bot) => bot.id === source.id && !bot.deleting && !bot.archived)
          : snapshot?.groups.some((group) => group.id === source.id && !group.deleting)
    const prefs = useBotViewStore.getState().hosts[client.hostId] ?? DEFAULT_BOT_VIEW
    if (exists) {
      const patch = botSidebarDropPatch(
        prefs,
        source,
        target,
        snapshot?.groups.map((group) => group.id)
      )
      if (patch) updateView(patch)
    }
    clearSidebarDrag()
  }
  const pinDropTarget = (event: DragEvent) =>
    botPinDropTarget(
      Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-bot-pin-key]")).map(
        (node) => {
          const { left, right, top, bottom } = node.getBoundingClientRect()
          return { key: node.dataset.botPinKey!, left, right, top, bottom }
        }
      ),
      { x: event.clientX, y: event.clientY },
      getComputedStyle(event.currentTarget).direction === "rtl"
    )
  const sectionDropTarget = (event: DragEvent, id: string): BotSidebarDrop => {
    const rect = (
      event.currentTarget.querySelector(".bot-section-heading") ?? event.currentTarget
    ).getBoundingClientRect()
    return sidebarDragging?.kind === "section"
      ? {
          kind: "section",
          id,
          position: event.clientY > rect.top + rect.height / 2 ? "after" : "before"
        }
      : { kind: "section-body", id }
  }
  const rowDragProps = (kind: "bot" | "group", id: string, pinned: boolean, enabled = true) => ({
    draggable: enabled && !showArchived,
    onDragStart: (event: DragEvent) => startSidebarDrag(event, { kind, id, pinned }),
    onDragEnd: clearSidebarDrag,
    onClickCapture: (event: React.MouseEvent) => {
      if (sidebarDrag) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    "data-bot-pin-key": pinned ? `${kind}:${id}` : undefined,
    "data-bot-drop-position":
      pinned && sidebarDrop?.kind === "pin-grid" && sidebarDrop.anchor === `${kind}:${id}`
        ? sidebarDrop.position
        : undefined
  })
  const sidebarListDropTarget = (event: DragEvent): BotSidebarDrop | null => {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest(".bots-list") || target.closest(".bot-pinned-list")) return null
    return target.closest("[data-bot-row-key], [data-bot-default-section]")
      ? ungroupedDropTarget
      : { kind: "agent-list" }
  }
  const renderGroupRow = (group: BotGroup, pinned = false) => {
    const memberStates = group.memberIds.map((id) => {
      const threadId = `group-${group.id}-${id}`
      return botConversationState(
        tasksByThread.get(threadId) ?? [],
        threadSummaries[threadId],
        snapshot?.backgroundThreads?.includes(threadId)
      )
    })
    const state = memberStates.includes("waiting_user")
      ? "waiting_user"
      : memberStates.includes("running")
        ? "running"
        : memberStates.includes("queued")
          ? "queued"
          : null
    return (
      <BotRowMenu
        key={`group:${group.id}`}
        compact={view.sidebarWidth < 180}
        {...groupActions(group)}
        waiting={state === "waiting_user"}
        preview={
          state === "waiting_user"
            ? STATE_LABELS[state]
            : (activityByConversation.get(`group:${group.id}`)?.preview ??
              `${group.memberIds.length} 位 Bot`)
        }
        avatar={
          <BotGroupAvatar
            memberIds={group.memberIds}
            bots={snapshot?.bots ?? []}
            userInitials={userInitials}
            size={18}
          />
        }
      >
        <button
          {...rowDragProps("group", group.id, pinned, !group.deleting)}
          className={pinned ? "bot-pinned-card" : "bot-list-item"}
          data-bot-row-key={`group:${group.id}`}
          data-bot-unread-count={
            activityByConversation.get(`group:${group.id}`)?.unread ? 1 : undefined
          }
          data-selected={!newChat && selectedGroup?.id === group.id}
          aria-label={pinned ? `${group.name}，已置顶` : group.name}
          onClick={() => {
            setSuppressedRead(null)
            closeNewChat()
            setGroupId(group.id)
          }}
        >
          <BotGroupAvatar
            memberIds={group.memberIds}
            bots={snapshot?.bots ?? []}
            userInitials={userInitials}
          />
          <span className={pinned ? "bot-pinned-name" : "min-w-0 flex-1"}>
            <span className={pinned ? undefined : "bot-list-name"}>{group.name}</span>
            {!pinned && (
              <span className="bot-list-preview">
                {state
                  ? STATE_LABELS[state]
                  : (activityByConversation.get(`group:${group.id}`)?.preview ??
                    `${group.memberIds.length} 位 Bot`)}
              </span>
            )}
          </span>
          {activityByConversation.get(`group:${group.id}`)?.unread && (
            <span className="bot-unread-dot" aria-label="未读动态" />
          )}
        </button>
      </BotRowMenu>
    )
  }
  const renderBotRow = (bot: BotDefinition) => {
    const botTasks = tasksByBot.get(bot.id) ?? [],
      current = botConversationState(
        botTasks,
        threadSummaries[bot.threadId],
        snapshot?.backgroundThreads?.includes(bot.threadId)
      ),
      last = botTasks.at(-1),
      activity = activityByConversation.get(`bot:${bot.id}`)
    return (
      <BotRowMenu
        key={bot.id}
        compact={view.sidebarWidth < 180}
        {...rowActions(bot)}
        waiting={current === "waiting_user"}
        preview={
          current === "waiting_user"
            ? STATE_LABELS[current]
            : (activity?.preview ?? last?.message ?? "开始与 Bot 合作")
        }
        avatar={<BotAvatar color={bot.color} shape={bot.shape} size={16} />}
      >
        <button
          {...rowDragProps("bot", bot.id, false, !bot.deleting && !bot.archived)}
          className="bot-list-item"
          data-bot-row-key={`bot:${bot.id}`}
          data-bot-unread-count={activity?.unread ? 1 : undefined}
          data-selected={!newChat && selected?.id === bot.id}
          aria-label={bot.name}
          onClick={() => {
            setSuppressedRead(null)
            closeNewChat()
            setSelectedId(bot.id)
            setGroupId(null)
          }}
        >
          <BotRuntimeAvatar
            threadId={bot.threadId}
            taskCreatedAt={botActiveTaskCreatedAt(botTasks, bot.threadId)}
            settlement={last}
            color={bot.color}
            shape={bot.shape}
            size={36}
            busy={current === "running"}
            waiting={current === "waiting_user"}
          />
          <span className="min-w-0 flex-1">
            <span className="bot-list-heading">
              <span className="bot-list-name">{bot.name}</span>
              {bot.label && (
                <span className="bot-list-label" title={bot.label}>
                  {bot.label}
                </span>
              )}
            </span>
            <span className="bot-list-preview">
              {current
                ? STATE_LABELS[current]
                : (activity?.preview ?? last?.message ?? "开始与 Bot 合作")}
            </span>
          </span>
          {activity?.unread ? (
            <span className="bot-unread-dot" aria-label="未读动态" />
          ) : (
            current && <span className="bot-status-dot" aria-label={STATE_LABELS[current]} />
          )}
        </button>
      </BotRowMenu>
    )
  }
  const renderConversations = (bots: BotDefinition[], groups: BotGroup[]) =>
    orderBotConversations(bots, groups, activityByConversation).map((item) =>
      item.kind === "bot" ? renderBotRow(item.value) : renderGroupRow(item.value)
    )
  const sidebarCollapsed = clampBotPanelWidth("sidebar", view.sidebarWidth) < 180
  const footerActions = [
    <BotWorkspaceMenu
      key="account"
      profileName={profileName}
      initials={userInitials}
      accentMode={view.accentMode ?? "neutral"}
      onAccentChange={(accentMode) => updateView({ accentMode })}
      showArchived={showArchived}
      showHidden={showHidden}
      onProfile={() => useAppStore.getState().setShowCustomizeView(true, "userinfo")}
      onHidden={() => {
        setShowHidden(!showHidden)
        setShowArchived(false)
        setSelectedId(null)
        setGroupId(null)
      }}
      onArchive={() => {
        setShowHidden(false)
        setShowArchived(!showArchived)
        setSelectedId(null)
        setGroupId(null)
      }}
      onWorkbench={() => useAppStore.getState().setMainView("thread")}
    />,
    <Tooltip key="apps">
      <TooltipTrigger asChild>
        <button
          className="bot-connect-apps"
          aria-label="连接应用"
          onClick={() => useAppStore.getState().setShowCustomizeView(true, "connectors")}
        >
          <BotStorefrontIcon />
          <span>连接应用</span>
        </button>
      </TooltipTrigger>
      {sidebarCollapsed && (
        <TooltipContent data-bot-popup side="right" className="bot-control-tooltip rounded-xl">
          连接应用
        </TooltipContent>
      )}
    </Tooltip>
  ]

  // BotEditor captures this render's ownership before awaiting create/update.
  const editorAttempt = newChatAttempt.current
  const editorIntent = newChatCreateIntent.current
  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={150}>
      <div
        className="bots-workspace"
        data-details-open={!newChat && detailOpen}
        style={
          {
            "--bot-sidebar-width": `${clampBotPanelWidth("sidebar", view.sidebarWidth)}px`,
            "--bot-detail-width": `${clampBotPanelWidth("detail", view.detailWidth)}px`,
            ...(view.accentMode === "bot" && !newChat ? botChatAccent(selected?.color) : {})
          } as React.CSSProperties
        }
      >
        {deleting && (
          <BotDeleteDialog
            bot={deleting}
            client={client}
            returnFocusTo={editorTrigger.current}
            onClose={() => setDeleting(null)}
            onDeleted={() => {
              setDeleting(null)
              if (useBotViewStore.getState().hosts[client.hostId]?.selectedId === deleting.id)
                setSelectedId(null)
              const pins = useBotViewStore.getState().hosts[client.hostId]?.pinnedBotIds ?? []
              const prefs = useBotViewStore.getState().hosts[client.hostId]
              updateView({
                pinnedBotIds: pins.filter((id) => id !== deleting.id),
                hiddenBotIds: (prefs?.hiddenBotIds ?? []).filter((id) => id !== deleting.id),
                sections: (prefs?.sections ?? []).map((section) => ({
                  ...section,
                  botIds: section.botIds.filter((id) => id !== deleting.id)
                }))
              })
              void useAppStore.getState().loadThreads()
            }}
          />
        )}
        <aside
          className="bots-sidebar"
          aria-label="Bots"
          onDragOver={(event) => {
            const target = sidebarListDropTarget(event)
            if (target) overSidebar(event, target)
          }}
          onDrop={(event) => {
            const target = sidebarListDropTarget(event)
            if (target) dropSidebar(event, target)
          }}
        >
          <div className="bot-sidebar-safe-area" aria-hidden="true" />
          <div className="bots-sidebar-toolbar">
            <button
              className="bot-icon-button bot-toolbar-action"
              aria-label="搜索 Bot"
              onClick={() => {
                if (view.sidebarWidth < 180) updateView({ sidebarWidth: 264 })
                setSearchOpen((value) => !value)
              }}
            >
              <Search size={19} />
            </button>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  ref={newConversationTrigger}
                  className="bot-icon-button bot-toolbar-action"
                  aria-label="新建 Bot"
                  disabled={newChatBusy}
                  onClick={(event) => openNewBot("", event.currentTarget)}
                >
                  <Plus size={22} />
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent
                data-bot-popup
                className="bot-workspace-menu rounded-xl p-1.5"
                onCloseAutoFocus={(event) => {
                  if (newMenuTransfersFocus.current) {
                    event.preventDefault()
                    newMenuTransfersFocus.current = false
                  }
                }}
              >
                <ContextMenuItem
                  disabled={newChatBusy}
                  onSelect={() => {
                    newMenuTransfersFocus.current = true
                    openNewBot("", newConversationTrigger.current)
                  }}
                >
                  新建 Bot
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={newChatBusy}
                  onSelect={() => {
                    newMenuTransfersFocus.current = true
                    openNewChat()
                  }}
                >
                  新建群聊
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
          {searchOpen && (
            <label className="bot-search">
              <button
                type="button"
                className="bot-search-expand bot-icon-button"
                aria-label="展开搜索 Bot"
                onClick={(event) => {
                  event.preventDefault()
                  updateView({ sidebarWidth: 264 })
                  requestAnimationFrame(() => searchInputRef.current?.focus())
                }}
              >
                <Search size={17} />
              </button>
              <Search className="bot-search-icon" size={16} />
              <input
                ref={searchInputRef}
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 Bot"
                aria-label="搜索 Bot"
              />
            </label>
          )}
          {showCreateGroupAction && (
            <button
              type="button"
              className="bot-list-item bot-search-create-group"
              disabled={newChatBusy}
              onClick={() => {
                if (creatingChat.current) return
                setQuery("")
                setSearchOpen(false)
                openNewChat()
              }}
            >
              <UsersRound size={18} aria-hidden="true" />
              <span>创建群聊</span>
              <span>操作</span>
            </button>
          )}
          <BotConversationList label={showArchived ? "已归档 Bot" : "Bot 会话"}>
            {(pinnedConversations.length > 0 ||
              (sidebarDragging && sidebarDragging.kind !== "section")) && (
              <div
                className="bot-pinned-list"
                aria-label="已置顶的 Bot"
                data-drop-empty={!pinnedConversations.length || undefined}
                data-bot-drop-target={sidebarDrop?.kind === "pin-grid" || undefined}
                onDragOver={(event) => overSidebar(event, pinDropTarget(event))}
                onDrop={(event) => dropSidebar(event, pinDropTarget(event))}
              >
                {pinnedConversations.map((conversation) => {
                  if (conversation.kind === "group") return renderGroupRow(conversation.value, true)
                  const bot = conversation.value
                  const current = botConversationState(
                    tasksByBot.get(bot.id) ?? [],
                    threadSummaries[bot.threadId],
                    snapshot?.backgroundThreads?.includes(bot.threadId)
                  )
                  return (
                    <BotRowMenu
                      key={`bot:${bot.id}`}
                      compact={view.sidebarWidth < 180}
                      {...rowActions(bot)}
                      waiting={current === "waiting_user"}
                      preview={
                        current === "waiting_user"
                          ? STATE_LABELS[current]
                          : (activityByConversation.get(`bot:${bot.id}`)?.preview ??
                            "开始与 Bot 合作")
                      }
                      avatar={<BotAvatar color={bot.color} shape={bot.shape} size={16} />}
                    >
                      <button
                        {...rowDragProps("bot", bot.id, true, !bot.deleting)}
                        className="bot-pinned-card"
                        data-bot-row-key={`bot:${bot.id}`}
                        data-bot-unread-count={
                          activityByConversation.get(`bot:${bot.id}`)?.unread ? 1 : undefined
                        }
                        data-selected={!newChat && !selectedGroup && selected?.id === bot.id}
                        aria-label={`${bot.name}，已置顶`}
                        onClick={() => {
                          setSuppressedRead(null)
                          closeNewChat()
                          setSelectedId(bot.id)
                          setGroupId(null)
                        }}
                      >
                        <BotRuntimeAvatar
                          threadId={bot.threadId}
                          taskCreatedAt={botActiveTaskCreatedAt(
                            tasksByBot.get(bot.id) ?? [],
                            bot.threadId
                          )}
                          settlement={tasksByBot.get(bot.id)?.at(-1)}
                          color={bot.color}
                          shape={bot.shape}
                          size={60}
                          busy={current === "running"}
                          waiting={current === "waiting_user"}
                        />
                        <span className="bot-pinned-name">{bot.name}</span>
                        {activityByConversation.get(`bot:${bot.id}`)?.unread && (
                          <span className="bot-unread-dot" aria-label="未读动态" />
                        )}
                      </button>
                    </BotRowMenu>
                  )
                })}
              </div>
            )}
            {!showArchived &&
              !showHidden &&
              !query.trim() &&
              sections.map((section) => (
                <section
                  key={section.id}
                  className="bot-sidebar-section"
                  aria-label={section.name}
                  data-bot-drop-target={
                    sidebarDrop?.kind === "section-body" && sidebarDrop.id === section.id
                      ? true
                      : undefined
                  }
                  data-bot-drop-position={
                    sidebarDrop?.kind === "section" && sidebarDrop.id === section.id
                      ? sidebarDrop.position
                      : undefined
                  }
                  onDragOver={(event) => overSidebar(event, sectionDropTarget(event, section.id))}
                  onDrop={(event) => dropSidebar(event, sectionDropTarget(event, section.id))}
                >
                  {sectionEditor?.id === section.id ? (
                    <BotSectionEditor
                      name={section.name}
                      onClose={() => setSectionEditor(null)}
                      onSave={(name) => {
                        const current =
                          useBotViewStore.getState().hosts[client.hostId]?.sections ?? []
                        updateView({
                          sections: current.map((item) =>
                            item.id === section.id ? { ...item, name } : item
                          )
                        })
                        setSectionEditor(null)
                      }}
                    />
                  ) : (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <button
                          draggable
                          onDragStart={(event) =>
                            startSidebarDrag(event, { kind: "section", id: section.id })
                          }
                          onDragEnd={clearSidebarDrag}
                          className="bot-section-heading"
                          data-bot-row-key={`section:${section.id}`}
                          data-bot-expand-unread={section.collapsed ? "true" : undefined}
                          data-bot-unread-count={
                            section.collapsed
                              ? section.botIds.filter(
                                  (id) =>
                                    visible.some((bot) => bot.id === id) &&
                                    !pinnedIds.includes(id) &&
                                    activityByConversation.get(`bot:${id}`)?.unread
                                ).length +
                                (section.groupIds ?? []).filter(
                                  (id) =>
                                    visibleGroups.some((group) => group.id === id) &&
                                    !pinnedGroupIds.includes(id) &&
                                    activityByConversation.get(`group:${id}`)?.unread
                                ).length
                              : undefined
                          }
                          aria-label={section.name}
                          title={section.name}
                          aria-expanded={!section.collapsed}
                          onClick={() => {
                            if (sidebarDrag) return
                            const current =
                              useBotViewStore.getState().hosts[client.hostId]?.sections ?? []
                            updateView({
                              sections: current.map((item) =>
                                item.id === section.id
                                  ? { ...item, collapsed: !item.collapsed }
                                  : item
                              )
                            })
                          }}
                        >
                          <ChevronRight
                            size={14}
                            className={section.collapsed ? "" : "rotate-90"}
                          />
                          <span>{section.name}</span>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent
                        data-bot-popup
                        className="bot-workspace-menu rounded-xl p-1.5"
                        onCloseAutoFocus={(event) => {
                          if (sectionFocus.current) {
                            event.preventDefault()
                            sectionFocus.current = false
                          }
                        }}
                      >
                        <ContextMenuItem
                          onSelect={() => {
                            sectionFocus.current = true
                            if (view.sidebarWidth < 180) updateView({ sidebarWidth: 264 })
                            setSectionEditor({ id: section.id, name: section.name })
                          }}
                        >
                          重命名分组
                        </ContextMenuItem>
                        <ContextMenuItem
                          onSelect={() =>
                            updateView({
                              sections: (
                                useBotViewStore.getState().hosts[client.hostId]?.sections ?? []
                              ).filter((item) => item.id !== section.id)
                            })
                          }
                        >
                          移除分组（保留聊天）
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  )}
                  {!section.collapsed &&
                    renderConversations(
                      visible.filter(
                        (bot) => section.botIds.includes(bot.id) && !pinnedIds.includes(bot.id)
                      ),
                      visibleGroups.filter(
                        (group) =>
                          section.groupIds?.includes(group.id) && !pinnedGroupIds.includes(group.id)
                      )
                    )}
                </section>
              ))}
            {!showArchived && !showHidden && !query.trim() && sections.length > 0 && (
              <div className="bot-section-heading" data-bot-default-section>
                <span>未分组</span>
              </div>
            )}
            {renderConversations(
              visible.filter(
                (bot) =>
                  (bot.archived || !pinnedIds.includes(bot.id)) &&
                  (showArchived ||
                    showHidden ||
                    query.trim() ||
                    !sections.some((section) => section.botIds.includes(bot.id)))
              ),
              visibleGroups.filter(
                (group) =>
                  !pinnedGroupIds.includes(group.id) &&
                  (showHidden ||
                    query.trim() ||
                    !sections.some((section) => section.groupIds?.includes(group.id)))
              )
            )}
            {!snapshot && !error && <Loader2 className="mx-auto mt-12 size-5 animate-spin" />}
            {snapshot && !visible.length && !visibleGroups.length && !showCreateGroupAction && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                {query.trim()
                  ? "没有匹配的会话"
                  : showArchived
                    ? "没有已归档的 Bot"
                    : showHidden
                      ? "没有隐藏的会话"
                      : "创建你的第一个 Bot"}
              </p>
            )}
          </BotConversationList>
          <footer className="bots-sidebar-footer">
            {sidebarCollapsed ? [footerActions[1], footerActions[0]] : footerActions}
          </footer>
        </aside>
        <BotPanelDivider
          kind="sidebar"
          width={clampBotPanelWidth("sidebar", view.sidebarWidth)}
          onChange={(sidebarWidth) => updateView({ sidebarWidth })}
        />
        <main className="bots-conversation">
          {error && (
            <div className="bot-notice" role="alert">
              <CircleAlert size={16} />
              {error}
            </div>
          )}
          {!snapshot ? (
            <div className="bot-empty" role="status">
              {error ? (
                <>
                  <p>暂时无法读取 Bot 列表</p>
                  <Button variant="outline" className="rounded-full" onClick={retry}>
                    重试
                  </Button>
                </>
              ) : (
                <>
                  <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                  <p>正在读取 Bots…</p>
                </>
              )}
            </div>
          ) : newChat ? (
            <BotNewChat
              bots={snapshot?.bots ?? []}
              groups={snapshot?.groups ?? []}
              recipients={newChatRecipients}
              draft={newChatDraft}
              files={newChatFiles}
              busy={newChatBusy}
              error={newChatError}
              onDraft={editNewChatDraft}
              onFiles={editNewChatFiles}
              onSelect={(value, name) => {
                if (value === "new-bot") {
                  if (newChatRecipients.length >= 8) setNewChatError("一次最多选择 8 个 Bot。")
                  else if (name && newChatRecipients.length)
                    addNewChatRecipient({ kind: "new", name })
                  else openNewBot(name, undefined, "draft")
                } else if (value.startsWith("bot:"))
                  addNewChatRecipient({ kind: "bot", id: value.slice(4) })
                else void selectNewChat(value)
              }}
              onRemoveRecipient={(key) => {
                if (creatingChat.current) return
                setNewChatRecipients((items) =>
                  items.filter((item) => botChatRecipientKey(item) !== key)
                )
                createdChatRecipients.current.delete(key)
                createdChatGroup.current = null
                privateChatRecipient.current = null
              }}
              onCommit={() => {
                void selectNewChat("recipients")
              }}
              onSend={() => {
                void selectNewChat("recipients", undefined, true)
              }}
              onClose={closeNewChat}
            />
          ) : selectedGroup ? (
            <BotGroupConversation
              key={`${client.hostId}:${selectedGroup.id}`}
              group={selectedGroup}
              bots={snapshot?.bots ?? []}
              userInitials={userInitials}
              tasks={snapshot?.tasks ?? []}
              backgroundThreads={snapshot?.backgroundThreads ?? []}
              revision={snapshot?.revision ?? 0}
              client={client}
              onEdit={() => openGroupEditor(selectedGroup)}
              onDetails={() => setDetailOpen(!detailOpen)}
              detailOpen={detailOpen}
              detailsTriggerRef={detailTriggerRef}
              onOpenBot={(bot) =>
                updateView({ selectedId: bot.id, groupId: null, detailTab: "details" })
              }
              onBrowser={() => {
                updateView({ groupDetailTab: "computer", detailOpen: true })
              }}
              onFiles={() => {
                updateView({ groupDetailTab: "files", detailOpen: true })
              }}
            />
          ) : selected ? (
            <>
              <header className="bot-chat-header">
                <button
                  className="bot-icon-button bot-execution-toggle"
                  aria-label={view.showExecutionDetails ? "收起执行过程" : "查看执行过程"}
                  title={view.showExecutionDetails ? "收起执行过程" : "查看执行过程"}
                  aria-pressed={Boolean(view.showExecutionDetails)}
                  onClick={() => updateView({ showExecutionDetails: !view.showExecutionDetails })}
                >
                  <ListTree size={18} />
                </button>
                <button
                  className="bot-title-pill"
                  ref={detailTriggerRef}
                  aria-label="查看 Bot 详情"
                  aria-expanded={detailOpen}
                  onClick={() => setDetailOpen(!detailOpen)}
                >
                  <BotRuntimeAvatar
                    threadId={selectedThreadId}
                    taskCreatedAt={botActiveTaskCreatedAt(tasks, selectedThreadId)}
                    settlement={tasksByBot.get(selected.id)?.at(-1)}
                    color={selected.color}
                    shape={selected.shape}
                    size={28}
                    busy={selectedState === "running"}
                    waiting={selectedState === "waiting_user"}
                  />
                  <span>{selectedWork?.title ?? selected.name}</span>
                </button>
                <button
                  className="bot-icon-button"
                  aria-label={detailOpen ? "关闭 Bot 详情" : "打开 Bot 详情"}
                  aria-expanded={detailOpen}
                  onClick={() => setDetailOpen(!detailOpen)}
                >
                  <PanelRight size={19} />
                </button>
              </header>
              {!activeWorkId &&
                snapshot?.personalIm?.some((entry) => entry.botId === selected.id) && (
                  <div className="bot-work-source" role="note">
                    本人招乎私聊已关联 · 主对话回复和任务结果会同步到招乎
                    {!snapshot.personalIm.find((entry) => entry.botId === selected.id)?.connected &&
                      " · 当前离线，待重新连接后同步"}
                  </div>
                )}
              {activeWorkId && (
                <div className="bot-work-breadcrumb">
                  <button onClick={() => selectWork(null)}>← {selected.name} 主对话</button>
                  <span>{selectedWork?.state === "completed" ? "已完成" : "独立任务"}</span>
                </div>
              )}
              {selectedWork?.source && (
                <div className="bot-work-source" role="note">
                  {selectedWork.source.transport === "im" ? "IM 任务" : "模拟渠道任务"} ·
                  此处文字与结果将回到原接入会话。仅支持文字和同受众工作，不提供本机文件、电脑或私人记忆。
                </div>
              )}
              {activeWorkId && !selectedWork ? (
                <div className="bot-empty" role="status">
                  {works.error ?? "正在读取任务会话…"}
                  <button onClick={() => void works.refresh()}>重试</button>
                </div>
              ) : (
                <BotConversation
                  key={`${selected.hostId}:${selected.id}:${selectedThreadId}`}
                  bot={selected}
                  work={selectedWork}
                  onConfigureModel={() => openBotEditor(selected)}
                  onOpenWork={(id) => selectWork(id)}
                  onOpenBot={(id) => updateView({
                    selectedId: id, groupId: null, detailTab: "details",
                    activeWorkIdByBot: { ...useBotViewStore.getState().hosts[client.hostId]?.activeWorkIdByBot, [id]: null }
                  })}
                  groups={snapshot?.groups ?? []}
                  onOpenGroup={(id) => updateView({ groupId: id, selectedId: null, groupDetailTab: "details" })}
                  bots={snapshot?.bots ?? []}
                  schedules={snapshot?.schedules ?? []}
                  tasks={tasks}
                  backgroundBusy={Boolean(
                    snapshot?.backgroundThreads?.includes(selectedThreadId) ||
                    threadSummaries[selectedThreadId]?.workflowRunning ||
                    threadSummaries[selectedThreadId]?.hasRunningCoordinatorWorker
                  )}
                  client={conversationClient}
                />
              )}
            </>
          ) : (
            <div className="bot-empty">
              <BotAvatar color={COLORS[0]} size={110} />
              <h1>把工作交给 Bot</h1>
              <p>交代目标，随时回来查看进展。</p>
              <Button
                className="rounded-full px-6"
                onClick={(event) => openNewBot("", event.currentTarget)}
              >
                <Plus size={16} className="mr-2" />
                创建 Bot
              </Button>
            </div>
          )}
        </main>
        {!newChat && selectedGroup && (
          <>
            {detailOpen && (
              <BotPanelDivider
                kind="detail"
                width={clampBotPanelWidth("detail", view.detailWidth)}
                onChange={(detailWidth) => updateView({ detailWidth })}
              />
            )}
            <BotDetailsPane open={detailOpen} label="群聊详情">
              <div className="bot-detail-actions">
                <button
                  className="bot-icon-button"
                  aria-label="关闭群聊详情"
                  onClick={() => setDetailOpen(false)}
                >
                  <X size={19} />
                </button>
              </div>
              <div className="bot-profile">
                <BotGroupAvatar
                  memberIds={selectedGroup.memberIds}
                  bots={snapshot?.bots ?? []}
                  userInitials={userInitials}
                  size={64}
                />
                <BotNameInput
                  key={`${client.hostId}:${selectedGroup.id}`}
                  name={selectedGroup.name}
                  version={selectedGroup.version}
                  label="群组名称"
                  maxLength={120}
                  disabled={Boolean(selectedGroup.deleting)}
                  onSave={(name, version) =>
                    client.saveGroup(
                      { name, memberIds: selectedGroup.memberIds },
                      { id: selectedGroup.id, version }
                    )
                  }
                />
              </div>
              <Tabs
                value={view.groupDetailTab ?? "details"}
                onValueChange={(tab) =>
                  updateView({ groupDetailTab: tab as typeof view.groupDetailTab })
                }
              >
                <TabsList
                  className="bot-detail-tabs bot-group-detail-tabs h-auto bg-transparent"
                  aria-label="群聊详情"
                >
                  <TabsTrigger
                    value="details"
                    className="font-normal data-[state=active]:shadow-none"
                  >
                    详情
                  </TabsTrigger>
                  <TabsTrigger
                    value="files"
                    className="font-normal data-[state=active]:shadow-none"
                  >
                    资料库
                  </TabsTrigger>
                  <TabsTrigger
                    value="members"
                    className="font-normal data-[state=active]:shadow-none"
                  >
                    成员
                  </TabsTrigger>
                  <TabsTrigger
                    value="computer"
                    className="font-normal data-[state=active]:shadow-none"
                  >
                    电脑
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="details" className="mt-0">
                  <section className="bot-group-members text-sm text-muted-foreground">
                    <p>
                      {selectedGroup.memberIds.length} 位 Bot
                      在此协作。群内共享消息和工作资料，成员私聊与私有记忆保持独立。
                    </p>
                    <button
                      className="bot-member-add"
                      onClick={() => openGroupEditor(selectedGroup)}
                    >
                      <Settings2 size={18} />
                      群聊设置
                    </button>
                  </section>
                </TabsContent>
                <TabsContent value="members" className="mt-0">
                  <BotGroupMembers
                    key={`${client.hostId}:${selectedGroup.id}`}
                    group={selectedGroup}
                    bots={snapshot?.bots ?? []}
                    client={client}
                    onOpen={(bot) =>
                      updateView({ selectedId: bot.id, groupId: null, detailTab: "details" })
                    }
                  />
                </TabsContent>
                <TabsContent value="files" className="mt-0">
                  <GroupFiles
                    group={selectedGroup}
                    bots={snapshot?.bots ?? []}
                    client={client}
                    tasks={selectedGroup.memberIds.flatMap(
                      (id) => tasksByThread.get(`group-${selectedGroup.id}-${id}`) ?? []
                    )}
                  />
                </TabsContent>
                <TabsContent value="computer" className="mt-0">
                  <GroupBrowser
                    key={selectedGroup.id}
                    group={selectedGroup}
                    bots={snapshot?.bots ?? []}
                    client={client}
                  />
                </TabsContent>
              </Tabs>
            </BotDetailsPane>
          </>
        )}
        {!newChat && selected && (
          <>
            {detailOpen && (
              <BotPanelDivider
                kind="detail"
                width={clampBotPanelWidth("detail", view.detailWidth)}
                onChange={(detailWidth) => updateView({ detailWidth })}
              />
            )}
            <BotDetailsPane open={detailOpen} label="Bot 详情">
              <div className="bot-detail-actions">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      ref={profileMenuTrigger}
                      className="bot-icon-button"
                      aria-label="更多 Bot 操作"
                    >
                      <MoreHorizontal size={20} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    data-bot-popup
                    align="end"
                    className="bot-workspace-menu rounded-xl p-1.5"
                  >
                    {!selected.archived && (
                      <button
                        className="flex w-full items-center rounded-md p-2 text-sm hover:bg-accent"
                        onClick={() => togglePin(selected.id)}
                      >
                        {pinnedIds.includes(selected.id) ? (
                          <PinOff className="mr-2 size-4" />
                        ) : (
                          <Pin className="mr-2 size-4" />
                        )}
                        {pinnedIds.includes(selected.id) ? "取消置顶" : "置顶 Bot"}
                      </button>
                    )}
                    <button
                      className="flex w-full items-center rounded-md p-2 text-sm hover:bg-accent"
                      onClick={() => openBotEditor(selected, profileMenuTrigger.current)}
                    >
                      <Settings2 className="mr-2 size-4" />
                      编辑 Bot
                    </button>
                    {client.im && (
                      <button
                        className="flex w-full items-center rounded-md p-2 text-sm hover:bg-accent"
                        onClick={() => setImBot(selected)}
                      >
                        IM 接入
                      </button>
                    )}
                    {client.mock && (
                      <button
                        className="flex w-full items-center rounded-md p-2 text-sm hover:bg-accent"
                        onClick={() => setMockBot(selected)}
                      >
                        模拟 IM 接入
                      </button>
                    )}
                    <button
                      className="flex w-full items-center rounded-md p-2 text-sm hover:bg-accent"
                      onClick={() => void archive(selected)}
                    >
                      <Archive className="mr-2 size-4" />
                      {selected.archived ? "恢复 Bot" : "归档 Bot"}
                    </button>
                    <button
                      className="flex w-full items-center rounded p-2 text-sm text-destructive hover:bg-accent"
                      onClick={() => {
                        editorTrigger.current = profileMenuTrigger.current
                        setDeleting(selected)
                      }}
                    >
                      <Trash2 className="mr-2 size-4" />
                      {selected.deleting ? "继续删除" : "删除 Bot"}
                    </button>
                  </PopoverContent>
                </Popover>
                <button
                  className="bot-icon-button"
                  aria-label="关闭详情"
                  onClick={() => setDetailOpen(false)}
                >
                  <X size={19} />
                </button>
              </div>
              <div className="bot-profile" key={`profile:${selected.id}`}>
                <BotAvatarEditor
                  bot={selected}
                  client={client}
                  settlement={tasksByBot.get(selected.id)?.at(-1)}
                  busy={selectedState === "running"}
                  waiting={selectedState === "waiting_user"}
                />
                <div className="bot-profile-identity">
                  <BotNameInput
                    name={selected.name}
                    version={selected.version}
                    label="Bot 名称"
                    maxLength={80}
                    disabled={Boolean(selectedState || selected.deleting)}
                    onSave={(name, expectedVersion) =>
                      client.update({ ...selected, name, expectedVersion })
                    }
                  />
                  <BotProfileLabel
                    bot={selected}
                    client={client}
                    disabled={Boolean(selectedState || selected.deleting)}
                  />
                </div>
                {(selectedState || selected.archived) && (
                  <span>
                    {selectedState
                      ? STATE_LABELS[selectedState]
                      : selected.archived
                        ? "已归档"
                        : ""}
                  </span>
                )}
              </div>
              <Tabs
                value={detailTab === "memory" ? "details" : detailTab}
                onValueChange={(tab) => {
                  if (tab === "details" || tab === "files" || tab === "computer") setDetailTab(tab)
                }}
              >
                <TabsList className="bot-detail-tabs h-auto bg-transparent" aria-label="Bot 详情">
                  <TabsTrigger
                    value="details"
                    className="font-normal data-[state=active]:shadow-none"
                    onClick={() => {
                      if (detailTab === "memory") setDetailTab("details")
                    }}
                  >
                    详情
                  </TabsTrigger>
                  <TabsTrigger
                    value="files"
                    className="font-normal data-[state=active]:shadow-none"
                  >
                    资料库
                  </TabsTrigger>
                  <TabsTrigger
                    value="computer"
                    className="font-normal data-[state=active]:shadow-none"
                  >
                    电脑
                  </TabsTrigger>
                </TabsList>
                <TabsContent
                  value={detailTab === "memory" ? "details" : detailTab}
                  className="mt-0"
                >
                  {activeWorkId &&
                  !selectedWork &&
                  (detailTab === "files" || detailTab === "computer") ? (
                    <div className="bot-detail-section" role="status">
                      <p>{works.error ?? "正在读取任务会话，资源面板暂不可用…"}</p>
                      <button onClick={() => void works.refresh()}>重试</button>
                      <button onClick={() => selectWork(null)}>返回主对话</button>
                    </div>
                  ) : selectedWork?.source &&
                    (detailTab === "files" || detailTab === "computer") ? (
                    <div className="bot-detail-section" role="note">
                      外部接入仅支持文字；此工作无法访问本机资料库和电脑。
                    </div>
                  ) : detailTab === "files" ? (
                    <BotFilesPanel
                      key={selectedThreadId}
                      bot={selected}
                      peers={snapshot?.bots ?? []}
                      client={conversationClient}
                      conversationThreadId={selectedThreadId}
                      refreshKey={botFileRefreshKey(tasks)}
                    />
                  ) : detailTab === "computer" ? (
                    <BotBrowserPanel
                      key={selectedThreadId}
                      botId={selected.id}
                      client={conversationClient}
                    />
                  ) : detailTab === "memory" ? (
                    <BotMemoryPanel
                      key={`${client.hostId}:${selected.id}`}
                      bot={selected}
                      client={client}
                      peers={snapshot?.bots ?? []}
                    />
                  ) : (
                    <>
                      <section className="bot-detail-section">
                        <h3>职责</h3>
                        <p>
                          {selected.instructions ||
                            "你可以在对话中交办工作，也可以为它设定长期职责。"}
                        </p>
                        <button onClick={(event) => openBotEditor(selected, event.currentTarget)}>
                          编辑职责
                        </button>
                        <button className="ml-4" onClick={() => setDetailTab("memory")}>
                          管理记忆
                        </button>
                      </section>
                      <BotWorkPanel
                        key={`${client.hostId}:${selected.id}`}
                        client={client}
                        botId={selected.id}
                        controller={works}
                        selected={selectedWork}
                        onSelect={selectWork}
                        disabled={Boolean(selected.archived || selected.deleting)}
                      />
                      <BotSchedulePanel
                        key={selected.id}
                        botId={selected.id}
                        client={client}
                        schedules={(snapshot?.schedules ?? []).filter(
                          (item) => item.botId === selected.id
                        )}
                      />
                      <section className="bot-detail-section">
                        <h3>最近活动</h3>
                        {tasks
                          .slice(-6)
                          .reverse()
                          .map((task) => (
                            <div className="bot-task-item" key={task.id}>
                              <span>{STATE_LABELS[task.state]}</span>
                              <p>{botTaskPreview(task)}</p>
                              {task.error && <small>{task.error}</small>}
                            </div>
                          ))}
                      </section>
                    </>
                  )}
                </TabsContent>
              </Tabs>
            </BotDetailsPane>
          </>
        )}
        {renamingGroup && (
          <BotGroupEditor
            key={renamingGroup.id}
            group={renamingGroup}
            bots={snapshot?.bots ?? []}
            client={client}
            nameOnly
            returnFocusTo={editorTrigger.current}
            onClose={() => setRenamingGroup(null)}
            onSaved={() => setRenamingGroup(null)}
          />
        )}
        {deletingGroup && (
          <BotDeleteDialog
            bot={deletingGroup}
            kind="group"
            client={client}
            returnFocusTo={editorTrigger.current}
            onClose={() => setDeletingGroup(null)}
            onDeleted={() => {
              const id = deletingGroup.id,
                prefs = useBotViewStore.getState().hosts[client.hostId]
              updateView({
                pinnedGroupIds: (prefs?.pinnedGroupIds ?? []).filter((item) => item !== id),
                hiddenGroupIds: (prefs?.hiddenGroupIds ?? []).filter((item) => item !== id),
                sections: (prefs?.sections ?? []).map((section) => ({
                  ...section,
                  groupIds: section.groupIds?.filter((item) => item !== id)
                })),
                ...(prefs?.groupId === id ? { groupId: null } : {})
              })
              setDeletingGroup(null)
            }}
          />
        )}
        {groupEditor && (
          <BotGroupEditor
            group={groupEditor === "new" ? null : groupEditor}
            returnFocusTo={groupEditorTrigger.current}
            bots={snapshot?.bots ?? []}
            client={client}
            onClose={() => setGroupEditor(null)}
            onSaved={(group) => {
              if (newChat) {
                createdChatGroup.current = group
                setGroupEditor(null)
                void selectNewChat(`group:${group.id}`, group)
                return
              }
              setGroupId(group.id)
              setGroupEditor(null)
              setShowArchived(false)
            }}
          />
        )}
        {renaming && (
          <BotEditor
            key={renaming.id}
            bot={renaming}
            client={client}
            nameOnly
            returnFocusTo={editorTrigger.current}
            onClose={() => setRenaming(null)}
            onSaved={() => setRenaming(null)}
          />
        )}
        {imBot && client.im && (
          <BotImChannelDialog
            key={`${client.hostId}:${imBot.id}`}
            client={client}
            bot={imBot}
            onClose={() => setImBot(null)}
            onOpenMain={() =>
              updateView({
                selectedId: imBot.id,
                groupId: null,
                activeWorkIdByBot: {
                  ...useBotViewStore.getState().hosts[client.hostId]?.activeWorkIdByBot,
                  [imBot.id]: null
                }
              })
            }
            onOpenWork={(id) =>
              updateView({
                selectedId: imBot.id,
                groupId: null,
                detailOpen: true,
                detailTab: "details",
                activeWorkIdByBot: {
                  ...useBotViewStore.getState().hosts[client.hostId]?.activeWorkIdByBot,
                  [imBot.id]: id
                }
              })
            }
          />
        )}
        {mockBot && client.mock && (
          <BotMockChannelDialog
            key={`${client.hostId}:${mockBot.id}`}
            bot={mockBot}
            client={client}
            revision={snapshot?.revision ?? 0}
            onClose={() => setMockBot(null)}
            onOpenWork={(id) => {
              updateView({
                selectedId: mockBot.id,
                groupId: null,
                detailOpen: true,
                detailTab: "details",
                activeWorkIdByBot: {
                  ...useBotViewStore.getState().hosts[client.hostId]?.activeWorkIdByBot,
                  [mockBot.id]: id
                }
              })
            }}
          />
        )}
        {editor && (
          <BotEditor
            bot={editor === "new" ? null : editor}
            initialName={newBotName}
            client={client}
            createBot={
              editorIntent
                ? (input) => {
                    if (
                      editorAttempt !== newChatAttempt.current ||
                      editorIntent !== newChatCreateIntent.current
                    )
                      return Promise.reject(new Error("创建页面已变化，请从当前草稿重试。"))
                    return createNewChatRecipient(input, editorIntent.recipientKey)
                  }
                : undefined
            }
            returnFocusTo={editorTrigger.current}
            onClose={() => {
              if (
                editorAttempt !== newChatAttempt.current ||
                editorIntent !== newChatCreateIntent.current
              )
                return
              newChatAttempt.current++
              newChatCreateIntent.current = null
              setEditor(null)
            }}
            onSaved={(bot) => {
              if (
                editorAttempt !== newChatAttempt.current ||
                editorIntent !== newChatCreateIntent.current
              )
                return
              newChatCreateIntent.current = null
              if (editor === "new" && newChat && editorIntent) {
                setEditor(null)
                setNewChatRecipients([{ kind: "bot", id: bot.id }])
                privateChatRecipient.current = bot
                void selectNewChat(`bot:${bot.id}`, undefined, editorIntent.intent === "send", bot)
                return
              }
              if (editor === "new" && newChat) closeNewChat()
              setSelectedId(bot.id)
              setGroupId(null)
              setShowArchived(bot.archived)
              setEditor(null)
            }}
          />
        )}
      </div>
    </TooltipProvider>
  )
}
