import { botEntityReferences, type BotEntityReference } from "../../../shared/bot-entity-references"
import { botApi } from "@/lib/bot-api"
import { readBotWorkspaceFrame } from "../../../shared/bot-workspace-frame"
import { BotWorkPageCache, type BotRendererWorkPage } from "./bot-work-page-cache"
import { BotTrackedWorkRegistry, isBotTrackedWorkState } from "./bot-tracked-work"
import {
  botTrackedWorkKey,
  type BotTrackedWorkTarget,
  type BotTrackedWorkState,
  type BotPendingWork,
  type BotWorkScope
} from "../../../shared/bot-work-pages"
import { BOT_RUN_OUTPUT_CAPABILITY } from "../../../shared/bot-run-output"
import { selectBotConversationTasks } from "./bot-conversation-tasks"
import { BotRunOutputCache, type BotCachedRunOutput } from "./bot-run-output-cache"
import type { BotPrimaryState } from "../../../shared/bot-primary"
import { mergeBotPrimaryState } from "./bot-primary-state"
import {
  composerDraftSelectionQuotes,
  composerDraftInlineReferences
} from "./bot-composer-document"
import { fetchBotMessagePage } from "./bot-message-fetch"
import { botSteeringTarget } from "./bot-steering"
import { create } from "zustand"
import { botErrorNotice, type BotErrorNotice } from "./bot-error-notice"
import { projectBotErrorTraySnapshot, sameBotErrorTrayAuthority } from "./bot-error-tray-projection"
import { mergeBotNotificationSettings } from "./bot-notification-projection"
import type {
  BotErrorTrayAuthority,
  BotErrorTraySnapshot,
  BotDismissErrorTray,
  BotClearErrorTrays
} from "../../../shared/bot-error-trays"
import {
  BOT_MESSAGE_PAGE_SIZE,
  boundBotMessageWindow,
  mergeBotMessagePage,
  mergeBotReactionStates,
  mergeBotThreadSummaries
} from "./bot-message-history"
import type { BotReactionState } from "../../../shared/bot-reactions"
import type { BotHostStatus } from "../../../shared/bot-api"
import type {
  BotMessage,
  BotSendInput,
  BotWorkspaceSnapshot,
  BotRun
} from "../../../shared/bot-types"
import { type DraftAttachment } from "../components/bots/upstream/grok-composer-draft"
import type { BotComposerDraft } from "./bot-composer-draft"
import { readStoredBotDraft } from "./bot-draft-storage"
import { botStartupPreferences, botStartupPreferenceScope } from "./bot-startup-preferences"
import type { BotSkillReference } from "../../../shared/bot-skill-references"
import { botRecipientIds } from "../../../shared/bot-recipients"
import { botThreadView, botViewAddress, retainBotViewCache } from "./bot-thread-view"
import {
  botViewportPositionCache,
  type BotViewportPosition,
  type BotViewportPositionLease
} from "./bot-viewport-position"
import type { BotThread, BotThreadSummary } from "../../../shared/bot-threads"
import type { BotDeepLink } from "../../../shared/bot-deep-link"
import {
  createRootShellNavigationState,
  recordRootShellAgentSelection,
  resolveRootShellNavigation,
  type RootShellNavigationState
} from "../components/bots/upstream/grok-navigation-history"

interface BotTranscriptError {
  viewId: string
  code: string | null
  message: string
  diagnostic?: BotErrorNotice["diagnostic"]
  /** An explicit navigation must retry its requested identity, not the latest page. */
  targetId?: string
  /** Paging failures keep the resident window and retry the same direction. */
  page?: "older" | "newer" | "latest"
}

/** A completed navigation owns only this view generation, including an
 * intentional main-conversation to thread redirect. Superseded work has no receipt. */
export interface BotMessageJumpReceipt {
  viewId: string
  lease: BotViewportPositionLease
}

interface BotWorkspaceState {
  navigation: BotDeepLink | null
  snapshot: BotWorkspaceSnapshot | null
  host: BotHostStatus | null
  taskPage: BotRendererWorkPage<BotRun>
  pendingPage: BotRendererWorkPage<BotPendingWork>
  trackedWork: Record<string, BotTrackedWorkState>
  setWorkPageOpen(kind: "tasks" | "pending", open: boolean): void
  navigateWorkPage(kind: "tasks" | "pending", direction: "next" | "previous" | "first"): void
  refreshWorkPages(): Promise<void>
  trackWork(target: BotTrackedWorkTarget): () => void
  watchTrackedWorkCapacity(retry: () => void): () => void
  runOutputs: Record<string, BotCachedRunOutput>
  expandedTaskOutputId: string | null
  expandTaskOutput(id: string | null): void
  activateTaskOutputs(): void
  clearTaskOutputs(disable?: boolean): void
  applyPrimary(primary: BotPrimaryState): void
  selected: string | null
  history: RootShellNavigationState
  threads: Record<string, BotThread>
  error: string | null
  errorNotice: BotErrorNotice | null
  errorTrayAuthority: BotErrorTrayAuthority | null
  errorTrays: BotErrorTraySnapshot | null
  applyErrorTrays(snapshot: BotErrorTraySnapshot): void
  dismissErrorTray(input: BotDismissErrorTray): Promise<BotErrorTraySnapshot>
  clearErrorTrays(input: BotClearErrorTrays): Promise<BotErrorTraySnapshot>
  transcriptError: BotTranscriptError | null
  messages: Record<string, BotMessage[]>
  drafts: Record<string, BotComposerDraft>
  readDraft(id: string): BotComposerDraft | undefined
  pending: Record<string, BotSendInput>
  pendingDraftRevisions: Record<string, string | undefined>
  sending: Record<string, boolean>
  uploading: Record<string, boolean>
  hasOlder: Record<string, boolean>
  loadingOlder: Record<string, boolean>
  opening: Record<string, boolean>
  hasNewer: Record<string, boolean>
  loadingNewer: Record<string, boolean>
  historyFollowTail: Record<string, boolean>
  historyAnchorIds: Record<string, string | undefined>
  viewportLease: BotViewportPositionLease | null
  viewportRestore: BotViewportPosition | null
  unreadAnchors: Record<string, number | null>
  automaticReadBlocked: Record<string, boolean>
  setUploading(id: string, uploading: boolean): void
  setHistoryFollowTail(id: string, following: boolean, anchorId?: string): void
  saveViewportPosition(
    id: string,
    position: BotViewportPosition,
    lease: BotViewportPositionLease
  ): boolean
  clearViewportRestore(id: string, lease?: BotViewportPositionLease): void
  select(id: string, restore?: boolean, targetId?: string): void
  retryMessages(id: string): void
  navigateHistory(direction: "back" | "forward"): void
  updateDraft(id: string, changes: Partial<BotComposerDraft>): void
  draft(id: string, text: string): void
  skills(id: string, skills: BotSkillReference[]): void
  references(id: string, references: BotEntityReference[]): void
  recipients(id: string, recipients: string[]): void
  reply(id: string, targetId?: string): void
  jumpToMessage(
    id: string,
    targetId: string,
    options?: { signal?: AbortSignal }
  ): Promise<BotMessageJumpReceipt | undefined>
  attachments(id: string, attachments: DraftAttachment[]): void
  refresh(options?: { preserveSelection?: boolean }): Promise<void>
  updateReactions(conversationId: string, changes: BotReactionState[]): void
  loadMessages(id: string, before?: number): Promise<void>
  loadNewer(id: string): Promise<void>
  markRead(id: string, throughSequence: number, manual?: boolean, unread?: boolean): Promise<void>
  send(id: string, recipients?: string[], newTask?: boolean): Promise<void>
}

function removeStoredPending(id: string, nonce: string): void {
  try {
    const stored = JSON.parse(localStorage.getItem(`bot-pending:${id}`) || "null")
    if (stored?.nonce === nonce) localStorage.removeItem(`bot-pending:${id}`)
  } catch {
    /* A persisted receipt can still deduplicate this retry after a storage failure. */
  }
}

/** Upgrade compatibility for pending sends saved before draft revisions existed. */
function matchesLegacySubmittedDraft(draft: BotComposerDraft, input: BotSendInput): boolean {
  const text =
    draft.prompt ||
    (draft.skills?.length
      ? "请按所选技能完成任务。"
      : draft.attachments.length
        ? "请查看附件。"
        : draft.references?.length
          ? "请查看所引用的对象。"
          : "")
  return (
    text === input.text &&
    (draft.replyToId ?? null) === (input.replyTo ?? null) &&
    JSON.stringify(draft.attachments.map(({ path }) => path)) ===
      JSON.stringify(input.attachments ?? []) &&
    JSON.stringify(
      draft.skills?.map(({ botId, id, version }) => ({ botId, id, version })) ?? []
    ) === JSON.stringify(input.skills ?? []) &&
    JSON.stringify(draft.references?.map(({ kind, id }) => ({ kind, id })) ?? []) ===
      JSON.stringify(input.references ?? []) &&
    JSON.stringify(draft.recipients ?? []) === JSON.stringify(input.recipients ?? []) &&
    JSON.stringify(composerDraftSelectionQuotes(draft)) ===
      JSON.stringify(input.selectionQuotes ?? [])
  )
}

const blank = (): BotComposerDraft => ({ prompt: "", attachments: [] })
function transcriptFailure(viewId: string, error: unknown, targetId?: string): BotTranscriptError {
  const notice = botErrorNotice(error, "消息加载失败")
  return {
    viewId,
    code:
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : null,
    message: notice.message,
    ...(notice.diagnostic ? { diagnostic: notice.diagnostic } : {}),
    ...(targetId ? { targetId } : {})
  }
}
/** Read caches can be discarded independently of unsent work and send receipts. */
const emptyHistory = () => ({
  selected: null,
  threads: {},
  messages: {},
  hasOlder: {},
  loadingOlder: {},
  opening: {},
  hasNewer: {},
  loadingNewer: {},
  historyFollowTail: {},
  historyAnchorIds: {},
  viewportLease: null,
  viewportRestore: null,
  transcriptError: null,
  unreadAnchors: {},
  automaticReadBlocked: {}
})
let refreshSequence = 0
let appliedRefresh = 0
let appliedEnvelopeRefresh = 0
let selectionSequence = 0
let refreshedMetadataSelection = -1
let dataGeneration = 0
const readQueues = new Map<string, Promise<void>>()
const readEpochs = new Map<string, number>()
const runOutputCache = new BotRunOutputCache()
let runOutputsActive = false
let runOutputGeneration = 0
let pendingOutputRead: { key: string; promise: Promise<void> } | undefined
const taskPager = new BotWorkPageCache<BotRun>()
const pendingPager = new BotWorkPageCache<BotPendingWork>()
const trackedRegistry = new BotTrackedWorkRegistry()
let pendingTrackedRead: { key: string; promise: Promise<void> } | undefined
function outputCandidates(
  state: Pick<BotWorkspaceState, "snapshot" | "taskPage" | "expandedTaskOutputId">,
  scope: { conversationId: string; threadRootId?: string }
) {
  const tasks = selectBotConversationTasks(state.snapshot?.runs ?? [], scope)
  const expanded = [...tasks.items, ...state.taskPage.items].find(
    (run) =>
      run.id === state.expandedTaskOutputId &&
      run.conversationId === scope.conversationId &&
      run.threadRootId === scope.threadRootId
  )
  return expanded && !tasks.inline.some((run) => run.id === expanded.id)
    ? [...tasks.inline, expanded]
    : tasks.inline
}
export const useBotWorkspaceStore = create<BotWorkspaceState>((set, get) => ({
  taskPage: taskPager.project(),
  pendingPage: pendingPager.project(),
  trackedWork: {},
  setWorkPageOpen(kind, open) {
    const pager = kind === "tasks" ? taskPager : pendingPager
    pager.setOpen(open)
    set(
      kind === "tasks" ? { taskPage: taskPager.project() } : { pendingPage: pendingPager.project() }
    )
    if (!open && kind === "tasks") get().expandTaskOutput(null)
    if (open) void get().refreshWorkPages()
  },
  navigateWorkPage(kind, direction) {
    const pager = kind === "tasks" ? taskPager : pendingPager
    pager.navigate(direction)
    set(
      kind === "tasks" ? { taskPage: taskPager.project() } : { pendingPage: pendingPager.project() }
    )
    if (kind === "tasks") get().expandTaskOutput(null)
    void get().refreshWorkPages()
  },
  watchTrackedWorkCapacity(retry) {
    return trackedRegistry.onCapacityAvailable(retry)
  },
  trackWork(target) {
    const release = trackedRegistry.register(target)
    void get().refreshWorkPages()
    return () => {
      release()
      set((state) => ({
        trackedWork: Object.fromEntries(
          Object.entries(state.trackedWork).filter(([key]) => trackedRegistry.has(key))
        )
      }))
    }
  },
  async refreshWorkPages() {
    const state = get(),
      host = state.host,
      snapshot = state.snapshot
    if (
      !host ||
      snapshot?.work?.projection !== "paged" ||
      !snapshot.dataEpoch ||
      snapshot.hostId !== host.hostId ||
      snapshot.dataEpoch !== host.dataEpoch
    )
      return
    const ownerKey = JSON.stringify([host.hostId, snapshot.dataEpoch])
    const currentOwner = () =>
      get().host?.hostId === host.hostId &&
      get().snapshot?.dataEpoch === snapshot.dataEpoch &&
      get().snapshot?.work?.projection === "paged"
    const selected = state.selected,
      sequence = selectionSequence
    const scope: BotWorkScope | undefined = selected
      ? { kind: "conversation", ...botViewAddress(selected) }
      : undefined
    const currentPage = () =>
      currentOwner() && get().selected === selected && selectionSequence === sequence
    const jobs: Promise<void>[] = []
    if (scope) {
      const request = { hostId: host.hostId, dataEpoch: snapshot.dataEpoch, scope }
      jobs.push(
        taskPager.refresh(request, botApi.openRuns, () => {
          if (currentPage()) set({ taskPage: taskPager.project() })
        })
      )
      jobs.push(
        pendingPager.refresh(request, botApi.pendingInteractions, () => {
          if (currentPage()) set({ pendingPage: pendingPager.project() })
        })
      )
    }
    const targets = trackedRegistry.list()
    if (targets.length && pendingTrackedRead?.key !== ownerKey) {
      const requestedTargets = new Map(targets.map((target) => [botTrackedWorkKey(target), target]))
      const keys = new Set(requestedTargets.keys())
      const job = botApi
        .trackedWork({ hostId: host.hostId, dataEpoch: snapshot.dataEpoch, targets })
        .then((result) => {
          if (!currentOwner()) return
          if (
            result.hostId !== host.hostId ||
            result.dataEpoch !== snapshot.dataEpoch ||
            result.items.length !== targets.length ||
            result.items.some(
              (item) =>
                !requestedTargets.has(item.key) ||
                !isBotTrackedWorkState(requestedTargets.get(item.key)!, item)
            ) ||
            new Set(result.items.map((item) => item.key)).size !== keys.size
          )
            throw new Error("任务状态身份已变化")
          set((state) => ({
            trackedWork: {
              ...state.trackedWork,
              ...Object.fromEntries(
                result.items
                  .filter((item) => trackedRegistry.has(item.key))
                  .map((item) => [item.key, item])
              )
            }
          }))
        })
        .catch(() => {
          /* Unknown transport results remain unknown, never terminal. */
        })
        .finally(() => {
          if (pendingTrackedRead?.promise !== job) return
          pendingTrackedRead = undefined
          // Newly mounted consumers join one bounded follow-up batch. A transport
          // failure alone never creates an immediate retry loop.
          if (
            currentOwner() &&
            trackedRegistry.list().some((target) => !keys.has(botTrackedWorkKey(target)))
          )
            void get().refreshWorkPages()
        })
      pendingTrackedRead = { key: ownerKey, promise: job }
      jobs.push(job)
    } else if (targets.length && pendingTrackedRead?.key === ownerKey)
      jobs.push(pendingTrackedRead.promise)
    await Promise.all(jobs)
  },
  navigation: null,
  snapshot: null,
  host: null,
  runOutputs: {},
  expandedTaskOutputId: null,
  activateTaskOutputs() {
    runOutputsActive = true
  },
  clearTaskOutputs(disable) {
    if (disable) runOutputsActive = false
    runOutputGeneration++
    runOutputCache.clear()
    taskPager.reset()
    pendingPager.reset()
    set({
      taskPage: taskPager.project(),
      pendingPage: pendingPager.project(),
      runOutputs: {},
      expandedTaskOutputId: null
    })
  },
  expandTaskOutput(id) {
    if (get().expandedTaskOutputId === id) return
    set({ expandedTaskOutputId: id })
    void get()
      .refresh({ preserveSelection: true })
      .catch(() => {})
  },
  applyPrimary(primary) {
    set((state) => {
      if (!state.snapshot || primary.dataEpoch !== state.snapshot.dataEpoch) return state
      const next = mergeBotPrimaryState(state.snapshot.primaryBot, primary, primary.dataEpoch)
      return next === state.snapshot.primaryBot
        ? state
        : { snapshot: { ...state.snapshot, primaryBot: next } }
    })
  },
  ...emptyHistory(),
  history: createRootShellNavigationState(),
  error: null,
  errorNotice: null,
  errorTrayAuthority: null,
  errorTrays: null,
  applyErrorTrays(snapshot) {
    set((state) => {
      const projected = projectBotErrorTraySnapshot(
        state.errorTrays,
        snapshot,
        state.errorTrayAuthority
      )
      return projected === state.errorTrays ? state : { errorTrays: projected }
    })
  },
  async dismissErrorTray(input) {
    const snapshot = await botApi.dismissErrorTray(input)
    get().applyErrorTrays(snapshot)
    return snapshot
  },
  async clearErrorTrays(input) {
    const snapshot = await botApi.clearErrorTrays(input)
    get().applyErrorTrays(snapshot)
    return snapshot
  },
  drafts: {},
  pending: {},
  pendingDraftRevisions: {},
  sending: {},
  uploading: {},
  updateReactions(id, changes) {
    set((state) => {
      const hasOlder = { ...state.hasOlder },
        hasNewer = { ...state.hasNewer }
      const messages = Object.fromEntries(
        Object.entries(state.messages).map(([key, current]) => {
          if (botViewAddress(key).conversationId !== id) return [key, current]
          const updated = mergeBotReactionStates(current, changes)
          const bounded = boundBotMessageWindow(updated, {
            direction: state.historyFollowTail[key] === false ? "target" : "newer",
            targetId: state.historyAnchorIds[key] ?? current[0]?.id
          })
          if (bounded.removedOlder) hasOlder[key] = true
          if (bounded.removedNewer) hasNewer[key] = true
          return [key, bounded.messages]
        })
      )
      return { messages, hasOlder, hasNewer }
    })
  },
  setUploading(id, uploading) {
    set((state) => ({ uploading: { ...state.uploading, [id]: uploading } }))
  },
  setHistoryFollowTail(id, following, anchorId) {
    set((state) => {
      if (state.selected !== id) return state
      const anchor = following
        ? undefined
        : (anchorId ?? state.historyAnchorIds[id] ?? state.messages[id]?.[0]?.id)
      if (state.historyFollowTail[id] === following && state.historyAnchorIds[id] === anchor)
        return state
      return {
        historyFollowTail: { ...state.historyFollowTail, [id]: following },
        historyAnchorIds: { ...state.historyAnchorIds, [id]: anchor }
      }
    })
  },
  saveViewportPosition(id, position, lease) {
    const state = get()
    // A view can be reopened with the same ID before an old scroll callback runs.
    // Require the caller's lease, rather than silently borrowing the current one.
    if (
      state.selected !== id ||
      lease.viewId !== id ||
      state.viewportLease?.generation !== lease.generation ||
      state.opening[id] ||
      state.viewportRestore ||
      state.transcriptError?.viewId === id ||
      (position.messageId &&
        !state.messages[id]?.some((message) => message.id === position.messageId))
    )
      return false
    return botViewportPositionCache.save(lease, position)
  },
  clearViewportRestore(id, lease) {
    set((state) => {
      if (
        state.selected !== id ||
        !state.viewportRestore ||
        (lease && (lease.viewId !== id || state.viewportLease?.generation !== lease.generation))
      )
        return state
      return { viewportRestore: null }
    })
  },
  readDraft: (id) => get().drafts[id],
  select(id, restore = false, targetId) {
    const failure = get().transcriptError
    const retry = get().selected === id && failure?.viewId === id
    if (get().selected === id && !retry) return
    if (retry && failure.targetId && !targetId) {
      get().retryMessages(id)
      return
    }
    restore = !retry && restore && Object.hasOwn(get().messages, id)
    const address = botViewAddress(id)
    get().clearTaskOutputs()
    const selection = ++selectionSequence
    const conversationRead = get().snapshot?.conversations.find(
      (item) => item.id === address.conversationId
    )?.readState
    const unreadAnchor = conversationRead?.firstUnreadSequence ?? null
    let { lease, position } = botViewportPositionCache.open(id)
    if (restore || targetId || (!address.threadRootId && conversationRead?.manuallyUnread))
      position = null
    const current = () =>
      selection === selectionSequence &&
      get().selected === id &&
      get().viewportLease?.generation === lease.generation &&
      botViewportPositionCache.isCurrent(lease)
    let draft = get().drafts[id]
    const stored = readStoredBotDraft(id, get().snapshot?.dataEpoch, localStorage, !draft)
    draft ??= stored.draft ?? blank()
    const pending = stored.pending
    const pendingDraftRevision = stored.pendingDraftRevision
    set((state) => ({
      selected: id,
      history: recordRootShellAgentSelection(state.history, address.conversationId),
      opening: { [id]: !restore },
      loadingOlder: {},
      loadingNewer: {},
      viewportLease: lease,
      viewportRestore: position,
      transcriptError: null,
      hasOlder: retainBotViewCache(state.hasOlder, id),
      hasNewer: retainBotViewCache(state.hasNewer, id),
      historyFollowTail: {
        ...retainBotViewCache(state.historyFollowTail, id),
        [id]: restore
          ? (state.historyFollowTail[id] ?? true)
          : targetId
            ? false
            : (position?.followTail ?? true)
      },
      historyAnchorIds: restore
        ? retainBotViewCache(state.historyAnchorIds, id)
        : {
            ...retainBotViewCache(state.historyAnchorIds, id),
            [id]: targetId ?? position?.messageId ?? undefined
          },
      threads: retainBotViewCache(state.threads, id),
      unreadAnchors: {
        ...retainBotViewCache(state.unreadAnchors, id),
        [id]: unreadAnchor
      },
      automaticReadBlocked: {
        ...retainBotViewCache(state.automaticReadBlocked, id),
        [id]: false
      },
      messages: {
        ...retainBotViewCache(state.messages, id),
        [id]: restore ? (state.messages[id] ?? []) : []
      },
      drafts: { ...state.drafts, [id]: draft! },
      pending: pending ? { ...state.pending, [id]: pending } : state.pending,
      pendingDraftRevisions: pending
        ? { ...state.pendingDraftRevisions, [id]: pendingDraftRevision }
        : state.pendingDraftRevisions
    }))
    if (get().snapshot?.conversations.some((item) => item.id === address.conversationId))
      botStartupPreferences.rememberConversation(
        botStartupPreferenceScope(get().host?.sharedWorkspace, get().snapshot?.dataEpoch),
        address.conversationId
      )
    if (restore || targetId) return
    void (async () => {
      const thread = address.threadRootId
        ? await botApi.thread({
            conversationId: address.conversationId,
            rootId: address.threadRootId
          })
        : undefined
      if (!current()) return
      const readState = thread?.readState ?? conversationRead
      const firstUnread = thread ? thread.readState.firstUnreadSequence : unreadAnchor
      if (readState?.manuallyUnread && position) {
        position = null
        set((state) => ({
          viewportRestore: null,
          historyFollowTail: { ...state.historyFollowTail, [id]: true },
          historyAnchorIds: { ...state.historyAnchorIds, [id]: undefined }
        }))
      }
      if (position?.messageId && !position.followTail) {
        let target: BotMessage | undefined
        try {
          target = await botApi.message({
            conversationId: address.conversationId,
            id: position.messageId
          })
        } catch (error) {
          // Missing durable identity permits fallback. Transport or authorization
          // failures must remain visible instead of quietly moving the reader.
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "reply_unavailable"
          )
            throw error
        }
        if (!current()) return
        if (
          target &&
          target.id === position.messageId &&
          botThreadView(target.conversationId, target.threadRootId) === id
        ) {
          const half = BOT_MESSAGE_PAGE_SIZE / 2
          const [older, newer] = await Promise.all([
            fetchBotMessagePage(botApi.messages, {
              ...address,
              before: target.sequence,
              limit: half
            }),
            fetchBotMessagePage(botApi.messages, {
              ...address,
              after: target.sequence,
              limit: half
            })
          ])
          return {
            messages: [...older.messages, target, ...newer.messages],
            thread,
            anchor: firstUnread,
            targetId: target.id,
            startsAtUnread: false,
            hasOlder: older.messages.length === older.limit,
            hasNewer: newer.messages.length === newer.limit
          }
        }
        // Deletion or a moved identity retires the old lease as well as its anchor.
        botViewportPositionCache.delete(id)
        lease = botViewportPositionCache.open(id).lease
        position = null
        set((state) => ({
          viewportLease: lease,
          viewportRestore: null,
          historyFollowTail: { ...state.historyFollowTail, [id]: true },
          historyAnchorIds: { ...state.historyAnchorIds, [id]: undefined }
        }))
      }
      const anchor = position?.followTail ? null : firstUnread
      const [page, earlier] = await Promise.all([
        fetchBotMessagePage(botApi.messages, {
          ...address,
          limit: BOT_MESSAGE_PAGE_SIZE,
          ...(anchor ? { after: anchor - 1 } : {})
        }),
        // Sequences can include hidden introduction cues or another branch.
        // Probe this visible view rather than briefly inventing an older page.
        anchor
          ? fetchBotMessagePage(botApi.messages, { ...address, before: anchor, limit: 1 })
          : undefined
      ])
      return {
        messages: page.messages,
        thread,
        // The unread divider survives a tail or saved-position restore even when
        // that marker did not choose which page to fetch.
        anchor: firstUnread,
        targetId: undefined,
        startsAtUnread: !!anchor,
        hasOlder: anchor ? !!earlier?.messages.length : page.messages.length === page.limit,
        hasNewer: !!anchor && page.messages.length === page.limit
      }
    })()
      .then((page) => {
        if (!page || !current()) return
        const { thread, anchor, targetId } = page
        const bounded = boundBotMessageWindow(page.messages, {
          direction: targetId ? "target" : page.startsAtUnread ? "older" : "newer",
          targetId
        })
        set((state) => ({
          messages: { ...state.messages, [id]: bounded.messages },
          ...(thread ? { threads: { ...state.threads, [id]: thread } } : {}),
          unreadAnchors: { ...state.unreadAnchors, [id]: anchor },
          hasOlder: {
            ...state.hasOlder,
            [id]: bounded.removedOlder || page.hasOlder
          },
          hasNewer: {
            ...state.hasNewer,
            [id]: bounded.removedNewer || page.hasNewer
          }
        }))
      })
      .catch((error) => {
        if (current()) set({ transcriptError: transcriptFailure(id, error) })
      })
      .finally(() => {
        if (current()) set((state) => ({ opening: { ...state.opening, [id]: false } }))
      })
  },
  retryMessages(id) {
    const state = get()
    const failure = state.transcriptError
    if (state.selected !== id || failure?.viewId !== id || state.opening[id]) return
    if (failure.page) {
      const lease = botViewportPositionCache.open(id).lease
      ++selectionSequence
      set({
        viewportLease: lease,
        viewportRestore: null,
        transcriptError: null,
        loadingOlder: {},
        loadingNewer: {}
      })
      const before = state.messages[id]?.[0]?.sequence
      const read =
        failure.page === "newer"
          ? get().loadNewer(id)
          : get().loadMessages(id, failure.page === "older" ? before : undefined)
      void read.catch(() => {})
      return
    }
    // Re-admission revokes the old viewport lease and all in-flight page results.
    state.select(id, false, failure.targetId)
    if (failure.targetId)
      void get()
        .jumpToMessage(id, failure.targetId)
        .catch(() => {})
  },
  navigateHistory(direction) {
    const state = get()
    const available = new Set(
      (state.snapshot?.conversations ?? [])
        .filter(
          (conversation) =>
            conversation.kind === "group" ||
            !state.snapshot?.bots.find((bot) => bot.id === conversation.members[0])?.hidden
        )
        .map((conversation) => conversation.id)
    )
    const next = resolveRootShellNavigation(state.history, available, direction)
    if (!next) return
    set({ history: next.state })
    get().select(next.targetId)
  },
  updateDraft(id, changes) {
    const draft = {
      ...(get().drafts[id] ?? blank()),
      ...changes,
      revision: crypto.randomUUID()
    }
    try {
      localStorage.setItem(
        `bot-draft:${id}`,
        JSON.stringify({
          ...draft,
          dataEpoch: get().snapshot?.dataEpoch ?? "initial"
        })
      )
    } catch {
      /* Keep the live draft if browser storage is full. */
    }
    set((state) => ({ drafts: { ...state.drafts, [id]: draft } }))
  },
  draft(id, text) {
    get().updateDraft(id, { prompt: text, richText: undefined })
  },
  attachments(id, attachments) {
    get().updateDraft(id, { attachments })
  },
  skills(id, skills) {
    get().updateDraft(id, { skills })
  },
  references(id, references) {
    get().updateDraft(id, {
      references: botEntityReferences.parse(references)
    })
  },
  recipients(id, recipients) {
    get().updateDraft(id, { recipients: botRecipientIds.parse(recipients) })
  },
  reply(id, targetId) {
    get().clearViewportRestore(id)
    get().updateDraft(id, { replyToId: targetId })
  },
  async jumpToMessage(id, targetId, options) {
    const signal = options?.signal
    if (signal?.aborted) return
    if (get().selected !== id) get().select(id, false, targetId)
    get().clearViewportRestore(id)
    get().setHistoryFollowTail(id, false, targetId)
    set({ transcriptError: null })
    const lease = get().viewportLease
    const receipt = (): BotMessageJumpReceipt | undefined => {
      if (
        signal?.aborted ||
        !lease ||
        get().selected !== id ||
        get().viewportLease !== lease ||
        !botViewportPositionCache.isCurrent(lease)
      )
        return
      // An attempted target is not yet a reading position. Preserve the last
      // visible position when the user leaves or cancels before the page commits.
      botViewportPositionCache.save(lease, {
        messageId: targetId,
        offset: 0,
        followTail: false
      })
      return { viewId: id, lease }
    }
    if (get().messages[id]?.some((message) => message.id === targetId)) {
      if (get().opening[id]) {
        ++selectionSequence
        set((state) => ({ opening: { ...state.opening, [id]: false } }))
      }
      return receipt()
    }
    // A navigation supersedes any in-flight refresh or page load for the old window.
    const selection = ++selectionSequence
    set((state) => ({ opening: { ...state.opening, [id]: true } }))
    const current = () =>
      !signal?.aborted && selection === selectionSequence && get().selected === id
    const abort = () => {
      if (selection !== selectionSequence || get().selected !== id) return
      ++selectionSequence
      set((state) => ({ opening: { ...state.opening, [id]: false } }))
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      const address = botViewAddress(id)
      const target = await botApi.message({
        conversationId: address.conversationId,
        id: targetId
      })
      if (!current()) return
      const targetView = botThreadView(address.conversationId, target.threadRootId)
      if (id !== targetView) {
        get().select(targetView, false, targetId)
        // Hand ownership to the thread request. Its rejection must not pass
        // through this parent's now-superseded catch.
        return get().jumpToMessage(targetView, targetId, options)
      }
      const half = BOT_MESSAGE_PAGE_SIZE / 2
      const [olderPage, newerPage, thread] = await Promise.all([
        fetchBotMessagePage(botApi.messages, {
          ...address,
          before: target.sequence,
          limit: half
        }),
        fetchBotMessagePage(botApi.messages, {
          ...address,
          after: target.sequence,
          limit: half
        }),
        address.threadRootId
          ? botApi.thread({
              conversationId: address.conversationId,
              rootId: address.threadRootId
            })
          : undefined
      ])
      if (!current()) return
      const older = olderPage.messages,
        newer = newerPage.messages
      const bounded = boundBotMessageWindow([...older, target, ...newer], {
        direction: "target",
        targetId
      })
      set((state) => ({
        messages: { ...state.messages, [id]: bounded.messages },
        ...(thread ? { threads: { ...state.threads, [id]: thread } } : {}),
        hasOlder: {
          ...state.hasOlder,
          [id]: bounded.removedOlder || older.length === olderPage.limit
        },
        hasNewer: {
          ...state.hasNewer,
          [id]: bounded.removedNewer || newer.length === newerPage.limit
        },
        historyFollowTail: { ...state.historyFollowTail, [id]: false }
      }))
      return receipt()
    } catch (error) {
      if (!current()) return
      set({ transcriptError: transcriptFailure(id, error, targetId) })
      throw error
    } finally {
      signal?.removeEventListener("abort", abort)
      if (selection === selectionSequence)
        set((state) => ({ opening: { ...state.opening, [id]: false } }))
    }
  },
  async refresh(options) {
    const outputGeneration = runOutputGeneration
    const sequence = ++refreshSequence
    const requestedView = get().selected
    const selectionAtRequest = selectionSequence
    const pageWasOpening = !!get().opening[get().selected ?? ""]
    try {
      const { snapshot, host } = await readBotWorkspaceFrame(
        botApi,
        requestedView ? botViewAddress(requestedView) : undefined
      )
      if (
        sequence < appliedRefresh ||
        sequence < appliedEnvelopeRefresh ||
        (snapshot.work?.projection === "paged" && selectionAtRequest !== selectionSequence)
      )
        return
      appliedEnvelopeRefresh = sequence
      const authority = {
        hostId: host.hostId,
        dataEpoch: snapshot.dataEpoch ?? "initial"
      }
      // Publish notification acknowledgements before slow transcript reads. Their
      // own revision protects against stale polls even when the DB cursor is equal.
      set((state) => {
        const errorTrays = projectBotErrorTraySnapshot(
          state.errorTrays,
          snapshot.errorTrays,
          authority
        )
        const errorTrayAuthority = sameBotErrorTrayAuthority(state.errorTrayAuthority, authority)
          ? state.errorTrayAuthority
          : authority
        return errorTrays === state.errorTrays && errorTrayAuthority === state.errorTrayAuthority
          ? state
          : { errorTrays, errorTrayAuthority }
      })
      if ((snapshot.dataEpoch ?? "initial") !== (get().snapshot?.dataEpoch ?? "initial")) {
        appliedRefresh = sequence
        dataGeneration++
        selectionSequence++
        refreshedMetadataSelection = -1
        runOutputGeneration++
        runOutputCache.clear()
        taskPager.reset()
        pendingPager.reset()
        readQueues.clear()
        readEpochs.clear()
        botViewportPositionCache.clear()
        set((state) => ({
          ...emptyHistory(),
          snapshot: null,
          trackedWork: {},
          runOutputs: {},
          expandedTaskOutputId: null,
          taskPage: taskPager.project(),
          pendingPage: pendingPager.project(),
          history: createRootShellNavigationState(),
          pending: {},
          pendingDraftRevisions: {},
          sending: {},
          uploading: {},
          navigation: null,
          drafts: Object.fromEntries(
            Object.entries(state.drafts).map(([id, draft]) => [
              id,
              { prompt: draft.prompt, attachments: [] }
            ])
          )
        }))
      }
      const selectedAtStart = get().selected
      const selectionAtStart = selectionSequence
      const address = selectedAtStart ? botViewAddress(selectedAtStart) : null
      const selectionExists = snapshot.conversations.some(
        (item) => item.id === address?.conversationId
      )
      const canReadTranscript = () =>
        sequence >= appliedEnvelopeRefresh &&
        selectedAtStart &&
        selectionExists &&
        selectionAtStart === selectionSequence &&
        get().selected === selectedAtStart &&
        !get().opening[selectedAtStart] &&
        get().transcriptError?.viewId !== selectedAtStart
      let incomingPage: Awaited<ReturnType<typeof fetchBotMessagePage>> | null = null
      if (
        canReadTranscript() &&
        !get().viewportRestore &&
        !(pageWasOpening && selectionAtRequest === selectionAtStart) &&
        !get().hasNewer[selectedAtStart!] &&
        (snapshot.cursor !== get().snapshot?.cursor ||
          host.hostId !== get().host?.hostId ||
          selectionAtStart !== refreshedMetadataSelection)
      ) {
        try {
          incomingPage = await fetchBotMessagePage(botApi.messages, {
            ...botViewAddress(selectedAtStart!),
            limit: BOT_MESSAGE_PAGE_SIZE
          })
        } catch (error) {
          if (canReadTranscript())
            set({
              transcriptError: transcriptFailure(selectedAtStart!, error)
            })
        }
      }
      if (sequence < appliedEnvelopeRefresh) return
      const incoming = incomingPage?.messages ?? null
      // Refresh every loaded message, including old pages outside the latest history window.
      const instructionChanges: BotMessage[] = []
      if (
        selectedAtStart &&
        canReadTranscript() &&
        host.capabilities?.includes("current-task-instructions") &&
        (snapshot.cursor !== get().snapshot?.cursor ||
          selectionAtStart !== refreshedMetadataSelection)
      ) {
        const pending = (get().messages[selectedAtStart] ?? []).filter(
          (message) => message.steering?.state === "pending"
        )
        for (let offset = 0; offset < pending.length; offset += 20) {
          if (selectionAtStart !== selectionSequence || sequence < appliedRefresh) break
          instructionChanges.push(
            ...(await Promise.all(
              pending.slice(offset, offset + 20).map((message) =>
                botApi.message({
                  conversationId: message.conversationId,
                  id: message.id
                })
              )
            ))
          )
        }
      }
      const reactionChanges: BotReactionState[] = []
      const summaries: BotThreadSummary[] = []
      const thread =
        canReadTranscript() &&
        address?.threadRootId &&
        host.capabilities?.includes("message-threads")
          ? await botApi.thread({
              conversationId: address.conversationId,
              rootId: address.threadRootId
            })
          : undefined
      if (
        selectedAtStart &&
        canReadTranscript() &&
        (host.capabilities?.includes("message-reactions") ||
          host.capabilities?.includes("message-threads")) &&
        (snapshot.cursor !== get().snapshot?.cursor ||
          host.hostId !== get().host?.hostId ||
          selectionAtStart !== refreshedMetadataSelection)
      ) {
        const ids = (get().messages[selectedAtStart] ?? []).map((message) => message.id)
        for (let offset = 0; offset < ids.length; offset += 200) {
          if (selectionAtStart !== selectionSequence || sequence < appliedRefresh) break
          if (host.capabilities?.includes("message-reactions"))
            reactionChanges.push(
              ...(await botApi.reactions({
                conversationId: address!.conversationId,
                messageIds: ids.slice(offset, offset + 200)
              }))
            )
          if (!address?.threadRootId && host.capabilities?.includes("message-threads"))
            summaries.push(
              ...(await botApi.threadSummaries({
                conversationId: address!.conversationId,
                rootIds: ids.slice(offset, offset + 200)
              }))
            )
        }
      }
      // A selected-page response is not authority for a later navigation.
      if (
        snapshot.work?.projection === "paged" &&
        selectedAtStart &&
        (requestedView !== selectedAtStart ||
          get().selected !== selectedAtStart ||
          selectionAtStart !== selectionSequence)
      )
        return
      // Publish the final answer and remove its provisional stream in one render.
      if (
        sequence < appliedRefresh ||
        sequence < appliedEnvelopeRefresh ||
        (host.hostId === get().host?.hostId && snapshot.cursor < (get().snapshot?.cursor ?? 0))
      )
        return
      const outputScope = address
        ? { ...address, dataEpoch: snapshot.dataEpoch ?? "initial" }
        : null
      const canHydrateOutputs = !!(
        runOutputsActive &&
        outputGeneration === runOutputGeneration &&
        selectedAtStart &&
        outputScope &&
        selectionAtStart === selectionSequence &&
        host.capabilities?.includes(BOT_RUN_OUTPUT_CAPABILITY) &&
        (snapshot.work?.projection !== "paged" ||
          (requestedView === selectedAtStart &&
            snapshot.work.selected?.view.conversationId === outputScope.conversationId &&
            snapshot.work.selected.view.threadRootId === outputScope.threadRootId))
      )
      if (outputScope && requestedView === selectedAtStart) {
        const pageScope: BotWorkScope = {
          kind: "conversation",
          conversationId: outputScope.conversationId,
          ...(outputScope.threadRootId ? { threadRootId: outputScope.threadRootId } : {})
        }
        taskPager.bind(host.hostId, outputScope.dataEpoch, pageScope)
        pendingPager.bind(host.hostId, outputScope.dataEpoch, pageScope)
      }
      if (canHydrateOutputs && outputScope) {
        const wanted = outputCandidates(
          { ...get(), snapshot, taskPage: taskPager.project() },
          outputScope
        )
        runOutputCache.reconcile(outputScope, host.hostId, wanted)
      } else runOutputCache.clear()
      const runOutputs = runOutputCache.project()
      appliedRefresh = sequence
      botViewportPositionCache.prune(new Set(snapshot.conversations.map((item) => item.id)))
      // A restored main transcript may predate work performed in its branch, even
      // when the global snapshot cursor has already advanced while viewing that branch.
      if (selectedAtStart && canReadTranscript()) refreshedMetadataSelection = selectionAtStart
      set((state) => {
        const merged =
          incoming &&
          selectedAtStart &&
          selectionAtStart === selectionSequence &&
          state.transcriptError?.viewId !== selectedAtStart &&
          !state.viewportRestore
            ? mergeBotMessagePage(state.messages[selectedAtStart] ?? [], incoming, true, {
                followTail: state.historyFollowTail[selectedAtStart] !== false,
                pageLimit: incomingPage?.limit
              })
            : null
        let refreshedMessages =
          selectedAtStart &&
          selectionAtStart === selectionSequence &&
          state.transcriptError?.viewId !== selectedAtStart
            ? mergeBotReactionStates(
                merged?.messages ?? state.messages[selectedAtStart] ?? [],
                reactionChanges
              )
            : null
        if (refreshedMessages && instructionChanges.length) {
          const changes = new Map(
            instructionChanges.map((message) => [message.id, message.steering])
          )
          refreshedMessages = refreshedMessages.map((message) =>
            changes.has(message.id) ? { ...message, steering: changes.get(message.id) } : message
          )
        }
        if (refreshedMessages && summaries.length)
          refreshedMessages = mergeBotThreadSummaries(refreshedMessages, summaries)
        const finalWindow =
          refreshedMessages && selectedAtStart
            ? boundBotMessageWindow(refreshedMessages, {
                direction: state.historyFollowTail[selectedAtStart] === false ? "target" : "newer",
                targetId: state.historyAnchorIds[selectedAtStart] ?? refreshedMessages[0]?.id
              })
            : null
        if (finalWindow) refreshedMessages = finalWindow.messages
        const currentThread = selectedAtStart ? state.threads[selectedAtStart] : undefined
        const nextThread =
          thread && currentThread && currentThread.readState.revision > thread.readState.revision
            ? { ...thread, readState: currentThread.readState }
            : thread
        return {
          snapshot: {
            ...snapshot,
            primaryBot: mergeBotPrimaryState(
              state.snapshot?.primaryBot,
              snapshot.primaryBot,
              snapshot.dataEpoch ?? "initial"
            ),
            errorTrays: state.errorTrays ?? undefined,
            notificationSettings: mergeBotNotificationSettings(state.snapshot, snapshot),
            conversations: snapshot.conversations.map((item) => {
              const current = state.snapshot?.conversations.find(
                (old) => old.id === item.id
              )?.readState
              return current && current.revision > (item.readState?.revision ?? 0)
                ? { ...item, readState: current }
                : item
            })
          },
          host,
          ...(state.host?.hostId !== host.hostId ? { trackedWork: {} } : {}),
          taskPage: taskPager.project(),
          pendingPage: pendingPager.project(),
          runOutputs:
            runOutputsActive && outputGeneration === runOutputGeneration ? runOutputs : {},
          ...(nextThread && selectedAtStart && selectionAtStart === selectionSequence
            ? { threads: { ...state.threads, [selectedAtStart]: nextThread } }
            : {}),
          error: null,
          errorNotice: null,
          ...(refreshedMessages && selectedAtStart
            ? {
                messages: {
                  ...state.messages,
                  [selectedAtStart]: refreshedMessages
                }
              }
            : {}),
          ...(finalWindow && selectedAtStart
            ? {
                hasOlder: {
                  ...state.hasOlder,
                  [selectedAtStart]:
                    finalWindow.removedOlder ||
                    !!merged?.removedOlder ||
                    (merged && incomingPage
                      ? incomingPage.messages.length === incomingPage.limit &&
                        (merged.reset || (state.hasOlder[selectedAtStart] ?? true))
                      : !!state.hasOlder[selectedAtStart])
                },
                hasNewer: {
                  ...state.hasNewer,
                  [selectedAtStart]:
                    finalWindow.removedNewer ||
                    !!merged?.deferredLatest ||
                    !!state.hasNewer[selectedAtStart]
                }
              }
            : {})
        }
      })
      // Metadata, approval routing and the final transcript are already committed.
      // Slow remote output pages must never block that control plane. One read cycle
      // is shared by subsequent polls; same-scope polls do not starve a late answer.
      const outputReadKey = JSON.stringify([
        host.hostId,
        outputGeneration,
        selectedAtStart,
        outputScope?.dataEpoch
      ])
      if (canHydrateOutputs && outputScope && pendingOutputRead?.key !== outputReadKey) {
        const job = runOutputCache
          .refresh(outputScope, botApi.runOutput)
          .then(() => {
            const state = get()
            if (
              !runOutputsActive ||
              outputGeneration !== runOutputGeneration ||
              selectionAtStart !== selectionSequence ||
              state.selected !== selectedAtStart ||
              state.host?.hostId !== host.hostId ||
              state.snapshot?.dataEpoch !== outputScope.dataEpoch
            )
              return
            set({ runOutputs: runOutputCache.projectFor(outputCandidates(state, outputScope)) })
          })
          .finally(() => {
            if (pendingOutputRead?.promise === job) pendingOutputRead = undefined
          })
        pendingOutputRead = { key: outputReadKey, promise: job }
      }
      void get().refreshWorkPages()
      const selected = get().selected
      if (
        !options?.preserveSelection &&
        (!selected ||
          !snapshot.conversations.some((c) => c.id === botViewAddress(selected).conversationId))
      ) {
        const preferred = botStartupPreferences.conversation(
          botStartupPreferenceScope(host.sharedWorkspace, snapshot.dataEpoch)
        )
        const initial =
          snapshot.conversations.find((item) => item.id === preferred) ?? snapshot.conversations[0]
        if (initial) get().select(initial.id)
        else {
          // The final conversation may disappear while a page request is still
          // pending. Retire that request before releasing the view caches.
          if (selected) selectionSequence++
          get().clearTaskOutputs()
          set(emptyHistory())
        }
      }
    } catch (error) {
      if (
        sequence === refreshSequence &&
        sequence >= appliedRefresh &&
        sequence >= appliedEnvelopeRefresh &&
        selectionAtRequest === selectionSequence &&
        get().selected === requestedView
      ) {
        const notice = botErrorNotice(error, "Bot 后台连接失败")
        set({ error: notice.message, errorNotice: notice })
      }
      throw error
    }
  },
  async loadMessages(id, before) {
    if (get().selected !== id || get().opening[id]) return
    if (before !== undefined && (get().loadingOlder[id] || get().hasOlder[id] === false)) return
    const selection = before === undefined ? ++selectionSequence : selectionSequence
    if (before === undefined) {
      const lease = get().viewportLease
      if (lease?.viewId === id)
        botViewportPositionCache.save(lease, {
          messageId: null,
          offset: 0,
          followTail: true
        })
      set((state) => ({
        viewportRestore: null,
        transcriptError: null,
        opening: { ...state.opening, [id]: true },
        loadingOlder: {},
        loadingNewer: {},
        historyFollowTail: { ...state.historyFollowTail, [id]: true },
        historyAnchorIds: { ...state.historyAnchorIds, [id]: undefined }
      }))
    } else
      set((state) => ({
        viewportRestore: null,
        transcriptError: null,
        loadingOlder: { ...state.loadingOlder, [id]: true },
        historyFollowTail: { ...state.historyFollowTail, [id]: false }
      }))
    try {
      const { messages: incoming, limit } = await fetchBotMessagePage(botApi.messages, {
        ...botViewAddress(id),
        ...(before === undefined ? {} : { before }),
        limit: BOT_MESSAGE_PAGE_SIZE
      })
      set((state) => {
        if (selection !== selectionSequence) return state
        const existing = state.messages[id] ?? []
        // The latest page can replace an old cache while this request is in flight.
        if (before !== undefined && existing[0]?.sequence !== before) return state
        const merged = mergeBotMessagePage(existing, incoming, before === undefined, {
          direction: before === undefined ? "newer" : "older",
          pageLimit: limit
        })
        return {
          messages: { ...state.messages, [id]: merged.messages },
          historyFollowTail: {
            ...state.historyFollowTail,
            [id]: before === undefined
          },
          hasNewer: {
            ...state.hasNewer,
            [id]: before === undefined ? false : merged.removedNewer || !!state.hasNewer[id]
          },
          hasOlder: {
            ...state.hasOlder,
            [id]:
              merged.removedOlder ||
              (before !== undefined
                ? incoming.length === limit
                : incoming.length === limit && (merged.reset || (state.hasOlder[id] ?? true)))
          }
        }
      })
    } catch (error) {
      if (selection === selectionSequence && get().selected === id)
        set({
          transcriptError: {
            ...transcriptFailure(id, error),
            page: before === undefined ? "latest" : "older"
          }
        })
      throw error
    } finally {
      if (selection === selectionSequence)
        set((state) =>
          before === undefined
            ? { opening: { ...state.opening, [id]: false } }
            : { loadingOlder: { ...state.loadingOlder, [id]: false } }
        )
    }
  },
  async loadNewer(id) {
    if (get().selected !== id || get().opening[id] || get().loadingNewer[id] || !get().hasNewer[id])
      return
    const after = get().messages[id]?.at(-1)?.sequence
    const selection = selectionSequence
    if (after === undefined) return
    set((state) => ({
      viewportRestore: null,
      transcriptError: null,
      loadingNewer: { ...state.loadingNewer, [id]: true }
    }))
    try {
      const { messages: incoming, limit } = await fetchBotMessagePage(botApi.messages, {
        ...botViewAddress(id),
        after,
        limit: BOT_MESSAGE_PAGE_SIZE
      })
      if (selection !== selectionSequence || get().messages[id]?.at(-1)?.sequence !== after) return
      set((state) => {
        const merged = mergeBotMessagePage(state.messages[id] ?? [], incoming, false, {
          direction: "newer"
        })
        return {
          messages: { ...state.messages, [id]: merged.messages },
          hasOlder: {
            ...state.hasOlder,
            [id]: merged.removedOlder || !!state.hasOlder[id]
          },
          hasNewer: { ...state.hasNewer, [id]: incoming.length === limit }
        }
      })
    } catch (error) {
      if (selection === selectionSequence && get().selected === id)
        set({
          transcriptError: { ...transcriptFailure(id, error), page: "newer" }
        })
      throw error
    } finally {
      if (selection === selectionSequence)
        set((state) => ({
          loadingNewer: { ...state.loadingNewer, [id]: false }
        }))
    }
  },
  async markRead(id, throughSequence, manual = false, unread = false) {
    const generation = dataGeneration
    let epoch = readEpochs.get(id) ?? 0
    if (manual) {
      readEpochs.set(id, ++epoch)
      set((state) => ({
        automaticReadBlocked: { ...state.automaticReadBlocked, [id]: unread }
      }))
    }
    // A visible-position request and an explicit click can otherwise consume the
    // same revision. Serialize this client's writes, then resolve the current
    // revision. An external window's conflict still requires a refresh, not replay.
    const execution = (readQueues.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (generation !== dataGeneration) return
        if (!manual && epoch !== (readEpochs.get(id) ?? 0)) return
        const address = botViewAddress(id)
        const previous = address.threadRootId
          ? get().threads[id]?.readState
          : get().snapshot?.conversations.find((item) => item.id === address.conversationId)
              ?.readState
        if (
          !previous ||
          (!manual &&
            (get().automaticReadBlocked[id] ||
              (throughSequence <= previous.lastReadSequence && !previous.manuallyUnread)))
        )
          return
        try {
          const readState = await botApi.setReadState({
            ...address,
            revision: previous.revision,
            throughSequence,
            unread
          })
          if (generation !== dataGeneration) return
          if (address.threadRootId) {
            set((state) => {
              const thread = state.threads[id]
              return thread && thread.readState.revision <= readState.revision
                ? {
                    threads: {
                      ...state.threads,
                      [id]: { ...thread, readState }
                    }
                  }
                : {}
            })
            return
          }
          set((state) =>
            state.snapshot
              ? {
                  snapshot: {
                    ...state.snapshot,
                    conversations: state.snapshot.conversations.map((item) =>
                      item.id === id && (item.readState?.revision ?? 0) <= readState.revision
                        ? { ...item, readState }
                        : item
                    )
                  }
                }
              : {}
          )
        } catch (error) {
          if (manual) {
            await get().refresh()
            throw error
          }
          // An intervening manual mark or another window owns the newer revision.
          // Refresh normally; never replay this stale visible-watermark request.
        }
      })
    readQueues.set(id, execution)
    try {
      await execution
    } finally {
      if (readQueues.get(id) === execution) {
        readQueues.delete(id)
        readEpochs.delete(id)
      }
    }
  },
  async send(id, recipients, newTask = false) {
    const generation = dataGeneration
    if (get().sending[id] || get().uploading[id]) return
    const files = get().drafts[id]?.attachments.map((file) => file.path) ?? []
    const skills =
      get().drafts[id]?.skills?.map(({ botId, id, version }) => ({
        botId,
        id,
        version
      })) ?? []
    const references = get().drafts[id]?.references?.map(({ kind, id }) => ({ kind, id })) ?? []
    const inlineReferences =
      get().host?.capabilities?.includes("inline-references") && get().drafts[id]
        ? composerDraftInlineReferences(get().drafts[id])
        : []
    const selectionQuotes = get().drafts[id] ? composerDraftSelectionQuotes(get().drafts[id]) : []
    recipients ??= get().drafts[id]?.recipients
    const steerRunId =
      !newTask && get().host?.capabilities?.includes("current-task-instructions")
        ? botSteeringTarget(get().snapshot, id)
        : undefined
    const draftRevision = get().pending[id]
      ? get().pendingDraftRevisions[id]
      : get().drafts[id]?.revision
    const input = get().pending[id] ?? {
      ...(steerRunId ? { steerRunId } : {}),
      nonce: crypto.randomUUID(),
      ...botViewAddress(id),
      text:
        get().drafts[id]?.prompt ||
        (skills.length
          ? "请按所选技能完成任务。"
          : files.length
            ? "请查看附件。"
            : references.length
              ? "请查看所引用的对象。"
              : ""),
      attachments: files,
      ...(get().drafts[id]?.replyToId ? { replyTo: get().drafts[id].replyToId } : {}),
      ...(skills.length ? { skills } : {}),
      ...(references.length ? { references } : {}),
      ...(inlineReferences.length ? { inlineReferences } : {}),
      ...(selectionQuotes.length ? { selectionQuotes } : {}),
      ...(recipients?.length ? { recipients } : {})
    }
    if (input.steerRunId && !get().host?.capabilities?.includes("current-task-instructions"))
      throw new Error("请等待 Bot 后台升级完成后再补充当前任务")
    if (input.skills?.length && !get().host?.capabilities?.includes("skill-references"))
      throw new Error("请等待 Bot 后台升级完成后再发送所选技能")
    if (input.references?.length && !get().host?.capabilities?.includes("entity-references"))
      throw new Error("请等待 Bot 后台升级完成后再发送引用")
    if (input.inlineReferences?.length && !get().host?.capabilities?.includes("inline-references"))
      throw new Error("请等待 Bot 后台升级完成后再发送正文引用")
    if (input.selectionQuotes?.length && !get().host?.capabilities?.includes("selection-quotes-v1"))
      throw new Error("请等待 Bot 后台升级完成后再发送选区引用")
    if (input.replyTo && !get().host?.capabilities?.includes("message-replies"))
      throw new Error("请等待 Bot 后台升级完成后再回复消息")
    if (input.threadRootId && !get().host?.capabilities?.includes("message-threads"))
      throw new Error("请等待 Bot 后台升级完成后再发送分支消息")
    if (!input.text.trim()) return
    set((state) => ({
      pending: { ...state.pending, [id]: input },
      pendingDraftRevisions: {
        ...state.pendingDraftRevisions,
        [id]: draftRevision
      },
      sending: { ...state.sending, [id]: true }
    }))
    try {
      localStorage.setItem(
        `bot-pending:${id}`,
        JSON.stringify({
          ...input,
          draftRevision,
          dataEpoch: get().snapshot?.dataEpoch ?? "initial"
        })
      )
    } catch {
      /* live retry still has a stable nonce */
    }
    try {
      await botApi.send(input)
      if (generation !== dataGeneration) return
      if (get().pending[id]?.nonce !== input.nonce) return
      const draft = get().drafts[id]
      // The receipt owns the submitted draft revision, never a subsequent edit,
      // even if that edit later restores identical text or selects the same object.
      const clearDraft =
        draft &&
        (draftRevision
          ? draft.revision === draftRevision
          : matchesLegacySubmittedDraft(draft, input))
      const cleared: BotComposerDraft = {
        ...blank(),
        skills: [],
        references: [],
        recipients: [],
        revision: crypto.randomUUID()
      }
      try {
        if (clearDraft) {
          const stored = JSON.parse(localStorage.getItem(`bot-draft:${id}`) || "null")
          // Another window may have persisted a newer draft while this one sent.
          if (
            !stored ||
            (stored.revision === draft.revision &&
              (stored.dataEpoch ?? "initial") === (get().snapshot?.dataEpoch ?? "initial"))
          ) {
            localStorage.setItem(
              `bot-draft:${id}`,
              JSON.stringify({
                ...cleared,
                dataEpoch: get().snapshot?.dataEpoch ?? "initial"
              })
            )
          }
        }
      } catch {
        /* The live draft can still settle if persistent storage is unavailable. */
      }
      removeStoredPending(id, input.nonce)
      set((state) => {
        const pending = { ...state.pending }
        const pendingDraftRevisions = { ...state.pendingDraftRevisions }
        delete pending[id]
        delete pendingDraftRevisions[id]
        return {
          pending,
          pendingDraftRevisions,
          ...(clearDraft ? { drafts: { ...state.drafts, [id]: cleared } } : {})
        }
      })
      await Promise.all([get().loadMessages(id), get().refresh()])
    } catch (error) {
      if (generation !== dataGeneration) throw error
      const code = error && typeof error === "object" && "code" in error ? error.code : null
      if (
        [
          "reference_unavailable",
          "invalid_inline_reference",
          "invalid_selection_quote",
          "selection_quote_scope",
          "selection_quote_unavailable",
          "skill_changed",
          "skill_unavailable",
          "skill_scope",
          "invalid_recipient",
          "reply_unavailable",
          "thread_unavailable"
        ].includes(String(code))
      ) {
        // These rejections happen before the message/queue transaction commits.
        removeStoredPending(id, input.nonce)
        set((state) => {
          if (state.pending[id]?.nonce !== input.nonce) return {}
          const pending = { ...state.pending }
          const pendingDraftRevisions = { ...state.pendingDraftRevisions }
          delete pending[id]
          delete pendingDraftRevisions[id]
          return { pending, pendingDraftRevisions }
        })
      }
      throw error
    } finally {
      if (generation === dataGeneration)
        set((state) => ({ sending: { ...state.sending, [id]: false } }))
    }
  }
}))
