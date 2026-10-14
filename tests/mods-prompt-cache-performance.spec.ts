import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { writeFileSync } from "node:fs"
import { FunctionGuestRuntime } from "../src/main/mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../src/main/mods/v2/session"
import { bindHostPromptOccurrence } from "../src/main/mods/v2/prompt-cache"
import { ModRuntimeAuthorities } from "../src/main/mods/runtime-instance"
import { withFunctionAgentExecution } from "../src/main/mods/v2/host-call"
import type { ModObject } from "../src/shared/mods/types"

async function main() {
  const registry = new ModRuntimeAuthorities()
  const { authority } = registry.create({ workspace: "/benchmark", threadId: "t", turnId: "turn" })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let count=0;
    on("prompt.context",async($,e,next)=>{
      const result=await next(e);return {...result,blocks:[...result.blocks,{name:"count",text:String(++count)}]}
    })
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "benchmark",
        root: "/fixture",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/benchmark",
      threadId: "t",
      assertLive() {
        /* Local-only fixture uses a real runtime authority below. */
      },
      publish: async (value) => structuredClone(value)
    }
  )
  const input: ModObject = { blocks: [{ name: "claudeMd", text: "P".repeat(32 * 1024) }] }
  const sample = async (source: object) =>
    withFunctionAgentExecution(
      {
        workspace: "/benchmark",
        threadId: "t",
        turnId: "turn",
        agentId: "main",
        runtimeAuthority: authority,
        userInitiated: false,
        leased: false,
        immediate: false
      },
      () =>
        session.promptComposition(
          "prompt.context",
          input,
          new AbortController().signal,
          bindHostPromptOccurrence(async (value) => value, "prompt.context", source)
        )
    )
  const percentile = (times: number[], fraction: number) => {
    times.sort((a, b) => a - b)
    return times[Math.floor(times.length * fraction)]
  }
  try {
    const source = {}
    const warm = await sample(source)
    const hits: number[] = [],
      cold: number[] = []
    for (let index = 0; index < 64; index++) {
      let start = performance.now()
      assert.deepEqual(await sample(source), warm)
      hits.push(performance.now() - start)
      start = performance.now()
      await sample({})
      cold.push(performance.now() - start)
    }
    assert.deepEqual(await sample(source), warm)
    const report = {
      scope: "32KiB real Session, one QuickJS hook and actual runtime owner; no network",
      iterations: 64,
      warmMedianMs: percentile(hits, 0.5),
      warmP95Ms: percentile(hits, 0.95),
      coldMedianMs: percentile(cold, 0.5),
      coldP95Ms: percentile(cold, 0.95),
      warmAdditionalHookExecutions: 0,
      coldIndependentOccurrences: 64
    }
    writeFileSync("output/mods-prompt-cache-performance.json", JSON.stringify(report, null, 2))
    assert(report.warmMedianMs < 25 && report.warmP95Ms < 75, JSON.stringify(report))
    console.log(JSON.stringify(report))
  } finally {
    await session.close()
    registry.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
