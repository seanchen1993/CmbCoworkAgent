import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { clampPromptDecorationGraphemes } from "../src/renderer/src/lib/prompt-decoration"
import { cumulativePromptEdit } from "../src/shared/mods/v2/prompt-edit"

const text = "abc中文👩‍💻\n".repeat(4000).slice(0, 16000)
const spans = Array.from({ length: 256 }, (_, index) => ({
  start: index * 40,
  end: index * 40 + 12,
  bold: true
}))
const sample = (run: () => void) => {
  const times = Array.from({ length: 50 }, () => {
    const start = performance.now()
    run()
    return performance.now() - start
  }).sort((left, right) => left - right)
  return { medianMs: times[25], p95Ms: times[47], maxMs: times[49] }
}
const decoration = sample(() => {
  assert.equal(clampPromptDecorationGraphemes(text, spans).length, 256)
})
const cumulative = sample(() => {
  assert.equal(
    cumulativePromptEdit(
      { text, cursor: text.length },
      { text: text + "新", cursor: text.length + 1 }
    ).inputText,
    "新"
  )
})
const result = {
  scope:
    "Local UTF-16 draft reconciliation and 256 decorations over 16k characters; no IPC, VM, disk or network",
  decoration,
  cumulative
}
writeFileSync("output/mods-prompt-editor-performance.json", JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
