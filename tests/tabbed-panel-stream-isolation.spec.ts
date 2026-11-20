import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const readSource = (path: string): string =>
  readFileSync(resolve(__dirname, `../${path}`), "utf8").replace(/\r\n/g, "\n")

const tabbedPanel = readSource("src/renderer/src/components/tabs/TabbedPanel.tsx")
const tabBar = readSource("src/renderer/src/components/tabs/TabBar.tsx")
const fileViewer = readSource("src/renderer/src/components/tabs/FileViewer.tsx")

for (const [name, source] of [
  ["TabbedPanel", tabbedPanel],
  ["TabBar", tabBar],
  ["FileViewer", fileViewer]
] as const) {
  assert.doesNotMatch(
    source,
    /use(?:CurrentThread|ThreadState)\(/,
    `${name} must not subscribe to the complete token-updated ThreadState`
  )
  assert.match(
    source,
    /useThreadStateSelector\(/,
    `${name} must subscribe only to fields that affect its rendered output`
  )
}

assert.match(fileViewer, /state\.fileContents\[cacheKey\]/)
assert.match(fileViewer, /useThreadActions\(threadId \?\? null\)\?\.setFileContents/)

console.log("tabbed panel stream isolation contracts passed")
