import type { FunctionPaneSnapshot } from "./ui"
import { isModObject, ModFunctionError } from "./contracts"

export type FunctionPlacedArgs = { id: string }
export type FunctionPlacedResult =
  | { isPlaced: true; requestId: string }
  | { isPlaced: false; requestId?: string; reason: string }
/** Native display identity, never a model message or a renderer supplied insertion point. */
export type FunctionPlacedAnchor =
  | { kind: "start" }
  | {
      kind: "after-message"
      id: string
      role: "user" | "assistant"
      providerSourceId?: string
      providerOccurrence?: number
    }
export interface FunctionPlacedEntry {
  requestId: string
  id: string
  plugin: string
  anchor: FunctionPlacedAnchor
  sequence: number
}
export interface FunctionPlacedSnapshot extends FunctionPlacedEntry {
  drawing: FunctionPaneSnapshot
}
export function validateFunctionPlacedArgs(value: unknown): asserts value is FunctionPlacedArgs {
  if (
    !isModObject(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)
  )
    throw new ModFunctionError("MODS_UI_PLACE_ARGUMENTS")
}
export function validateFunctionPlacedResult(
  value: unknown
): asserts value is FunctionPlacedResult {
  if (
    !isModObject(value) ||
    typeof value.isPlaced !== "boolean" ||
    Object.keys(value).some((key) => !["isPlaced", "requestId", "reason"].includes(key)) ||
    (value.requestId !== undefined &&
      (typeof value.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(value.requestId))) ||
    (value.isPlaced
      ? typeof value.requestId !== "string" || value.reason !== undefined
      : typeof value.reason !== "string" ||
        value.reason.length < 1 ||
        value.reason.length > 200 ||
        // eslint-disable-next-line no-control-regex -- Protocol reasons are one printable line.
        /[\r\n\u0000]/.test(value.reason))
  )
    throw new ModFunctionError("MODS_UI_PLACE_RESULT")
}

/** Exact resident segment only. A released/missing/ambiguous anchor is never moved to the tail. */
export function placeFunctionRows(
  messages: readonly {
    id: string
    role: string
    provider_source_id?: string
    provider_occurrence?: number
  }[],
  visibleIndexes: readonly number[],
  rows: readonly FunctionPlacedEntry[],
  includesStart: boolean
): { start: FunctionPlacedEntry[]; after: Map<number, FunctionPlacedEntry[]> } {
  const result = {
    start: [] as FunctionPlacedEntry[],
    after: new Map<number, FunctionPlacedEntry[]>()
  }
  const visible = new Set(visibleIndexes)
  for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
    if (row.anchor.kind === "start") {
      if (includesStart) result.start.push(row)
      continue
    }
    const anchor = row.anchor
    const candidates: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (m.role !== anchor.role) continue
      if (
        m.id === anchor.id ||
        (anchor.providerSourceId !== undefined &&
          m.provider_source_id === anchor.providerSourceId &&
          m.provider_occurrence === anchor.providerOccurrence)
      )
        candidates.push(i)
    }
    if (candidates.length !== 1 || !visible.has(candidates[0])) continue
    const entries = result.after.get(candidates[0]) ?? []
    entries.push(row)
    result.after.set(candidates[0], entries)
  }
  return result
}
