import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as iconv from "iconv-lite"
import { describe, expect, it } from "vitest"

interface ControllerResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

interface ControllerOptions {
  appendTransportNewline?: boolean
  executablePath?: string
  transportPrefix?: Buffer
}

const controllerPath = path.resolve(
  __dirname,
  "../../../resources/bin/win32/background-job-controller.exe"
)

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n")
}

function decodeOutput(chunks: Buffer[], encoding: "utf8" | "gbk"): string {
  return normalizeNewlines(iconv.decode(Buffer.concat(chunks), encoding))
}

function runController(
  shellPath: string,
  shellKind: "powershell" | "cmd",
  command: string,
  extraEnv: NodeJS.ProcessEnv = {},
  options: ControllerOptions = {}
): Promise<ControllerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executablePath ?? controllerPath, [shellPath, shellKind], {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`${shellKind} controller did not settle within 15 seconds`))
    }, 15_000)

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        stdout: decodeOutput(stdout, shellKind === "cmd" ? "gbk" : "utf8"),
        stderr: decodeOutput(stderr, shellKind === "cmd" ? "gbk" : "utf8")
      })
    })
    const transport = options.appendTransportNewline === false ? command : `${command}\n`
    child.stdin.end(
      Buffer.concat([options.transportPrefix ?? Buffer.alloc(0), Buffer.from(transport, "utf8")])
    )
  })
}

function runDirectCmd(
  shellPath: string,
  command: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<ControllerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      env: { ...process.env, ...extraEnv },
      shell: shellPath,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error("direct cmd baseline did not settle within 15 seconds"))
    }, 15_000)

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        stdout: decodeOutput(stdout, "gbk"),
        stderr: decodeOutput(stderr, "gbk")
      })
    })
  })
}

function runDirectPowerShell(shellPath: string, command: string): Promise<ControllerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: shellPath,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error("direct PowerShell baseline did not settle within 15 seconds"))
    }, 15_000)

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        code,
        signal,
        stdout: decodeOutput(stdout, "utf8"),
        stderr: decodeOutput(stderr, "utf8")
      })
    })
  })
}

const describeOnWindows = process.platform === "win32" ? describe : describe.skip

describeOnWindows("Windows background Job controller fallback shells", () => {
  it("executes a real Windows PowerShell UTF-8 script without CLIXML or code-page damage", async () => {
    expect(existsSync(controllerPath)).toBe(true)
    const shell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    )
    const command = [
      "chcp 65001 >$null",
      "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
      "$OutputEncoding=[System.Text.Encoding]::UTF8",
      'Write-Output "PowerShell中文输出"',
      '[Console]::Error.WriteLine("PowerShell中文错误")',
      "exit 29"
    ].join("; ")

    const result = await runController(shell, "powershell", command)

    expect(result).toEqual({
      code: 29,
      signal: null,
      stdout: "PowerShell中文输出\n",
      stderr: "PowerShell中文错误\n"
    })
  })

  it("keeps the PowerShell stdin contract free of a UTF-8 BOM", async () => {
    const shell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    )
    const result = await runController(
      shell,
      "powershell",
      'Write-Output "must not run"',
      {},
      { transportPrefix: Buffer.from([0xef, 0xbb, 0xbf]) }
    )

    expect(result.code).toBe(126)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unexpected UTF-8 BOM on background stdin")
  })

  it("preserves Node PowerShell final-command exit semantics", async () => {
    const shell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    )
    const cases = [
      "Write-Output 'success'",
      "exit 29",
      "cmd.exe /d /c exit 37",
      "cmd.exe /d /c exit 37; Write-Output 'recovered'",
      "Write-Error 'boom'",
      "Write-Error 'boom'; Write-Output 'recovered'",
      "$ErrorActionPreference='SilentlyContinue'; Write-Error 'boom'",
      "Write-Error 'boom' -ErrorAction Ignore",
      "$ErrorActionPreference='Stop'; Write-Error 'boom'; Write-Output 'unreachable'",
      "throw 'boom'",
      "try { throw 'boom' } catch { Write-Output 'recovered' }"
    ]

    for (const command of cases) {
      const [result, direct] = await Promise.all([
        runController(shell, "powershell", command),
        runDirectPowerShell(shell, command)
      ])
      expect(
        {
          code: result.code,
          signal: result.signal,
          stdout: result.stdout,
          hasStderr: result.stderr.length > 0
        },
        command
      ).toEqual({
        code: direct.code,
        signal: direct.signal,
        stdout: direct.stdout,
        hasStderr: direct.stderr.length > 0
      })
    }
  }, 45_000)

  it("executes a real cmd UTF-8 fallback without banner/prompt and clears command text", async () => {
    const shell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
    const command = [
      "chcp 65001 >nul",
      'echo CMD中文输出-%CMB_NATIVE_TEST_VALUE%&echo "CMD引号内&符号"',
      "echo CMD中文错误 1>&2",
      "node -e \"process.stdout.write(process.env.CMB_BACKGROUND_JOB_COMMAND === undefined ? 'ENV_CLEARED' : 'ENV_LEAKED')\"",
      "exit /b 31"
    ].join(" & ")

    const extraEnv = {
      CMB_NATIVE_TEST_VALUE: "变量展开"
    }
    const [result, direct] = await Promise.all([
      runController(shell, "cmd", command, extraEnv),
      runDirectCmd(shell, command, extraEnv)
    ])

    expect(result).toEqual(direct)
    expect(result.code).toBe(31)
    expect(result.stdout).toContain("CMD中文输出-变量展开")
    expect(result.stdout).toContain('"CMD引号内&符号"')
    expect(result.stdout).toContain("ENV_CLEARED")
    expect(result.stderr).toContain("CMD中文错误")
    expect(result.stdout).not.toContain("Microsoft Windows")
    expect(result.stdout).not.toContain(process.cwd())
  })

  it("preserves cmd block syntax and prevents external programs from consuming the script", async () => {
    const shell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
    const command = [
      "chcp 65001 >nul",
      '(echo BLOCK中文一 & echo "BLOCK中文二&符号")',
      "node -e \"let value='';process.stdin.setEncoding('utf8');" +
        "process.stdin.on('data',chunk=>value+=chunk);" +
        "process.stdin.on('end',()=>process.stdout.write(value===''?'STDIN_EOF':'STDIN_LEAK'))\"",
      "echo AFTER_EXTERNAL",
      "exit /b 41"
    ].join(" & ")

    const [result, direct] = await Promise.all([
      runController(shell, "cmd", command),
      runDirectCmd(shell, command)
    ])

    expect(result).toEqual(direct)
    expect(result.code).toBe(41)
    expect(result.stdout).toContain("BLOCK中文一")
    expect(result.stdout).toContain('"BLOCK中文二&符号"')
    expect(result.stdout).toContain("STDIN_EOF")
    expect(result.stdout).toContain("AFTER_EXTERNAL")
    expect(result.stdout).not.toContain("STDIN_LEAK")
    expect(result.stderr).toBe("")
  })

  it("preserves cmd exit variants and the transport delimiter", async () => {
    const shell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"

    for (const command of ["exit /b 31", "exit 43", "cmd /d /q /c exit 47"]) {
      const [result, direct] = await Promise.all([
        runController(shell, "cmd", command, {}, { appendTransportNewline: false }),
        runDirectCmd(shell, command)
      ])
      expect(result).toEqual(direct)
    }

    const multiline = "echo BEFORE_EXIT\r\nexit 43\r\necho SHOULD_NOT_RUN"
    const [multilineResult, multilineDirect] = await Promise.all([
      runController(shell, "cmd", multiline),
      runDirectCmd(shell, multiline)
    ])
    expect(multilineResult).toEqual(multilineDirect)
  })

  it("preserves direct cmd for-variable and percent expansion semantics", async () => {
    const shell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
    const command = [
      "chcp 65001 >nul",
      "for %A in (甲 乙) do @echo FOR=%A",
      "echo ZERO=[%0] ONE=[%1] DOUBLE=[100%%] TAIL=[100%]"
    ].join(" & ")

    const [result, direct] = await Promise.all([
      runController(shell, "cmd", command),
      runDirectCmd(shell, command)
    ])

    expect(result).toEqual(direct)
    expect(result.stdout).toContain("FOR=甲")
    expect(result.stdout).not.toContain("cmb-background-job-")
  })

  it("rejects an oversized cmd command before executing any prefix", async () => {
    const shell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
    const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "cmb-job-controller-limit-"))
    const marker = path.join(isolatedDirectory, "must-not-exist.txt")
    const boundedMarker = path.join(isolatedDirectory, "bounded-must-not-exist.txt")
    try {
      const command = `echo EXECUTED>"${marker}" & rem ${"x".repeat(9_000)}`
      const result = await runController(shell, "cmd", command)
      const boundedResult = await runController(
        shell,
        "cmd",
        `echo EXECUTED>"${boundedMarker}" & rem ${"x".repeat(33_000)}`
      )

      expect(result.code).toBe(126)
      expect(result.stderr).toContain("8191-character limit")
      expect(existsSync(marker)).toBe(false)
      expect(boundedResult.code).toBe(126)
      expect(boundedResult.stderr).toContain("bounded transport limit")
      expect(existsSync(boundedMarker)).toBe(false)
    } finally {
      await rm(isolatedDirectory, { recursive: true, force: true })
    }
  })

  it("fails closed before shell start when the packaged PowerShell bootstrap is missing", async () => {
    const isolatedDirectory = await mkdtemp(path.join(tmpdir(), "cmb-job-controller-missing-"))
    const isolatedController = path.join(isolatedDirectory, path.basename(controllerPath))
    try {
      await copyFile(controllerPath, isolatedController)

      const result = await runController(
        path.join(isolatedDirectory, "shell-that-must-not-start.exe"),
        "powershell",
        'Write-Output "must not run"',
        {},
        { executablePath: isolatedController }
      )

      expect(result.code).toBe(126)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("Background shell bootstrap is missing")
      expect(result.stderr).not.toContain("Background shell failed to start")
    } finally {
      await rm(isolatedDirectory, { recursive: true, force: true })
    }
  })
})
