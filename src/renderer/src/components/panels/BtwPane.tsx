import { useDeferredValue, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { ChevronsDown, File, FileDiff, FolderOpen, Globe, Maximize2, MessageSquareText, Minimize2, Plus, X } from "lucide-react"
import { closeBtw, loadBtwThread, openBtw, retryBtwSkillGeneration, useBtwChat } from "@/lib/btw-chat"
import { selectSkillGenerationAgent, selectSkillRetryContext, selectThreadSummary, useAppStore } from "@/lib/store"
import { useThreadContext } from "@/lib/thread-context"
import { hasOpenModalDialog } from "@/lib/modal-dialog"
import { useShallow } from "zustand/react/shallow"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"
import { focusBtwPaneComposer, prepareBtwComposerFocus } from "@/lib/btw-composer-focus"
import { ChatContainer } from "../chat/ChatContainer"
import { useBtwComposerToolbarHeight } from "../chat/use-floating-chat-layout"
import { SkillGenerationCard } from "./RightPanel"

export const BTW_LAUNCHER_TAB = "new-tab"
const launcher = BTW_LAUNCHER_TAB
const iconButton = "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"

function select(parentId: string, id: string) {
  useBtwChat.setState(s => ({ selected: { ...s.selected, [parentId]: id } }))
}

function closeLauncher(parentId: string) {
  useBtwChat.setState(({ tabs, selected }) => {
    const next = { ...selected }
    const last = tabs.findLast(tab => tab.parentId === parentId)
    if (last) next[parentId] = last.id
    else delete next[parentId]
    return { selected: next }
  })
}

function openBtwLauncher(parentId: string) {
  const app = useAppStore.getState()
  if (app.mainView !== "thread" || app.currentThreadId !== parentId) return
  select(parentId, launcher)
  useAppStore.setState({ rightModule: "btw", rightPanelCollapsed: false })
}

function closeWithComposerFocus(
  parentId: string,
  ids: readonly string[],
  pane: HTMLElement | null,
  close: () => Promise<void> | void
) {
  const { selected, tabs } = useBtwChat.getState()
  const isInPane = (target: EventTarget | null) => target instanceof Node && (
    pane?.contains(target) || (target instanceof HTMLElement &&
      target.closest<HTMLElement>("[data-btw-tab-owner]")?.dataset.btwTabOwner === parentId)
  )
  const closingIds = new Set(ids)
  // Separate close clicks can still be waiting for the same panel to disappear.
  for (const tab of tabs) {
    if (tab.parentId === parentId && tab.closeState === "closing") closingIds.add(tab.id)
  }
  if (!pane || !isInPane(document.activeElement) || !closingIds.has(selected[parentId])) {
    void close()
    return
  }
  pane.focus({ preventScroll: true })
  if (tabs.some(tab => tab.parentId === parentId && !closingIds.has(tab.id))) {
    void close()
    return
  }

  const intent = new AbortController()
  const cancelIfOutside = (event: Event) => {
    if (!isInPane(event.target)) intent.abort()
  }
  for (const type of ["pointerdown", "focusin"]) {
    window.addEventListener(type, cancelIfOutside, { capture: true, signal: intent.signal })
  }
  const restoreFocus = () => {
    const state = useBtwChat.getState()
    if (state.selected[parentId]) {
      if (!state.tabs.some(tab => closingIds.has(tab.id) && tab.closeState === "closing")) intent.abort()
      return
    }
    // In full view the main composer becomes visible again in the close commit.
    requestAnimationFrame(() => {
      if (intent.signal.aborted) return
      intent.abort()
      const app = useAppStore.getState()
      if (app.currentThreadId !== parentId || app.mainView !== "thread" || app.showCustomizeView ||
        useBtwChat.getState().selected[parentId] || pane.isConnected ||
        document.activeElement !== document.body || hasOpenModalDialog()) return
      const composer = document.querySelector<HTMLTextAreaElement>(
        `[data-chat-surface="default"][data-chat-thread-id="${CSS.escape(parentId)}"] textarea.composer-textarea:enabled`
      )
      // The browser checks whether the composer can receive focus. Avoid forcing layout first.
      composer?.focus({ preventScroll: true })
    })
  }
  void Promise.resolve(close()).then(() => {
    if (intent.signal.aborted) return
    const unsubscribe = useBtwChat.subscribe(restoreFocus)
    intent.signal.addEventListener("abort", unsubscribe, { once: true })
    restoreFocus()
  }, () => intent.abort())
}

interface BtwViewProps {
  parentId: string
  full: boolean
  toggleFull: () => void
  mainTabVisible?: boolean
  showMainTab?: (show: boolean) => void
}

function BtwTabs({ parentId, full, toggleFull, mainTabVisible, showMainTab }: BtwViewProps) {
  const mainTitle = useAppStore(s => full ? selectThreadSummary(s, parentId)?.title || "主会话" : "")
  const tabs = useBtwChat(useShallow(s => s.tabs.filter(tab => tab.parentId === parentId)))
  const activeId = useBtwChat(s => s.selected[parentId])
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [resultIndex, setResultIndex] = useState(0)
  const focusSelectedComposer = useRef<string | null>(null)
  const tabDrag = useRef<AbortController | null>(null)
  const draggedTab = useRef<string | null>(null)
  const selectedTab = useRef<HTMLButtonElement>(null)
  const tabStrip = useRef<HTMLDivElement>(null)
  useEffect(() => () => tabDrag.current?.abort(), [])
  useEffect(() => {
    const tab = selectedTab.current?.parentElement
    if (!tab || (tabs.length <= 1 && activeId !== launcher)) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio < 1) tab.scrollIntoView({ block: "nearest", inline: "nearest" })
      observer.disconnect()
    }, { root: tabStrip.current, threshold: 1 })
    observer.observe(tab)
    return () => observer.disconnect()
  }, [activeId, tabs.length, mainTabVisible])
  const items = tabs.map(tab => ({
    id: tab.id, title: `辅助对话 ${tab.number}`, closeState: tab.closeState,
    pending: !tab.closeState && Boolean(tab.pending || tab.skillRequests?.length)
  }))
  if (activeId === launcher) items.push({ id: launcher, title: "新标签页", closeState: undefined, pending: false })
  const matches = items.filter(item => item.title.includes(search.trim()))
  const highlightedIndex = Math.min(resultIndex, matches.length - 1)
  function selectSideTab(id: string) {
    if (mainTabVisible) showMainTab?.(false)
    select(parentId, id)
  }
  function chooseSearchResult(id: string) {
    focusSelectedComposer.current = id === launcher ? null : id
    selectSideTab(id)
    setSearchOpen(false)
  }
  function startTabDrag(id: string, event: ReactPointerEvent<HTMLDivElement>) {
    draggedTab.current = null
    const strip = tabStrip.current
    if (!strip || id === launcher || event.button !== 0 || event.pointerType !== "mouse") return
    tabDrag.current?.abort()
    const drag = new AbortController()
    tabDrag.current = drag
    const { pointerId, clientX, clientY } = event
    let canceledByEscape = false
    const options = { capture: true, signal: drag.signal }
    let scrollTimer: number | undefined
    let scrollDirection = 0
    function stopScrolling() {
      window.clearInterval(scrollTimer)
      scrollTimer = undefined
      scrollDirection = 0
    }
    drag.signal.addEventListener("abort", stopScrolling, { once: true })
    function cancel() {
      drag.abort()
      tabDrag.current = null
    }
    const trackMovement = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId || canceledByEscape) return
      if (draggedTab.current !== id && Math.hypot(pointer.clientX - clientX, pointer.clientY - clientY) < 5) return
      draggedTab.current = id
      const max = strip.scrollWidth - strip.clientWidth
      if (max <= 0) return
      const { left, right, top, bottom, width } = strip.getBoundingClientRect()
      const edge = Math.min(24, width / 2)
      let direction = 0
      if (pointer.clientY >= top && pointer.clientY <= bottom && pointer.clientX >= left && pointer.clientX <= right) {
        if (pointer.clientX < left + edge && strip.scrollLeft > 0) direction = -1
        if (pointer.clientX > right - edge && strip.scrollLeft < max - 0.5) direction = 1
      }
      if (direction === scrollDirection) return
      stopScrolling()
      if (!direction) return
      scrollDirection = direction
      scrollTimer = window.setInterval(() => {
        const before = strip.scrollLeft
        strip.scrollLeft += direction * 16
        if (strip.scrollLeft === before) stopScrolling()
      }, 16)
    }
    // The pointer can leave the strip before returning to a drop target.
    window.addEventListener("pointermove", trackMovement, options)
    window.addEventListener("pointerup", up => {
      if (up.pointerId !== pointerId) return
      trackMovement(up)
      cancel()
      if (canceledByEscape || up.button !== 0 || draggedTab.current !== id || !(up.target instanceof Element)) return
      const targetTab = up.target.closest<HTMLElement>("[data-sortable-btw-tab]")
      const to = targetTab?.dataset.sortableBtwTab
      if (!to || to === id || !tabStrip.current?.contains(targetTab)) return
      useBtwChat.setState(s => {
        const ordered = [...s.tabs]
        const index = ordered.findIndex(t => t.parentId === parentId && t.id === id)
        const target = ordered.findIndex(t => t.parentId === parentId && t.id === to)
        if (index < 0 || target < 0) return s
        const [moved] = ordered.splice(index, 1)
        ordered.splice(target, 0, moved)
        return { tabs: ordered }
      })
    }, options)
    window.addEventListener("pointercancel", canceled => { if (canceled.pointerId === pointerId) cancel() }, options)
    window.addEventListener("keydown", key => {
      if (key.key !== "Escape") return
      if (draggedTab.current === id) {
        key.preventDefault()
        canceledByEscape = true
        stopScrolling()
      } else {
        cancel()
      }
    }, options)
    window.addEventListener("blur", cancel, { signal: drag.signal })
  }
  function closeTabs(ids: readonly string[]) {
    const pane = tabStrip.current?.closest("aside") ?? null
    closeWithComposerFocus(parentId, ids, pane, async () => {
      await Promise.all(ids.map(id => {
        if (id !== launcher) return closeBtw(id)
        closeLauncher(parentId)
        if (!useBtwChat.getState().selected[parentId]) useAppStore.getState().setRightModule("work")
        return undefined
      }))
    })
  }
  return (
    <header aria-label="辅助对话标签页" className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-border px-2">
      <Popover open={searchOpen} onOpenChange={open => { setSearchOpen(open); setSearch(""); setResultIndex(0) }}>
        <PopoverTrigger asChild><button type="button" aria-label="搜索标签页" title="搜索标签页" className={iconButton}><ChevronsDown className="size-4" /></button></PopoverTrigger>
        <PopoverContent data-btw-tab-search data-btw-tab-owner={parentId} align="start" className="w-64 p-1.5" onCloseAutoFocus={event => {
          const id = focusSelectedComposer.current
          focusSelectedComposer.current = null
          if (!id || useBtwChat.getState().selected[parentId] !== id) return
          const pane = selectedTab.current?.closest<HTMLElement>("[data-btw-pane]")
          if (!pane) return
          event.preventDefault()
          if (document.activeElement === document.body || pane.contains(document.activeElement)) focusBtwPaneComposer(pane)
        }}>
          <input autoFocus aria-label="搜索标签页" placeholder="搜索标签页..." value={search} onChange={e => { setSearch(e.target.value); setResultIndex(0) }}
            onKeyDown={e => {
              if (e.nativeEvent.isComposing || !matches.length) return
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                const next = (highlightedIndex + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length
                setResultIndex(next)
                e.currentTarget.parentElement?.querySelectorAll("[data-tab-result]")[next]?.scrollIntoView({ block: "nearest" })
              } else if (e.key === "Enter") {
                e.preventDefault()
                chooseSearchResult(matches[highlightedIndex].id)
              }
            }}
            className="mb-1 w-full border-b bg-transparent px-2 py-1.5 text-sm outline-none" />
          <div className="max-h-60 overflow-y-auto">{matches.map((item, index) => <div key={item.id} data-tab-result
            className={cn("flex items-center rounded", index === highlightedIndex && "bg-muted")} onPointerMove={() => setResultIndex(index)}>
            <button type="button" onClick={() => chooseSearchResult(item.id)} className="flex-1 px-2 py-1.5 text-left text-sm">{item.title}</button>
            <button type="button" aria-label={`关闭 ${item.title}`} disabled={item.closeState === "closing"} onClick={() => closeTabs([item.id])} className={iconButton}><X className="size-3" /></button>
          </div>)}
            {!matches.length && <p className="p-2 text-xs text-muted-foreground">没有匹配的标签页</p>}</div>
        </PopoverContent>
      </Popover>
      {full && <button type="button" title={mainTitle} aria-pressed={Boolean(mainTabVisible)}
        onClick={() => showMainTab?.(true)}
        className={cn("flex h-7 min-w-0 max-w-[35%] shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground hover:bg-muted/50", mainTabVisible && "bg-foreground/[0.085] text-foreground")}>
        <MessageSquareText className="size-3.5 shrink-0" /><span className="truncate">{mainTitle}</span>
      </button>}
      <div ref={tabStrip} className="flex min-w-0 select-none items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {items.map(({ id, title, closeState, pending }) => {
          const active = !mainTabVisible && id === activeId
          const Icon = id === launcher ? File : MessageSquareText
          return <ContextMenu key={id}><ContextMenuTrigger asChild><div data-sortable-btw-tab={id === launcher ? undefined : id}
            onPointerDown={event => startTabDrag(id, event)}
            onClickCapture={event => {
              if (event.detail > 0 && draggedTab.current === id) {
                draggedTab.current = null
                event.stopPropagation()
              }
            }}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); closeTabs([id]) } }}
            className={cn("group flex w-[156px] max-w-full shrink-0 items-center rounded-md text-muted-foreground hover:bg-muted/50", active && "bg-foreground/[0.085] text-foreground")}>
            <button type="button" ref={active ? selectedTab : undefined} data-btw-active-tab={active || undefined} aria-pressed={active}
              onClick={() => selectSideTab(id)}
              className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md pl-2 pr-1 text-[13px] font-medium">
              <Icon className="size-3.5" />{title}
              {pending && <span role="img" aria-label="等待处理" title="等待处理" className="size-1.5 shrink-0 rounded-full bg-status-warning" />}
            </button>
            <button type="button" aria-label={`关闭 ${title}`} disabled={closeState === "closing"} onClick={() => closeTabs([id])}
              className={cn("mr-1 shrink-0 rounded p-0.5 hover:bg-background/75", !active && "opacity-0 group-hover:opacity-100 focus:opacity-100")}>
              <X className="size-3" />
            </button>
          </div></ContextMenuTrigger>
            <ContextMenuContent data-btw-tab-owner={parentId}>
              <ContextMenuItem disabled={closeState === "closing"} onSelect={() => closeTabs([id])}>关闭标签页</ContextMenuItem>
              <ContextMenuItem disabled={items.length < 2} onSelect={() => {
                select(parentId, id)
                closeTabs(items.filter(t => t.id !== id && t.id !== launcher).map(t => t.id))
              }}>关闭其他标签页</ContextMenuItem>
              <ContextMenuItem onSelect={() => closeTabs(items.map(t => t.id))}>关闭所有标签页</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        })}
      </div>
      <button type="button" title="新增标签" aria-label="新增标签" className={iconButton} onClick={() => { if (mainTabVisible) showMainTab?.(false); openBtwLauncher(parentId) }}><Plus className="size-4" /></button>
      <button type="button" aria-label={full ? "退出完整视图" : "进入完整视图"} title={full ? "退出完整视图" : "进入完整视图"} aria-pressed={full} className={cn(iconButton, "ml-auto")} onClick={toggleFull}>
        {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </button>
    </header>
  )
}

function BtwSkillGeneration({ threadId }: { threadId: string }) {
  const { phase, streamedText, errorText } = useAppStore(state => selectSkillGenerationAgent(state, threadId))
  const canRetry = useAppStore(state => Boolean(selectSkillRetryContext(state, threadId)))
  if (phase !== "generating" && phase !== "error") return null
  return (
    <div className="shrink-0 border-b px-3 py-2">
      <SkillGenerationCard
        phase={phase}
        streamedText={streamedText}
        errorText={errorText}
        onRetry={phase === "error" && canRetry ? () => void retryBtwSkillGeneration(threadId) : undefined}
        onDismiss={phase === "error"
          ? () => useAppStore.getState().setSkillGenerationPhase(null, undefined, threadId)
          : undefined}
      />
    </div>
  )
}

export function BtwPane(props: BtwViewProps) {
  const { parentId, full, mainTabVisible } = props
  const id = useBtwChat(s => s.selected[parentId])
  const { getThreadState } = useThreadContext()
  const composerId = useDeferredValue<string | null | undefined>(id, null)
  const hasSummary = useAppStore(s => Boolean(id && s.sideThreads.has(id)))
  const closeState = useBtwChat(s => s.tabs.find(tab => tab.id === id)?.closeState)
  const opening = useRef(false)
  const paneRef = useRef<HTMLElement>(null)
  useBtwComposerToolbarHeight(paneRef, parentId, Boolean(id && id !== launcher && !full))
  useEffect(() => {
    if (!id || id === launcher || hasSummary) return
    void loadBtwThread(id, parentId).catch(console.error)
  }, [id, hasSummary, parentId])
  const options = [
    { kind: "files", label: "文件", detail: "从目录中选择一个文件", icon: FolderOpen },
    { kind: "browser", label: "浏览器", detail: "浏览网页和预览应用。", icon: Globe },
    { kind: "git", label: "审查", detail: "查看代码变更与差异。", icon: FileDiff },
    { kind: "btw", label: "辅助对话", detail: "在侧边面板中继续对话。", icon: MessageSquareText }
  ] as const
  function openLauncherOption(kind: (typeof options)[number]["kind"]): void {
    if (kind === "btw") {
      if (opening.current) return
      opening.current = true
      const completeFocus = prepareBtwComposerFocus(parentId)
      void openBtw(parentId, getThreadState(parentId).currentModel).then(completeFocus).catch(error => {
        completeFocus(undefined)
        toast.error(error instanceof Error ? error.message : "无法创建辅助对话。")
      }).finally(() => { opening.current = false })
      return
    }
    closeLauncher(parentId)
    const app = useAppStore.getState()
    if (kind === "files") app.requestOpenRightPanelSection(parentId, "files")
    else if (kind === "browser") app.requestOpenBrowserPanel()
    else app.setRightModule("git")
  }
  if (!id) return null
  return (
    <aside ref={paneRef} aria-label="辅助对话" data-btw-pane={mainTabVisible ? undefined : id} tabIndex={-1} data-thread-floating-chat="true" className={cn("relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background", mainTabVisible && "[&>:not(header)]:hidden")}>
      <BtwTabs {...props} />
      {id === launcher ? <div className="mx-auto w-full max-w-2xl overflow-auto px-6 py-8">
        <h2 className="mb-4 font-semibold">新标签页</h2>
        {options.map(({kind, label, detail, icon: Icon}) => <button type="button" key={kind} onClick={() => openLauncherOption(kind)}
          className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-muted">
          <Icon className="size-4" /><span className="flex flex-col text-sm">{label}<small className="text-xs text-muted-foreground">{detail}</small></span>
        </button>)}
      </div> : closeState ? (
        <div className="flex items-center justify-between gap-2 px-4 py-3 text-sm">
          <p role="status">{closeState === "closing" ? "正在关闭辅助对话…" : "尚未完成关闭辅助对话。"}</p>
          {closeState === "failed" && (
            <button type="button" className="rounded-md border px-2 py-1 hover:bg-muted" onClick={event =>
              closeWithComposerFocus(parentId, [id], event.currentTarget.closest("[data-btw-pane]"), () => closeBtw(id))}>
              重试关闭
            </button>
          )}
        </div>
      ) : hasSummary && composerId === id ? (
        <>
          <BtwSkillGeneration key={id} threadId={id} />
          <ChatContainer key={id} threadId={id} surface="btw" visible={!mainTabVisible} />
        </>
      ) : null}
    </aside>
  )
}
