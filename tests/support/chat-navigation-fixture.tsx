/* eslint-disable react-refresh/only-export-components -- standalone browser fixture, not a Fast Refresh module */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Virtuoso } from "react-virtuoso"
import {
  ChatMessageVirtualList,
  type ChatMessageVirtualListProps
} from "../../src/renderer/src/components/chat/ChatMessageVirtualList"
import { ChatSearchOverlay } from "../../src/renderer/src/components/chat/ChatSearchOverlay"
import { StreamingMarkdown } from "../../src/renderer/src/components/chat/StreamingMarkdown"
import type { ChatSearchCorpus } from "../../src/renderer/src/lib/chat-search-matches"
import { createChatSearchPlan } from "../../src/shared/chat-search-plan"
import type { ChatSearchReveal } from "../../src/shared/chat-search-types"
import { createChatSearchIndexer } from "../../src/renderer/src/lib/chat-search-indexer"

type SearchCase = "occurrences" | "folded" | "delayed" | "dense" | "tail" | "inline"
interface Metrics {
  renders: number
  started: number
  beforeParent?: { renders: number; milliseconds: number }
  reveals: boolean[]
}

declare global {
  interface Window {
    chatSearchWorkerUrl: string
    chatNavigationMetrics: Metrics
    chatNavigationFixture: {
      mountList(count: number): void
      mountSearch(kind: SearchCase): void
      hideRow?: () => void
      tick?: () => void
      finishHydration?: () => void
      stressSearch(): Promise<{
        preparationMs: number
        searchMs: number
        inputUnits: number
        maxPacketBytes: number
        matches: number
      }>
    }
  }
}

const noop = (): void => {}
const emptyCorpus: ChatSearchCorpus = {
  stableDocuments: [],
  dynamicDocuments: [],
  dynamicMessageIds: new Set()
}
const durablePage = {
  matches: [
    {
      messageId: "message",
      ordinal: 1,
      role: "assistant" as const,
      createdAt: 1,
      occurrenceCount: 2,
      preview: "needle"
    }
  ],
  beforeOrdinal: null,
  beforeMessageId: null,
  hasMore: false
}
const searchDurable = async (): Promise<typeof durablePage> => durablePage

function SearchFixture({ kind }: { kind: SearchCase }): React.JSX.Element {
  const indexer = useRef<ReturnType<typeof createChatSearchIndexer> | null>(null)
  const searchLocal = useCallback((corpus: ChatSearchCorpus, query: string) => {
    indexer.current ??= createChatSearchIndexer(() => new Worker(window.chatSearchWorkerUrl))
    return indexer.current.search(corpus, query)
  }, [])
  const cancelLocal = useCallback(() => indexer.current?.cancel(), [])
  useEffect(() => () => indexer.current?.dispose(), [])
  const [searchReveal, setSearchReveal] = useState<ChatSearchReveal | null>(null)
  const [visible, setVisible] = useState(kind !== "delayed")
  const [revision, setRevision] = useState(0)
  const [open, setOpen] = useState(true)
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null)
  const hydrationResolve = useRef<(() => void) | null>(null)
  const text = useMemo(
    () =>
      kind === "dense"
        ? `needle\n\n${"A **formatted** paragraph with `code`.\n\n".repeat(13_100)}`
        : kind === "tail"
          ? `HEAD_TARGET\n\n${"x".repeat(300_000)}\n\nneedle`
          : kind === "inline"
            ? "before alpha **needle** omega after"
            : kind === "folded"
              ? `${"x".repeat(20_000)}\n\nneedle\n\n${"y".repeat(80_000)}`
              : [
                  "needle",
                  ...Array.from({ length: 78 }, (_, index) => `paragraph ${index}`),
                  "needle"
                ].join("\n\n"),
    [kind]
  )
  const corpus = useMemo<ChatSearchCorpus>(
    () => ({
      stableDocuments: [
        {
          messageId: "message",
          text,
          plan: createChatSearchPlan("assistant", text),
          truncated: createChatSearchPlan("assistant", text).truncated,
          durableAuthoritative: true
        }
      ],
      dynamicDocuments: [],
      dynamicMessageIds: new Set()
    }),
    [text]
  )
  const getCorpus = useCallback(
    () => (kind === "delayed" && !visible ? emptyCorpus : corpus),
    [corpus, kind, visible]
  )
  const getViewport = useCallback(() => document.getElementById("viewport"), [])
  const revealDurable = useCallback(
    () =>
      new Promise<void>((resolve) => {
        hydrationResolve.current = resolve
        window.chatNavigationFixture.finishHydration = () => setVisible(true)
      }),
    []
  )

  useLayoutEffect(() => {
    window.chatNavigationFixture.hideRow = () => setVisible(false)
    window.chatNavigationFixture.tick = () => setRevision((value) => value + 1)
    if (visible) {
      // Resolve after React has committed a new onRevealMessage closure and the row.
      requestAnimationFrame(() => {
        hydrationResolve.current?.()
        hydrationResolve.current = null
      })
    }
  }, [visible])

  return (
    <>
      <div
        id="viewport"
        ref={setScrollParent}
        style={{ height: 400, overflow: "auto", width: 700, marginTop: 80 }}
      >
        {kind !== "folded" && <div style={{ height: 500 }} />}
        {visible && kind === "folded" && scrollParent && (
          <Virtuoso
            data={["Earlier context", text]}
            customScrollParent={scrollParent}
            initialTopMostItemIndex={{ index: "LAST", align: "end" }}
            alignToBottom
            defaultItemHeight={112}
            followOutput={() => false}
            itemContent={(index, content) => (
              <div data-chat-message-id={index === 1 ? "message" : "context"}>
                <StreamingMarkdown
                  searchLocation={index === 1 ? searchReveal?.location : undefined}
                >
                  {content}
                </StreamingMarkdown>
              </div>
            )}
          />
        )}
        {visible && kind !== "folded" && (
          <div data-chat-message-id="message">
            <StreamingMarkdown
              searchLocation={searchReveal?.location}
              isStreaming={kind === "tail" && revision === 0}
            >
              {text}
            </StreamingMarkdown>
          </div>
        )}
        {kind !== "folded" && <div style={{ height: 500 }} />}
      </div>
      <ChatSearchOverlay
        searchLocalCorpus={searchLocal}
        onCancelLocalSearch={cancelLocal}
        onRevealSearchContext={setSearchReveal}
        open={open}
        onClose={() => setOpen(false)}
        getViewport={getViewport}
        getSearchCorpus={getCorpus}
        onRevealMessage={() => {
          window.chatNavigationMetrics.reveals.push(visible)
        }}
        searchDurableMessages={kind === "delayed" ? searchDurable : undefined}
        onRevealDurableMessage={revealDurable}
        recomputeKey={`${revision}:${visible}`}
      />
    </>
  )
}

function ListFixture({ count }: { count: number }): React.JSX.Element {
  const [parent, setParent] = useState<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const props = useMemo<ChatMessageVirtualListProps>(
    () => ({
      messages: Array.from({ length: count }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant",
        created_at: new Date(index),
        content: `paragraph ${index} **bold** and code.\n\n`.repeat(80)
      })),
      visibleMessageIndexes: Array.from({ length: count }, (_, index) => index),
      lastUserMessageIndex: -1,
      contentVersion: 0,
      historyHasMore: false,
      historyPageLoading: false,
      historyRemainingCount: 0,
      onLoadEarlierHistoryPage: noop,
      historyGapBeforeMessageId: null,
      canLoadReleasedHistory: false,
      onLoadReleasedHistoryWindow: noop,
      onRestoreLatestHistoryWindow: noop,
      hookLoggingEnabled: false,
      hookLogBucketByTurnId: new Map(),
      detachedHookLogBuckets: [],
      contentMessageRefs: { current: new Map() },
      setMessageRef: () => noop,
      isLoading: false,
      toolResults: new Map(),
      toolCallStates: new Map(),
      pendingApprovalToolCallKeys: new Set(),
      pendingApproval: null,
      autoApproveGitPush: false,
      onApprovalDecision: noop,
      onEditUserMessage: noop,
      onSetGoalFromMessage: noop,
      onForkFromMessage: noop,
      forkingMessageId: null,
      onOpenHookLogBucket: noop,
      threadId: `fixture-${count}`,
      assistantDurationMsById: new Map(),
      userSendTimeLabelById: new Map(),
      customScrollParent: null,
      virtuosoRef: { current: null },
      navigatorVirtualRangeRef: { current: null },
      initialTopMostItemIndex: { index: "LAST", align: "end" },
      onInitialVirtualItemsRendered: noop,
      onContentHeightChanged: noop,
      onAtBottomStateChange: noop,
      footer: null
    }),
    [count]
  )
  useLayoutEffect(() => {
    const metrics = window.chatNavigationMetrics
    metrics.beforeParent = {
      renders: metrics.renders,
      milliseconds: performance.now() - metrics.started
    }
    // Match ChatContainer's mount order to detect pre-Virtuoso Markdown work.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setParent(viewportRef.current)
  }, [])
  return (
    <div ref={viewportRef} style={{ height: 400, overflow: "auto", width: 700 }}>
      <ChatMessageVirtualList {...props} customScrollParent={parent} />
    </div>
  )
}

let root: Root | undefined
function mount(component: React.ReactNode): void {
  root?.unmount()
  window.chatNavigationMetrics = { renders: 0, started: performance.now(), reveals: [] }
  delete window.chatNavigationFixture.finishHydration
  root = createRoot(document.getElementById("root")!)
  root.render(component)
}
window.chatNavigationFixture = {
  mountList: (count) => mount(<ListFixture count={count} />),
  mountSearch: (kind) => mount(<SearchFixture kind={kind} />),
  async stressSearch() {
    const body = `needle\n\n${"A **formatted** paragraph with `code`.\n\n".repeat(8000)}`
    const blocks = Array.from({ length: 32 }, () => ({ type: "text", text: body }))
    const start = performance.now()
    const plan = createChatSearchPlan("assistant", blocks)
    const text = plan.segments.map((segment) => segment.raw).join("\n")
    const preparationMs = performance.now() - start
    let maxPacketBytes = 0
    const indexer = createChatSearchIndexer(() => {
      const worker = new Worker(window.chatSearchWorkerUrl)
      const send = worker.postMessage.bind(worker)
      worker.postMessage = (data: unknown): void => {
        maxPacketBytes = Math.max(
          maxPacketBytes,
          new TextEncoder().encode(JSON.stringify(data)).length
        )
        send(data)
      }
      return worker
    })
    try {
      const searchStart = performance.now()
      const matches = await indexer.search(
        {
          stableDocuments: [{ messageId: "stress", text, plan }],
          dynamicDocuments: [],
          dynamicMessageIds: new Set()
        },
        "needle"
      )
      return {
        preparationMs,
        searchMs: performance.now() - searchStart,
        inputUnits: text.length,
        maxPacketBytes,
        matches: matches.length
      }
    } finally {
      indexer.dispose()
    }
  }
}
