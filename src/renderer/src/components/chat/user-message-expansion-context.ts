import { createContext, useContext, useLayoutEffect, useMemo, useState } from "react"

interface UserMessageExpansionChoice {
  generation: number
  contentKey: string
  expanded: boolean
}

const MAX_SAVED_USER_MESSAGE_CHOICES = 500
export const userMessageExpansionKey = (threadId: string, messageId: string): string =>
  JSON.stringify([threadId, messageId])

/** Only explicit user choices survive virtual row recycling; they never alter message content. */
export class UserMessageExpansionStore extends Map<string, UserMessageExpansionChoice> {
  latestRevision = 0

  discardMessages(threadId: string, messageIds: ReadonlySet<string>, revision: number): void {
    this.latestRevision = Math.max(this.latestRevision, revision)
    for (const id of messageIds) this.delete(userMessageExpansionKey(threadId, id))
  }
}

export const UserMessageExpansionContext = createContext<UserMessageExpansionStore | null>(null)

/** A bounded UI identity, not an authorization fingerprint or a retained copy of raw text. */
export function userMessageContentKey(content: string | readonly unknown[]): string {
  const text = typeof content === "string" ? content : JSON.stringify(content)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 2246822519)
  }
  return `${typeof content}:${text.length}:${first >>> 0}:${second >>> 0}`
}

export function readUserMessageExpansion(
  choices: UserMessageExpansionStore | null,
  messageKey: string,
  contentKey: string,
  snapshotGeneration = 0,
  revision = 0
): { generation: number; expanded: boolean; explicit: boolean } {
  const cached = choices?.get(messageKey)
  // A zero generation can also mean its bounded attempt record was evicted. Keep an existing
  // older choice, but never let an old render borrow a future attempt's generation.
  const generation =
    snapshotGeneration || (cached && cached.generation <= revision ? cached.generation : 0)
  const matches = cached?.generation === generation && cached.contentKey === contentKey
  return { generation, expanded: matches ? cached.expanded : false, explicit: Boolean(matches) }
}

export function rememberUserMessageExpansion(
  choices: UserMessageExpansionStore,
  messageKey: string,
  choice: UserMessageExpansionChoice,
  revision = 0
): void {
  if (revision < choices.latestRevision) return
  choices.latestRevision = revision
  choices.delete(messageKey)
  choices.set(messageKey, choice)
  if (choices.size > MAX_SAVED_USER_MESSAGE_CHOICES) choices.delete(choices.keys().next().value!)
}

export function useUserMessageExpansion(
  threadId: string,
  messageId: string,
  content: string | readonly unknown[] | null,
  snapshotGeneration = 0,
  revision = 0
): [boolean, () => void] {
  const choices = useContext(UserMessageExpansionContext)
  const messageKey = userMessageExpansionKey(threadId, messageId)
  const contentKey = useMemo(
    () => (content === null ? "" : userMessageContentKey(content)),
    [content]
  )
  const initial = readUserMessageExpansion(
    choices,
    messageKey,
    contentKey,
    snapshotGeneration,
    revision
  )
  const { generation } = initial
  const [saved, setSaved] = useState(() => ({
    choices,
    messageKey,
    contentKey,
    revision,
    ...initial
  }))
  const matches =
    saved.choices === choices &&
    saved.messageKey === messageKey &&
    saved.contentKey === contentKey &&
    saved.generation === generation
  const discardedOutsideWindow = choices && saved.revision !== revision && !choices.has(messageKey)
  const state = matches && !discardedOutsideWindow ? saved : initial
  // Reset before committing DOM when a row is reused for edited content or another attempt.
  if (!matches || saved.revision !== revision || state !== saved)
    setSaved({
      choices,
      messageKey,
      contentKey,
      generation,
      revision,
      expanded: state.expanded,
      explicit: state.explicit
    })

  useLayoutEffect(() => {
    if (!choices || content === null || revision < choices.latestRevision) return
    const cached = choices.get(messageKey)
    if (cached && (cached.generation !== generation || cached.contentKey !== contentKey))
      choices.delete(messageKey)
    if (state.explicit)
      rememberUserMessageExpansion(
        choices,
        messageKey,
        { generation, contentKey, expanded: state.expanded },
        revision
      )
  }, [
    choices,
    content,
    contentKey,
    generation,
    messageKey,
    revision,
    state.expanded,
    state.explicit
  ])

  return [
    state.expanded,
    () => {
      setSaved({
        choices,
        messageKey,
        contentKey,
        generation,
        revision,
        expanded: !state.expanded,
        explicit: true
      })
    }
  ]
}
