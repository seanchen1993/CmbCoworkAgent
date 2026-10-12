import { BotSkillCreateForm } from "./BotSkillCreateForm"
import { BotSkillMaintenancePanel } from "./BotSkillMaintenance"
import { BotSkillSaveRecovery } from "./BotSkillSaveRecovery"
import { botApi } from "@/lib/bot-api"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ArrowLeft, CalendarClock, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { readPendingRoutine, inspectPendingRoutine } from "@/lib/bot-routine-pending"
import { toggleBotRoutine, type BotRoutineOpenIntent } from "@/lib/bot-routine-toggle"
import { appendComposerText } from "@/lib/bot-composer-document"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import type { BotMemory, BotRoutine, BotSkill, CoworkBot } from "../../../../shared/bot-types"
import type { BotSkillTrial } from "../../../../shared/bot-teach"
import { BotMemoryPanel } from "./BotMemoryPanel"
import { BotSharedMemoryPanel } from "./BotSharedMemoryPanel"
import {
  BOT_USER_SKILLS_CAPABILITY,
  type BotLibrarySkill
} from "../../../../shared/bot-skill-library"
import type { BotSkillReference } from "../../../../shared/bot-skill-references"
import { BotSkillLibraryPanel } from "./BotSkillLibrary"
import { BotInstalledSkills } from "./BotInstalledSkills"
import { BotSkillCard } from "./BotSkillCard"
import { BotSkillDeletionRecovery } from "./BotSkillDeletion"
import { BotRoutinePendingRecovery } from "./BotRoutinePendingRecovery"
import { BotRoutineHistory } from "./BotRoutineHistory"
import { BotRoutineCard } from "./BotRoutineCard"
import { BotRoutineForm } from "./BotRoutineForm"
import { BotWebhook } from "./BotWebhook"
const report = (error: unknown) => toast.error(error instanceof Error ? error.message : "操作失败")

export interface BotResourcePresentation {
  busy: boolean
  modal: boolean
}

function BotResourceSurface({
  panel,
  close,
  onCloseAutoFocus,
  children
}: {
  panel: boolean
  close(): void
  onCloseAutoFocus(event: Event): void
  children: ReactNode
}) {
  if (panel)
    return (
      <section
        role="region"
        aria-label="例程详情"
        data-testid="bot-routine-detail"
        className="bot-routine-detail"
      >
        {children}
      </section>
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="bot-editor-dialog w-[calc(100%-2rem)] max-w-2xl gap-0 p-0"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

export function BotResources({
  bot,
  tab,
  focusId,
  routineIntent,
  referencedSkill,
  manageSkills,
  presentation = "dialog",
  back,
  onPresentationChange,
  close
}: {
  bot: CoworkBot
  tab: "memory" | "skills" | "routines"
  focusId?: string
  routineIntent?: BotRoutineOpenIntent
  referencedSkill?: BotSkillReference
  manageSkills?(): void
  presentation?: "dialog" | "panel"
  back?(): void
  onPresentationChange?(state: BotResourcePresentation): void
  close(): void
}) {
  const panel = presentation === "panel"
  const viewVisible = useBotViewVisibility()
  const mounted = useRef(true)
  const presentationCallback = useRef(onPresentationChange)
  const busyRef = useRef(false)
  const modalRef = useRef({
    edit: false,
    recovery: false,
    history: false,
    webhook: false,
    remove: false
  })
  const publishPresentation = useCallback(() => {
    presentationCallback.current?.({
      busy: busyRef.current,
      modal: Object.values(modalRef.current).some(Boolean)
    })
  }, [])
  useLayoutEffect(() => {
    presentationCallback.current = onPresentationChange
    publishPresentation()
  }, [onPresentationChange, publishPresentation])
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      presentationCallback.current?.({ busy: false, modal: false })
    }
  }, [])
  const [skillScope, setSkillScope] = useState(() =>
    useBotWorkspaceStore.getState().host?.capabilities?.includes(BOT_USER_SKILLS_CAPABILITY)
      ? "user"
      : "bot"
  )
  const installedSkills = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("installed-skills") ?? false
  )
  const [library, setLibrary] = useState<BotLibrarySkill[]>([])
  const sharedSkills = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("skill-library") ?? false
  )
  const [memoryScope, setMemoryScope] = useState<"bot" | "user" | "project">("bot")
  const scopedMemory = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("memory-scopes") ?? false
  )
  const [memories, setMemories] = useState<BotMemory[]>([]),
    [skills, setSkills] = useState<BotSkill[]>([]),
    [routines, setRoutines] = useState<BotRoutine[]>([])
  const [available, setAvailable] = useState<
    import("../../../../shared/bot-types").BotSkillSummary[]
  >([])
  const allTrialSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("skill-trials") ?? false
  )
  const [trials, setTrials] = useState<BotSkillTrial[]>([])
  const [busy, updateBusy] = useState(false)
  const setBusy = useCallback(
    (value: boolean) => {
      busyRef.current = value
      updateBusy(value)
      publishPresentation()
    },
    [publishPresentation]
  )
  const routineSkillSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-skills") ?? false
  )
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">("idle")
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogRetry, setCatalogRetry] = useState(0)
  const catalogRequest = useRef({ sequence: 0 })
  const catalogLoaded = useRef(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const routineSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-management") ?? false
  )
  const historySupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-history") ?? false
  )
  const editorSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-editor") ?? false
  )
  const readinessSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("routine-readiness-state") ?? false
  )
  const mutationSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  const [memoryEpoch] = useState(dataEpoch)
  const [routinesLoaded, setRoutinesLoaded] = useState(false)
  const [creatingRoutine, setCreatingRoutine] = useState(
    () =>
      tab === "routines" &&
      !routineIntent &&
      editorSupport &&
      Boolean(readPendingRoutine(bot.id, undefined, dataEpoch ?? "initial"))
  )
  const createRoutineButton = useRef<HTMLButtonElement>(null)
  const createRoutinePanel = useRef<HTMLDivElement>(null)
  const visitedCreation = useRef(false)
  useEffect(() => {
    if (creatingRoutine) {
      visitedCreation.current = true
      createRoutinePanel.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus()
    } else if (visitedCreation.current) {
      createRoutineButton.current?.focus({ preventScroll: true })
    }
  }, [creatingRoutine])
  const [editRoutine, updateEditRoutine] = useState<BotRoutine | null>(null)
  const setEditRoutine = useCallback(
    (value: BotRoutine | null) => {
      modalRef.current.edit = Boolean(value)
      if (value) {
        catalogLoaded.current = false
        setCatalogStatus("idle")
      }
      publishPresentation()
      updateEditRoutine(value)
    },
    [publishPresentation]
  )
  const [recoveryId, updateRecoveryId] = useState<string | null>(null)
  const setRecoveryId = useCallback(
    (value: string | null) => {
      modalRef.current.recovery = Boolean(value)
      if (value) {
        catalogLoaded.current = false
        setCatalogStatus("idle")
      }
      publishPresentation()
      updateRecoveryId(value)
    },
    [publishPresentation]
  )
  const openedRoutineIntent = useRef<string | null>(null)
  const [historyRoutine, updateHistoryRoutine] = useState<BotRoutine | null>(null)
  const setHistoryRoutine = useCallback(
    (value: BotRoutine | null) => {
      modalRef.current.history = Boolean(value)
      publishPresentation()
      updateHistoryRoutine(value)
    },
    [publishPresentation]
  )
  const [webhookRoutine, updateWebhookRoutine] = useState<BotRoutine | null>(null)
  const setWebhookRoutine = useCallback(
    (value: BotRoutine | null) => {
      modalRef.current.webhook = Boolean(value)
      publishPresentation()
      updateWebhookRoutine(value)
    },
    [publishPresentation]
  )
  const webhookSupport = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("webhooks") ?? false
  )
  const routineLimit = useBotWorkspaceStore((state) => state.host?.limits?.routines)
  const routinesFull =
    tab === "routines" && routineLimit !== undefined && routines.length >= routineLimit
  const [deleteRoutine, updateDeleteRoutine] = useState<{
    routine: BotRoutine
    nonce: string
    uncertain?: boolean
  } | null>(null)
  const setDeleteRoutine = useCallback(
    (value: { routine: BotRoutine; nonce: string; uncertain?: boolean } | null) => {
      modalRef.current.remove = Boolean(value)
      publishPresentation()
      updateDeleteRoutine(value)
    },
    [publishPresentation]
  )
  const editingRoutine = useRef<{
    conversationId: string
    revision?: string
  } | null>(null)
  const focusedRoutine = useRef<string | null>(null)
  const routineBackButton = useRef<HTMLButtonElement>(null)
  const routineRequest = useRef({ sequence: 0 })
  const resourceRequest = useRef({ sequence: 0 })
  const readRoutines = useCallback(async () => {
    const generation = ++routineRequest.current.sequence
    try {
      const items = await botApi.routines(bot.id)
      if (
        generation === routineRequest.current.sequence &&
        mounted.current &&
        useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch
      ) {
        setRoutines(items)
        setRoutinesLoaded(true)
        setFailure(null)
      }
    } catch (error) {
      if (
        generation === routineRequest.current.sequence &&
        mounted.current &&
        useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch
      )
        throw error
    }
  }, [bot.id, dataEpoch])
  const load = useCallback(async () => {
    const sequence = ++resourceRequest.current.sequence
    if (tab === "memory") {
      if (useBotWorkspaceStore.getState().snapshot?.dataEpoch !== memoryEpoch) return
      const items = await botApi.memories(bot.id)
      if (
        sequence === resourceRequest.current.sequence &&
        useBotWorkspaceStore.getState().snapshot?.dataEpoch === memoryEpoch
      )
        setMemories(items)
    }
    if (tab === "skills") {
      const [items, runs, shared, catalog] = await Promise.all([
        botApi.skills(bot.id),
        botApi.skillTrials(bot.id),
        sharedSkills ? botApi.skillLibrary() : Promise.resolve([]),
        allTrialSupport ? botApi.availableSkills(bot.id) : Promise.resolve([])
      ])
      if (sequence !== resourceRequest.current.sequence) return
      setAvailable(catalog)
      setLibrary(shared)
      setSkills(items)
      setTrials(runs)
      setSkillsLoaded(true)
    }
    if (tab === "routines") {
      await readRoutines()
      if (sequence !== resourceRequest.current.sequence) return
      if (!panel) {
        const items = allTrialSupport
          ? await botApi.availableSkills(bot.id)
          : await botApi.skills(bot.id)
        if (
          sequence === resourceRequest.current.sequence &&
          mounted.current &&
          useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch
        )
          setAvailable(items)
      }
    }
    if (sequence === resourceRequest.current.sequence) setFailure(null)
  }, [bot.id, tab, readRoutines, sharedSkills, allTrialSupport, memoryEpoch, panel, dataEpoch])
  useEffect(() => {
    if (!viewVisible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const fence = resourceRequest.current
    const routineFence = routineRequest.current
    const poll = async () => {
      try {
        await load()
      } catch (error) {
        if (!disposed) setFailure(error instanceof Error ? error.message : "资料读取失败")
      } finally {
        if (!disposed && tab !== "memory") timer = setTimeout(() => void poll(), 2000)
      }
    }
    void poll()
    return () => {
      disposed = true
      ++fence.sequence
      ++routineFence.sequence
      clearTimeout(timer)
    }
  }, [load, tab, viewVisible])
  useEffect(() => {
    if (creatingRoutine || !focusId || !routines.some((routine) => routine.id === focusId)) return
    const key = `${bot.id}:${focusId}`
    if (focusedRoutine.current === key) return
    const node = document.getElementById(`bot-routine-${focusId}`)
    node?.scrollIntoView({ block: "center" })
    node?.focus({ preventScroll: true })
    if (node) focusedRoutine.current = key
  }, [bot.id, focusId, routines, creatingRoutine])
  const skillReference =
    tab === "skills" && referencedSkill?.botId === bot.id && referencedSkill.id === focusId
      ? referencedSkill
      : undefined
  const referenceTarget = (() => {
    if (!skillReference) return undefined
    const own = skills.find((item) => item.id === skillReference.id)
    if (own) return { scope: "bot", version: own.version }
    const shared = library.find((item) => item.id === skillReference.id && item.enabled)
    if (shared) return { scope: "user", version: shared.revision }
    const installed = available.find(
      (item) => item.id === skillReference.id && item.scope === "desktop"
    )
    if (installed) return { scope: "desktop", version: installed.version }
    return undefined
  })()
  const referenceScope = referenceTarget?.scope
  const initialSkillFocus = useRef("")
  const positionedSkill = useRef("")
  useEffect(() => {
    if (!skillReference || !skillsLoaded || !referenceScope) return
    const key = `${bot.id}:${skillReference.id}:${skillReference.version}`
    if (initialSkillFocus.current === key) return
    initialSkillFocus.current = key
    setSkillScope(referenceScope)
  }, [bot.id, skillReference, skillsLoaded, referenceScope])
  useEffect(() => {
    if (!skillReference || !referenceScope || skillScope !== referenceScope) return
    const key = `${bot.id}:${skillReference.id}:${skillReference.version}`
    if (positionedSkill.current === key) return
    const node = document.getElementById(`bot-skill-${skillReference.id}`)
    if (!node) return
    node.scrollIntoView({ block: "center" })
    node.focus({ preventScroll: true })
    positionedSkill.current = key
  }, [bot.id, skillReference, skillScope, referenceScope, skills, library])
  const mutationInFlight = useRef(false)
  const currentEpoch = useCallback(
    () => useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch,
    [dataEpoch]
  )
  const live = useCallback(() => mounted.current && currentEpoch(), [currentEpoch])
  const mutate = async (action: () => Promise<unknown>) => {
    if (!live() || mutationInFlight.current) return
    mutationInFlight.current = true
    setBusy(true)
    try {
      await action()
      if (!live()) return
      await load()
      if (!live()) return
      await useBotWorkspaceStore.getState().refresh()
    } catch (error) {
      if (live()) report(error)
    } finally {
      mutationInFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const catalogTarget = editRoutine?.id ?? recoveryId
  useEffect(() => {
    if (!panel || !routineSkillSupport || !catalogTarget || !viewVisible || catalogLoaded.current)
      return
    const fence = catalogRequest.current
    const request = ++fence.sequence
    let disposed = false
    const isCurrent = () =>
      !disposed &&
      mounted.current &&
      request === fence.sequence &&
      useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch
    setCatalogStatus("loading")
    setCatalogError(null)
    void (allTrialSupport ? botApi.availableSkills(bot.id) : botApi.skills(bot.id)).then(
      (items) => {
        if (!isCurrent()) return
        setAvailable(items)
        catalogLoaded.current = true
        setCatalogStatus("ready")
      },
      (error: unknown) => {
        if (!isCurrent()) return
        setCatalogError(error instanceof Error ? error.message : "技能读取失败")
        setCatalogStatus("error")
      }
    )
    return () => {
      disposed = true
      ++fence.sequence
    }
  }, [
    panel,
    routineSkillSupport,
    catalogTarget,
    viewVisible,
    catalogRetry,
    allTrialSupport,
    bot.id,
    dataEpoch
  ])
  const toggleRoutine = async (routine: BotRoutine) => {
    if (!dataEpoch || !live()) return
    // The existing editor retains its original busy owner on reopen.
    if (editorSupport && inspectPendingRoutine(bot.id, routine.id, dataEpoch).kind !== "empty") {
      setEditRoutine(routine)
      return
    }
    if (readinessSupport && routine.effectiveState === "needs_setup" && routine.skillIssue) {
      setEditRoutine(routine)
      return
    }
    await mutate(() =>
      toggleBotRoutine({
        botId: bot.id,
        routine,
        dataEpoch,
        editorSupport,
        mutationSupport,
        readinessSupport,
        setup: () => setEditRoutine(routine),
        reschedule: () => setEditRoutine(routine),
        isLive: live,
        isCurrentEpoch: currentEpoch,
        save: (input) => botApi.saveRoutine(input),
        recover: () => setEditRoutine(routine)
      })
    )
  }
  const viewRoutineId =
    tab === "routines" &&
    routineIntent?.mode === "view" &&
    routineIntent.dataEpoch === (dataEpoch ?? "initial")
      ? routineIntent.id
      : undefined
  const editRoutineInChat = useCallback(
    (routine: BotRoutine) => {
      const state = useBotWorkspaceStore.getState()
      const conversation = state.snapshot?.conversations.find(
        (item) => item.kind === "direct" && item.members.includes(bot.id)
      )
      if (!conversation) {
        toast.error("此 Bot 的对话不可用")
        return
      }
      if (!live() || busyRef.current || Object.values(modalRef.current).some(Boolean)) return
      state.select(conversation.id)
      const previous = useBotWorkspaceStore.getState().drafts[conversation.id]
      const change = appendComposerText(
        previous ?? { prompt: "", attachments: [] },
        `请修改例程「${routine.name}」（ID: ${routine.id}，版本 ${routine.revision}）：`
      )
      if (!change) {
        toast.error("草稿内容过长，请缩短后再添加例程调整要求")
        return
      }
      state.updateDraft(conversation.id, change)
      editingRoutine.current = {
        conversationId: conversation.id,
        revision: useBotWorkspaceStore.getState().drafts[conversation.id]?.revision
      }
      ;(panel ? (back ?? close) : close)()
    },
    [bot.id, live, panel, back, close]
  )
  useEffect(() => {
    if (
      tab !== "routines" ||
      !routinesLoaded ||
      !routineIntent ||
      routineIntent.mode === "view" ||
      routineIntent.dataEpoch !== (dataEpoch ?? "initial")
    )
      return
    const key = `${bot.id}:${routineIntent.id}:${routineIntent.dataEpoch}:${routineIntent.mode}`
    if (openedRoutineIntent.current === key || !live() || busyRef.current) return
    openedRoutineIntent.current = key
    const selected = routines.find((item) => item.id === routineIntent.id)
    if (routineIntent.mode === "recover") {
      if (selected) setEditRoutine(selected)
      else setRecoveryId(routineIntent.id)
    } else if (!selected) toast.error("例程已删除或不再可用。")
    else if (routineSupport && editorSupport && routineIntent.mode === "reschedule")
      setEditRoutine(selected)
    else if (routineIntent.mode === "history" && historySupport) setHistoryRoutine(selected)
    else if (routineSupport && routineIntent.mode === "edit") editRoutineInChat(selected)
    else if (routineSupport && routineIntent.mode === "delete")
      setDeleteRoutine({ routine: selected, nonce: crypto.randomUUID() })
  }, [
    bot.id,
    tab,
    routineIntent,
    routinesLoaded,
    routines,
    dataEpoch,
    routineSupport,
    editorSupport,
    historySupport,
    setEditRoutine,
    setRecoveryId,
    setHistoryRoutine,
    setDeleteRoutine,
    editRoutineInChat,
    live
  ])
  const focusPreparedDraft = useCallback(() => {
    if (!editingRoutine.current) return
    const { conversationId, revision } = editingRoutine.current
    requestAnimationFrame(() => {
      const state = useBotWorkspaceStore.getState()
      if (state.selected !== conversationId || state.drafts[conversationId]?.revision !== revision)
        return
      const field = document.getElementById(`bot-composer-${conversationId}`)
      if (!field || field.closest("[inert]") || !field.getClientRects().length) return
      field.focus({ preventScroll: true })
      const range = document.createRange()
      range.selectNodeContents(field)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }, [])
  useEffect(
    () => () => {
      if (panel) focusPreparedDraft()
    },
    [panel, focusPreparedDraft]
  )
  const exit = (action: () => void) => {
    if (!live() || busyRef.current || Object.values(modalRef.current).some(Boolean)) return
    action()
  }
  const selectedRoutine = routines.find((routine) => routine.id === viewRoutineId)
  const missingRoutine = Boolean(panel && routinesLoaded && viewRoutineId && !selectedRoutine)
  const childModalOpen = Boolean(
    editRoutine || recoveryId || historyRoutine || webhookRoutine || deleteRoutine
  )
  useLayoutEffect(() => {
    if (
      !missingRoutine ||
      !viewVisible ||
      !mounted.current ||
      busy ||
      childModalOpen ||
      useBotWorkspaceStore.getState().snapshot?.dataEpoch !== dataEpoch
    )
      return
    const focused = document.activeElement
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      focused.isConnected &&
      !focused.closest("[hidden],[inert]") &&
      focused.getClientRects().length
    )
      return
    if (
      [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"],[role="menu"],[role="listbox"]')
      ].some((node) => !node.closest("[hidden],[inert]") && node.getClientRects().length)
    )
      return
    // Removing the exact card can remove its focused control. Keep Escape and
    // keyboard navigation on the remaining detail surface without stealing focus.
    routineBackButton.current?.focus({ preventScroll: true })
  }, [missingRoutine, viewVisible, dataEpoch, busy, childModalOpen])
  return (
    <BotResourceSurface
      panel={panel}
      close={() => exit(close)}
      onCloseAutoFocus={(event) => {
        if (!editingRoutine.current) return
        event.preventDefault()
        focusPreparedDraft()
      }}
    >
      {panel ? (
        <>
          <header
            className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3"
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                !event.nativeEvent.isComposing &&
                event.keyCode !== 229 &&
                !event.defaultPrevented
              ) {
                event.preventDefault()
                event.stopPropagation()
                exit(back ?? close)
              }
            }}
          >
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 rounded-full px-2"
              ref={routineBackButton}
              aria-label="返回 Bot 详情"
              disabled={busy}
              onClick={() => exit(back ?? close)}
            >
              <ArrowLeft size={15} />
              返回详情
            </Button>
            <h2 className="min-w-0 flex-1 break-words text-sm font-medium">
              {selectedRoutine?.name ?? "例程详情"}
            </h2>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 rounded-full"
              aria-label="关闭例程详情面板"
              disabled={busy}
              onClick={() => exit(close)}
            >
              <X size={16} />
            </Button>
          </header>
        </>
      ) : (
        <>
          <DialogHeader className="shrink-0 border-b px-6 py-5 pr-12 text-left">
            {viewRoutineId && (
              <Button
                size="sm"
                variant="ghost"
                className="mb-1 gap-1.5 rounded-full px-2"
                aria-label="返回 Bot 详情"
                disabled={busy}
                onClick={close}
              >
                <ArrowLeft size={15} />
                返回详情
              </Button>
            )}
            {creatingRoutine && (
              <Button
                size="icon"
                variant="ghost"
                className="mb-1 size-8 rounded-full"
                aria-label="返回例程列表"
                disabled={busy}
                onClick={() => setCreatingRoutine(false)}
              >
                <ArrowLeft size={17} />
              </Button>
            )}
            <DialogTitle>
              {viewRoutineId
                ? "例程详情"
                : creatingRoutine
                  ? "新建例程"
                  : `${bot.name} · ${tab === "memory" ? "记忆" : tab === "skills" ? "技能" : "例程"}`}
            </DialogTitle>
            <DialogDescription>
              {tab === "memory"
                ? "保存工作偏好和长期事实；删除的内容不会被旧版本覆盖恢复。"
                : tab === "skills"
                  ? "将成熟流程保存为技能，供后续任务复用。"
                  : creatingRoutine
                    ? "设定工作内容与执行计划，Bot 会按时处理。"
                    : viewRoutineId
                      ? "查看指令、运行计划与执行记录。"
                      : "安排周期工作，查看计划与运行记录。"}
            </DialogDescription>
          </DialogHeader>
        </>
      )}
      {skillReference && (
        <aside
          role="status"
          aria-label="消息引用的技能"
          className="mx-6 mt-4 shrink-0 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-relaxed"
        >
          <p className="font-medium">
            /{skillReference.name} · 消息引用 v{skillReference.version}
          </p>
          <p className="mt-1 text-muted-foreground">
            {!skillsLoaded
              ? "正在读取技能…"
              : !referenceTarget
                ? "该技能已删除或不再可用。"
                : referenceTarget.version !== skillReference.version
                  ? `当前版本为 v${referenceTarget.version}，与消息引用的版本不同。`
                  : "查看此版本的工作步骤与验证记录。"}
          </p>
        </aside>
      )}
      {failure && (
        <p role="alert" className="px-6 py-3 text-sm text-destructive">
          {failure}
        </p>
      )}
      <div
        hidden={creatingRoutine}
        className={
          panel
            ? "flex min-h-0 min-w-0 flex-1 flex-col"
            : "min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 space-y-3"
        }
        onKeyDown={
          panel
            ? (event) => {
                if (
                  event.key !== "Escape" ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229 ||
                  event.defaultPrevented ||
                  (event.target instanceof Element &&
                    event.target.closest('[role="dialog"],[role="menu"],[role="listbox"]'))
                )
                  return
                event.preventDefault()
                event.stopPropagation()
                exit(back ?? close)
              }
            : undefined
        }
      >
        {tab === "memory" &&
          (scopedMemory ? (
            <Tabs
              value={memoryScope}
              onValueChange={(value) => {
                if (value === "bot" || value === "user" || value === "project")
                  setMemoryScope(value)
              }}
              className="space-y-4"
            >
              <TabsList className="flex w-full" aria-label="记忆范围">
                {(
                  [
                    ["bot", "此 Bot"],
                    ["project", "当前项目"],
                    ["user", "我的所有 Bot"]
                  ] as const
                ).map(([scope, label]) => (
                  <TabsTrigger
                    key={scope}
                    value={scope}
                    className="flex-1 text-xs"
                    disabled={scope === "project" && !bot.workspacePath}
                  >
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="bot">
                <BotMemoryPanel botId={bot.id} memories={memories} reload={load} close={close} />
              </TabsContent>
              {(["project", "user"] as const).map((scope) => (
                <TabsContent key={scope} value={scope}>
                  <BotSharedMemoryPanel
                    key={`${bot.id}:${bot.revision}:${scope}`}
                    bot={bot}
                    scope={scope}
                    close={close}
                  />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <BotMemoryPanel botId={bot.id} memories={memories} reload={load} close={close} />
          ))}
        {tab === "skills" && (
          <Tabs value={skillScope} onValueChange={setSkillScope} className="space-y-4">
            {sharedSkills && (
              <TabsList className="flex w-full" aria-label="技能范围">
                <TabsTrigger value="bot" className="flex-1 text-xs">
                  此 Bot
                </TabsTrigger>
                <TabsTrigger value="user" className="flex-1 text-xs">
                  我的技能库
                </TabsTrigger>
                {installedSkills && (
                  <TabsTrigger value="desktop" className="flex-1 text-xs">
                    CMBDevClaw 技能
                  </TabsTrigger>
                )}
              </TabsList>
            )}
            <BotSkillSaveRecovery
              botId={bot.id}
              activeSkillIds={[
                ...skills.map((skill) => skill.id),
                ...library.filter((skill) => skill.enabled).map((skill) => skill.id)
              ]}
              reload={load}
            />
            <TabsContent value="bot" className="space-y-3">
              <BotSkillMaintenancePanel
                key={`${bot.id}:${dataEpoch}`}
                botId={bot.id}
                reload={load}
              />
              <BotSkillDeletionRecovery
                botId={bot.id}
                activeSkillIds={skills.map((skill) => skill.id)}
                reload={load}
              />
              {skills.map((skill) => (
                <BotSkillCard
                  key={skill.id}
                  skill={skill}
                  revealSteps={skill.id === skillReference?.id}
                  trials={trials.filter((trial) => trial.skillId === skill.id)}
                  reload={load}
                  sharing={
                    sharedSkills
                      ? {
                          published: library.find((item) => item.sourceSkillId === skill.id)
                        }
                      : undefined
                  }
                />
              ))}
            </TabsContent>
            {sharedSkills && (
              <TabsContent value="user">
                <BotSkillLibraryPanel
                  botId={bot.id}
                  focusId={skillReference?.id}
                  items={library}
                  available={available}
                  trials={trials}
                  reload={load}
                />
              </TabsContent>
            )}
            {installedSkills && (
              <TabsContent value="desktop">
                <BotInstalledSkills
                  key={bot.id}
                  botId={bot.id}
                  focusId={skillReference?.id}
                  manage={manageSkills}
                  trials={trials}
                  reload={load}
                />
              </TabsContent>
            )}
          </Tabs>
        )}
        {tab === "routines" && (
          <>
            {!panel && !viewRoutineId && (
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {routineLimit !== undefined
                    ? `${routines.length} / ${routineLimit} 个例程`
                    : `${routines.length} 个例程`}
                  {routinesFull && " · 已达创建上限"}
                </p>
                <Button
                  ref={createRoutineButton}
                  size="sm"
                  className="rounded-full"
                  disabled={busy}
                  onClick={() => setCreatingRoutine(true)}
                >
                  <Plus size={15} />
                  新建例程
                </Button>
              </div>
            )}
            {routinesLoaded &&
              editorSupport &&
              routineIntent?.mode !== "recover" &&
              !recoveryId &&
              !panel &&
              !viewRoutineId && (
                <BotRoutinePendingRecovery
                  botId={bot.id}
                  dataEpoch={dataEpoch ?? "initial"}
                  activeRoutineIds={routines.map((item) => item.id)}
                />
              )}
            {!routinesLoaded && !failure && (
              <p role="status" className="py-8 text-center text-sm text-muted-foreground">
                正在读取例程…
              </p>
            )}
            {routinesLoaded &&
              viewRoutineId &&
              !routines.some((item) => item.id === viewRoutineId) && (
                <p role="status" className="py-8 text-center text-sm text-muted-foreground">
                  例程已删除或不再可用。
                </p>
              )}
            {routinesLoaded && !panel && !viewRoutineId && routines.length === 0 && !failure && (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                  <CalendarClock size={22} className="text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-medium">让重复工作按时完成</h3>
                  <p className="text-sm text-muted-foreground">
                    新建例程，设定工作内容与执行时间。
                  </p>
                </div>
              </div>
            )}
            {panel && !viewRoutineId && (
              <p role="status" className="px-6 py-8 text-sm text-muted-foreground">
                例程已不可用，请重新打开后核对。
              </p>
            )}
            {(panel && !viewRoutineId ? [] : routines)
              .filter((routine) => !viewRoutineId || routine.id === viewRoutineId)
              .map((routine) => (
                <BotRoutineCard
                  key={routine.id}
                  routine={routine}
                  detail={panel}
                  dataEpoch={dataEpoch}
                  readinessSupport={readinessSupport}
                  busy={busy}
                  edit={routineSupport && editorSupport ? () => setEditRoutine(routine) : undefined}
                  editInChat={routineSupport ? () => editRoutineInChat(routine) : undefined}
                  history={historySupport ? () => setHistoryRoutine(routine) : undefined}
                  webhook={
                    webhookSupport && routine.schedule.kind === "event"
                      ? () => setWebhookRoutine(routine)
                      : undefined
                  }
                  remove={
                    routineSupport
                      ? () =>
                          setDeleteRoutine({
                            routine,
                            nonce: crypto.randomUUID()
                          })
                      : undefined
                  }
                  toggle={() => void toggleRoutine(routine)}
                />
              ))}
          </>
        )}
        {tab === "skills" && (skillScope === "bot" || skillScope === "user") && (
          <BotSkillCreateForm
            key={`${bot.id}:${dataEpoch}`}
            botId={bot.id}
            reload={load}
            onCreatedScope={setSkillScope}
          />
        )}
      </div>
      <Dialog
        open={Boolean(editRoutine || recoveryId)}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditRoutine(null)
            setRecoveryId(null)
          }
        }}
      >
        <DialogContent className="bot-editor-dialog bot-routine-dialog w-[calc(100%-2rem)] max-w-xl gap-0 p-0">
          <DialogHeader className="shrink-0 border-b px-6 py-5 pr-12 text-left">
            <DialogTitle>{recoveryId ? "核对原例程" : "编辑例程"}</DialogTitle>
            <DialogDescription>
              {recoveryId
                ? "核对已保存的原请求；不会重新创建已删除的例程。"
                : "调整工作内容和执行计划，保存后用于后续运行。"}
            </DialogDescription>
          </DialogHeader>
          {panel && routineSkillSupport && catalogStatus !== "ready" && (
            <div className="space-y-3 px-6 py-5">
              {catalogStatus === "error" ? (
                <>
                  <p role="alert" className="text-sm text-destructive">
                    {catalogError}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCatalogRetry((value) => value + 1)}
                  >
                    重试读取技能
                  </Button>
                </>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  正在读取技能…
                </p>
              )}
            </div>
          )}
          {(editRoutine || recoveryId) &&
            (!panel || !routineSkillSupport || catalogStatus === "ready") && (
              <BotRoutineForm
                key={editRoutine?.id ?? recoveryId!}
                dialog
                botId={bot.id}
                routine={editRoutine ?? undefined}
                recoveryId={recoveryId ?? undefined}
                skills={available}
                latest={routines.find((item) => item.id === (editRoutine?.id ?? recoveryId))}
                idempotent={editorSupport}
                onBusyChange={setBusy}
                onCancel={() => {
                  setEditRoutine(null)
                  setRecoveryId(null)
                }}
                onSaved={() => {
                  setEditRoutine(null)
                  setRecoveryId(null)
                  void readRoutines().catch(report)
                }}
              />
            )}
        </DialogContent>
      </Dialog>
      {tab === "routines" && !panel && !viewRoutineId && (
        <div ref={createRoutinePanel} className={creatingRoutine ? "contents" : "hidden"}>
          <BotRoutineForm
            key={bot.id}
            dialog
            botId={bot.id}
            skills={available}
            full={routinesFull}
            idempotent={editorSupport}
            onBusyChange={setBusy}
            onCancel={() => setCreatingRoutine(false)}
            onSaved={() => {
              setCreatingRoutine(false)
              void readRoutines().catch(report)
            }}
          />
        </div>
      )}
      {historyRoutine && (
        <BotRoutineHistory
          key={historyRoutine.id}
          routine={routines.find((routine) => routine.id === historyRoutine.id) ?? historyRoutine}
          close={() => setHistoryRoutine(null)}
          openMessage={(conversationId, messageId) => {
            if (!live() || busyRef.current) return
            setHistoryRoutine(null)
            useBotWorkspaceStore.setState({
              navigation: { conversationId, messageId }
            })
            close()
          }}
        />
      )}
      {webhookRoutine && (
        <BotWebhook
          key={`${webhookRoutine.id}:${dataEpoch}`}
          routine={routines.find((item) => item.id === webhookRoutine.id) ?? webhookRoutine}
          close={() => setWebhookRoutine(null)}
        />
      )}
      <Dialog
        open={deleteRoutine !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteRoutine(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除例程「{deleteRoutine?.routine.name}」？</DialogTitle>
            <DialogDescription>
              删除后不再触发新任务，并取消尚未开始的任务。运行中或待核对的任务会保留，历史结果不会删除。
            </DialogDescription>
          </DialogHeader>
          {deleteRoutine &&
            !routines.some(
              (routine) =>
                routine.id === deleteRoutine.routine.id &&
                routine.revision === deleteRoutine.routine.revision
            ) && (
              <p role="alert" className="text-sm text-destructive">
                {deleteRoutine.uncertain
                  ? "上次删除结果尚未确认，可重试核对。"
                  : "例程已变化，请关闭此窗口后重新确认。"}
              </p>
            )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setDeleteRoutine(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={
                busy ||
                (!deleteRoutine?.uncertain &&
                  !routines.some(
                    (routine) =>
                      routine.id === deleteRoutine?.routine.id &&
                      routine.revision === deleteRoutine.routine.revision
                  ))
              }
              onClick={() => {
                if (!deleteRoutine) return
                const selected = deleteRoutine
                void mutate(async () => {
                  let receipt
                  try {
                    receipt = await botApi.deleteRoutine({
                      nonce: selected.nonce,
                      botId: bot.id,
                      id: selected.routine.id,
                      revision: selected.routine.revision
                    })
                  } catch (error) {
                    if (!live()) throw error
                    const code =
                      error && typeof error === "object" && "code" in error
                        ? String(error.code)
                        : ""
                    setDeleteRoutine({
                      ...selected,
                      uncertain: !["revision_conflict", "not_found", "invalid_input"].includes(code)
                    })
                    throw error
                  }
                  if (!live()) return
                  setDeleteRoutine(null)
                  if (receipt.activeRunIds.length)
                    toast.message("例程已删除；已经开始的任务仍可在对话中停止或核对")
                })
              }}
            >
              {busy ? "正在删除…" : deleteRoutine?.uncertain ? "重试核对" : "确认删除"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </BotResourceSurface>
  )
}
