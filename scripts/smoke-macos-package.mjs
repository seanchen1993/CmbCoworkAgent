import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { constants, existsSync, readdirSync } from "node:fs"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import process from "node:process"
import asar from "@electron/asar"
import { _electron } from "playwright"

const marker = "CMB_MACOS_PTY_OK"

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 10_000 }).trim()
}

async function verifyApp(executable, isolated, workspace, env) {
  const application = await _electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${join(isolated, "electron")}`, "--proxy-server=http://127.0.0.1:9"],
    cwd: isolated,
    env,
    timeout: 60_000
  })
  let logs = ""
  for (const stream of [application.process().stdout, application.process().stderr]) {
    stream.setEncoding("utf8").on("data", (data) => {
      logs = (logs + data).slice(-16_384)
    })
  }

  try {
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
    const page = await application.firstWindow({ timeout: 60_000 })
    await page.waitForURL("file://**/renderer/index.html", { timeout: 30_000 })
    await page.getByRole("button", { name: "自定义设置", exact: true }).waitFor({ timeout: 30_000 })
    const preload = await page.evaluate(async () => ({
      threads: typeof window.api?.threads?.create,
      mods: typeof window.api?.mods?.status,
      design: typeof window.api?.design?.sessions?.create
    }))
    assert.deepEqual(preload, {
      threads: "function",
      mods: "function",
      design: "function"
    })
    console.log("PASS packaged Electron renderer and preload")

    await page.evaluate(
      async ({ workDir, expected }) => {
        const terminal = window.api.terminal
        const id = await terminal.create({ workDir })
        let unsubscribeData
        let unsubscribeExit
        let timeout
        try {
          await new Promise((resolvePty, reject) => {
            let output = ""
            unsubscribeData = terminal.onData(id, (data, bytes) => {
              terminal.ack(id, bytes)
              output = (output + data).slice(-16_384)
              if (output.includes(expected)) resolvePty()
            })
            unsubscribeExit = terminal.onExit(id, (code) => {
              reject(new Error(`Packaged terminal exited early (${code})\n${output}`))
            })
            timeout = setTimeout(() => {
              reject(new Error(`Packaged terminal timed out\n${output}`))
            }, 15_000)
            // Split the marker so terminal echo cannot be mistaken for command output.
            terminal.write(id, "test -f sample.txt && printf '%s%s\\n' CMB_MACOS_ PTY_OK\r")
          })
        } finally {
          clearTimeout(timeout)
          unsubscribeData?.()
          unsubscribeExit?.()
          await terminal.dispose(id)
        }
      },
      { workDir: workspace, expected: marker }
    )
    console.log("PASS packaged terminal ran a command through IPC")
  } catch (error) {
    console.error(logs)
    throw error
  } finally {
    await application.close()
  }
}

async function main() {
  assert.equal(process.platform, "darwin", "Run this smoke test on macOS")
  const [, , appPath, mode] = process.argv
  assert.ok(
    appPath && (mode === undefined || mode === "--bundle-only"),
    "Usage: node scripts/smoke-macos-package.mjs </path/to/CMBDevClaw.app> [--bundle-only]"
  )
  const contents = join(resolve(appPath), "Contents")
  const resources = join(contents, "Resources")
  const plist = join(contents, "Info.plist")
  const executableName = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist])
  assert.ok(executableName && executableName === basename(executableName))
  assert.equal(
    run("/usr/libexec/PlistBuddy", ["-c", "Print :LSMinimumSystemVersion", plist]),
    "13.0"
  )
  const executable = join(contents, "MacOS", executableName)
  const ripgrep = join(resources, "bin", "darwin", "rg")
  const ptyRoot = join(resources, "app.asar.unpacked", "node_modules", "node-pty")
  // node-pty looks for the native module in this order and starts its sibling helper.
  const ptyDirectory = [
    join(ptyRoot, "build", "Release"),
    join(ptyRoot, "build", "Debug"),
    join(ptyRoot, "prebuilds", "darwin-arm64")
  ].find((directory) => existsSync(join(directory, "pty.node")))
  assert.ok(ptyDirectory, `No native PTY module found in ${ptyRoot}`)
  const ptyModule = join(ptyDirectory, "pty.node")
  const spawnHelper = join(ptyDirectory, "spawn-helper")
  for (const binary of [executable, ripgrep, spawnHelper]) {
    await access(binary, constants.X_OK)
  }
  for (const binary of [executable, ripgrep, ptyModule, spawnHelper]) {
    assert.equal(run("/usr/bin/lipo", ["-archs", binary]), "arm64", `${binary} must be ARM64`)
  }
  console.log("PASS bundled ARM64 native PTY and executable spawn-helper")

  const archive = join(resources, "app.asar")
  const entries = new Set(asar.listPackage(archive).map((entry) => entry.replace(/^\//, "")))
  for (const entry of [
    "out/main/index.js",
    "out/main/mod-host.js",
    "out/main/function-mod-host.js",
    "out/main/mods-cli.js",
    "out/main/code-exec-helper.js",
    "out/preload/index.js",
    "out/renderer/index.html",
    "out/skills",
    "out/resources/mods",
    "out/resources/mods-policy.json"
  ]) {
    assert.ok(entries.has(entry), `Missing packaged resource: ${entry}`)
  }
  for (const directory of ["design-systems", "design-templates", "pets"]) {
    assert.ok(readdirSync(join(resources, directory)).length > 0, `Empty packaged ${directory}`)
  }
  const esbuild = join(
    resources,
    "app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild"
  )
  await access(esbuild, constants.X_OK)
  assert.equal(run("/usr/bin/lipo", ["-archs", esbuild]), "arm64")
  console.log("PASS packaged Mods, skills, design resources and ARM64 esbuild")

  const isolated = await mkdtemp(join(tmpdir(), "cmb-macos-package-"))
  try {
    const dataRoot = join(isolated, "data")
    const home = join(isolated, "home")
    const workspace = join(isolated, "workspace 演示")
    const bin = join(isolated, "bin")
    await Promise.all([mkdir(workspace), mkdir(dataRoot), mkdir(home), mkdir(bin)])
    const fixture = join(workspace, "sample.txt")
    await writeFile(fixture, "packaged ripgrep fixture\n")
    assert.equal(
      run(ripgrep, ["--no-config", "--fixed-strings", "--no-filename", "ripgrep", fixture]),
      "packaged ripgrep fixture"
    )
    console.log("PASS bundled ARM64 ripgrep")
    // The packaged terminal expects a Claude CLI. Keep this fixture fully offline.
    const claude = join(bin, "claude")
    await writeFile(claude, "#!/bin/sh\nexit 0\n", { mode: 0o755 })

    // Run inside the packaged Electron runtime to catch ABI errors and ASAR
    // resolution failures. This also checks UAT bundles without starting the UI.
    const runtimeScript = join(isolated, "runtime-check.cjs")
    await writeFile(
      runtimeScript,
      String.raw`
const assert = require("node:assert/strict")
const { createRequire } = require("node:module")
const { join } = require("node:path")
const load = createRequire(join(process.argv[2], "app.asar", "package.json"))
async function main() {
  assert.equal(process.arch, "arm64")
  const compiler = load(load.resolve("esbuild").replace(/\.asar([\\/])/, ".asar.unpacked$1"))
  const compiled = compiler.transformSync("const value: number = 42", { loader: "ts" })
  assert.match(compiled.code, /42/)
  console.log("PASS packaged esbuild compiled TypeScript")
  const vm = (await load("quickjs-emscripten").getQuickJS()).newContext()
  try {
    const value = vm.unwrapResult(vm.evalCode("21 * 2"))
    try { assert.equal(vm.dump(value), 42) } finally { value.dispose() }
  } finally { vm.dispose() }
  console.log("PASS packaged QuickJS loaded WASM and executed JavaScript")
  await new Promise((resolve, reject) => {
    const terminal = load("node-pty").spawn("/bin/zsh", ["-f", "-c", "test -f sample.txt && printf '%s%s\\n' CMB_NATIVE_ PTY_OK"], {
      cwd: process.argv[3], env: process.env
    })
    let output = ""
    const timer = setTimeout(() => { terminal.kill(); reject(new Error("Native PTY timed out: " + output)) }, 10000)
    terminal.onData((data) => { output += data })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      try { assert.equal(exitCode, 0); assert.match(output, /CMB_NATIVE_PTY_OK/); resolve() } catch (error) { reject(error) }
    })
  })
  console.log("PASS packaged node-pty executed a command in a Unicode path")
  // Exercise the real unpacked PTY host too: resolving node-pty from the wrong
  // root produces app.asar.unpacked.unpacked and breaks only this forked path.
  await new Promise((resolve, reject) => {
    const host = require("node:child_process").fork(
      join(process.argv[2], "app.asar.unpacked", "out", "main", "pty-host.js"), [],
      { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] }
    )
    let output = "", errors = "", passed = false, settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      host.kill()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error("Packaged PTY host timed out: " + output + errors)), 10000)
    host.stderr.on("data", (data) => { errors = (errors + data).slice(-8192) })
    host.on("error", fail)
    host.on("message", (message) => {
      if (message.type === "ready") host.send({
        type: "create", id: "smoke", workDir: process.argv[3], cols: 80, rows: 24,
        claudePath: process.argv[4], args: [], electronPath: process.execPath
      })
      if (message.type === "created") host.send({
        type: "write", id: "smoke", data: "test -f sample.txt && printf '%s%s\\n' CMB_HOST_ PTY_OK\r"
      })
      if (message.type === "error") fail(new Error(message.error))
      if (message.type === "data" && !passed) {
        output += message.data
        if (output.includes("CMB_HOST_PTY_OK")) { passed = true; host.disconnect() }
      }
    })
    host.once("exit", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (passed && code === 0) resolve()
      else reject(new Error("Packaged PTY host exited " + code + ": " + output + errors))
    })
  })
  console.log("PASS packaged unpacked PTY host created a terminal and executed a command")
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
`
    )
    const runtimeOutput = execFileSync(executable, [runtimeScript, resources, workspace, claude], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        TMPDIR: tmpdir(),
        SHELL: "/bin/zsh",
        ELECTRON_RUN_AS_NODE: "1"
      }
    })
    process.stdout.write(runtimeOutput)
    if (mode === "--bundle-only") return

    await writeFile(
      join(dataRoot, "userinfo-models.json"),
      JSON.stringify({ sapId: "localhost-fixture", userName: "Local fixture" })
    )
    const env = {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      TMPDIR: tmpdir(),
      SHELL: "/bin/zsh",
      CMB_COWORK_AGENT_HOME: dataRoot,
      CMB_COWORK_TRACE_STORAGE_MODE: "off",
      CMB_TASK_CARDS_MOCK: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost"
    }
    await verifyApp(executable, isolated, workspace, env)
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
}

await main()
