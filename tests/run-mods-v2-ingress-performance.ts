/** Independent application-ingress fixture: no shared build, installer or dependency mutation. */
import { build } from "esbuild"
import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseIngressPerformanceOptions } from "./support/mods-v2-ingress-performance"

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const require = createRequire(join(root, "package.json"))
  const options = parseIngressPerformanceOptions(process.argv.slice(2))
  const label = `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.smoke ? "smoke" : "matrix"}-${randomUUID().slice(0, 8)}`
  const output = join(root, "output/mods-v2-validation", `v2-ingress-${label}`)
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, "options.json"), JSON.stringify(options, null, 2))
  await build({
    entryPoints: {
      "function-mod-host": join(root, "src/main/mods/v2/host-entry.ts"),
      "mod-host": join(root, "src/main/mods/host-entry.ts"),
      "ingress-entry": join(root, "tests/support/mods-v2-ingress-performance-entry.ts")
    },
    outdir: output,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    // Native/runtime assets remain at the installed paths. No stubbed tool or model modules.
    packages: "external",
    define: { "import.meta.env": "{}", "import.meta.url": "__filename" }
  })
  // Electron's default startup exception dialog can keep a headless run alive indefinitely.
  // Catch only this fixture's startup and exit it; there is no process-global app interception.
  writeFileSync(
    join(output, "launch.cjs"),
    'try { require("./ingress-entry.cjs") } catch (error) { console.error(error); require("electron").app.exit(1) }\n'
  )
  const hashes = Object.fromEntries(
    ["function-mod-host.cjs", "mod-host.cjs", "ingress-entry.cjs", "launch.cjs"].map((file) => [
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
  const child = spawn(require("electron"), [join(output, "launch.cjs"), output], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: "inherit"
  })
  const manifest = {
    startedAt: new Date().toISOString(),
    runnerPid: process.pid,
    electronPid: child.pid,
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true
    }).trim(),
    output,
    hashes,
    options,
    stopFile: join(output, "STOP")
  }
  writeFileSync(join(output, "run.json"), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify(manifest))
  const stop = () => writeFileSync(join(output, "STOP"), "Owned ingress fixture stop requested\n")
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const timeout = setTimeout(stop, 60 * 60 * 1000)
  const watcher = setInterval(() => {
    if (!existsSync(join(output, "STOP"))) return
    clearInterval(watcher)
    const grace = setTimeout(() => {
      // This exact child is owned by this invocation. Never enumerate/kill Electron processes.
      if (child.exitCode === null) child.kill()
    }, 10000)
    grace.unref()
  }, 1000)
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
    writeFileSync(join(output, "exit.json"), JSON.stringify({ code, at: new Date().toISOString() }))
    process.exitCode = code
  } finally {
    clearTimeout(timeout)
    clearInterval(watcher)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
