// Use IndexedDB so recalling prompts never competes with the draft queue's localStorage quota.
export interface PromptHistoryEntry {
  order: number
  through?: number
  text: string
  // Only in the live view. Accepted rows in IndexedDB have no preview receipts.
  previews?: { rejected: boolean }[]
}
export interface PromptHistoryCursor extends PromptHistoryEntry { workspace: string }

const limit = 30
const changes = new EventTarget()
const pending = new Map<number, { workspace: string; rejected: boolean; separatesDuplicates: boolean }>()
const sessionStart = Math.floor(performance.timeOrigin * 1000)
const offsets = new Map<string, number>()
const previews = new Map<number, { workspace: string; entry: PromptHistoryEntry }>()
let lastOrder = 0
let opening: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("cmbcowork-prompt-history", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("workspaces")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(error => {
    opening = undefined
    throw error
  })
}

// Keep this session's submissions after durable history even if the system clock moved back.
function orderOffset(workspace: string, saved: PromptHistoryEntry[]): number {
  let offset = offsets.get(workspace)
  if (offset === undefined) {
    const tail = saved.at(-1)
    offset = Math.max(0, (tail?.through ?? tail?.order ?? 0) + 1 - sessionStart)
    offsets.set(workspace, offset)
  }
  return offset
}

// A collapsed run retains its order range so an already recalled duplicate keeps its cursor.
function collapse(entries: PromptHistoryEntry[], separated?: (after: number, before: number) => boolean): PromptHistoryEntry[] {
  const result: PromptHistoryEntry[] = []
  for (const item of entries) {
    const previous = result.at(-1)
    if (previous?.text === item.text && !separated?.(previous.through ?? previous.order, item.order)) {
      const merged = { ...previous, through: Math.max(previous.through ?? previous.order, item.through ?? item.order) }
      if (previous.previews && item.previews) merged.previews = [...previous.previews, ...item.previews]
      else delete merged.previews
      result[result.length - 1] = merged
    } else {
      result.push(item)
    }
  }
  return result
}

export function watchPromptHistory(workspace: string, update: (entries: PromptHistoryEntry[]) => void) {
  let active = true
  let loaded = false
  let saved: PromptHistoryEntry[] = []
  const refresh = () => {
    const offset = offsets.get(workspace) ?? 0
    const visible = [...previews.values()].filter(item => item.workspace === workspace)
      .map(({ entry }) => ({ ...entry, order: entry.order + offset }))
    update(collapse([...saved, ...visible].sort((a, b) => a.order - b.order)).slice(-limit))
  }
  const listener = (event: Event) => {
    const entries = (event as CustomEvent<PromptHistoryEntry[]>).detail
    if (entries) {
      saved = entries
      loaded = true
    }
    if (loaded) refresh()
  }
  changes.addEventListener(workspace, listener)
  void database().then(db => {
    if (!active) return
    const request = db.transaction("workspaces").objectStore("workspaces").get(workspace)
    request.onsuccess = () => {
      if (!active) return
      saved = request.result ?? []
      orderOffset(workspace, saved)
      loaded = true
      refresh()
    }
    request.onerror = () => { loaded = true; if (active) refresh() }
  }).catch(() => { loaded = true; if (active) refresh() })
  return () => {
    active = false
    changes.removeEventListener(workspace, listener)
  }
}

// Reserve the order at Enter. A slow @file read or agent admission can finish after a later send.
export function preparePromptHistory(workspace: string | null, text: string) {
  text = text.trim()
  if (!workspace || !text) return
  lastOrder = Math.max(lastOrder + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000))
  const entry = { order: lastOrder, text }
  const receipt = { workspace, rejected: false, separatesDuplicates: false }
  pending.set(entry.order, receipt)
  function removePreview() {
    if (previews.delete(entry.order)) changes.dispatchEvent(new Event(workspace!))
  }
  const preview = () => {
    if (previews.has(entry.order)) return
    previews.set(entry.order, { workspace, entry: { ...entry, previews: [receipt] } })
    changes.dispatchEvent(new Event(workspace))
  }
  function persist(append: boolean) {
    // Capture the other submissions now: their accepted writes may still be queued behind ours.
    const outstanding = [...pending].filter(([, slot]) => slot.workspace === workspace)
    void database().then(db => {
      const tx = db.transaction("workspaces", "readwrite")
      tx.onabort = removePreview
      const store = tx.objectStore("workspaces")
      const read = store.get(receipt.workspace)
      read.onsuccess = () => {
        const saved: PromptHistoryEntry[] = read.result ?? []
        const offset = orderOffset(receipt.workspace, saved)
        const order = entry.order + offset
        const separated = (after: number, before: number) => {
          const gap = outstanding.find(([key, slot]) => !slot.rejected && key + offset > after && key + offset < before)
          if (gap) gap[1].separatesDuplicates = true
          return Boolean(gap)
        }
        const tail = saved.at(-1)
        if (append && tail?.text === text && order > (tail.through ?? tail.order) &&
            !separated(tail.through ?? tail.order, order)) {
          tx.oncomplete = removePreview
          return
        }
        const entries = append ? [...saved, { order, text }].sort((a, b) => a.order - b.order) : saved
        const compact = collapse(entries, separated)
        if (!append && compact.length === saved.length) return
        let groups = 0
        let first = compact.length
        while (first > 0) {
          const i = first - 1
          if (compact[i].text !== compact[first]?.text && ++groups > limit) break
          first = i
        }
        compact.splice(0, first)
        store.put(compact, receipt.workspace)
        tx.oncomplete = () => {
          previews.delete(entry.order)
          changes.dispatchEvent(new CustomEvent(receipt.workspace, { detail: compact }))
        }
      }
    }).catch(removePreview)
  }
  return {
    preview,
    discard() {
      if (!pending.delete(entry.order)) return
      receipt.rejected = true
      removePreview()
      if (receipt.separatesDuplicates) persist(false)
    },
    accept() {
      if (!pending.delete(entry.order)) return
      preview()
      persist(true)
    }
  }
}
