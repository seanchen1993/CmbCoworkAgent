/** Standalone VM initialization microbenchmark; not a TTFT or long-running memory acceptance. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { transformSync } from "esbuild"
import { getQuickJS } from "quickjs-emscripten"
import { FUNCTION_GUEST_BOOTSTRAP } from "../../src/main/mods/v2/guest-bootstrap"
import { FUNCTION_ENCODING_GLOBALS } from "../../src/main/mods/v2/guest-encoding"
import { FUNCTION_CODEGEN_GUARD } from "../../src/main/mods/v2/guest-codegen"

async function main(): Promise<void> {
  const engine = await getQuickJS()
  assert.equal(FUNCTION_GUEST_BOOTSTRAP.split(FUNCTION_ENCODING_GLOBALS).length, 2)
  const sources = {
    baseline: FUNCTION_GUEST_BOOTSTRAP.replace(FUNCTION_ENCODING_GLOBALS, ""),
    current: FUNCTION_GUEST_BOOTSTRAP
  }
  const code = Object.fromEntries(
    Object.entries(sources).map(([key, value]) => [
      key,
      transformSync(value, { target: "es2016" }).code +
        '\nvar __cmbFunctionMod={register(){}};__functionRegister("{}")'
    ])
  )
  const samples = { baseline: [] as number[], current: [] as number[], codec: [] as number[] }
  for (let index = 0; index < 120; index++) {
    for (const kind of index % 2
      ? (["current", "baseline"] as const)
      : (["baseline", "current"] as const)) {
      const start = performance.now()
      const vm = engine.newRuntime()
      vm.setMemoryLimit(16 * 1024 * 1024)
      vm.setMaxStackSize(512 * 1024)
      const context = vm.newContext()
      vm.setInterruptHandler(() => performance.now() - start > 1000)
      try {
        for (const source of [FUNCTION_CODEGEN_GUARD, code[kind]]) {
          const result = context.evalCode(source)
          if (result.error) {
            result.error.dispose()
            throw Error(`Bootstrap failure: ${kind}`)
          }
          result.value.dispose()
        }
        const elapsed = performance.now() - start
        if (index >= 20) samples[kind].push(elapsed)
        if (kind === "current") {
          const begin = performance.now()
          const result = context.evalCode(`(() => {
            const text="中文😀test".repeat(128), encoder=new TextEncoder(),decoder=new TextDecoder();
            for(let i=0;i<5;i++)if(decoder.decode(encoder.encode(text))!==text)throw Error("codec roundtrip");
            return true;
          })()`)
          if (result.error) {
            result.error.dispose()
            throw Error("Codec workload failed")
          }
          result.value.dispose()
          if (index >= 20) samples.codec.push(performance.now() - begin)
        }
      } finally {
        context.dispose()
        vm.dispose()
      }
    }
  }
  const summarize = (values: number[]) => {
    const ordered = [...values].sort((a, b) => a - b)
    return {
      samples: values.length,
      meanMs: values.reduce((sum, n) => sum + n, 0) / values.length,
      p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1],
      p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
      maxMs: ordered[ordered.length - 1]
    }
  }
  const report = {
    node: process.version,
    measuredAt: new Date().toISOString(),
    limits:
      "Microbenchmark only: includes VM creation, guard, bootstrap evaluation and empty registration; excludes bootstrap compilation, utility process startup, real application TTFT, renderer paint and long-running memory. Baseline differs only by omission of UTF-8 globals; order alternates and first 20 rounds are discarded.",
    baseline: summarize(samples.baseline),
    current: summarize(samples.current),
    codec: {
      ...summarize(samples.codec),
      workload: "5 UTF-8 encode/decode round trips, each 1024 UTF-16 code units / 1792 bytes"
    },
    samples
  }
  const output = join(process.cwd(), "output/mods-v4-validation")
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, "encoding-performance.json"), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      {
        baseline: report.baseline,
        current: report.current,
        codec: report.codec,
        deltaP95Ms: report.current.p95Ms - report.baseline.p95Ms
      },
      null,
      2
    )
  )
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
