import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { writeFileSync } from "node:fs"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { composeModPrompt } from "../src/main/agent/mods-prompt-composition"
import { FunctionSession } from "../src/main/mods/v2/session"

const session = new FunctionSession([], {
  workspace: "/benchmark",
  threadId: "local",
  assertLive() {
    /* No native tools or credentials participate in this local benchmark. */
  },
  publish: async (value) => structuredClone(value)
})
const text = "P".repeat(32 * 1024)
const messages = [new SystemMessage(text), new HumanMessage("TASK")]
const facts = {
  model: "fixture",
  promptModel: "fixture",
  surfaces: ["desktop"],
  tools: [],
  outputStyle: null,
  traits: []
}
const times: number[] = []
async function main() {
  try {
    for (let index = 0; index < 72; index++) {
      const start = performance.now()
      const result = await composeModPrompt(
        messages,
        facts,
        new AbortController().signal,
        (event, input, signal, core) => session.promptComposition(event, input, signal, core),
        () => {
          /* The fixture has no runtime owner. */
        },
        [
          {
            id: "cmb:agents",
            scope: "session",
            text,
            context: {
              name: "claudeMd",
              instructionFiles: [{ path: "/benchmark/AGENTS.md", kind: "project", content: text }]
            }
          }
        ]
      )
      assert.equal(result.messages, messages)
      if (index >= 8) times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    const medianMs = times[Math.floor(times.length / 2)]
    const p95Ms = times[Math.floor(times.length * 0.95)]
    const report = {
      scope:
        "Local 32KiB native context and real FunctionSession publication, no network or filesystem latency",
      iterations: times.length,
      medianMs,
      p95Ms,
      preservedOriginalMessages: true
    }
    writeFileSync("output/mods-prompt-context-performance.json", JSON.stringify(report, null, 2))
    assert(medianMs < 25 && p95Ms < 75, JSON.stringify(report))
    console.log(JSON.stringify(report))
  } finally {
    await session.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
