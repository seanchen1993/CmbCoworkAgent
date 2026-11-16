import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import process from "node:process"
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
      mods: "mods" in window.api,
      update: await window.api.update.check()
    }))
    assert.deepEqual(preload, {
      threads: "function",
      mods: false,
      update: { hasUpdate: false, source: null }
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
  assert.ok(
    process.argv[2],
    "Usage: node scripts/smoke-macos-package.mjs </path/to/CMBDevClaw.app>"
  )
  const contents = join(resolve(process.argv[2]), "Contents")
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
  for (const binary of [executable, ripgrep]) {
    assert.equal(run("/usr/bin/lipo", ["-archs", binary]), "arm64", `${binary} must be ARM64`)
  }

  const isolated = await mkdtemp(join(tmpdir(), "cmb-macos-package-"))
  try {
    const dataRoot = join(isolated, "data")
    const home = join(isolated, "home")
    const workspace = join(isolated, "workspace 演示")
    const bin = join(isolated, "bin")
    await Promise.all([mkdir(dataRoot), mkdir(home), mkdir(workspace), mkdir(bin)])
    // The packaged terminal expects a Claude CLI on PATH. Its usage is outside this smoke test.
    await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
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
