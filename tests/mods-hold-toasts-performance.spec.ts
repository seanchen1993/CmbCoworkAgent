import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { writeFileSync } from "node:fs"
import { FunctionUiFeedback } from "../src/main/mods/v2/ui-feedback"
import { FunctionPresentationPublisher } from "../src/main/mods/v2/presentation-broker"
import { ChatTransientToasts } from "../src/renderer/src/lib/chat-transient-toasts"
import type { FunctionPresentationReport } from "../src/shared/mods/v2/presentation"

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
  }
}
async function main() {
  const native: number[] = [],
    engine: number[] = []
  for (let sample = 0; sample < 35; sample++) {
    const feedback = new FunctionUiFeedback(() => {}),
      publisher = new FunctionPresentationPublisher(),
      controller = new AbortController()
    let start = performance.now()
    try {
      for (let plugin = 0; plugin < 8; plugin++)
        for (let row = 0; row < 4; row++)
          feedback.set("plugin" + plugin, "ui.toast", {
            text: "Bounded presentation " + row,
            timeoutMs: 2000
          })
      const entries = feedback.snapshot(),
        ids = entries.map((row) => row.id)
      assert.equal(entries.length, 32)
      const publication = await publisher.publish(async () => ({
        entries,
        signal: controller.signal,
        assertLive: () => controller.signal.throwIfAborted(),
        present: (report) =>
          feedback.present(report.shown, report.hovered, report.dismissed, !report.present),
        pause: () => feedback.pause()
      }))
      const report = (sequence: number, present: boolean): FunctionPresentationReport => ({
        threadId: "sample",
        owner: "sample",
        receipt: publication.receipt!,
        sequence,
        present,
        panes: [],
        shown: present ? ids : [],
        hovered: [],
        dismissed: []
      })
      for (let sequence = 1; sequence <= 20; sequence++)
        publisher.report(report(sequence, sequence % 2 === 0))
      publisher.report({ ...report(21, false), dismissed: ids })
      assert.equal(feedback.snapshot().length, 0)
      if (sample >= 5) native.push(performance.now() - start)
    } finally {
      publisher.close()
      feedback.close()
    }
    let submitted = 0,
      dismissed = 0
    const queue = new ChatTransientToasts("sample", "sample", {
      show: (_kind, _text, options) => {
        submitted++
        return options.id!
      },
      dismiss: () => {
        dismissed++
      }
    })
    start = performance.now()
    try {
      for (let row = 0; row < 40; row++)
        queue.show("info", "Waiting " + row, { id: row, duration: 2000 })
      assert.equal(submitted, 0)
      assert.equal(queue.pending, 40)
      for (let i = 0; i < 20; i++) queue.present(true, i % 2 !== 0, true, false)
      queue.dismiss()
      assert.equal(queue.pending, 0)
      assert.equal(submitted, 1)
      assert.equal(dismissed, 1)
      if (sample >= 5) engine.push(performance.now() - start)
    } finally {
      queue.close()
    }
  }
  const result = {
    warmup: 5,
    samples: 30,
    native: stats(native),
    engine: stats(engine),
    scope:
      "Real native publisher/feedback bookkeeping (32 entries, 21 reports) and renderer queue (40 entries, 20 state transitions); no guest/IPC/DOM/model or OS paint timing"
  }
  writeFileSync("output/mods-hold-toasts-performance.json", JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result))
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
