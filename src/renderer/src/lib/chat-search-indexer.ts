import type { ChatSearchLocation } from "../../../shared/chat-search-types"
import type { ChatSearchCorpus, ChatSearchDocument, ChatSearchMatch } from "./chat-search-matches"

/** One worker and one in-flight request; superseded token updates never form a work queue. */
export function createChatSearchIndexer(
  createWorker = () =>
    new Worker(new URL("./chat-search.worker.ts", import.meta.url), { type: "module" })
): {
  search(corpus: ChatSearchCorpus, query: string): Promise<ChatSearchMatch[]>
  validate(
    document: ChatSearchDocument,
    location: ChatSearchLocation,
    signal?: AbortSignal
  ): Promise<boolean>
  cancel(): void
  dispose(): void
} {
  let worker: Worker | null = null
  let requestId = 0
  let generation = 0
  let cancellation = 0
  let nextDocumentId = 0
  let identities = new WeakMap<ChatSearchDocument, number>()
  const uploaded = new Set<number>()
  const matched = new Map<number, { limit: number; locations: ChatSearchLocation[] }>()
  let matchedQuery = ""
  let running: Promise<unknown> = Promise.resolve()
  let rejectPending: ((error: Error) => void) | null = null

  const dispose = (): void => {
    generation += 1
    cancellation += 1
    rejectPending?.(new Error("Search cancelled"))
    rejectPending = null
    worker?.terminate()
    worker = null
    uploaded.clear()
    matched.clear()
    identities = new WeakMap()
  }
  const send = (body: object, onTruncated?: () => void): Promise<ChatSearchLocation[]> => {
    worker ??= createWorker()
    const activeWorker = worker
    const id = ++requestId
    return new Promise((resolve, reject) => {
      const locations: ChatSearchLocation[] = []
      const timer = setTimeout(() => fail(new Error("Search worker timed out")), 10_000)
      const cleanup = (): void => {
        clearTimeout(timer)
        activeWorker.removeEventListener("message", onMessage)
        activeWorker.removeEventListener("error", onError)
        rejectPending = null
      }
      const fail = (error: Error): void => {
        cleanup()
        activeWorker.terminate()
        if (worker === activeWorker) {
          worker = null
          uploaded.clear()
          matched.clear()
        }
        reject(error)
      }
      const onError = (event: Event): void => {
        event.preventDefault()
        fail(new Error("Search worker failed"))
      }
      const onMessage = (
        event: MessageEvent<{
          requestId: number
          locations?: ChatSearchLocation[]
          done?: boolean
          error?: string
          truncated?: boolean
        }>
      ): void => {
        if (event.data.requestId !== id) return
        if (event.data.error) {
          fail(new Error(event.data.error))
          return
        }
        if (event.data.locations) locations.push(...event.data.locations)
        if (event.data.truncated) onTruncated?.()
        if (event.data.done) {
          cleanup()
          resolve(locations)
        }
      }
      rejectPending = fail
      activeWorker.addEventListener("message", onMessage)
      activeWorker.addEventListener("error", onError)
      try {
        activeWorker.postMessage({ ...body, requestId: id })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  const upload = async (doc: ChatSearchDocument, id: number, check: () => void): Promise<void> => {
    if (uploaded.has(id)) return
    const plan = doc.plan ?? {
      role: "user",
      stripThink: false,
      cleanAttachments: false,
      segments: [
        {
          kind: "summary" as const,
          blockIndex: 0,
          start: 0,
          end: doc.text.length,
          sourceLength: doc.text.length,
          raw: doc.text
        }
      ]
    }
    await send({
      type: "begin",
      id,
      role: plan.role,
      stripThink: plan.stripThink,
      cleanAttachments: plan.cleanAttachments
    })
    for (const { raw, ...source } of plan.segments) {
      for (let offset = 0; offset < raw.length; offset += 8192) {
        check()
        await send({
          type: "part",
          source,
          raw: raw.slice(offset, offset + 8192),
          last: offset + 8192 >= raw.length
        })
      }
    }
    await send({ type: "commit" }, () => {
      doc.truncated = true
    })
    uploaded.add(id)
  }
  return {
    dispose,
    cancel() {
      generation += 1
      cancellation += 1
    },
    validate(document, location, signal) {
      const epoch = cancellation
      const existingId = identities.get(document)
      const id = existingId ?? ++nextDocumentId
      const check = (): void => {
        signal?.throwIfAborted()
        if (epoch !== cancellation) throw new Error("Search cancelled")
      }
      const task = async (): Promise<boolean> => {
        check()
        const temporary = !uploaded.has(id)
        try {
          await upload(document, id, check)
          check()
          const result = await send({ type: "validate", id, location })
          check()
          return result.length === 1
        } finally {
          if (temporary && worker && epoch === cancellation) {
            await send({ type: "forget", id })
            uploaded.delete(id)
          }
        }
      }
      const result = running.catch(() => undefined).then(task)
      running = result.catch(() => undefined)
      return result
    },
    search(corpus, query) {
      const currentGeneration = ++generation
      const task = async (): Promise<ChatSearchMatch[]> => {
        const check = (): void => {
          if (currentGeneration !== generation) throw new Error("Search superseded")
        }
        check()
        if (matchedQuery !== query) {
          matched.clear()
          matchedQuery = query
        }
        const documents = [
          ...corpus.stableDocuments.filter((doc) => !corpus.dynamicMessageIds.has(doc.messageId)),
          ...corpus.dynamicDocuments
        ].sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        const entries = documents.map((doc) => {
          let id = identities.get(doc)
          if (id === undefined) {
            id = ++nextDocumentId
            identities.set(doc, id)
          }
          return { doc, id }
        })
        const retained = new Set(entries.map((entry) => entry.id))
        await send({ type: "retain", ids: [...retained] })
        for (const id of uploaded)
          if (!retained.has(id)) {
            uploaded.delete(id)
            matched.delete(id)
          }
        const matches: ChatSearchMatch[] = []
        const visited = new Set<number>()
        for (const { doc, id } of entries) {
          check()
          await upload(doc, id, check)
          check()
          const limit = 1001 - matches.length
          let cached = matched.get(id)
          if (!cached || (cached.limit < limit && cached.locations.length === cached.limit)) {
            cached = { limit, locations: await send({ type: "match", id, query, limit }) }
            matched.set(id, cached)
          }
          const locations = cached.locations.slice(0, limit)
          matched.set(id, { limit, locations })
          visited.add(id)
          check()
          locations.forEach((location, occurrenceIndex) =>
            matches.push({
              messageId: doc.messageId,
              sortIndex: doc.sortIndex,
              occurrenceIndex,
              location
            })
          )
          if (matches.length >= 1001) break
        }
        for (const id of matched.keys()) if (!visited.has(id)) matched.delete(id)
        return matches
      }
      const result = running.catch(() => undefined).then(task)
      running = result.catch(() => undefined)
      return result
    }
  }
}
