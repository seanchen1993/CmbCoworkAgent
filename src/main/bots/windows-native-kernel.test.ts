import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotHostLock } from "./host-lock"
import { createBotHostShellFactory } from "./host-shell-factory"
import { BotShellProcess } from "./shell-process"
import { inspectOwnedShellReceipts } from "./owned-shell-receipts"
import { botShellResultSandboxName, type BotShellRequest } from "./shell-contract"
import type { OwnedShellResource } from "./owned-shell-process"
import { loadWindowsNativeTestConfiguration } from "./windows-native-test-configuration"
const enabled = process.platform === "win32" && process.env.CMB_BOT_NATIVE_WINDOWS_TEST === "1"
const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
async function fixture(source: string, readOnly = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-windows-kernel-"))),
    workspace = join(root, "workspace")
  const { directory, windowsNative } = await loadWindowsNativeTestConfiguration(process.env)
  await mkdir(workspace)
  const sentinel = join(
    directory,
    `native-acceptance-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  )
  await writeFile(sentinel, "HOST_PRIVATE", { flag: "wx" })
  await writeFile(join(workspace, "task.cjs"), source)
  const lock = BotHostLock.acquire(directory)
  if (!lock) throw new Error("Actual fixture lock unavailable")
  closes.push(async () => {
    try {
      if ((await inspectOwnedShellReceipts(join(directory, "shell-resources"))).length) {
        console.error("Unproven Windows fixture retained", { directory, workspace })
        return
      }
      await unlink(sentinel)
      await rm(root, { recursive: true, force: true })
    } finally {
      lock.release()
    }
  })
  // Explicit setup is completed separately in application settings. This test
  // never requests administrator elevation or substitutes capability booleans.
  const factory = await createBotHostShellFactory({
    directory,
    helperEntry: resolve("out/main/bot-shell-owner.js"),
    workerEntry: resolve("out/main/bot-shell.js"),
    hostId: () => "windows-native-acceptance",
    dataEpoch: () => "kernel-test",
    assertOwnership: async (signal) => {
      signal.throwIfAborted()
      await lock.checkCurrent()
    },
    windowsNative
  })
  let resource: OwnedShellResource | undefined
  const runner = new BotShellProcess(async (request, signal) => ({
    ...(await factory(request, signal)),
    resourceReady: (value) => {
      resource = value
    }
  }))
  const request: BotShellRequest = {
    command: "trusted-node-protocol",
    cwd: workspace,
    workspaceRoot: workspace,
    readOnly,
    runId: "actual-windows-kernel",
    timeoutMs: 45000,
    hook: {
      invocation: { executable: process.execPath, args: [join(workspace, "task.cjs")] },
      stdin: "{}",
      env: {}
    },
    execution: { windowsSandbox: "none", resourceDirectory: resolve("resources") }
  }
  return { directory, workspace, sentinel, request, runner, resource: () => resource }
}
async function started(path: string) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if ((await readFile(path).catch(() => Buffer.alloc(0))).length) return
    await delay(25)
  }
  throw new Error("Actual native command did not start")
}
it.skipIf(!enabled)(
  "Windows actual compiled owner admits fixed sandbox PID only inside the atomic Job and returns real result",
  async () => {
    const f = await fixture("console.log('ACTUAL_WINDOWS_JOB');process.exitCode=7")
    const result = await f.runner.execute(f.request, new AbortController().signal)
    expect(result.exitCode).toBe(7)
    expect(result.output).toContain("ACTUAL_WINDOWS_JOB")
    expect(f.resource()?.containment).toBe("verified-windows-atomic-job-v2")
    expect(botShellResultSandboxName(result)).toBe("windows-codex-atomic-job-v2")
    expect(await inspectOwnedShellReceipts(join(f.directory, "shell-resources"))).toEqual([])
  },
  60000
)
it.skipIf(!enabled)(
  "Windows actual compiled command denies protected Host reads and read-only workspace writes",
  async () => {
    const f = await fixture(
      `const fs=require('node:fs');let read=false,write=false;try{fs.readFileSync(${JSON.stringify("PLACEHOLDER")})}catch{read=true}try{fs.writeFileSync('write-denied.txt','x')}catch{write=true}console.log(JSON.stringify({read,write}));if(!read||!write)process.exitCode=9`,
      true
    )
    const script = join(f.workspace, "task.cjs")
    await writeFile(
      script,
      (await readFile(script, "utf8")).replace(
        JSON.stringify("PLACEHOLDER"),
        JSON.stringify(f.sentinel)
      )
    )
    const result = await f.runner.execute(f.request, new AbortController().signal)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('"read":true')
    expect(result.output).toContain('"write":true')
    expect(await inspectOwnedShellReceipts(join(f.directory, "shell-resources"))).toEqual([])
  },
  60000
)
it.skipIf(!enabled)(
  "Windows actual native cancellation drains detached descendants before dropping the resource receipt",
  async () => {
    const child = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync('ticks','x'),25);setTimeout(()=>process.exit(0),60000)`
    const f = await fixture(
        `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`
      ),
      cancel = new AbortController()
    const completion = f.runner.execute(f.request, cancel.signal)
    void completion.catch(() => {})
    await started(join(f.workspace, "ticks"))
    cancel.abort(new Error("actual Windows cancellation"))
    await expect(completion).rejects.toThrow()
    const before = await readFile(join(f.workspace, "ticks"))
    await delay(250)
    expect(await readFile(join(f.workspace, "ticks"))).toEqual(before)
    expect(await inspectOwnedShellReceipts(join(f.directory, "shell-resources"))).toEqual([])
  },
  60000
)
it.skipIf(!enabled)(
  "Windows killing the real compiled owner retains unknown business outcome while the native Job proves descendants drained",
  async () => {
    const child = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync('ticks','x'),25);setTimeout(()=>process.exit(0),60000)`
    const f = await fixture(
      `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`
    )
    const completion = f.runner.execute(f.request, new AbortController().signal)
    void completion.catch(() => {})
    await started(join(f.workspace, "ticks"))
    const owner = f.resource()
    expect(owner?.helperPid).toBeGreaterThan(0)
    process.kill(owner!.helperPid, "SIGKILL")
    await expect(completion).rejects.toThrow()
    const before = await readFile(join(f.workspace, "ticks"))
    await delay(250)
    expect(await readFile(join(f.workspace, "ticks"))).toEqual(before)
    expect(await inspectOwnedShellReceipts(join(f.directory, "shell-resources"))).toEqual([])
  },
  60000
)

it.skipIf(!enabled)(
  "Windows ancestor-workspace write grant cannot open the compiled runtime for writing",
  async () => {
    const f = await fixture("unused"),
      code = resolve("out/main/bot-shell.js"),
      repo = await realpath(resolve("."))
    f.request.cwd = repo
    f.request.workspaceRoot = repo
    f.request.hook!.invocation = {
      executable: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs');let denied=false;try{const fd=fs.openSync(${JSON.stringify(code)},'r+');fs.closeSync(fd)}catch{denied=true}console.log('RUNTIME_WRITE_DENIED='+denied);if(!denied)process.exitCode=9`
      ]
    }
    const before = await readFile(code),
      result = await f.runner.execute(f.request, new AbortController().signal)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("RUNTIME_WRITE_DENIED=true")
    expect(await readFile(code)).toEqual(before)
    expect(await inspectOwnedShellReceipts(join(f.directory, "shell-resources"))).toEqual([])
  },
  60000
)
