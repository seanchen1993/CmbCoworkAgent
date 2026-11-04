import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import rehypeHighlight from "rehype-highlight"
import { VFile } from "vfile"
import { rehypeChatHighlight } from "../src/renderer/src/lib/markdown-highlight"

// Isolate repeated syntax work from IPC and model timing. Keep the old shared registry
// as the baseline; creating the registry per sample would exaggerate the improvement.
const old = rehypeHighlight()
const current = rehypeChatHighlight()
const processor = unified().use(remarkParse).use(remarkRehype)
const source =
  "```typescript\n" +
  Array.from(
    { length: 120 },
    (_, index) => `const value${index}: string = items.map(item => item.name.trim()).join(', ')`
  ).join("\n") +
  "\n```"
const file = new VFile(source)
const tree = processor.runSync(processor.parse(file), file)
function sample(transform: typeof old) {
  const copy = structuredClone(tree)
  const next = new VFile(source)
  const start = performance.now()
  transform(copy, next)
  return { ms: performance.now() - start, tree: copy }
}
assert.deepEqual(sample(current).tree, sample(old).tree)
const previous: number[] = [],
  cached: number[] = []
for (let index = 0; index < 30; index++) {
  previous.push(sample(old).ms)
  cached.push(sample(current).ms)
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[15]
const report = {
  samples: 30,
  codeLines: 120,
  beforeMedianMs: median(previous),
  afterMedianMs: median(cached),
  before: previous,
  after: cached
}
assert(
  report.afterMedianMs < report.beforeMedianMs,
  "Warm scrolling should avoid repeat highlighting"
)
mkdirSync(resolve("output/chat-highlight-performance"), { recursive: true })
writeFileSync(
  resolve("output/chat-highlight-performance/result.json"),
  JSON.stringify(report, null, 2)
)
console.log(
  JSON.stringify({ beforeMedianMs: report.beforeMedianMs, afterMedianMs: report.afterMedianMs })
)
