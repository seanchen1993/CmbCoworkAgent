/** Archive local Bot performance/review runs. No real model, IM or ES traffic. */
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { homedir, platform, arch, cpus } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const vitest = "node_modules/vitest/vitest.mjs"
const suites = {
  "im-regression": [
    vitest,
    "run",
    "src/main/bots/im-channel.test.ts",
    "src/main/bots/background-commands.test.ts",
    "src/main/bots/message-reactions.test.ts",
    "--maxWorkers=2"
  ],
  "directory-ui": ["--import", "tsx", "tests/bots-work-directory-browser.spec.ts"],
  "feature-ui": ["--import", "tsx", "tests/bots-feature-panel-browser.spec.ts"],
  focused: [
    vitest,
    "run",
    "src/main/bots/work-projection.test.ts",
    "src/main/bots/feature-follow.test.ts",
    "src/main/bots/host.test.ts",
    "src/main/bots/memory.test.ts",
    "src/main/bots/prompt.test.ts",
    "src/main/bots/performance-regression.test.ts",
    "--maxWorkers=2"
  ],
  "typecheck-node": [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "-p",
    "tsconfig.node.json",
    "--composite",
    "false"
  ],
  "typecheck-web": [
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "-p",
    "tsconfig.web.json",
    "--composite",
    "false"
  ],
  performance: ["--import", "tsx", "tests/bot-performance-review.spec.ts"],
  scheduling: ["--import", "tsx", "tests/bot-performance-review.spec.ts", "--scheduling-only"],
  renderer: ["--import", "tsx", "tests/bot-performance-browser.spec.ts"],
  preview: ["--import", "tsx", "tests/bots-browser-preview-browser.spec.ts"],
  regression: [
    vitest,
    "run",
    "src/main/bots",
    "src/shared/bots",
    "src/renderer/src/lib/bot",
    "src/main/ipc/bots.test.ts",
    "src/main/ipc/bot-files.test.ts",
    "src/main/ipc/bot-im-file-export.test.ts",
    "src/main/agent/file-operation-lock.test.ts",
    "src/main/services/im/bot-file-delivery.test.ts",
    "src/main/agent/bot-turn-context.test.ts",
    "src/main/agent/bot-dispatch-feedback.test.ts",
    "src/main/agent/bot-skill-dispatch.test.ts",
    "src/main/agent/bot-skill-selection.test.ts",
    "src/main/ipc/dashboard-bot-metrics.test.ts",
    "--maxWorkers=2"
  ]
}
const names = process.argv[2]
  ? [process.argv[2]]
  : ["performance", "renderer", "preview", "regression"]
if (process.argv.length > 3 || names.some((name) => !Object.hasOwn(suites, name)))
  throw new Error(
    `Usage: node scripts/run-bot-performance-review.mjs [${Object.keys(suites).join("|")}]`
  )
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node 22+ is required")
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
const sanitize = (text) =>
  text
    .replaceAll(root, "<repo>")
    .replaceAll(homedir(), "<user>")
    .replace(/\/private\/var\/folders\/[^\s:]+|\/var\/folders\/[^\s:]+/g, "<temporary>")
const sourceFiles = [
  "scripts/run-bot-performance-review.mjs",
  "tests/bot-performance-review.spec.ts",
  "tests/bot-performance-browser.spec.ts",
  "tests/support/bot-performance-browser-fixture.tsx"
]
for (const name of names) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "")
  const relative = `docs/experiments/bot-performance/${stamp}-${name}`
  const out = join(root, relative)
  await mkdir(out, { recursive: true })
  const metadata = {
    startedAt: new Date().toISOString(),
    case: name,
    args: suites[name],
    head: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    workingTree: git("status", "--short"),
    kind: "local synthetic or regression; no production load",
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    sourceHashes: {}
  }
  for (const file of sourceFiles) {
    const bytes = await readFile(join(root, file))
    metadata.sourceHashes[file] = createHash("sha256").update(bytes).digest("hex")
    const destination = join(out, "source", file)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes, { flag: "wx" })
  }
  const changedSource = [
    ...new Set([
      ...git("diff", "--name-only", "HEAD", "--", "src", "tests").split("\n"),
      ...git("ls-files", "--others", "--exclude-standard", "--", "src").split("\n")
    ])
  ].filter(Boolean)
  const patch = sanitize(git("diff", "HEAD", "--", "src", "tests"))
  await writeFile(join(out, "source", "working-tree.patch"), patch + "\n", { flag: "wx" })
  for (const file of changedSource) {
    const bytes = await readFile(join(root, file))
    metadata.sourceHashes[file] = createHash("sha256").update(bytes).digest("hex")
    if (git("ls-files", "--", file)) continue // tracked contents reconstruct from HEAD + patch
    const destination = join(out, "source", file)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, sanitize(bytes.toString()), { flag: "wx" })
  }
  await writeFile(join(out, "execution.json"), JSON.stringify(metadata, null, 2) + "\n", {
    flag: "wx"
  })
  const log = createWriteStream(join(out, "output.txt"), { flags: "wx" })
  const child = spawn(process.execPath, suites[name], {
    cwd: root,
    env: { ...process.env, BOT_PERF_REPORT: join(out, "metrics.json") },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const started = performance.now()
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }))
  })
  const readers = [child.stdout, child.stderr].map(async (stream) => {
    for await (const line of createInterface({ input: stream })) log.write(sanitize(line) + "\n")
  })
  let exitCode = 1,
    signal = null,
    error
  try {
    const result = await completion
    exitCode = result.code
    signal = result.signal
    await Promise.all(readers)
  } catch (cause) {
    error = sanitize(String(cause))
  } finally {
    await new Promise((resolve) => log.end(resolve))
    await writeFile(
      join(out, "execution.json"),
      JSON.stringify(
        {
          ...metadata,
          exitCode,
          signal,
          error,
          seconds: Math.round(performance.now() - started) / 1000,
          finishedAt: new Date().toISOString()
        },
        null,
        2
      ) + "\n"
    )
  }
  console.log(JSON.stringify({ run: relative, exitCode }))
  if (exitCode) {
    process.exitCode = exitCode
    break
  }
}
