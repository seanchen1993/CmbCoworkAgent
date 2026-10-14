import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"
import { assertFunctionSourcesCurrent } from "../src/main/mods/v2/source-adoption-fence"

async function main() {
  const root = await mkdtemp(join(tmpdir(), "mods-config-performance-"))
  try {
    const compiled = []
    for (let index = 0; index < 8; index++) {
      const path = join(root, String(index))
      await mkdir(join(path, "hooks"), { recursive: true })
      await writeFile(join(path, "plugin.json"), JSON.stringify({ name: "config-perf-" + index }))
      await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
      const imports: string[] = []
      for (let file = 0; file < 127; file++) {
        const name = `source-${file}.ts`
        await writeFile(
          join(path, "hooks", name),
          `export const value=${file};/*${"x".repeat(15000)}*/`
        )
        imports.push(`import {value as v${file}} from "./${name}"`)
      }
      await writeFile(
        join(path, "hooks/register.ts"),
        imports.join("\n") +
          `\nexport function register(){return ${imports.map((_, i) => "v" + i).join("+")}}`
      )
      compiled.push(await compileFunctionPlugin(path))
    }
    const times: number[] = []
    for (let sample = 0; sample < 12; sample++) {
      const start = performance.now()
      for (const plugin of compiled) assertFunctionSourcesCurrent(plugin)
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    const ordinaryRoot = join(root, "ordinary")
    await mkdir(join(ordinaryRoot, "hooks"), { recursive: true })
    await writeFile(join(ordinaryRoot, "plugin.json"), '{"name":"ordinary-config"}')
    await writeFile(join(ordinaryRoot, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(join(ordinaryRoot, "hooks/register.ts"), "export function register() {}")
    const ordinary = await compileFunctionPlugin(ordinaryRoot)
    const small: number[] = []
    for (let sample = 0; sample < 50; sample++) {
      const start = performance.now()
      assertFunctionSourcesCurrent(ordinary)
      small.push(performance.now() - start)
    }
    small.sort((a, b) => a - b)
    const result = {
      scope:
        "Eight real packages, 128 actual source files per package, about 15MiB total; final synchronous fence only",
      samples: times.length,
      medianMs: times[6],
      p95Ms: times[11],
      maxMs: times[11],
      ordinary: { samples: small.length, medianMs: small[25], p95Ms: small[47], maxMs: small[49] }
    }
    await mkdir("output", { recursive: true })
    await writeFile("output/mods-config-performance.json", JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
    assert(result.maxMs < 1000, "Final source fence exceeded the gross regression limit")
  } finally {
    assert(
      dirname(resolve(root)) === resolve(tmpdir()) &&
        basename(root).startsWith("mods-config-performance-"),
      "Unexpected cleanup target"
    )
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
