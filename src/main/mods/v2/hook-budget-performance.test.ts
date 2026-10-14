import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"

it("reads actual native budget snapshots without SDK calls and releases every invocation", async () => {
  const runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("command.run",($,e,next)=>{
      let left=0;for(let i=0;i<300;i++)left+=next.budget.remainingMs;
      return {ms:next.budget.ms,positive:left>0};
    });
  }}`)
  const samples: number[] = []
  let sdkCalls = 0
  try {
    for (let index = 0; index < 13; index++) {
      const start = performance.now()
      expect(
        await runtime.invoke(
          "0",
          {},
          async () => {
            sdkCalls++
            return {}
          },
          {
            event: "command.run",
            origin: { plugin: "engine", tier: "core" },
            plugin: { name: "budget-performance", root: "/budget-performance" },
            capabilities: [],
            ownBudgetMs: 10000
          }
        )
      ).toEqual({ value: { ms: 10000, positive: true } })
      if (index) samples.push(performance.now() - start)
      expect(runtime.stats).toMatchObject({ frames: 0, replies: 0 })
    }
    expect(sdkCalls).toBe(0)
    const ordered = [...samples].sort((a, b) => a - b)
    // Loose regression ceiling includes scheduling; this is not a product latency promise.
    expect(ordered.at(-1)).toBeLessThan(1000)
    await mkdir(resolve("output"), { recursive: true })
    await writeFile(
      resolve("output/mods-hook-budget-performance.json"),
      JSON.stringify(
        {
          scope:
            "Actual QuickJS native snapshots, 300 reads per invocation, 12 warm samples; no SDK/IPC/model/renderer",
          samples,
          medianMs: ordered[Math.floor(ordered.length / 2)],
          p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
          sdkCalls,
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
