import assert from "node:assert/strict"
import { build, type BuildOptions } from "esbuild"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, relative, resolve } from "node:path"
import { modsGitTree } from "./support/mods-git-tree"
import { modsSourceNodeWorkers } from "./support/mods-source-node-workers"
import { captureModsSourceSnapshot, verifyModsSourceSnapshot } from "./support/mods-source-snapshot"
import {
  collectMcpPerformanceChild,
  MCP_PERFORMANCE_BOOTSTRAP_SOURCE,
  MCP_PERFORMANCE_ESM_EXTERNAL,
  mcpPerformanceEsmExternal,
  mcpPerformanceSamples,
  type McpPerformanceChildOutput
} from "./support/mods-mcp-performance-harness"
import { parsePerformanceOptions, summarizeSamples } from "./support/mods-v2-performance"

/** Same fixed fixture, full historical source tree, same installed dependency lock, fresh profiles. */
async function main() {
  const root = resolve(__dirname, "..")
  const args = process.argv.slice(2)
  assert(
    new Set(args).size === args.length &&
      args.every((arg) =>
        [
          "--smoke",
          "--baseline-only",
          "--diagnostic-guest-dispose",
          "--suite=runtime",
          "--suite=ingress",
          "--suite=mcp"
        ].includes(arg)
      ),
    "Usage: tsx tests/run-mods-phase3-performance.ts --suite=runtime|ingress|mcp [--smoke] [--baseline-only] [--diagnostic-guest-dispose]"
  )
  const choices = args.filter((arg) => arg.startsWith("--suite="))
  assert.equal(choices.length, 1)
  const suite = choices[0].slice(8)
  const smoke = args.includes("--smoke")
  const diagnosticDispose = args.includes("--diagnostic-guest-dispose")
  assert(
    !diagnosticDispose || (suite === "runtime" && args.includes("--baseline-only") && !smoke),
    "GUEST_DISPOSE_DIAGNOSTIC_REQUIRES_RUNTIME_BASELINE_ONLY_NOSMOKE"
  )
  const tree = modsGitTree(root, "15492cc9f")
  const dependencyHash = tree.assertSameDependencies()
  const output = join(
    root,
    "output",
    `phase3-${diagnosticDispose ? "diagnostic-dispose" : "performance"}-${suite}-${randomUUID().slice(0, 8)}`
  )
  mkdirSync(output)
  const variants = args.includes("--baseline-only") ? ["baseline"] : ["baseline", "current"]
  const fixture =
    suite === "runtime"
      ? "mods-v2-performance-entry.ts"
      : suite === "ingress"
        ? "mods-v2-ingress-performance-entry.ts"
        : "function-mcp-performance-entry.ts"
  const fixturePath = join(root, "tests/support", fixture)
  const fixtureHash = createHash("sha256").update(readFileSync(fixturePath)).digest("hex")
  const hashes: Record<string, Record<string, string>> = {}
  const builds: Record<string, string> = {}
  const currentSources = new Map<string, string>()
  const currentSnapshot = variants.includes("current")
    ? captureModsSourceSnapshot(root, ["src"])
    : undefined
  const fixtureSources = new Map<string, string>()
  const driverHashes = Object.fromEntries(
    [
      "tests/run-mods-phase3-performance.ts",
      "tests/support/mods-git-tree.ts",
      "tests/support/mods-source-node-workers.ts",
      "tests/support/mods-source-snapshot.ts",
      "tests/support/mods-mcp-performance-harness.ts"
    ].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex")
    ])
  )
  for (const variant of variants) {
    const folder = join(output, `${variant}-bundle`)
    builds[variant] = folder
    const workers = modsSourceNodeWorkers(root, variant === "baseline" ? tree : undefined)
    const entries = {
      "performance-entry": fixturePath,
      ...(suite !== "mcp"
        ? {
            "function-mod-host": join(
              root,
              suite === "runtime"
                ? "tests/support/mods-v2-performance-host.ts"
                : "src/main/mods/v2/host-entry.ts"
            )
          }
        : {}),
      ...(suite === "ingress" ? { "mod-host": join(root, "src/main/mods/host-entry.ts") } : {})
    }
    const buildOptions: BuildOptions = {
      entryPoints: entries,
      outdir: folder,
      outExtension: { ".js": suite === "mcp" ? ".mjs" : ".cjs" },
      bundle: true,
      format: suite === "mcp" ? "esm" : "cjs",
      platform: "node",
      target: "node22",
      packages: "external",
      ...(suite === "mcp"
        ? {
            banner: {
              js: 'import {createRequire as perfRequire} from "node:module";import {fileURLToPath as perfFile} from "node:url";import {dirname as perfDir} from "node:path";const require=perfRequire(import.meta.url);const __filename=perfFile(import.meta.url);const __dirname=perfDir(__filename);'
            }
          }
        : {}),
      define: {
        __MODS_GUEST_DISPOSE_DIAGNOSTIC__: diagnosticDispose ? "true" : "false",
        "import.meta.env": "{}",
        "import.meta.url": "__filename",
        __MODS_MCP_SDK__: "true",
        __MODS_MCP_ROUTING__: "true",
        __MODS_RUNTIME_AUTHORITY__: "true",
        __MODS_MATCHED_PUBLICATION__: "true"
      },
      plugins: [
        mcpPerformanceEsmExternal(suite),
        workers.plugin,
        {
          name: "fixed-fixture-inputs",
          setup(builder) {
            builder.onLoad({ filter: /[\\/]tests[\\/]support[\\/].*\.ts$/ }, (source) => {
              const file = relative(root, source.path).replaceAll("\\", "/")
              const digest = createHash("sha256").update(readFileSync(source.path)).digest("hex")
              assert(
                !fixtureSources.has(file) || fixtureSources.get(file) === digest,
                `PERFORMANCE_FIXTURE_CHANGED_DURING_COMPILE:${file}`
              )
              fixtureSources.set(file, digest)
              return undefined
            })
          }
        },
        variant === "baseline"
          ? tree.plugin
          : {
              name: "record-complete-current-source",
              setup(builder) {
                builder.onLoad({ filter: /[\\/]src[\\/].*\.[cm]?[jt]sx?$/ }, (source) => {
                  const file = relative(root, source.path).replaceAll("\\", "/")
                  const digest = createHash("sha256")
                    .update(readFileSync(source.path))
                    .digest("hex")
                  assert.equal(
                    digest,
                    currentSnapshot?.[file],
                    `SOURCE_CHANGED_DURING_COMPILE:${file}`
                  )
                  currentSources.set(file, digest)
                  return undefined
                })
              }
            }
      ]
    }
    await build(buildOptions)
    const completed = new Set<string>()
    while (completed.size < workers.entries.size) {
      for (const [source, name] of [...workers.entries]) {
        if (completed.has(source)) continue
        await build({
          ...buildOptions,
          entryPoints: [source],
          outdir: undefined,
          outfile: join(folder, name),
          format: "cjs",
          banner: undefined
        })
        completed.add(source)
      }
    }
    hashes[variant] = Object.fromEntries(
      readdirSync(folder).map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(folder, file)))
          .digest("hex")
      ])
    )
    if (suite === "mcp") {
      const bootstrap = join(folder, "mcp-bootstrap.cjs")
      writeFileSync(bootstrap, MCP_PERFORMANCE_BOOTSTRAP_SOURCE)
      hashes[variant]["mcp-bootstrap.cjs"] = createHash("sha256")
        .update(readFileSync(bootstrap))
        .digest("hex")
    }
  }
  if (currentSnapshot) verifyModsSourceSnapshot(root, ["src"], currentSnapshot)
  const manifest = {
    workloadSchedule: diagnosticDispose
      ? "unpaced diagnostic burst; not a formal sample"
      : suite === "mcp"
        ? "unchanged unpaced 1000-tool resolver fixture"
        : {
            minimumVmEventStartIntervalMs: 25,
            maximumOfferedVmEventsPerSecond: 40,
            appliesTo: "matrix cold/warmup/samples for every 0/1/8-plugin profile in both variants",
            scheduling: "last actual start; serial; no catch-up; waiting outside timed calls",
            unchanged:
              "paired disabled/direct reads stay equally interleaved and unpaced; no VM involved",
            scope: "Declared-load single-call latency, not saturation throughput"
          },
    diagnosticOnly: diagnosticDispose,
    timingEligible: !diagnosticDispose,
    compiledGuestDisposeObserver: diagnosticDispose,
    ...(suite === "mcp"
      ? {
          esmExternalNormalization: MCP_PERFORMANCE_ESM_EXTERNAL,
          carrier:
            "Real installed Electron main, private profile, no full App; same bootstrap in both variants",
          bootstrapSha256: createHash("sha256")
            .update(MCP_PERFORMANCE_BOOTSTRAP_SOURCE)
            .digest("hex")
        }
      : {}),
    baseline: tree.commit,
    dependencyHash,
    fixture,
    fixtureHash,
    suite,
    smoke,
    driverHashes,
    fixtureSources: Object.fromEntries(fixtureSources),
    hashes,
    baselineSources: tree.loadedSources(),
    currentSources: Object.fromEntries(currentSources),
    currentSnapshot,
    scope: diagnosticDispose
      ? "Diagnostic only: historical baseline single-plugin burst, original dispose reason; no formal samples or comparison."
      : suite === "mcp"
        ? "Same named MCP resolver + instance authority + SQLite, 1000 tools, complete source graph in real Electron main; original empty guest source fixture, passthrough transport, no network/model. Native windows/guest utility observations are recorded before/after each run."
        : suite === "runtime"
          ? "Paired 0/1/8 plugin matrix and disabled reads; real QuickJS/SQLite; excludes 2h soak/idle qualification"
          : "Paired actual LocalSandbox + Mods ingress, 0/1/8 plugins, project/global off; no renderer/model",
    output,
    startedAt: new Date().toISOString(),
    node: process.version
  }
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify({ output, suite, smoke, variants, baseline: tree.commit }))
  const options = parsePerformanceOptions(
    smoke ? ["--smoke", "--phase=matrix"] : ["--phase=matrix"]
  )
  const reports: Array<{ variant: string; path: string; code: number; result: unknown }> = []
  const aggregate = () =>
    Object.fromEntries(
      variants.map((variant) => {
        const runs = reports.filter((report) => report.variant === variant)
        const profiles = suite === "mcp" ? ["mcp-1000-tools"] : ["0", "1", "8"]
        return [
          variant,
          Object.fromEntries(
            profiles.map((profile) => {
              const values = runs.flatMap((run) =>
                suite === "mcp"
                  ? (JSON.parse(readFileSync(join(run.path, "timings.json"), "utf8")) as number[])
                  : readdirSync(run.path)
                      .filter((name) =>
                        new RegExp(`^samples-round-\\d+-plugins-${profile}\\.json$`).test(name)
                      )
                      .flatMap(
                        (name) => JSON.parse(readFileSync(join(run.path, name), "utf8")) as number[]
                      )
              )
              return [profile, values.length ? summarizeSamples(values) : null]
            })
          )
        ]
      })
    )
  const order =
    variants.length === 1
      ? ["baseline"]
      : suite === "mcp" && !smoke
        ? Array.from({ length: 4 }, (_, index) =>
            index % 2
              ? ["current", "baseline", "baseline", "current"]
              : ["baseline", "current", "current", "baseline"]
          ).flat()
        : ["baseline", "current", "current", "baseline"]
  const require = createRequire(join(root, "package.json"))
  for (const [index, variant] of order.entries()) {
    const run = join(output, `${index}-${variant}`)
    cpSync(builds[variant], run, { recursive: true })
    writeFileSync(
      join(run, "options.json"),
      JSON.stringify(
        suite === "ingress"
          ? {
              smoke: options.smoke,
              rounds: options.rounds,
              samples: options.samples,
              warmups: options.warmups
            }
          : options
      )
    )
    const env = { ...process.env }
    env.CMB_MODS_PERFORMANCE_GC = "natural"
    env.CMB_MODS_GUEST_DISPOSE_DIAGNOSTIC = diagnosticDispose ? "1" : "0"
    delete env.ELECTRON_RUN_AS_NODE
    for (const [key, name] of Object.entries({
      HOME: "home",
      USERPROFILE: "home",
      APPDATA: "appdata",
      LOCALAPPDATA: "localappdata",
      CMB_COWORK_AGENT_HOME: "data",
      TEMP: "temp",
      TMP: "temp"
    })) {
      env[key] = join(run, name)
      mkdirSync(env[key]!, { recursive: true })
    }
    let mcpOutput: McpPerformanceChildOutput | undefined
    const code = await new Promise<number>((done, fail) => {
      const child = spawn(
        require("electron"),
        [
          join(run, suite === "mcp" ? "mcp-bootstrap.cjs" : "performance-entry.cjs"),
          ...(suite === "mcp" ? [] : [run])
        ],
        { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      )
      const timer = setTimeout(() => {
        child.kill()
        fail(Error("OWNED_PERFORMANCE_TIMEOUT"))
      }, 1800000)
      if (suite === "mcp") {
        void collectMcpPerformanceChild(child, {
          stdout: (bytes) => process.stdout.write(bytes),
          stderr: (bytes) => process.stderr.write(bytes)
        }).then(
          (value) => {
            clearTimeout(timer)
            mcpOutput = value
            done(value.code ?? 1)
          },
          (error) => {
            clearTimeout(timer)
            fail(error)
          }
        )
      } else {
        child.stdout.on("data", (bytes) => {
          process.stdout.write(bytes)
        })
        child.stderr.on("data", (bytes) => process.stderr.write(bytes))
        child.once("error", (error) => {
          clearTimeout(timer)
          fail(error)
        })
        child.once("exit", (value) => {
          clearTimeout(timer)
          done(value ?? 1)
        })
      }
    })
    let mcpTimings: number[] | undefined
    if (suite === "mcp") {
      assert(mcpOutput, "MCP_CHILD_OUTPUT_UNAVAILABLE")
      writeFileSync(join(run, "raw-stdout.txt"), mcpOutput.stdout)
      writeFileSync(join(run, "stderr.txt"), mcpOutput.stderr)
      writeFileSync(
        join(run, "child-exit.json"),
        JSON.stringify(
          {
            code: mcpOutput.code,
            signal: mcpOutput.signal,
            closeCode: mcpOutput.closeCode,
            closeSignal: mcpOutput.closeSignal,
            exitObserved: mcpOutput.exitObserved,
            stdoutBytes: mcpOutput.stdout.length,
            stderrBytes: mcpOutput.stderr.length
          },
          null,
          2
        )
      )
      mcpTimings = mcpPerformanceSamples(mcpOutput)
      writeFileSync(join(run, "timings.json"), JSON.stringify(mcpTimings))
    }
    const result =
      suite === "mcp"
        ? summarizeSamples(mcpTimings!)
        : JSON.parse(readFileSync(join(run, "result.json"), "utf8"))
    reports.push({ variant, path: run, code, result })
    writeFileSync(
      join(output, diagnosticDispose ? "diagnostic.json" : "comparison.json"),
      JSON.stringify(
        { ...manifest, completedAt: new Date().toISOString(), reports, aggregate: aggregate() },
        null,
        2
      )
    )
    assert(
      (diagnosticDispose ? [0, 1, 2] : [0, 2]).includes(code),
      `PERFORMANCE_EXECUTION_FAILED:${variant}:${code}`
    )
  }
  assert.equal(createHash("sha256").update(readFileSync(fixturePath)).digest("hex"), fixtureHash)
  for (const [file, digest] of currentSources)
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex"),
      digest,
      `PERFORMANCE_CURRENT_CHANGED:${file}`
    )
  if (currentSnapshot) verifyModsSourceSnapshot(root, ["src"], currentSnapshot)
  for (const [file, digest] of [...fixtureSources, ...Object.entries(driverHashes)])
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex"),
      digest,
      `PERFORMANCE_DRIVER_CHANGED:${file}`
    )
  process.exitCode = diagnosticDispose
    ? (reports.find((row) => row.code !== 0)?.code ?? 0)
    : reports.some((row) => row.code !== 0)
      ? 2
      : 0
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
