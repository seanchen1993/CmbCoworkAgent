import { describe, expect, it } from "vitest"
import type { GitGraphCommit } from "../../../shared/git-graph"
import {
  dialogMaxHeight,
  layoutGitGraph,
  mapScrollPosition,
  maxScrollHeight,
  visibleGraphLines
} from "../components/git/git-graph-layout"

function commit(hash: string, ...parents: string[]): GitGraphCommit {
  return { hash, parents, author: "", timestamp: 0, subject: hash, refs: [] }
}

describe("commit graph lanes", () => {
  it("draws untouched parent lanes without keeping one segment per lane in every history block", async () => {
    const parents = Array.from({ length: 500 }, (_, index) => "tip-" + index)
    const merge = await layoutGitGraph([commit("merge", ...parents)])
    const block = await layoutGitGraph([commit("other", "root")], merge.outgoing)
    expect(block.lines.length).toBeLessThan(4)
    const drawn = visibleGraphLines(block)
    expect(drawn).toHaveLength(block.lines.length + block.outgoing.filter(Boolean).length)
    expect(drawn).toContainEqual({
      sourceHash: "merge",
      targetHash: "tip-499",
      colourIndex: 499,
      from: { laneIndex: 499, rowIndex: -0.5 },
      to: { laneIndex: 499, rowIndex: 0.5 }
    })
  })
  it("preserves the visible row across appends beyond Chromium's scroll height limit", () => {
    const logicalHeight = 800_000 * 42
    const nextHeight = logicalHeight + 50 * 42
    const end = maxScrollHeight - dialogMaxHeight
    expect(mapScrollPosition(end, maxScrollHeight, logicalHeight)).toBe(
      logicalHeight - dialogMaxHeight
    )
    for (const y of [0, 10_000, end - 100, end, end + 250]) {
      const anchor = mapScrollPosition(y, maxScrollHeight, logicalHeight)
      const afterAppend = mapScrollPosition(anchor, nextHeight, maxScrollHeight)
      expect(mapScrollPosition(afterAppend, maxScrollHeight, nextHeight)).toBeCloseTo(anchor, 5)
    }
    expect(mapScrollPosition(3500, 4200, 4200)).toBe(3500)
  })
  it("connects both sides of a merge, including across a load boundary", async () => {
    const history = [
      commit("merge", "a", "b"),
      commit("a", "root"),
      commit("b", "root"),
      commit("root")
    ]
    const whole = await layoutGitGraph(history)
    const first = await layoutGitGraph(history.slice(0, 2))
    const second = await layoutGitGraph(history.slice(2), first.outgoing)
    expect(whole.width).toBe(2)
    expect([...first.rows, ...second.rows]).toEqual(whole.rows)
    expect(whole.rows.map((row) => row.column)).toEqual([0, 0, 1, 0])
    expect(second.outgoing).toEqual([])
    const edges = new Set(
      [...visibleGraphLines(first), ...visibleGraphLines(second)].map(
        (line) => line.sourceHash + " -> " + line.targetHash
      )
    )
    expect(edges).toEqual(new Set(["merge -> a", "merge -> b", "a -> root", "b -> root"]))
    first.outgoing.forEach((lane, column) => {
      if (!lane) return
      expect(visibleGraphLines(first)).toContainEqual(
        expect.objectContaining({ ...lane, to: { laneIndex: column, rowIndex: 1.5 } })
      )
      expect(visibleGraphLines(second)).toContainEqual(
        expect.objectContaining({ ...lane, from: { laneIndex: column, rowIndex: -0.5 } })
      )
    })
  })

  it("gives unrelated roots no edges and keeps colours when a lane moves", async () => {
    expect((await layoutGitGraph([commit("a"), commit("b")])).lines).toEqual([])
    const graph = await layoutGitGraph([
      commit("a", "root-a"),
      commit("b", "root-b"),
      commit("root-a"),
      commit("root-b")
    ])
    expect(graph.rows[1]).toMatchObject({ column: 1, colourIndex: 1 })
    expect(graph.rows[3]).toMatchObject({ column: 0, colourIndex: 1 })
    expect(graph.lines.filter((line) => line.sourceHash === "a")).toMatchObject([
      { from: { rowIndex: 0 }, to: { rowIndex: 2 } }
    ])
  })

  it("carries wide merges across blocks and reuses vacated lanes without changing edge colours", async () => {
    const parents = Array.from({ length: 64 }, (_, index) => `parent-${index}`)
    const first = await layoutGitGraph([commit("merge", ...parents)])
    expect(first.outgoing.map((lane) => lane?.targetHash)).toEqual(parents)

    const second = await layoutGitGraph(
      [commit(parents[0]), commit(parents[2]), commit("unrelated", "older")],
      first.outgoing
    )
    expect(second.rows.map(({ column, colourIndex }) => [column, colourIndex])).toEqual([
      [0, 0],
      [0, 2],
      [0, 0]
    ])
    expect(second.outgoing[0]?.targetHash).toBe("older")
    expect(second.outgoing[2]).toBeNull()
    expect(visibleGraphLines(second)).toContainEqual({
      sourceHash: "merge",
      targetHash: parents[63],
      colourIndex: 63,
      from: { laneIndex: 63, rowIndex: -0.5 },
      to: { laneIndex: 63, rowIndex: 2.5 }
    })
  })

  it("yields inside a large merge and keeps clipped and highlighted edges continuous", async () => {
    const parents = Array.from({ length: 4_000 }, (_, index) => `parent-${index}`)
    const targets = new Map<string, number>()
    let resume = () => {}
    const pause = new Promise<void>((resolve) => { resume = resolve })
    const layout = layoutGitGraph([commit("merge", ...parents)], [], targets, () => pause)
    expect(targets.size).toBeGreaterThan(0)
    expect(targets.size).toBeLessThan(parents.length)
    resume()
    const first = await layout
    expect(first.outgoing.map((lane) => lane?.targetHash)).toEqual(parents)

    const clip = { first: 1_980, last: 2_040, colors: 4 }
    expect(visibleGraphLines(first, 2_000, 2_020, "merge", clip)).toHaveLength(45)
    expect(visibleGraphLines(first, 2_000, 2_020, parents[3_998], clip)).toEqual([
      {
        sourceHash: "merge",
        targetHash: parents[3_998],
        colourIndex: 3_998,
        from: { laneIndex: 0, rowIndex: 0 },
        to: { laneIndex: 3_998, rowIndex: 0.5 }
      }
    ])

    const second = await layoutGitGraph([commit(parents[0])], first.outgoing, targets)
    expect(targets.has(parents[0])).toBe(false)
    expect(visibleGraphLines(second, 2_000, 2_020, parents[2_000], clip)).toEqual([
      {
        sourceHash: "merge",
        targetHash: parents[2_000],
        colourIndex: 2_000,
        from: { laneIndex: 2_000, rowIndex: -0.5 },
        to: { laneIndex: 2_000, rowIndex: 0.5 }
      }
    ])
  })

  it("stops processing a large merge when a yield rejects", async () => {
    const parents = Array.from({ length: 4_000 }, (_, index) => `parent-${index}`)
    const targets = new Map<string, number>()
    const reason = new Error("Cancelled graph layout")
    const layout = layoutGitGraph([commit("merge", ...parents)], [], targets, () => Promise.reject(reason))
    const beforeCancel = targets.size
    await expect(layout).rejects.toBe(reason)
    expect(targets.size).toBe(beforeCancel)
    expect(targets.has(parents.at(-1)!)).toBe(false)
  })
})
