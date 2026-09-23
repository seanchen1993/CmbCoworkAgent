/** Independent bundles/profile; never runs electron-vite or rebuilds shared dependencies. */
import { build } from "esbuild"
import { createHash, randomUUID } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { parsePerformanceOptions } from "./support/mods-v2-performance"

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const require = createRequire(join(root, "package.json"))
  const options = parsePerformanceOptions(process.argv.slice(2))
  const label = `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.phase}-${options.smoke ? "smoke" : "full"}-${randomUUID().slice(0, 8)}`
  const output = join(root, "output/mods-v2-validation", `v2-performance-${label}`)
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(output)
  writeFileSync(join(output, "options.json"), JSON.stringify(options, null, 2))
  await build({
    entryPoints: {
      "function-mod-host": join(root, "tests/support/mods-v2-performance-host.ts"),
      "performance-entry": join(root, "tests/support/mods-v2-performance-entry.ts")
    },
    outdir: output,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron", "quickjs-emscripten", "esbuild"]
  })
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  }).trim()
  const hashes = Object.fromEntries(
    ["function-mod-host.cjs", "performance-entry.cjs"].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(output, file)))
        .digest("hex")
    ])
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const [key, folder] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    CMB_COWORK_AGENT_HOME: "data",
    TEMP: "temp",
    TMP: "temp"
  })) {
    env[key] = join(output, folder)
    mkdirSync(env[key]!, { recursive: true })
  }
  const child = spawn(require("electron"), [join(output, "performance-entry.cjs"), output], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: "inherit"
  })
  const manifest = {
    startedAt: new Date().toISOString(),
    runnerPid: process.pid,
    electronPid: child.pid,
    output,
    head,
    hashes,
    options,
    stopFile: join(output, "STOP")
  }
  writeFileSync(join(output, "run.json"), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify(manifest))
  const requestStop = () => writeFileSync(join(output, "STOP"), "Runner requested a stop\n")
  process.once("SIGINT", requestStop)
  process.once("SIGTERM", requestStop)
  const timeout = setTimeout(
    requestStop,
    (options.soakSeconds + options.idleSeconds * 2 + 3600) * 1000
  )
  const killer = setInterval(() => {
    if (existsSync(join(output, "STOP")) && child.exitCode === null) {
      // Only this ChildProcess is owned here. Give its normal resource cleanup ten seconds.
      clearInterval(killer)
      const grace = setTimeout(() => {
        if (child.exitCode === null) child.kill()
      }, 10000)
      grace.unref()
    }
  }, 1000)
  try {
    const code = await new Promise<number>((yes, no) => {
      child.once("error", no)
      child.once("exit", (code) => yes(code ?? 1))
    })
    writeFileSync(
      join(output, "exit.json"),
      JSON.stringify({ code, finishedAt: new Date().toISOString() })
    )
    process.exitCode = code
  } finally {
    clearTimeout(timeout)
    clearInterval(killer)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
