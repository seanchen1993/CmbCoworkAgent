import assert from "node:assert/strict"
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Focused ABBA/BAAB comparison of the actual host wrapper + SQLite, without a guest VM or I/O.
// The baseline is loaded from Git into the bundler, never checked out over the user's files.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const baseline = execFileSync(
  "git",
  ["rev-parse", "--verify", `${process.argv[2] ?? "aa97b145"}^{commit}`],
  { cwd: root, encoding: "utf8" }
).trim()
const mcpMode = ["mcp", "mcp-matched"].includes(process.argv[3])
const matchedPublication = process.argv[3] === "mcp-matched"
const output = join(
  root,
  `output/mods-v2-validation/${mcpMode ? process.argv[3] : "host"}-performance`
)
await mkdir(output, { recursive: true })
const source = mcpMode
  ? await readFile(join(root, "tests/support/function-mcp-performance-entry.ts"), "utf8")
  : `
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { ModControlStore } from "./src/main/mods/control-store"
import { FunctionRegisteredTools } from "./src/main/mods/v2/registered-tools"
import { withFunctionExecution } from "./src/main/mods/v2/execution-context"
const workspace = mkdtempSync(join(tmpdir(), "mods-host-perf-"))
const store = new ModControlStore(join(workspace, "control.sqlite"))
const grant = store.grant(workspace, "function:perf", "snapshot", true)
const host = new FunctionRegisteredTools(store, {
  assertScope: () => {}, admit: async () => {}, publish: async (identity, value) => {
    store.publication(identity.callId, "", [], "published")
    return value
  }
})
const times = []
try {
  for (let i = 0; i < 140; i++) {
    const before = performance.now()
    await withFunctionExecution({ workspace, threadId: "thread", turnId: "turn",
      leased: true, immediate: false, userInitiated: false }, () => host.call(
      workspace, "thread", grant, { tool: "mcp__perf__echo", tool_use_id: "call-" + i },
      "model", new AbortController().signal, async () => ({ result: "echo" })))
    if (i >= 40) times.push(performance.now() - before)
  }
  process.stdout.write(JSON.stringify(times))
} finally {
  store.close()
  if (dirname(resolve(workspace)) !== resolve(tmpdir()) || !basename(workspace).startsWith("mods-host-perf-"))
    throw Error("Unexpected performance cleanup path")
  rmSync(workspace, { recursive: true, force: true })
}
`
const hashes = {}
for (const variant of ["baseline", "current"]) {
  const outfile = join(output, `${variant}.mjs`)
  await build({
    stdin: {
      contents: source,
      resolveDir: mcpMode ? join(root, "tests/support") : root,
      loader: "ts"
    },
    define: {
      __MODS_MCP_SDK__: variant === "current" ? "true" : "false",
      __MODS_MATCHED_PUBLICATION__: matchedPublication ? "true" : "false"
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
    plugins: [
      ...(mcpMode
        ? [
            {
              name: "no-guest-in-host-performance",
              setup(builder) {
                builder.onLoad({ filter: /[\\/]main[\\/]mods[\\/]runtime-client\.ts$/ }, () => ({
                  contents:
                    "export class ModRuntimeClient { version=0; stop(){}; load(){throw Error('Unexpected guest in host benchmark')} }",
                  loader: "ts"
                }))
              }
            }
          ]
        : []),
      ...(variant === "baseline"
        ? [
            {
              name: "frozen-mods-baseline",
              setup(builder) {
                builder.onLoad(
                  { filter: /[\\/]src[\\/](main|shared)[\\/]mods[\\/].*\.ts$/ },
                  (args) => ({
                    contents: execFileSync(
                      "git",
                      ["show", `${baseline}:${relative(root, args.path).replaceAll("\\", "/")}`],
                      { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
                    ),
                    loader: "ts",
                    resolveDir: dirname(args.path)
                  })
                )
              }
            }
          ]
        : [])
    ]
  })
  hashes[variant] = createHash("sha256")
    .update(await readFile(outfile))
    .digest("hex")
}
assert.notEqual(hashes.baseline, hashes.current, "comparison must exercise different host code")
const samples = { baseline: [], current: [] }
const rounds = []
for (let round = 0; round < 4; round++) {
  const order =
    round % 2
      ? ["current", "baseline", "baseline", "current"]
      : ["baseline", "current", "current", "baseline"]
  for (const variant of order) {
    const values = JSON.parse(
      execFileSync(process.execPath, [join(output, `${variant}.mjs`)], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60000
      })
    )
    assert.equal(values.length, 100)
    samples[variant].push(...values)
    rounds.push({ round, variant, values })
  }
}
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1)
  }
}
const prior = summarize(samples.baseline),
  current = summarize(samples.current)
const report = {
  baseline,
  hashes,
  scope: mcpMode
    ? "baseline internal MCP capability route versus new named SDK resolver (1000 tools), both actual ModEngine + SQLite; stub approval/transport, no guest VM or policy worker; " +
      (matchedPublication
        ? "benchmark adds equivalent publication persistence to baseline, isolating resolver/guard overhead"
        : "SDK additionally persists publication with policy off, baseline leaves it pending")
    : "registered host boundary + actual SQLite; no VM, policy worker, native tool I/O or provider",
  prior,
  current,
  p95DeltaPercent: (current.p95Ms / prior.p95Ms - 1) * 100,
  rounds
}
await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n")
process.stdout.write(
  JSON.stringify(
    {
      ...report,
      rounds: rounds.map(({ round, variant, values }) => ({ round, variant, ...summarize(values) }))
    },
    null,
    2
  ) + "\n"
)
