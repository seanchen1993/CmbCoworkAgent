type SidebarPinningStorage = Pick<Storage, "getItem" | "setItem">

export function readStoredStringSet(
  storageKey: string,
  storage: SidebarPinningStorage = localStorage
): Set<string> {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || "[]")
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === "string"))
  } catch {
    return new Set()
  }
}

export function toggleStoredStringSet(
  current: Set<string>,
  value: string,
  storageKey: string,
  storage: SidebarPinningStorage = localStorage
): Set<string> {
  const next = new Set(current)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  storage.setItem(storageKey, JSON.stringify([...next]))
  return next
}

export function sortPinnedFirst<T>(items: Iterable<T>, isPinned: (item: T) => boolean): T[] {
  const pinned: T[] = []
  const regular: T[] = []
  for (const item of items) {
    if (isPinned(item)) pinned.push(item)
    else regular.push(item)
  }
  return [...pinned, ...regular]
}
