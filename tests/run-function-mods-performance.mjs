/** Runtime-only ABBA comparison. Reads baseline sources with git; never changes the checkout. */
import { build } from "esbuild"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const output = join(root, "output/mods-v2-validation/runtime-performance")
function git(args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.status !== 0) throw Error(result.stderr || "git reference unavailable")
  return result.stdout
}
if (!process.argv[2])
  throw Error("Usage: node tests/run-function-mods-performance.mjs <baseline-commit>")
const baseline = git(["rev-parse", "--verify", process.argv[2] + "^{commit}"]).trim()
await mkdir(output, { recursive: true })
const digests = {}
for (const variant of ["baseline", "working-tree"]) {
  const outdir = join(output, variant)
  await build({
    entryPoints: {
      "function-mod-host": join(root, "src/main/mods/v2/host-entry.ts"),
      "perf-entry": join(root, "tests/support/function-mods-perf-entry.ts")
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outdir,
    outExtension: { ".js": ".cjs" },
    external: ["electron", "quickjs-emscripten", "esbuild"],
    plugins:
      variant !== "baseline"
        ? []
        : [
            {
              name: "baseline-mods-source",
              setup(builder) {
                builder.onLoad(
                  { filter: /[\\/]src[\\/](main|shared)[\\/]mods[\\/].*\.tsx?$/ },
                  (args) => ({
                    contents: git([
                      "show",
                      `${baseline}:${relative(root, args.path).replaceAll("\\", "/")}`
                    ]),
                    loader: args.path.endsWith(".tsx") ? "tsx" : "ts"
                  })
                )
              }
            }
          ]
  })
  digests[variant] = createHash("sha256")
    .update(await readFile(join(outdir, "function-mod-host.cjs")))
    .digest("hex")
}
const runs = []
for (const [index, variant] of ["baseline", "working-tree", "working-tree", "baseline"].entries()) {
  const destination = join(output, `${index}-${variant}.json`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(
      require("electron"),
      [join(output, variant, "perf-entry.cjs"), root, destination],
      {
        cwd: root,
        env,
        stdio: "inherit",
        windowsHide: true
      }
    )
    const timer = setTimeout(() => {
      child.kill()
      reject(Error("performance process timed out"))
    }, 60000)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code) reject(Error(`performance process exited ${code}`))
      else resolve()
    })
  })
  runs.push({ variant, ...JSON.parse(await readFile(destination, "utf8")) })
}
const summary = Object.fromEntries(
  ["baseline", "working-tree"].map((variant) => {
    const samples = runs
      .filter((run) => run.variant === variant)
      .flatMap((run) => run.samples)
      .sort((a, b) => a - b)
    return [
      variant,
      {
        count: samples.length,
        p50Ms: samples[Math.floor(samples.length * 0.5)],
        p95Ms: samples[Math.floor(samples.length * 0.95)],
        maxMs: samples.at(-1)
      }
    ]
  })
)
const changePercent = Object.fromEntries(
  ["p50Ms", "p95Ms"].map((key) => [
    key,
    100 * (summary["working-tree"][key] / summary.baseline[key] - 1)
  ])
)
const report = {
  baseline,
  head: git(["rev-parse", "HEAD"]).trim(),
  digests,
  summary,
  changePercent,
  scope:
    "ABBA; 30 warmups and 450 samples per run; identical two-hook fixture; Mods runtime sources only; not whole-app or long-duration proof"
}
await writeFile(join(output, "comparison.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
