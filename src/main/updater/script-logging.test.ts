import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { spawn, spawnSync } from "child_process"
import { tmpdir } from "os"
import { join } from "path"
import AdmZip from "adm-zip"

const state = vi.hoisted(() => ({ root: "" }))
vi.mock("electron", () => ({
  app: {
    getPath: () => join(state.root, "app", "CMBDevClaw.exe"),
    getVersion: () => "1.4.10",
    quit: vi.fn()
  }
}))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root }))

import { bashLoggingHeader } from "./script-logging"
import {
  generateFullZipUpdatePs1,
  generateFullZipUpdateSh,
  generateRollbackPs1,
  generateRollbackSh,
  generateUpdatePs1,
  generateUpdateSh,
  writePowerShellScript,
  writePs1Launcher
} from "./installer"

const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe"
const bash = process.platform === "win32" ? gitBash : "bash"
const bashAvailable = process.platform !== "win32" || existsSync(gitBash)

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "cmb 更新 script-"))
  vi.stubGlobal("process", { ...process, resourcesPath: join(state.root, "app", "resources") })
})

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function runDetachedLauncher(launcher: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/c", launcher], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, TEMP: state.root, TMP: state.root }
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Launcher terminated by ${signal}`))
      else resolve(code)
    })
  })
}

async function runPowerShell(content: string): Promise<{ status: number | null; log: string }> {
  const script = join(state.root, "diagnostic.ps1")
  writePowerShellScript(script, content)
  const launcher = writePs1Launcher(script)
  const status = await runDetachedLauncher(launcher)
  return {
    status,
    log: readFileSync(join(state.root, "diagnostic.launcher.log"), "utf-8")
  }
}

describe.skipIf(process.platform !== "win32")(
  "PowerShell update diagnostics",
  { timeout: 30000 },
  () => {
    it("records quiet success, caught failure, unhandled failure and preserves past attempts", async () => {
      const success = await runPowerShell("Write-UpdateStage 'fixture-success'")
      expect(success.status).toBe(0)
      expect(success.log).toContain("Script body completed")
      expect(success.log).toContain("launch-exit code=0")
      const failure = await runPowerShell("throw 'fixture-error'")
      expect(failure.status).toBe(1)
      expect(failure.log).toContain("fixture-success")
      expect(failure.log).toContain("Unhandled error: fixture-error")
      expect(failure.log).toContain("launch-exit code=1")
    })

    it("captures syntax errors before the script can start logging", async () => {
      const result = await runPowerShell("if (")
      expect(result.status).not.toBe(0)
      expect(result.log).toContain("launch-start")
      expect(result.log).toContain("ParserError")
      expect(result.log).toContain("launch-exit code=1")
      expect(result.log).toContain(state.root)
      expect(result.log).not.toContain("\uFFFD")
    })

    it("preserves Chinese diagnostic text in the UTF-8 launcher log", async () => {
      const result = await runPowerShell("Write-UpdateStage '版本校验失败：实际 1.5.0，预期 1.5.1'")
      expect(result.status).toBe(0)
      expect(result.log).toContain("版本校验失败：实际 1.5.0，预期 1.5.1")
    })

    it("preserves an explicit script exit code", async () => {
      const result = await runPowerShell("exit 7")
      expect(result.status).toBe(7)
      expect(result.log).toContain("launch-exit code=7")
      expect(result.log).toContain("powershell-exit code=7")
    })

    it("still executes the update body when the PowerShell log cannot be written", async () => {
      const script = join(state.root, "diagnostic.ps1")
      writePowerShellScript(
        script,
        "[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'completed'), 'success')"
      )
      const launcher = writePs1Launcher(script)
      mkdirSync(join(state.root, "diagnostic.launcher.log"))
      expect(await runDetachedLauncher(launcher)).toBe(0)
      expect(readFileSync(join(state.root, "completed"), "utf-8")).toBe("success")
    })

    it("records a real ZIP extraction failure with its versions and stage", async () => {
      const appDir = join(state.root, "app")
      mkdirSync(appDir)
      const result = await runPowerShell(
        "function Get-Process {}\n" +
          generateFullZipUpdatePs1(
            join(state.root, "missing.zip"),
            appDir,
            join(appDir, "CMBDevClaw.exe"),
            "1.4.10",
            "1.5.0",
            "1.5.1",
            "staging",
            "1.5.0"
          )
      )
      expect(result.status).toBe(1)
      expect(result.log).toContain("Extracting ZIP")
      expect(result.log).toContain("Operation failed")
      expect(result.log).toContain('"toVersion":"1.5.0"')
      expect(result.log).toContain('"releaseVersion":"1.5.1"')
      expect(existsSync(appDir)).toBe(true)
    })

    it("logs a successful ZIP swap and restart handoff in an isolated fixture", async () => {
      const appDir = join(state.root, "app")
      mkdirSync(appDir)
      writeFileSync(join(appDir, "old-file"), "old")
      const zipPath = join(state.root, "fixture.zip")
      const zip = new AdmZip()
      zip.addFile("CMBDevClaw.exe", Buffer.from("fixture executable; never launched"))
      zip.addFile("resources/app.asar", Buffer.from("fixture ASAR"))
      zip.writeZip(zipPath)
      const result = await runPowerShell(
        "function Get-Process {}\nfunction Start-Process { [pscustomobject]@{ Id = 12345 } }\n" +
          generateFullZipUpdatePs1(
            zipPath,
            appDir,
            join(appDir, "CMBDevClaw.exe"),
            "1.4.10",
            "1.5.0",
            "1.5.1",
            "stable",
            "1.5.0"
          )
      )
      expect(result.status).toBe(0)
      expect(result.log).toContain("Swapping installation")
      expect(result.log).toContain("Restart spawned: pid=12345; startup self-check pending")
      const marker = JSON.parse(
        readFileSync(join(appDir, "resources", "update-marker.json"), "utf-8").replace(
          /^\uFEFF/,
          ""
        )
      )
      expect(marker).toMatchObject({
        toVersion: "1.5.0",
        releaseVersion: "1.5.1",
        channel: "stable"
      })
      expect(existsSync(`${appDir}.bak`)).toBe(true)
    })

    it("records ASAR update and rollback failures before exiting", async () => {
      const update = await runPowerShell(
        "function Get-Process {}\n" +
          generateUpdatePs1(join(state.root, "missing-asar"), "1.5.0", "1.5.1")
      )
      expect(update.status).toBe(1)
      expect(update.log).toContain("New ASAR not found")
      const rollback = await runPowerShell(
        "function Get-Process {}\n" + generateRollbackPs1(join(state.root, "missing-backup"))
      )
      expect(rollback.status).toBe(1)
      expect(rollback.log).toContain("Restoring ASAR")
      expect(rollback.log).toContain("Operation failed")
    })
  }
)

describe.skipIf(!bashAvailable)("bash update diagnostics", { timeout: 30000 }, () => {
  it("does not abort installation when opening or writing the log fails", () => {
    const blockedPath = state.root
      .replace(/\\/g, "/")
      .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    const result = spawnSync(
      bash,
      [
        "-c",
        `set -e\nLOG_FILE="$UPDATE_LOG"\n${bashLoggingHeader()}\nprintf() { return 1; }\nupdate_stage failed-write\necho installation-completed`
      ],
      {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 10000,
        env: { ...process.env, UPDATE_LOG: blockedPath }
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("installation-completed")
  })

  it("appends start/end/error records and preserves a failing command's exit code", () => {
    const logPath = join(state.root, "bash.log")
    const unixPath = logPath
      .replace(/\\/g, "/")
      .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    const run = (body: string) =>
      spawnSync(bash, ["-c", `set -e\nLOG_FILE="$UPDATE_LOG"\n${bashLoggingHeader()}\n${body}`], {
        encoding: "utf-8",
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, UPDATE_LOG: unixPath }
      })
    expect(run("update_stage fixture-success").status).toBe(0)
    expect(run("false").status).toBe(1)
    const log = readFileSync(logPath, "utf-8")
    expect(log).toContain("fixture-success")
    expect(log).toContain("Script exited: code=0")
    expect(log).toContain("Command failed: line=")
    expect(log).toContain("Script exited: code=1")
  })

  it("keeps all generated Linux install/rollback scripts valid", () => {
    const scripts = [
      generateUpdateSh("/tmp/update.tmp", "1.5.0", "1.5.1"),
      generateRollbackSh("/opt/app/resources/app.asar.bak"),
      generateFullZipUpdateSh(
        "/tmp/full.zip",
        "/opt/app",
        "/opt/app/cmbdevclaw",
        "1.4.10",
        "1.5.0",
        "1.5.1"
      )
    ]
    for (const script of scripts) {
      const result = spawnSync(bash, ["-n"], {
        input: script,
        encoding: "utf-8",
        windowsHide: true
      })
      expect(result.status, result.stderr).toBe(0)
    }
  })
})
