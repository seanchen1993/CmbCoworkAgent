import { create } from "zustand"

export interface BtwReference {
  parentId: string
  rowId: string
  role: string
  text: string
}

const empty: BtwReference[] = []
const drafts = create<Record<string, BtwReference[]>>(() => ({}))

export function useBtwReferences(id: string | undefined) {
  return drafts(state => id ? state[id] ?? empty : empty)
}

export function formatBtwMessageForCopy(body: string, quotes: readonly string[]): string {
  return [body, ...quotes.map(quote => "> " + quote.replace(/\r\n|[\r\n\u2028\u2029]/g, "$&> "))].filter(Boolean).join("\n\n")
}

export function addBtwReference(id: string, reference: BtwReference) {
  const current = drafts.getState()[id] ?? empty
  if (current.some(r => r.parentId === reference.parentId && r.rowId === reference.rowId &&
    r.role === reference.role && r.text === reference.text)) return
  if (reference.text.length > 8000 || current.length >= 8 ||
      current.reduce((sum, r) => sum + r.text.length, reference.text.length) > 16000) {
    throw new Error("每条选区最多 8,000 字，每次最多引用 8 条、共 16,000 字。")
  }
  drafts.setState({ [id]: [...current, reference] })
}

export function clearBtwReferences(id: string, consumed?: readonly BtwReference[]) {
  const current = drafts.getState()[id]
  if (!current) return
  const remaining = consumed ? current.filter(r => !consumed.includes(r)) : []
  if (remaining.length) drafts.setState({ [id]: remaining })
  else {
    const next = { ...drafts.getState() }
    delete next[id]
    drafts.setState(next, true)
  }
}
