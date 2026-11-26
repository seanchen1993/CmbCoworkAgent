import { formatLineRanges } from "./commit-file-agent-lines"
import type { LocalGeneratedLineDetail } from "../../shared/adoption-trace-types"

export interface OwnershipLine extends LocalGeneratedLineDetail {
  sourceLine?: number
  transferredTo?: string
}

export interface SourceDetails {
  sha: string
  lines: OwnershipLine[]
}

// Keep the ambiguous marker even when later occurrences agree with one of the candidates.
function addUnique<K, V>(map: Map<K, V | null>, key: K, value: V): void {
  if (!map.has(key)) map.set(key, value)
  else if (map.get(key) !== value) map.set(key, null)
}

// A repeated brace or statement can be placed when an adjacent, uniquely
// positioned generation line fixes its location in the actual source patch.
export function sourcePosition(
  lines: OwnershipLine[],
  index: number,
  added: Map<number, string>,
  unique: Map<string, number>
): number | undefined {
  const text = lines[index].text
  const pos = unique.get(text)
  if (pos) return pos
  let located: number | undefined
  for (const step of [-1, 1]) {
    const neighbor = lines[index + step]
    if (neighbor?.status !== "adopted") continue
    const anchor = unique.get(neighbor.text)
    if (!anchor || added.get(anchor - step) !== text) continue
    if (located && located !== anchor - step) return undefined
    located = anchor - step
  }
  return located
}

// Imports and trivial returns occur independently in sibling branches.
const BOILERPLATE =
  /^\s*(?:(?:import|package|using|from|#include)\b|(?:return\s+)?(?:true|false|null|undefined|none|nil|0|1)\s*;?\s*$)/i

// One unique substantive anchor plus an adjacent exact line at the same offset.
// Proposals must be one-to-one in both directions, even across overlapping blocks.
export function matchAddedLines(
  sources: SourceDetails[],
  added: Map<number, string>,
  occupied: Set<number>
): Map<OwnershipLine, number> {
  const anchors = new Map<string, OwnershipLine | null>()
  const groups = new Map<string, Map<number, OwnershipLine | null>>()
  const neighbors = new Map<OwnershipLine, Map<number, OwnershipLine | null>>()
  for (const source of sources) {
    const positions = groups.get(source.sha) ?? new Map<number, OwnershipLine | null>()
    groups.set(source.sha, positions)
    for (const line of source.lines) {
      if (line.sourceLine === undefined) continue
      addUnique(anchors, line.text, line)
      addUnique(positions, line.sourceLine, line)
      neighbors.set(line, positions)
    }
  }
  const targets = new Map<string, number | null>()
  for (const [pos, text] of added) addUnique(targets, text, pos)
  const from = new Map<OwnershipLine, number | null>()
  const to = new Map<number, OwnershipLine | null>()
  for (const [text, pos] of targets) {
    const anchor = anchors.get(text)
    if (
      !pos ||
      occupied.has(pos) ||
      !anchor ||
      anchor.transferredTo ||
      BOILERPLATE.test(text) ||
      !/[\p{L}\p{N}_]{3}/u.test(text)
    )
      continue
    const positions = neighbors.get(anchor)!
    if (positions.get(anchor.sourceLine!) !== anchor) continue
    for (const step of [-1, 1]) {
      const line = positions.get(anchor.sourceLine! + step)
      if (
        !line ||
        line.transferredTo ||
        occupied.has(pos + step) ||
        added.get(pos + step) !== line.text
      )
        continue
      addUnique(from, anchor, pos)
      addUnique(to, pos, anchor)
      addUnique(from, line, pos + step)
      addUnique(to, pos + step, line)
    }
  }
  const matches = new Map<OwnershipLine, number>()
  for (const [line, pos] of from) if (pos && to.get(pos) === line) matches.set(line, pos)
  return matches
}

export function linePositions(ranges: unknown, truncated: unknown): Set<number> | null {
  if (truncated || !Array.isArray(ranges)) return null
  const positions = new Set<number>()
  for (const item of ranges) {
    const match = /^(\d+)-(\d+)$/.exec(String(item))
    if (!match) return null
    const start = Number(match[1]),
      end = Number(match[2])
    if (start < 1 || end < start || end - start + positions.size >= 20_000) return null
    for (let line = start; line <= end; line++) positions.add(line)
  }
  return positions
}

export function adjustCounts(props: Record<string, unknown>, delta: number): void {
  for (const key of [
    "generatedLineCount",
    "effectiveGeneratedLineCount",
    "adoptedLineCount",
    "agentLineCount"
  ]) {
    if (typeof props[key] === "number") {
      const value = props[key] + delta
      if (value < 0) throw new Error("Invalid transfer balance")
      props[key] = value
    }
  }
}

export function setPositions(props: Record<string, unknown>, positions: Set<number>): void {
  const { ranges, truncated } = formatLineRanges([...positions].sort((a, b) => a - b))
  props.agentLineRanges = ranges
  props.agentLineRangesTruncated = truncated
}
