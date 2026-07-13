export function reconcileMessageDisplayOrder<T extends { id: string }>(
  messages: T[],
  orderHintMessages: ReadonlyArray<{ id?: string }> | undefined
): T[] {
  if (messages.length < 2 || !orderHintMessages?.length) return messages

  const messageById = new Map(messages.map((message) => [message.id, message]))
  const orderedHintIds: string[] = []
  const seenHintIds = new Set<string>()
  for (const hint of orderHintMessages) {
    const id = typeof hint.id === "string" ? hint.id : ""
    if (!id || seenHintIds.has(id) || !messageById.has(id)) continue
    seenHintIds.add(id)
    orderedHintIds.push(id)
  }
  if (orderedHintIds.length < 2) return messages

  const hintedSlots: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (seenHintIds.has(messages[index].id)) hintedSlots.push(index)
  }
  if (hintedSlots.length !== orderedHintIds.length) return messages

  const reconciled = [...messages]
  for (let index = 0; index < hintedSlots.length; index += 1) {
    reconciled[hintedSlots[index]] = messageById.get(orderedHintIds[index])!
  }
  return reconciled
}
