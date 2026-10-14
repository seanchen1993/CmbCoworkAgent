import { mkdirSync, writeFileSync } from "node:fs"
import { expect, it } from "vitest"
import { FunctionPluginPromptQueue } from "./plugin-prompt-queue"

it.skipIf(process.env.CMB_MODS_QUEUE_PERF !== "1")(
  "measures isolated host queue admission and real cleanup, without model or IPC substitutes in the timing claim",
  async () => {
    const batch = async () => {
      let ended = 0,
        busy = true,
        runs = 0
      const complete = Promise.withResolvers<void>()
      let idle!: (thread: string) => void
      const queue = new FunctionPluginPromptQueue({
        busy: () => busy,
        claim: () => ({
          assertCurrent: () => {},
          release: () => {
            if (++ended === 8) complete.resolve()
          }
        }),
        run: async (_, __, ___, ____, _____, started) => {
          runs++
          started()
        },
        onIdle: (listener) => {
          idle = listener
          return () => {}
        }
      })
      const origin = { kind: "plugin" as const, name: "actual" }
      const start = performance.now()
      try {
        const pending = Array.from({ length: 8 }, (_, index) => {
          const ticket = queue.reserve({
            workspace: "project",
            threadId: "thread",
            origin,
            signal: new AbortController().signal,
            assertLive: () => {}
          })
          ticket.accept({ text: `words-${index}`, origin, wait: false })
          ticket.finish({ text: `words-${index}`, origin })
          return ticket.wait()
        })
        await Promise.resolve()
        expect(runs).toBe(0)
        busy = false
        idle("thread")
        await complete.promise
        await Promise.all(pending)
        const elapsed = performance.now() - start
        expect(runs).toBe(8)
        expect(queue.size).toBe(0)
        return elapsed
      } finally {
        queue.close()
      }
    }
    for (let index = 0; index < 30; index++) await batch()
    const samples: number[] = []
    for (let index = 0; index < 50; index++) samples.push(await batch())
    const sorted = [...samples].sort((a, b) => a - b)
    const report = {
      scope:
        "Eight in-memory admissions plus host AsyncResource dispatch and lease cleanup; host run is a test stub. Excludes SQLite, guest compilation/hooks, IPC, renderer and model/network.",
      warmups: 30,
      samples,
      medianMs: sorted[25],
      p95Ms: sorted[47],
      maximumMs: sorted.at(-1),
      retainedEntries: 0,
      busyNativeRuns: 0
    }
    mkdirSync("output", { recursive: true })
    writeFileSync(
      "output/mods-plugin-prompt-queue-performance.json",
      JSON.stringify(report, null, 2)
    )
    console.log(JSON.stringify(report))
  }
)
