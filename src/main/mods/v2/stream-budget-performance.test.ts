import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { dispatchFunctionStream } from "./stream-dispatcher"
import { dispatchFunctionPullStream } from "./pull-stream-dispatcher"

it("delivers bounded native chunks with actual QuickJS receipts and releases all frames", async () => {
  const runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,e,next){return yield* next(e)});
    on("process.spawn",async function*($,e,next){return yield* next(e)});
  }}`)
  const results: Array<{ event: string; totalMs: number[]; firstMs: number[]; providers: number }> =
    []
  try {
    for (const event of ["turn.step", "process.spawn"]) {
      const record = { event, totalMs: [] as number[], firstMs: [] as number[], providers: 0 }
      for (let sample = 0; sample < 5; sample++) {
        let produced = 0,
          consumed = 0,
          maxAhead = 0
        const options = {
          core: async function* () {
            record.providers++
            for (let index = 0; index < 100; index++) {
              produced++
              maxAhead = Math.max(maxAhead, produced - consumed)
              yield { index, text: "x".repeat(128) }
            }
            return { code: 0 }
          }
        }
        const plugins = [
          {
            name: "stream-performance",
            root: "/stream-performance",
            tier: "user" as const,
            guest: runtime,
            capabilities: []
          }
        ]
        const start = performance.now()
        const stream =
          event === "turn.step"
            ? dispatchFunctionStream(plugins, {}, options)
            : dispatchFunctionPullStream(plugins, {}, options)
        for await (const chunk of stream) {
          if (!consumed && sample) record.firstMs.push(performance.now() - start)
          expect(chunk).toEqual({ index: consumed++, text: "x".repeat(128) })
        }
        if (sample) record.totalMs.push(performance.now() - start)
        expect(consumed).toBe(100)
        expect(maxAhead).toBeLessThanOrEqual(1)
        expect(await stream.result).toEqual({ code: 0 })
        expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
      }
      expect(record.providers).toBe(5)
      expect(Math.max(...record.totalMs)).toBeLessThan(5000)
      results.push(record)
    }
    await mkdir(resolve("output"), { recursive: true })
    await writeFile(
      resolve("output/mods-stream-budget-performance.json"),
      JSON.stringify(
        {
          scope:
            "Native QuickJS, one actual provider per 100 x 128-byte chunks; 4 warm samples per event, max one unpublished native chunk; no IPC/renderer/network",
          results,
          frames: runtime.stats.frames,
          replies: runtime.stats.replies
        },
        null,
        2
      )
    )
  } finally {
    runtime.dispose()
  }
})
