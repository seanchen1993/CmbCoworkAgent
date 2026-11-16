import assert from "node:assert/strict"
import { execFileSync, fork } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import process from "node:process"
import { _electron } from "playwright"

const marker = "CMB_MACOS_PTY_OK"

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 10_000 }).trim()
}

function verifyTerminal(executable, resources, cwd, env) {
  const hostPath = join(resources, "app.asar.unpacked", "out", "main", "pty-host.js")
  return new Promise((resolvePty, reject) => {
    const host = fork(hostPath, [], {
      cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      execArgv: [],
      execPath: executable,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    })
    let output = ""
    let stderr = ""
    let stopping = false
    const timer = setTimeout(() => fail(new Error("Packaged PTY timed out")), 15_000)

    function fail(error) {
      clearTimeout(timer)
      host.kill("SIGKILL")
      reject(new Error(`${error.message}\nPTY output: ${output}\nPTY stderr: ${stderr}`))
    }

    function send(message) {
      host.send(message, (error) => {
        if (error) fail(error)
      })
    }

    host.stdout.resume()
    host.stderr.setEncoding("utf8").on("data", (data) => {
      stderr = (stderr + data).slice(-16_384)
    })
    host.once("error", fail)
    host.once("close", (code, signal) => {
      clearTimeout(timer)
      if (stopping && code === 0) resolvePty()
      else fail(new Error(`Packaged PTY exited early (${signal ?? code})`))
    })
    host.on("message", (message) => {
      if (message.type === "ready") {
        send({
          type: "create",
          id: "macos-package-smoke",
          workDir: cwd,
          cols: 80,
          rows: 24,
          claudePath: "/bin/echo",
          args: [marker],
          electronPath: executable
        })
      } else if (message.type === "error") {
        fail(new Error(message.error))
      } else if (message.type === "data" && !stopping) {
        output = (output + message.data).slice(-16_384)
        if (output.includes(marker)) {
          stopping = true
          send({ type: "disposeAll" })
        }
      }
    })
  })
}

async function verifyApp(executable, isolated, env) {
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
    const preload = await page.evaluate(() => ({
      threads: typeof window.api?.threads?.create,
      mods: "mods" in window.api
    }))
    assert.deepEqual(preload, { threads: "function", mods: false })
  } catch (error) {
    console.error(logs)
    throw error
  } finally {
    await application.close()
  }
}

async function main() {
  assert.equal(process.platform, "darwin", "Run this smoke test on macOS")
  assert.ok(
    process.argv[2],
    "Usage: node scripts/smoke-macos-package.mjs </path/to/CMBDevClaw.app>"
  )
  const contents = join(resolve(process.argv[2]), "Contents")
  const resources = join(contents, "Resources")
  const executableName = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleExecutable",
    join(contents, "Info.plist")
  ])
  assert.ok(executableName && executableName === basename(executableName))
  const executable = join(contents, "MacOS", executableName)
  const ripgrep = join(resources, "bin", "darwin", "rg")
  for (const binary of [executable, ripgrep]) {
    assert.equal(run("/usr/bin/lipo", ["-archs", binary]), "arm64", `${binary} must be ARM64`)
  }

  const isolated = await mkdtemp(join(tmpdir(), "cmb-macos-package-"))
  try {
    const dataRoot = join(isolated, "data")
    const home = join(isolated, "home")
    const workspace = join(isolated, "workspace 演示")
    await Promise.all([mkdir(dataRoot), mkdir(home), mkdir(workspace)])
    const fixture = join(workspace, "sample.txt")
    await writeFile(fixture, "packaged ripgrep fixture\n")
    assert.equal(
      run(ripgrep, ["--no-config", "--fixed-strings", "--no-filename", "ripgrep", fixture]),
      "packaged ripgrep fixture"
    )
    console.log("PASS bundled ARM64 ripgrep")

    await writeFile(
      join(dataRoot, "userinfo-models.json"),
      JSON.stringify({ sapId: "localhost-fixture", userName: "Local fixture" })
    )
    const env = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
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
    await verifyTerminal(executable, resources, workspace, env)
    console.log("PASS packaged PTY host spawned a command")
    await verifyApp(executable, isolated, env)
    console.log("PASS packaged Electron renderer and preload")
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
}

await main()
