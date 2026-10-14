import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionSessionActivity } from "./session-activity"

it("retains bounded callback activity and measures actual successful and failed VM entries", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"start",description:"start"});return next(e)
    });
    on("command.run",$=>{
      let n=0;const timer=$.clock.every(5,()=>{
        if(++n===24){timer.cancel();return}
        if(n%2)throw new Error("ordinary failure")
      });return {}
    });
  }}`)
  const activity = new FunctionSessionActivity()
  const session = new FunctionSession(
    [
      {
        name: "timer-performance",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "performance",
      activity,
      assertLive() {
        // The fixture retains its actual grant until session teardown.
      },
      publish: async (value) => value
    }
  )
  const records: Array<{ outcome: "success" | "failed"; durationMs: number }> = []
  const nativeInvoke = guest.invoke.bind(guest)
  vi.spyOn(guest, "invoke").mockImplementation(async (...args) => {
    const start = performance.now()
    let outcome: "success" | "failed" = "success"
    try {
      return await nativeInvoke(...args)
    } catch (error) {
      outcome = "failed"
      throw error
    } finally {
      if (args[0] === "resource") records.push({ outcome, durationMs: performance.now() - start })
    }
  })
  try {
    await session.run("start", "")
    await vi.waitFor(() => expect(records).toHaveLength(24), { timeout: 5000 })
    await vi.waitFor(() => expect(activity.size).toBe(0))
    expect(records.filter((row) => row.outcome === "failed")).toHaveLength(12)
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
    const samples = records.slice(2)
    const summary = (outcome: "success" | "failed") => {
      const times = samples
        .filter((row) => row.outcome === outcome)
        .map((row) => row.durationMs)
        .sort((a, b) => a - b)
      return {
        samples: times.length,
        medianMs: times[Math.floor(times.length / 2)],
        p95Ms: times[Math.ceil(times.length * 0.95) - 1]
      }
    }
    await writeFile(
      resolve("output/mods-timer-recovery-performance.json"),
      JSON.stringify(
        {
          scope:
            "Actual native QuickJS timer callback invocation; 24 periods with alternating failures, first two excluded from latency summary; no IPC, model, network, renderer or wall-cadence assertion",
          success: summary("success"),
          failed: summary("failed"),
          records,
          residual: {
            activity: activity.size,
            frames: guest.stats.frames,
            replies: guest.stats.replies
          }
        },
        null,
        2
      ) + "\n"
    )
  } finally {
    await session.close()
  }
})
