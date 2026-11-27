import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { transformSync } from "esbuild"
import { beforeAll, describe, expect, it } from "vitest"
import { virtuosoResizeAnchor } from "../../../scripts/vite-virtuoso-resize-anchor"

type Signal = unknown
type System = Record<string, Signal>
type Internals = {
  bo(system: unknown): System
  oo: unknown
  M<T>(signal: Signal, value: T): void
  Y<T>(signal: Signal, receive: (value: T) => void): void
}
type SizeRange = { startIndex: number; endIndex: number; size: number }
type ScrollMeasurement = { top: number; height: number; viewport?: number }

function size(index: number, height: number): SizeRange {
  return { startIndex: index, endIndex: index, size: height }
}

describe("Virtuoso upward resize anchoring", () => {
  let internals: Internals

  beforeAll(() => {
    const require = createRequire(import.meta.url)
    const path = join(dirname(require.resolve("react-virtuoso")), "index.mjs")
    const transform = virtuosoResizeAnchor().transform as (
      source: string,
      id: string
    ) => { code: string }
    const { code } = transform(readFileSync(path, "utf8"), path)
    // Use the real renderer transform and Virtuoso's own streams without a DOM.
    const commonJs = transformSync(`${code}\nexport { bo, oo, M, Y };`, { format: "cjs" }).code
    const module = { exports: {} }
    new Function("module", "exports", "require", commonJs)(module, module.exports, require)
    internals = module.exports as Internals
  })

  function measure(
    ranges: SizeRange[],
    {
      anchor = true,
      top = 840,
      header = 0,
      overscan = 0,
      scroll = "up",
      scrollMeasurements = []
    }: {
      anchor?: boolean
      top?: number
      header?: number
      overscan?: number
      scroll?: "up" | "down" | "navigation"
      scrollMeasurements?: ScrollMeasurement[]
    } = {}
  ): number[] {
    const { bo, oo, M, Y } = internals
    const list = bo(oo)
    const writes: number[] = []
    Y<{ top: number }>(list.scrollBy, (options) => writes.push(options.top))
    M(list.context, { anchorUpwardResize: anchor })
    M(list.headerHeight, header)
    M(list.defaultItemHeight, 100)
    M(list.increaseViewportBy, overscan)
    M(
      list.data,
      Array.from({ length: 60 }, (_, index) => index)
    )
    M(list.viewportHeight, 400)
    M(list.didMount, true)
    const move = (scrollTop: number) => {
      M(list.scrollContainerState, { scrollTop, scrollHeight: 6_000 + header, viewportHeight: 400 })
    }
    move(top + (scroll === "down" ? -60 : 60))
    move(top)
    if (scroll === "navigation") M(list.scrollingInProgress, true)
    for (const measurement of scrollMeasurements) {
      M(list.scrollContainerState, {
        scrollTop: measurement.top,
        scrollHeight: measurement.height,
        viewportHeight: measurement.viewport ?? 400
      })
    }
    M(list.sizeRanges, ranges)
    return writes
  }

  it("keeps the reading position when a row grows during an upward scroll from the tail", () => {
    const { bo, oo, M, Y } = internals
    const list = bo(oo)
    const rows = Array.from({ length: 8 }, (_, index) => index)
    const writes: number[] = []
    Y<{ top: number }>(list.scrollTo, ({ top }) => writes.push(top))
    M(list.followOutput, false)
    M(list.defaultItemHeight, 100)
    M(list.data, rows)
    M(list.viewportHeight, 400)
    M(list.didMount, true)
    M(list.propsReady, true)
    M(list.scrollContainerState, { scrollTop: 400, scrollHeight: 800, viewportHeight: 400 })

    // A same-length renderer update precedes the next measurement of the image row.
    M(list.data, [...rows])
    M(list.propsReady, false)
    M(list.propsReady, true)
    writes.length = 0
    M(list.scrollContainerState, { scrollTop: 0, scrollHeight: 900, viewportHeight: 400 })
    expect(writes).toEqual([])
  })

  it("ignores rows growing below the reading position", () => {
    expect(measure([size(15, 275)])).toEqual([])
  })

  it("only includes preceding rows in a mixed resize batch", () => {
    expect(measure([size(7, 156), size(15, 275)])).toEqual([56])
    expect(measure([size(7, 156), size(15, 44)])).toEqual([56])
    expect(measure([size(7, 60)])).toEqual([-40])
  })

  it("uses viewport coordinates and can measure an anchor outside the next mounted range", () => {
    expect(measure([size(7, 156), size(9, 275)], { header: 200, top: 1_040 })).toEqual([56])
    expect(measure([size(2, 156), size(7, 275)], { top: 400, overscan: 600 })).toEqual([56])
    expect(measure([size(7, 1_100)])).toEqual([1_000])
  })

  it("only makes up the part of a shrink that the native clamp did not already apply", () => {
    const options = { top: 5_580, scrollMeasurements: [{ top: 5_520, height: 5_920 }] }
    expect(measure([size(52, 20)], options)).toEqual([-20])
    expect(measure([size(59, 20)], options)).toEqual([])
    expect(measure([size(59, 220)], options)).toEqual([])
  })

  it("discards a previous resize jump if the reader leaves and returns to the same offset", () => {
    expect(
      measure([size(54, 120), size(59, 10)], {
        top: 5_580,
        scrollMeasurements: [
          { top: 5_460, height: 5_860 },
          { top: 5_460, height: 5_860, viewport: 350 },
          { top: 5_480, height: 5_860, viewport: 350 },
          { top: 5_460, height: 5_860, viewport: 350 }
        ]
      })
    ).toEqual([])
  })

  it("discards a previous resize jump when the native viewport changes at the same offset", () => {
    expect(
      measure([size(54, 120), size(59, 10)], {
        top: 5_580,
        scrollMeasurements: [
          { top: 5_460, height: 5_860 },
          { top: 5_460, height: 5_860, viewport: 350 }
        ]
      })
    ).toEqual([])
  })

  it("preserves navigation and the existing behavior of lists that do not opt in", () => {
    const mixed = [size(7, 156), size(15, 275)]
    expect(measure(mixed, { scroll: "navigation" })).toEqual([])
    expect(measure(mixed, { scroll: "down" })).toEqual([])
    expect(measure(mixed, { anchor: false })).toEqual([231])
  })
})
