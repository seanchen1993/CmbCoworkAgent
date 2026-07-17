import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const appSource = readFileSync(join(process.cwd(), "src/renderer/src/App.tsx"), "utf8")

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  assert(startIndex >= 0, `missing start marker: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert(endIndex >= 0, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

assert(
  appSource.includes('const chatThreadId = mainView === "harness" ? previousThreadId : currentThreadId'),
  "project mode must retain the previous chat thread id"
)

const persistentModeShell = between(
  appSource,
  ') : mainView === "thread" || mainView === "harness" ? (',
  ') : mainView === "kanban" ? ('
)

assert.equal(
  (persistentModeShell.match(/<ThreadSidebar \/>/g) ?? []).length,
  1,
  "chat and project modes must share one sidebar instance"
)
assert(
  persistentModeShell.includes('mainView === "thread"') &&
    persistentModeShell.includes(': "hidden"'),
  "chat workspace must be hidden instead of conditionally unmounted in project mode"
)
assert(
  (persistentModeShell.match(/threadId=\{chatThreadId\}/g) ?? []).length >= 2,
  "chat workspace must keep using the retained chat thread id"
)
assert(
  persistentModeShell.includes('{mainView === "harness" && ('),
  "project board must render beside the retained chat workspace"
)

console.log("app mode keep-alive checks passed")
