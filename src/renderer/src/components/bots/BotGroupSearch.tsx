import { useCallback, useEffect, useMemo, useRef } from "react"
import {
  ChatSearchOverlay,
  type DurableChatSearchMatch,
  type SearchDurableMessages
} from "@/components/chat/ChatSearchOverlay"
import { useAppStore } from "@/lib/store"
import { createChatSearchIndexer } from "@/lib/chat-search-indexer"
import {
  boundChatSearchCorpus,
  type ChatSearchCorpus,
  type ChatSearchDocument,
  type ChatSearchMatch
} from "@/lib/chat-search-matches"
import {
  botGroupPendingSearchDocument,
  botGroupSearchDocument,
  botGroupSearchPage
} from "@/lib/bot-group-search"
import type { BotClient, BotGroupMessage } from "../../../../shared/bots/contracts"
import type { ChatSearchReveal } from "../../../../shared/chat-search-types"
import type { BotGroupPendingQuestion } from "./use-group-questions"

const corpusFor = (documents: readonly ChatSearchDocument[]): ChatSearchCorpus =>
  boundChatSearchCorpus({
    stableDocuments: documents,
    dynamicDocuments: [],
    dynamicMessageIds: new Set()
  })

/** The public room reuses the workbench search, never the members' execution transcripts. */
export function BotGroupSearch({
  client,
  groupId,
  messages,
  questions,
  enabled,
  open,
  onOpenChange,
  getViewport,
  onRevealMessage,
  onRevealDurableMessage,
  onCancelDurableReveal,
  onRevealSearchContext
}: {
  client: BotClient
  groupId: string
  messages: readonly BotGroupMessage[]
  questions: readonly BotGroupPendingQuestion[]
  enabled: boolean
  open: boolean
  onOpenChange(open: boolean): void
  getViewport(): HTMLElement | null
  onRevealMessage(messageId: string): void
  onRevealDurableMessage(match: DurableChatSearchMatch): Promise<void>
  onCancelDurableReveal(): void
  onRevealSearchContext(reveal: ChatSearchReveal | null): void
}) {
  const localIndexer = useRef<ReturnType<typeof createChatSearchIndexer> | null>(null)
  const pageIndexer = useRef<ReturnType<typeof createChatSearchIndexer> | null>(null)
  const generation = useRef(0)
  const current = useRef({ messages, questions, active: open && enabled })
  current.current = { messages, questions, active: open && enabled }
  const documents = useRef(
    new Map<
      string,
      {
        source: BotGroupMessage
        pending?: BotGroupPendingQuestion["request"]
        document: ChatSearchDocument
      }
    >()
  )
  const dispose = useCallback(() => {
    generation.current++
    localIndexer.current?.dispose()
    pageIndexer.current?.dispose()
    localIndexer.current = pageIndexer.current = null
    documents.current.clear()
  }, [])
  useEffect(() => {
    if (!open || !enabled) dispose()
    if (!enabled && open) onOpenChange(false)
  }, [open, enabled, dispose, onOpenChange])
  useEffect(
    () => () => {
      dispose()
      onCancelDurableReveal()
    },
    [client, groupId, dispose, onCancelDurableReveal]
  )
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !enabled ||
        useAppStore.getState().showCustomizeView ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') ||
        !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f")
      )
        return
      const viewport = getViewport()
      if (!viewport || viewport.offsetParent === null) return
      event.preventDefault()
      onOpenChange(true)
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [enabled, getViewport, onOpenChange])

  const getSearchCorpus = useCallback(async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (!current.current.active) return corpusFor([])
    const owner = generation.current
    const snapshot = current.current
    const check = () => {
      signal?.throwIfAborted()
      if (!current.current.active || generation.current !== owner)
        throw new DOMException("Search cancelled", "AbortError")
    }
    let batchStart = performance.now()
    const pendingRequests = new Map(
      snapshot.questions.map(({ request }) => [request.requestId, request])
    )
    const found: ChatSearchDocument[] = []
    const next: typeof documents.current = new Map()
    for (const message of snapshot.messages.slice(-500)) {
      check()
      if (performance.now() - batchStart >= 4) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        check()
        batchStart = performance.now()
      }
      const cached = documents.current.get(message.id)
      const source = cached?.source
      const pending = message.question
        ? pendingRequests.get(message.question.request.requestId)
        : undefined
      const unchanged =
        source &&
        cached?.pending === pending &&
        source.text === message.text &&
        source.authorBotId === message.authorBotId &&
        source.question?.state === message.question?.state &&
        source.question?.request.requestId === message.question?.request.requestId &&
        source.question?.result?.content === message.question?.result?.content &&
        source.question?.result?.is_error === message.question?.result?.is_error
      const doc = unchanged ? cached!.document : botGroupSearchDocument(message, pending)
      if (!doc) continue
      found.push(doc)
      next.set(message.id, { source: message, pending, document: doc })
    }
    const lastOrdinal = snapshot.messages.at(-1)?.ordinal ?? 0
    snapshot.questions.forEach(({ request }, index) => {
      if (
        snapshot.messages.some(
          (message) => message.question?.request.requestId === request.requestId
        )
      )
        return
      const doc = botGroupPendingSearchDocument(request, lastOrdinal + index + 1)
      if (doc) found.push(doc)
    })
    const corpus = corpusFor(found)
    const retained = new Set(corpus.stableDocuments.map((doc) => doc.messageId))
    check()
    documents.current = new Map([...next].filter(([id]) => retained.has(id)))
    return corpus
  }, [])
  const searchLocalCorpus = useCallback((corpus: ChatSearchCorpus, query: string) => {
    if (!current.current.active) return Promise.resolve([])
    localIndexer.current ??= createChatSearchIndexer()
    return localIndexer.current.search(corpus, query)
  }, [])
  const cancelSearch = useCallback(() => {
    generation.current++
    localIndexer.current?.cancel()
    pageIndexer.current?.cancel()
  }, [])
  const searchDurableMessages = useCallback<SearchDurableMessages>(
    async (query, options) => {
      const owner = generation.current
      const check = () => {
        if (!current.current.active || generation.current !== owner)
          throw new DOMException("Search cancelled", "AbortError")
      }
      check()
      const page = await client.groupMessages(groupId, options.beforeOrdinal)
      check()
      const pendingRequests = new Map(
        current.current.questions.map(({ request }) => [request.requestId, request])
      )
      let remaining = page.flatMap((message) => {
        const doc = botGroupSearchDocument(
          message,
          message.question ? pendingRequests.get(message.question.request.requestId) : undefined
        )
        return doc ? [doc] : []
      })
      const matches: ChatSearchMatch[] = []
      let oldestScanned = page[0]?.ordinal
      let truncated = remaining.some((doc) => doc.truncated)
      // Usually all fifty rows fit. If not, send the same bounded corpus in
      // successive windows, without retaining or mounting older history pages.
      while (remaining.length) {
        const corpus = corpusFor(remaining)
        pageIndexer.current ??= createChatSearchIndexer()
        const found = await pageIndexer.current.search(corpus, query)
        check()
        truncated ||= corpus.stableDocuments.some((doc) => doc.truncated)
        matches.push(...found.slice(0, Math.max(0, 1001 - matches.length)))
        const retained = new Set(corpus.stableDocuments.map((doc) => doc.messageId))
        oldestScanned = Math.min(...corpus.stableDocuments.map((doc) => doc.sortIndex!))
        remaining = remaining.filter((doc) => !retained.has(doc.messageId))
        if (matches.length >= 1001) {
          truncated = true
          break
        }
      }
      const scanned = remaining.length
        ? page.filter((message) => message.ordinal >= oldestScanned!)
        : page
      return {
        ...botGroupSearchPage(scanned, matches, truncated),
        hasMore: remaining.length > 0 || page.length === 50
      }
    },
    [client, groupId]
  )
  const validateSearchLocation = useCallback(
    async (reveal: ChatSearchReveal, signal: AbortSignal) => {
      const corpus = await getSearchCorpus(signal)
      const doc = corpus.stableDocuments.find((item) => item.messageId === reveal.messageId)
      if (!doc) return false
      localIndexer.current ??= createChatSearchIndexer()
      return localIndexer.current.validate(doc, reveal.location, signal)
    },
    [getSearchCorpus]
  )
  // Public message bodies are immutable. Only new rows and native question
  // receipts change this projection; unrelated member token events do not.
  const recomputeKey = useMemo(() => {
    if (!open) return "closed"
    return JSON.stringify([
      messages.length,
      messages[0]?.id,
      messages.at(-1)?.id,
      messages
        .slice(-500)
        .flatMap((message) =>
          message.question
            ? [
                message.id,
                message.question.state,
                message.question.result?.content,
                message.question.result?.is_error
              ]
            : []
        ),
      questions.map(({ request }) => request.requestId)
    ])
  }, [messages, questions, open])
  return (
    <ChatSearchOverlay
      open={open && enabled}
      onClose={() => onOpenChange(false)}
      getViewport={getViewport}
      getSearchCorpus={getSearchCorpus}
      searchLocalCorpus={searchLocalCorpus}
      onCancelLocalSearch={cancelSearch}
      validateSearchLocation={validateSearchLocation}
      onRevealMessage={onRevealMessage}
      searchDurableMessages={searchDurableMessages}
      onRevealDurableMessage={onRevealDurableMessage}
      onCancelDurableReveal={onCancelDurableReveal}
      onRevealSearchContext={onRevealSearchContext}
      recomputeKey={recomputeKey}
    />
  )
}
