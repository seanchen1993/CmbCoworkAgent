import { spawn as originalSpawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginHookMetadata } from "../types"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"

const observed = vi.hoisted(() => ({ count: 0, onSpawn: undefined as (() => void) | undefined }))
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof originalSpawn>) => {
      observed.count++
      const child = actual.spawn(...args)
      child.once("spawn", () => observed.onSpawn?.())
      return child
    }
  }
})
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ isEnabled: () => false }) }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { runHooks } from "./runner"
import { startOwnedHookCommand } from "./owned-command"
import type { HookConfig, HookResult } from "./types"

const roots: string[] = []
const oldPath = process.env.PATH
const bash = process.env.GIT_BASH_PATH
const python = process.env.HOOK_TEST_PYTHON || "C:/Program Files/Python312/python.exe"
const windows = process.platform === "win32"
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "hook-owned-"))
  roots.push(value)
  return value
}
function hook(command: string): HookConfig {
  return {
    id: randomUUID(),
    event: "PreToolUse",
    type: "command",
    command,
    timeout: 3000,
    enabled: true,
    createdAt: "",
    updatedAt: ""
  }
}
function context(workspace: string, signal?: AbortSignal) {
  return { sessionId: randomUUID(), workspacePath: workspace, toolName: "read_file", signal }
}
afterEach(() => {
  observed.onSpawn = undefined
  process.env.PATH = oldPath
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

it.runIf(windows)(
  "actual cancellation after native controller spawn but before observed READY owns the child tree",
  async () => {
    const workspace = root(),
      script = join(workspace, "startup.cjs")
    const pidFile = join(workspace, "pid"),
      doneFile = join(workspace, "natural-exit")
    writeFileSync(
      script,
      `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
        `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(doneFile)},"natural"),2000)`
    )
    const controller = new AbortController()
    let spawned = false
    observed.onSpawn = () => {
      spawned = true
      controller.abort(new Error("HOOK_STARTUP_CANCEL"))
    }
    await expect(
      runHooks(
        [hook(`"${process.execPath}" "${script}"`)],
        "PreToolUse",
        context(workspace, controller.signal)
      )
    ).rejects.toThrow("HOOK_STARTUP_CANCEL")
    expect(spawned).toBe(true)
    if (existsSync(pidFile)) expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false)
    await wait(2200)
    expect(existsSync(doneFile)).toBe(false)
  }
)

it("does not spawn an already cancelled Hook", async () => {
  const controller = new AbortController()
  controller.abort(new Error("EARLY_HOOK_CANCEL"))
  const before = observed.count
  await expect(
    runHooks([hook("echo should-not-start")], "PreToolUse", context(root(), controller.signal))
  ).rejects.toThrow("EARLY_HOOK_CANCEL")
  expect(observed.count).toBe(before)
})

it.runIf(windows).each(["timeout", "cancel", "output-limit"] as const)(
  "original runHooks %s physically reaps real Git Bash/Python tree before settlement",
  async (mode) => {
    expect(bash && existsSync(bash)).toBe(true)
    expect(existsSync(python)).toBe(true)
    process.env.PATH = dirname(bash!) + ";" + oldPath
    const workspace = root(),
      script = join(workspace, "sample.py")
    const pidFile = join(workspace, "pid.json"),
      doneFile = join(workspace, "natural-exit")
    const marker = randomUUID()
    writeFileSync(
      script,
      `import json,os,sys,time\n` +
        `json.loads(sys.stdin.read())\n` +
        `with open(sys.argv[1],"w") as f: json.dump({"pid":os.getpid(),"ppid":os.getppid(),"marker":sys.argv[3]},f)\n` +
        (mode === "output-limit" ? `sys.stdout.write("x"*1100000);sys.stdout.flush()\n` : "") +
        `time.sleep(6)\n` +
        `open(sys.argv[2],"w").write("natural-exit")\n`
    )
    const quote = (value: string) => '"' + value.replace(/\\/g, "/") + '"'
    const config = {
      ...hook(
        `exec ${quote(python)} -I -B ${quote(script)} ${quote(pidFile)} ${quote(doneFile)} ${quote(marker)}`
      ),
      shell: "bash" as const
    }
    const controller = new AbortController(),
      results: HookResult[] = []
    const started = Date.now()
    const actual = runHooks(
      [config],
      "PreToolUse",
      context(workspace, controller.signal),
      (_e, _h, result) => results.push(result)
    ).then(
      (result) => ({ result, error: undefined }),
      (error) => ({ result: undefined, error })
    )
    while (!existsSync(pidFile) && Date.now() - started < 2500) await wait(10)
    expect(existsSync(pidFile)).toBe(true)
    const fact = JSON.parse(readFileSync(pidFile, "utf8"))
    expect(fact.marker).toBe(marker)
    if (mode === "cancel") controller.abort(new Error("OWNED_HOOK_CANCEL"))
    const outcome = await actual
    expect(alive(fact.pid)).toBe(false)
    expect(alive(fact.ppid)).toBe(false)
    expect(existsSync(doneFile)).toBe(false)
    if (mode === "cancel") expect(String(outcome.error)).toContain("OWNED_HOOK_CANCEL")
    else {
      expect(outcome.error).toBeUndefined()
      expect(results).toHaveLength(1)
      expect(results[0].blocked).toBe(false) // ordinary Hook remains fail-open
      expect(results[0].exitCode).toBe(mode === "timeout" ? null : 1)
      expect(results[0].stderr).toContain(mode === "timeout" ? "timed out" : "output truncated")
      expect(results[0].stdout).toBe("")
    }
    // A later natural-exit marker would prove only the launcher was stopped.
    await wait(Math.max(0, started + 6300 - Date.now()))
    expect(existsSync(doneFile)).toBe(false)
  },
  12000
)

it("normal command retains JSON stdin/stdout and exit-2 blocking without the private READY prefix", async () => {
  const workspace = root(),
    script = join(workspace, "stdin.cjs")
  writeFileSync(
    script,
    `let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{const p=JSON.parse(s);console.log(JSON.stringify({decision:"block",reason:p.tool_name}));process.exitCode=2})`
  )
  const result = await runHooks(
    [hook(`"${process.execPath}" "${script}"`)],
    "PreToolUse",
    context(workspace)
  )
  expect(result?.blocked).toBe(true)
  expect(result?.stdout).toContain("read_file")
  expect(result?.stdout).not.toContain("MODS_PROCESS_STARTED")
})

it
  .runIf(windows)
  .each([
    'echo "two words" & echo %OS%',
    'echo literal^&value & echo "quote & value"',
    "echo one && echo two || echo should-not-run"
  ])("preserves original Windows cmd shell quoting and metacharacters: %s", async (command) => {
  const workspace = root(),
    results: HookResult[] = []
  const original = spawnSync(command, { shell: true, cwd: workspace, encoding: "buffer" })
  expect(original.status).toBe(0)
  await runHooks([hook(command)], "PreToolUse", context(workspace), (_e, _h, result) =>
    results.push(result)
  )
  expect(results).toHaveLength(1)
  expect(results[0].exitCode).toBe(original.status)
  expect(results[0].stdout).toBe(original.stdout.toString("utf8").trim())
})

it.runIf(windows)(
  "normal Bash launcher exit reaps its remaining real Python descendant",
  async () => {
    expect(bash && existsSync(bash)).toBe(true)
    process.env.PATH = dirname(bash!) + ";" + oldPath
    const workspace = root(),
      script = join(workspace, "daemon.py"),
      pidFile = join(workspace, "pid")
    writeFileSync(
      script,
      `import os,sys,time\nopen(sys.argv[1],"w").write(str(os.getpid()))\ntime.sleep(6)\n`
    )
    const command = `"${python}" -I -B "${script}" "${pidFile}" & while [ ! -f "${pidFile}" ]; do sleep 0.01; done; exit 0`
    const results: HookResult[] = []
    await runHooks(
      [{ ...hook(command.replace(/\\/g, "/")), shell: "bash" }],
      "PreToolUse",
      context(workspace),
      (_e, _h, result) => results.push(result)
    )
    expect(results[0].exitCode).toBe(0)
    expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false)
  }
)

it.each([300, 3000])(
  "required command timeout %ims remains blocked without a successful receipt",
  async (timeout) => {
    const workspace = root(),
      script = join(workspace, "wait.cjs")
    writeFileSync(script, "setTimeout(()=>console.log('{}'),6000)")
    const config: PluginHookMetadata = {
      ...hook(`"${process.execPath}" "${script}"`),
      timeout,
      id: "plugin:owned/gate",
      pluginId: "owned",
      pluginName: "owned",
      pluginEnabled: true,
      pluginRoot: workspace,
      hookPath: "hooks/hooks.json",
      hookSourceType: "plugin",
      hookSourceRoot: workspace
    }
    mkdirSync(join(workspace, "hooks"))
    const token = issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        threadId: "owned-thread",
        incarnationKey: "owned",
        projectId: "composition-legacy:owned:unit",
        operationId: "owned",
        workspace,
        packageDigest: "a".repeat(64),
        stageId: "check",
        plugin: { id: "owned", name: "owned", enabled: true, path: workspace } as never,
        requiredHooks: ["gate"]
      },
      () => {}
    )
    const result = await withRuntimePluginSource(token, () =>
      runHooks([config], "PreToolUse", context(workspace))
    )
    expect(result?.blocked).toBe(true)
    expect(result?.exitCode).toBe(1)
    expect(result?.stdout).toContain("REQUIRED_BUSINESS_CHECK_FAILED")
    expect(result?.stderr).toContain("timed out")
  },
  10000
)

it.runIf(windows)("real native framing cannot be forged by a child exiting 125", async () => {
  const output: Buffer[] = [],
    fake = "MODS_HOOK_SETTLED_V1:" + "b".repeat(32) + ":0\n"
  const owned = startOwnedHookCommand({
    executable: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(fake)});process.exitCode=125`],
    cwd: root(),
    env: process.env as Record<string, string>,
    stdin: "{}",
    stdout: (chunk) => output.push(chunk),
    stderr: () => {}
  })
  expect(await owned.completion).toEqual({ code: 125, error: undefined })
  expect(Buffer.concat(output).toString()).toBe(fake)
})
