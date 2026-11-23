import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { BotChangeEvent } from "../../../../shared/bots/contracts"
import type {
  BotReactionTarget,
  BotMessageReactionState,
  BotMessageReactions,
  BotMessageReactionUpdate
} from "../../../../shared/bots/message-reactions"
import {
  BotMessageReactionsContext,
  type BotReactionContext
} from "./bot-message-reactions-context"

export interface BotReactionClient {
  readonly hostId: string
  messageReactions(target: BotReactionTarget, ids: string[]): Promise<BotMessageReactions>
  setMessageReaction(
    target: BotReactionTarget,
    id: string,
    emoji: string,
    present: boolean
  ): Promise<BotMessageReactionUpdate>
  subscribe(listener: (event: BotChangeEvent) => void): () => void
}
type Projection = BotMessageReactionState & { revision: number }
const readableError = (error: unknown) =>
  error instanceof Error ? error.message : "暂时无法更新消息回应，请重试。"
const scopeKeyFor = (target: BotReactionTarget) =>
  JSON.stringify(
    target.kind === "bot" ? ["bot", target.botId, target.workId ?? null] : ["group", target.groupId]
  )

/** A projection of host-owned reactions for loaded rows, never another message store. */
export function BotMessageReactionsProvider({
  client,
  target,
  messageIds,
  readOnly = false,
  enabled = true,
  refreshKey,
  children
}: {
  client: BotReactionClient
  target: BotReactionTarget
  messageIds: readonly string[]
  readOnly?: boolean
  enabled?: boolean
  /** A persisted/completed tail identity, never streaming message text. */
  refreshKey?: string | number
  children: ReactNode
}) {
  const scopeKey = scopeKeyFor(target)
  const scope = useMemo(() => {
    const [kind, id, workId] = JSON.parse(scopeKey) as string[]
    return kind === "group"
      ? { kind: "group" as const, groupId: id }
      : { kind: "bot" as const, botId: id, ...(workId ? { workId } : {}) }
  }, [scopeKey])
  const session = useMemo(() => ({ client, scope, active: enabled }), [client, scope, enabled])
  const idsKey = JSON.stringify([...new Set(messageIds)])
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey])
  const allowed = useRef(new Set(ids))
  allowed.current = new Set(ids)
  const [projection, setProjection] = useState<{
    session: typeof session
    items: Map<string, Projection>
  }>({ session, items: new Map() })
  const [activity, setActivity] = useState<{
    session: typeof session
    pending: Set<string>
    errors: Map<string, string>
    loadError?: string
  }>({ session, pending: new Set(), errors: new Map() })
  const pending = useRef(new Set<string>())
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    session.active = enabled
    pending.current = new Set()
    return () => {
      session.active = false
    }
  }, [session, enabled])
  const apply = useCallback(
    (items: BotMessageReactionState[], revision: number) => {
      if (!session.active) return
      setProjection((previous) => {
        const next = new Map(previous.session === session ? previous.items : [])
        for (const id of next.keys()) if (!allowed.current.has(id)) next.delete(id)
        for (const item of items) {
          if (
            allowed.current.has(item.messageId) &&
            (next.get(item.messageId)?.revision ?? -1) <= revision
          )
            next.set(item.messageId, { ...item, revision })
        }
        return { session, items: next }
      })
    },
    [session]
  )
  useEffect(() => {
    if (!enabled) {
      refresh.current = () => {}
      return
    }
    let disposed = false,
      inFlight = false,
      dirty = false
    const read = async () => {
      dirty = true
      if (inFlight) return
      inFlight = true
      try {
        while (dirty && !disposed) {
          dirty = false
          for (let offset = 0; offset < ids.length && !disposed; offset += 100) {
            const result = await client.messageReactions(scope, ids.slice(offset, offset + 100))
            if (!disposed) apply(result.items, result.revision)
          }
          if (!disposed)
            setActivity((previous) => ({
              ...(previous.session === session
                ? previous
                : { pending: new Set<string>(), errors: new Map<string, string>() }),
              session,
              errors: new Map(),
              loadError: undefined
            }))
        }
      } catch (error) {
        if (!disposed)
          setActivity((previous) => ({
            ...(previous.session === session
              ? previous
              : { pending: new Set<string>(), errors: new Map<string, string>() }),
            session,
            loadError: readableError(error)
          }))
      } finally {
        inFlight = false
      }
    }
    const retry = () => {
      void read()
    }
    refresh.current = retry
    const unsubscribe = client.subscribe((event) => {
      if (
        event.hostId === client.hostId &&
        event.reactionTarget &&
        scopeKeyFor(event.reactionTarget) === scopeKey
      )
        retry()
    })
    window.addEventListener("focus", retry)
    retry()
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener("focus", retry)
      if (refresh.current === retry) refresh.current = () => {}
    }
  }, [client, scope, scopeKey, ids, apply, session, enabled, refreshKey])
  const value: BotReactionContext = {
    stateFor: (id) => (projection.session === session ? projection.items.get(id) : undefined),
    pending: (id) => activity.session === session && activity.pending.has(id),
    errorFor: (id) =>
      activity.session === session ? (activity.errors.get(id) ?? activity.loadError) : undefined,
    readOnly,
    retry: () => refresh.current(),
    async set(id, emoji, present) {
      const item = projection.session === session ? projection.items.get(id) : undefined
      if (
        !enabled ||
        readOnly ||
        !item?.canReact ||
        !allowed.current.has(id) ||
        pending.current.has(id)
      )
        return
      pending.current.add(id)
      setActivity((previous) => ({
        session,
        pending: new Set(pending.current),
        errors: previous.session === session ? new Map(previous.errors) : new Map()
      }))
      try {
        const result = await client.setMessageReaction(scope, id, emoji, present)
        if (!session.active) return
        apply([result.item], result.revision)
        setActivity((previous) => {
          if (previous.session !== session) return previous
          const errors = new Map(previous.errors)
          errors.delete(id)
          return { ...previous, errors }
        })
      } catch (error) {
        if (session.active)
          setActivity((previous) => {
            const errors = new Map(previous.session === session ? previous.errors : [])
            errors.set(id, readableError(error))
            return { session, pending: new Set(pending.current), errors }
          })
      } finally {
        if (session.active) {
          pending.current.delete(id)
          setActivity((previous) =>
            previous.session === session
              ? { ...previous, pending: new Set(pending.current) }
              : previous
          )
        }
      }
    }
  }
  return (
    <BotMessageReactionsContext.Provider value={enabled ? value : null}>
      {children}
    </BotMessageReactionsContext.Provider>
  )
}
