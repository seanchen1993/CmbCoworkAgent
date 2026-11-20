/** Opt-in local benchmark: npm run build && npx tsx tests/shell-file-telemetry-benchmark.ts */
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"
import type { Worker } from "node:worker_threads"
import iconv from "iconv-lite"
import { beginShellFileCapture } from "../src/main/agent/shell-file-effects"
import { ShellEditDiffClient } from "../src/main/services/shell-edit-diff-client"
import { shellEditLineFragments } from "../src/main/services/adoption-lines"

const exec = promisify(execFile)
const fileCount = 20_000
const dirtyCount = 200
const require = createRequire(import.meta.url)
async function main(): Promise<void> {
  const raw = await mkdtemp(path.join(tmpdir(), "shell-telemetry-benchmark-"))
  const root = await realpath(raw)
  try {
    await exec("git", ["init", "-q", root])
    await exec("git", ["-C", root, "config", "user.name", "Benchmark"])
    await exec("git", ["-C", root, "config", "user.email", "test@example.invalid"])
    await exec("git", ["-C", root, "config", "gc.auto", "0"])
    await mkdir(path.join(root, "src"))
    for (let start = 0; start < fileCount; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, fileCount - start) }, (_, j) =>
          writeFile(
            path.join(root, "src", `file-${start + j}.ts`),
            `export const value${start + j} = 1\n`
          )
        )
      )
    }
    await exec("git", ["-C", root, "add", "."])
    await exec("git", ["-C", root, "commit", "-qm", "seed"])
    await Promise.all(
      Array.from({ length: dirtyCount }, (_, i) =>
        writeFile(path.join(root, "src", `file-${i}.ts`), `export const value${i} = 2\n`)
      )
    )
    const measurements: { beforeMs: number; afterMs: number }[] = []
    const edited = path.join(root, "src", `file-${fileCount - 1}.ts`)
    for (let iteration = 0; iteration < 5; iteration++) {
      const started = performance.now()
      const capture = await beginShellFileCapture({
        workspaceRoot: root,
        cwd: root,
        command: `sed -i 's/1/2/' src/file-${fileCount - 1}.ts`,
        isCodeFile: (p) => p.endsWith(".ts")
      })
      const beforeMs = performance.now() - started
      if (!capture) throw new Error("benchmark capture unexpectedly skipped")
      await writeFile(edited, `export const value${fileCount - 1} = ${iteration + 3}\n`)
      const ended = performance.now(),
        result = await capture.finish()
      if (result.changes.filter((c) => c.decision === "counted").length !== 1)
        throw new Error("benchmark changed unrelated dirty files")
      measurements.push({ beforeMs, afterMs: performance.now() - ended })
    }

    const output = path.resolve("out/main")
    const entry = (await readdir(output)).find((f) => /^shell-edit-diff-client-.*\.js$/.test(f))
    if (!entry) throw new Error("build first: the production worker entry is missing")
    const create = require(path.join(output, entry)).default as (options: object) => Worker
    const client = new ShellEditDiffClient(async () =>
      create({ name: "shell-edit-benchmark", resourceLimits: { maxOldGenerationSizeMb: 128 } })
    )
    try {
      const context =
        "// 这是一段用于检验文件编码的中文说明，包括实现内容、测试步骤和结果分析。\n".repeat(15_000)
      const before = iconv.encode(context + "const value = 1\n", "gbk"),
        after = iconv.encode(context + "const value = 2\n", "gbk")
      const expected = shellEditLineFragments(before, after)
      let maxTimerDelayMs = 0,
        previous = performance.now()
      const ticker = setInterval(() => {
        const now = performance.now()
        maxTimerDelayMs = Math.max(maxTimerDelayMs, now - previous - 5)
        previous = now
      }, 5)
      const started = performance.now()
      let result: Awaited<ReturnType<ShellEditDiffClient["diff"]>>
      try {
        result = await client.diff(before, after)
      } finally {
        clearInterval(ticker)
      }
      if (JSON.stringify(result) !== JSON.stringify(expected))
        throw new Error("production worker differs from shared decoder/hash semantics")
      console.log(
        JSON.stringify(
          {
            fileCount,
            dirtyCount,
            measurements,
            worker: {
              combinedBytes: before.length + after.length,
              durationMs: performance.now() - started,
              maxTimerDelayMs,
              generatedContent: result?.generatedContent
            }
          },
          null,
          2
        )
      )
    } finally {
      await client.close()
    }
  } finally {
    await rm(raw, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
