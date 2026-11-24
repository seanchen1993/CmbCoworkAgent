// Adapted from ZCode's packages/ui/src/git-graph/layoutAlgorithm.ts (Copyright 2026 Z.AI Co., Ltd).
// Modified for incremental layout and viewport clipping. See resources/licenses/ZCode-Git-Graph.txt.
// Each block ends halfway between commits. Carry its open parent lanes into the
// next block so loading more history never moves an already drawn connection.
import type { GitGraphCommit } from "../../../../shared/git-graph"

export const dialogMaxHeight = 720
// Chromium clamps individual element heights. Leave the last viewport at native
// scale so every loaded row, including the last one, is reachable.
export const maxScrollHeight = 16_000_000
export function mapScrollPosition(y: number, fromHeight: number, toHeight: number): number {
  if (fromHeight === toHeight || y <= 0) return y
  return y + (toHeight - fromHeight) * Math.min(1, y / (fromHeight - dialogMaxHeight))
}

interface GraphPoint {
  laneIndex: number
  rowIndex: number
}

interface ParentLane {
  sourceHash: string
  targetHash: string
  colourIndex: number
}

export interface BranchLineSeed extends ParentLane {
  from: GraphPoint
  to: GraphPoint
}

type Lanes = readonly (ParentLane | null)[]

// For an octopus merge keep its many parent connections in compact lane pairs.
interface ParentFan {
  commit: GitGraphCommit
  row: number
  column: number
  targets: Int32Array
}

export async function layoutGitGraph(
  commits: readonly GitGraphCommit[],
  incoming: Lanes = [],
  existingTargets?: Map<string, number>,
  yieldIfBusy?: () => Promise<void> | undefined
) {
  const lanes = [...incoming]
  const starts: number[] = []
  const fans: ParentFan[] = []
  const lines: BranchLineSeed[] = []
  const laneByTarget = existingTargets ?? new Map<string, number>()
  if (!existingTargets) lanes.forEach((lane, column) => {
    if (lane) laneByTarget.set(lane.targetHash, column)
  })
  // Track the leftmost gap instead of rescanning all occupied lanes for each parent.
  const firstGap = lanes.indexOf(null)
  let freeColumn = firstGap < 0 ? lanes.length : firstGap
  let width = Math.max(1, lanes.length)

  function line(
    lane: ParentLane,
    fromColumn: number,
    fromRow: number,
    toColumn: number,
    toRow: number
  ) {
    if (fromRow === toRow && fromColumn === toColumn) return
    lines.push({
      ...lane,
      from: { laneIndex: fromColumn, rowIndex: fromRow },
      to: { laneIndex: toColumn, rowIndex: toRow }
    })
  }

  const rows: Array<{ commit: GitGraphCommit; column: number; colourIndex: number }> = []
  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row]
    const arriving = laneByTarget.get(commit.hash)
    const column = arriving === undefined ? freeColumn : Math.min(arriving, freeColumn)
    const colourIndex = arriving === undefined ? column : lanes[arriving]!.colourIndex
    width = Math.max(width, column + 1)
    if (arriving !== undefined) {
      const lane = lanes[arriving]!
      if (column !== arriving) {
        line(lane, arriving, starts[arriving] ?? -0.5, arriving, row - 0.5)
        starts[arriving] = row - 0.5
      }
      line(lane, arriving, starts[arriving] ?? -0.5, column, row)
      lanes[arriving] = null
      laneByTarget.delete(commit.hash)
      freeColumn = Math.min(freeColumn, arriving)
    }

    const fan = commit.parents.length > 64 ? new Int32Array(commit.parents.length * 2) : null
    if (fan) fans.push({ commit, column, row, targets: fan })
    for (let index = 0; index < commit.parents.length; index++) {
      if (index > 0 && index % 1024 === 0) {
        const pause = yieldIfBusy?.()
        if (pause) await pause
      }
      const parent = commit.parents[index]
      const existing = laneByTarget.get(parent)
      const target = existing ?? (index === 0 ? column : freeColumn)
      const edge = {
        sourceHash: commit.hash,
        targetHash: parent,
        colourIndex: lanes[target]?.colourIndex ?? (index === 0 ? colourIndex : target)
      }
      const connects = target !== column || existing !== undefined
      if (fan) {
        fan[index * 2] = connects ? target : -1
        fan[index * 2 + 1] = edge.colourIndex
      } else if (connects) line(edge, column, row, target, row + 0.5)
      if (existing === undefined) {
        lanes[target] = edge
        laneByTarget.set(parent, target)
        starts[target] = target === column ? row : row + 0.5
        if (target === freeColumn) {
          while (freeColumn < lanes.length && lanes[freeColumn] !== null) freeColumn++
        }
      }
    }
    while (lanes.length && lanes.at(-1) === null) lanes.pop()
    freeColumn = Math.min(freeColumn, lanes.length)
    width = Math.max(width, lanes.length)
    rows.push({ commit, column, colourIndex })
  }

  return { rows, lines, width, outgoing: lanes, starts, fans }
}

// Only materialize outgoing vertical strokes for the portion of the graph on screen.
export function visibleGraphLines(
  block: Awaited<ReturnType<typeof layoutGitGraph>>,
  firstLane = 0,
  lastLane = block.width - 1,
  relatedHash?: string,
  // Beyond these bounds the renderer clips identical offscreen strokes together.
  clip?: { first: number; last: number; colors: number }
): BranchLineSeed[] {
  const lines: BranchLineSeed[] = []
  for (const line of block.lines) {
    if (relatedHash && relatedHash !== line.sourceHash && relatedHash !== line.targetHash) continue
    if (Math.max(line.from.laneIndex, line.to.laneIndex) < firstLane ||
        Math.min(line.from.laneIndex, line.to.laneIndex) > lastLane) continue
    lines.push(line)
  }
  for (const { commit, column, row, targets } of block.fans) {
    const leftColors = new Set<number>()
    const rightColors = new Set<number>()
    for (let i = 0; i < commit.parents.length; i++) {
      const targetColumn = targets[i * 2]
      if (targetColumn < 0 || Math.max(column, targetColumn) < firstLane ||
          Math.min(column, targetColumn) > lastLane) continue
      const targetHash = commit.parents[i]
      if (relatedHash && relatedHash !== commit.hash && relatedHash !== targetHash) continue
      const colourIndex = targets[i * 2 + 1]
      if (clip && (targetColumn < clip.first || targetColumn > clip.last)) {
        const seen = targetColumn < clip.first ? leftColors : rightColors
        const color = colourIndex % clip.colors
        if (seen.has(color)) continue
        seen.add(color)
      }
      lines.push({
        sourceHash: commit.hash, targetHash, colourIndex,
        from: { laneIndex: column, rowIndex: row },
        to: { laneIndex: targetColumn, rowIndex: row + 0.5 }
      })
    }
  }
  const end = Math.min(lastLane + 1, block.outgoing.length)
  for (let column = Math.max(0, firstLane); column < end; column++) {
    const lane = block.outgoing[column]
    if (lane && block.starts[column] !== block.rows.length - 0.5 &&
        (!relatedHash || relatedHash === lane.sourceHash || relatedHash === lane.targetHash)) {
      lines.push({
        ...lane,
        from: { laneIndex: column, rowIndex: block.starts[column] ?? -0.5 },
        to: { laneIndex: column, rowIndex: block.rows.length - 0.5 }
      })
    }
  }
  return lines
}
