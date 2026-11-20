export const MESSAGE_ID_INDEX_THRESHOLD = 32

interface MessageIdentity {
  id: string
}

export interface MessageIdIndexLookup {
  findFirstIndex: (messageId: string) => number
}

/**
 * Keep short transcripts allocation-free while avoiding a full history scan on
 * every streaming update for long transcripts. The caller must retain this
 * lookup only while the message identity and order are unchanged.
 */
export function createMessageIdIndexLookup(
  messages: readonly MessageIdentity[]
): MessageIdIndexLookup {
  let firstIndexById: Map<string, number> | null = null

  return {
    findFirstIndex(messageId) {
      if (messages.length < MESSAGE_ID_INDEX_THRESHOLD) {
        return messages.findIndex((message) => message.id === messageId)
      }

      if (!firstIndexById) {
        firstIndexById = new Map<string, number>()
        for (let index = 0; index < messages.length; index += 1) {
          const id = messages[index].id
          // Match Array.findIndex semantics if malformed input contains duplicate ids.
          if (!firstIndexById.has(id)) firstIndexById.set(id, index)
        }
      }

      return firstIndexById.get(messageId) ?? -1
    }
  }
}
