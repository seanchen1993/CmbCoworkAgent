import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { expect, it } from "vitest"
import { parseFunctionMarkdown } from "../../../shared/mods/v2/markdown"
import { FunctionMarkdownLinkRegistry } from "./markdown-link-registry"

const enabled = process.env.CMB_MODS_MARKDOWN_PERF === "1"
const rounds = 10
const warmup = 2
const batch = 5

it.skipIf(!enabled)(
  "measures final Markdown parsing and unchanged native publication",
  () => {
    const prefix = "# Report\n\n| Step | Result |\n| --- | --- |\n| Review | Ready |\n\n"
    const links = Array.from(
      { length: 80 },
      (_, index) => `[Report ${index}](https://example.test/report/${index})`
    ).join("\n")
    const text = (prefix + links + "\n\n" + "plain report text ".repeat(800)).slice(0, 10000)
    expect(text.length).toBe(10000)
    const expected = parseFunctionMarkdown(text).hrefs
    expect(expected).toHaveLength(80)
    const report: Record<string, unknown> = {
      scope: "Pure final HAST and main-only publication; excludes IPC, React, OS, files and models",
      textLength: text.length,
      hrefs: expected.length,
      rounds,
      warmup,
      batch,
      modelRequests: 0
    }
    const registry = new FunctionMarkdownLinkRegistry()
    const owner = {}
    const epoch = {}
    const binding = {
      owner,
      epoch,
      contentFingerprint: "actual-frame-fingerprint",
      address: { kind: "pane" as const, pane: "Q:report", generation: "frame-1" },
      assertCurrent() {
        /* Fixed native owner for an isolated publication benchmark. */
      }
    }
    const leaves = [{ nodePath: [], props: { text } }]
    const first = registry.prepare(binding, leaves)
    registry.commit([first])
    for (const mode of ["parse", "unchanged-publication"] as const) {
      const measurements: number[] = []
      for (let round = 0; round < rounds + warmup; round++) {
        const started = performance.now()
        for (let index = 0; index < batch; index++) {
          if (mode === "parse") expect(parseFunctionMarkdown(text).hrefs).toEqual(expected)
          else {
            const candidate = registry.prepare(binding, leaves)
            expect(candidate.markdownLinks).toEqual(first.markdownLinks)
            registry.commit([candidate])
          }
        }
        if (round >= warmup) measurements.push((performance.now() - started) / batch)
      }
      const sorted = [...measurements].sort((a, b) => a - b)
      report[mode] = {
        batchMeansMs: measurements,
        medianBatchMeanMs: sorted[Math.floor(sorted.length / 2)],
        p95BatchMeanMs: sorted[Math.ceil(sorted.length * 0.95) - 1]
      }
    }
    registry.close()
    const folder = resolve(
      process.env.CMB_MODS_MARKDOWN_PERF_DIR ?? "output/mods-markdown-performance"
    )
    mkdirSync(folder, { recursive: true })
    writeFileSync(resolve(folder, "markdown-performance.json"), JSON.stringify(report, null, 2))
  },
  120000
)
