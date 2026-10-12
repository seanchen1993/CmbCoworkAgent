import { afterEach, expect, it, vi } from "vitest"
import { searchBotProject } from "./project-search"

afterEach(() => vi.restoreAllMocks())
const MiB = 1024 * 1024
const paths = (count: number) => Array.from({ length: count }, (_, index) => `${index}.ts`)

it("bounds active reads and keeps source order when reads finish in reverse order", async () => {
  const pending = new Map<string, (value: { text: string; bytes: number }) => void>()
  let active = 0,
    peak = 0
  const read = vi.fn(async (path: string) => {
    peak = Math.max(peak, ++active)
    try {
      return await new Promise<{ text: string; bytes: number }>((resolve) =>
        pending.set(path, resolve)
      )
    } finally {
      active--
    }
  })
  const scan = searchBotProject(paths(9), "needle", read, () => {})
  expect([...pending.keys()]).toEqual(paths(4))
  for (const path of paths(4).reverse()) pending.get(path)!({ text: `needle ${path}`, bytes: 16 })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(8))
  for (const path of paths(8).slice(4).reverse())
    pending.get(path)!({ text: `needle ${path}`, bytes: 16 })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(9))
  pending.get("8.ts")!({ text: "needle 8.ts", bytes: 16 })
  expect((await scan).matches.map((match) => match.path)).toEqual(paths(9))
  expect(peak).toBe(4)
  expect(active).toBe(0)
})

it("drains the current batch before cancellation returns and never opens the next batch", async () => {
  let cancelled = false,
    finished = false
  const pending: ((value: { text: string; bytes: number }) => void)[] = []
  const read = vi.fn(
    () => new Promise<{ text: string; bytes: number }>((resolve) => pending.push(resolve))
  )
  const scan = searchBotProject(paths(20), "needle", read, () => {
    if (cancelled) throw new Error("CANCELLED")
  })
  const outcome = scan
    .then(
      () => "success",
      (error: Error) => error.message
    )
    .finally(() => {
      finished = true
    })
  expect(read).toHaveBeenCalledTimes(4)
  cancelled = true
  for (const resolve of pending.slice(0, 3)) resolve({ text: "needle", bytes: 6 })
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).toBe(false)
  pending[3]({ text: "needle", bytes: 6 })
  expect(await outcome).toBe("CANCELLED")
  expect(read).toHaveBeenCalledTimes(4)
})

it("reserves byte capacity before launching a batch, including the final partial file", async () => {
  const limits: number[] = []
  const sizes = [2, 2, 2, 1.5, 2, 2, 2, 2, 0.5].map((value) => value * MiB)
  const read = vi.fn(async (_path: string, maxBytes: number) => {
    limits.push(maxBytes)
    const bytes = sizes[limits.length - 1]
    expect(bytes).toBeLessThanOrEqual(maxBytes)
    return { text: "needle", bytes }
  })
  expect(await searchBotProject(paths(100), "needle", read, () => {})).toMatchObject({
    scannedFiles: 9,
    skippedFiles: 0,
    incomplete: true,
    stoppedReason: "bytes"
  })
  expect(limits).toEqual([...Array(8).fill(2 * MiB), 0.5 * MiB])
  expect(sizes.reduce((sum, value) => sum + value, 0)).toBe(16 * MiB)
})

it("counts actual bounded reads, rejects no-match claims on unreadable files and stops at 1000 files", async () => {
  const read = vi.fn(async (path: string) => {
    if (path === "2.ts") throw new Error("unreadable")
    return { text: "", bytes: 0 }
  })
  expect(await searchBotProject(paths(1001), "needle", read, () => {})).toEqual({
    matches: [],
    scannedFiles: 1000,
    skippedFiles: 1,
    incomplete: true,
    stoppedReason: "files"
  })
  expect(read).toHaveBeenCalledTimes(1000)
})

it("returns bounded matches without starting more batches", async () => {
  const read = vi.fn(async () => ({ text: "needle\n".repeat(201), bytes: 1407 }))
  const result = await searchBotProject(paths(100), "needle", read, () => {})
  expect(result).toMatchObject({ scannedFiles: 4, incomplete: true, stoppedReason: "matches" })
  expect(result.matches).toHaveLength(200)
  expect(result.matches.every((item) => item.path === "0.ts")).toBe(true)
  expect(read).toHaveBeenCalledTimes(4)
})

it("honors the original scan deadline and launches no more work after an in-flight batch", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(0)
  const read = vi.fn(async () => {
    now.mockReturnValue(10_001)
    return { text: "needle", bytes: 6 }
  })
  expect(await searchBotProject(paths(100), "needle", read, () => {}, 10_000)).toMatchObject({
    matches: [],
    scannedFiles: 4,
    incomplete: true,
    stoppedReason: "time"
  })
  expect(read).toHaveBeenCalledTimes(4)
  read.mockClear()
  expect(await searchBotProject(paths(100), "needle", read, () => {}, 10_000)).toMatchObject({
    scannedFiles: 0,
    incomplete: true,
    stoppedReason: "time"
  })
  expect(read).not.toHaveBeenCalled()
})
