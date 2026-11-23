import type { BotMockFeedEntry } from "../../../shared/bots/mock-channel"

type HistoryWindow = { items: BotMockFeedEntry[]; before: string | null }
const changingStates = new Set(["queued", "running", "waiting_user", "pending", "sending"])
const order = (a: BotMockFeedEntry, b: BotMockFeedEntry) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Refresh loaded mutable history through the existing keyset API, without extending the window. */
export async function refreshBotImHistory(
  old: HistoryWindow,
  read: (before?: string) => Promise<HistoryWindow>,
  current: () => boolean
): Promise<(HistoryWindow & { overlap: boolean }) | undefined> {
  const page = await read()
  if (!current()) return
  const oldIds = new Set(old.items.map(item => item.id))
  const overlap = !old.items.length || !page.items.length || page.items.some(item => oldIds.has(item.id))
  if (!overlap) return { ...page, overlap }
  const merged = new Map(old.items.map(item => [item.id, item]))
  for (const item of page.items) merged.set(item.id, item)
  const newestIds = new Set(page.items.map(item => item.id))
  // A completed user dispatch may still own running peers and later become cancelled.
  // Only delivered bot replies have immutable terminal states.
  const pending = new Set(old.items
    .filter(item => (item.kind === "user" || changingStates.has(item.state)) && !newestIds.has(item.id))
    .map(item => item.id))
  const oldest = old.items.reduce<BotMockFeedEntry | undefined>(
    (first, item) => !first || order(item, first) < 0 ? item : first, undefined
  )
  let before = page.before
  while (pending.size && before && current()) {
    const older = await read(before)
    if (!current()) return
    if (older.before === before) throw new Error("历史记录分页没有前进，请刷新后重试。")
    for (const item of older.items) {
      if (oldIds.has(item.id)) merged.set(item.id, item)
      pending.delete(item.id)
    }
    // A removed record must not make a refresh scan beyond the loaded window.
    if (oldest && older.items.some(item => order(item, oldest) <= 0)) break
    before = older.before
  }
  return { items: [...merged.values()], before: old.items.length ? old.before : page.before, overlap }
}
