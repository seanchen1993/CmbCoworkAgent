import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { getQuickJS } from "quickjs-emscripten"
import { transformSync } from "esbuild"
import { FUNCTION_GUEST_BOOTSTRAP } from "../src/main/mods/v2/guest-bootstrap"
import { FUNCTION_CODEGEN_GUARD } from "../src/main/mods/v2/guest-codegen"
import { FUNCTION_URL_GLOBALS } from "../src/main/mods/v2/guest-url-source"
import { FUNCTION_URL_LAZY_GLOBALS } from "../src/main/mods/v2/guest-url"

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)]
  }
}

async function main() {
  const engine = await getQuickJS()
  const bootstrap = transformSync(FUNCTION_GUEST_BOOTSTRAP, { target: "es2016" }).code
  const before: number[] = [],
    after: number[] = [],
    firstUse: number[] = [],
    repeatUse: number[] = []
  for (let i = 0; i < 70; i++) {
    for (const lazy of i % 2 ? [true, false] : [false, true]) {
      const start = performance.now()
      const runtime = engine.newRuntime()
      runtime.setMemoryLimit(16 * 1024 * 1024)
      runtime.setMaxStackSize(512 * 1024)
      const context = runtime.newContext()
      let deadline = 0
      runtime.setInterruptHandler(() => performance.now() > deadline)
      const evaluate = (code: string) => {
        deadline = performance.now() + 50
        const result = context.evalCode(code)
        if (result.error) {
          result.dispose()
          throw Error("URL performance probe exceeded VM budget")
        }
        result.dispose()
      }
      try {
        evaluate(FUNCTION_CODEGEN_GUARD)
        evaluate(bootstrap)
        if (lazy) {
          const initialize = context.newFunction("initializeUrl", () =>
            context.evalCode(FUNCTION_URL_GLOBALS)
          )
          context.setProp(context.global, "__functionInitializeUrl", initialize)
          initialize.dispose()
          evaluate(FUNCTION_URL_LAZY_GLOBALS)
        }
        const duration = performance.now() - start
        if (i >= 10) (lazy ? after : before).push(duration)
        if (lazy) {
          let now = performance.now()
          evaluate('new URL("https://例子.测试/a?q=中").searchParams.get("q")')
          if (i >= 10) firstUse.push(performance.now() - now)
          now = performance.now()
          evaluate('new URL("https://例子.测试/a?q=中").searchParams.get("q")')
          if (i >= 10) repeatUse.push(performance.now() - now)
        }
      } finally {
        context.dispose()
        runtime.dispose()
      }
    }
  }
  const baseline = summarize(before),
    unusedUrl = summarize(after)
  const report = {
    samples: before.length,
    warmupPairs: 10,
    note: "Paired alternating real QuickJS creation, same VM limits. Excludes IPC, model, disk and TTFT.",
    baseline,
    unusedUrl,
    unusedP95DeltaMs: unusedUrl.p95Ms - baseline.p95Ms,
    firstUrlUse: summarize(firstUse),
    repeatUrlUse: summarize(repeatUse)
  }
  const output = resolve("output/mods-v5-validation")
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, "url-performance.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
