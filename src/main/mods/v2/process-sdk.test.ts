import { mkdtemp, rm } from "node:fs/promises"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModObject } from "../../../shared/mods/types"
import { afterEach, expect, it, vi } from "vitest"
import {
  FunctionProcessHost,
  functionProcessRequest,
  type FunctionProcessContext
} from "./process-sdk"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function context(): Promise<FunctionProcessContext & { controller: AbortController }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "mods-process-"))
  directories.push(cwd)
  const controller = new AbortController()
  return {
    cwd,
    controller,
    signal: controller.signal,
    assertLive: vi.fn(),
    authorize: vi.fn(async () => {}),
    publish: vi.fn(async (value) => value)
  }
}
const js = (source: string, args: string[] = []) => [process.execPath, "-e", source, "--", ...args]

it("waits for exact sleep without requesting OS process authority", async () => {
  const c = await context()
  c.authorize = vi.fn(async () => { throw Error("external command denied") })
  expect(await new FunctionProcessHost().run({ argv: ["sleep", "0.01"] }, c))
    .toEqual({ exitCode: 0, stdout: "", stderr: "" })
  expect(c.authorize).not.toHaveBeenCalled()
  expect(c.publish).toHaveBeenCalledOnce()
})

const nonWaitInputs: ModObject[] = [
  { argv: ["/bin/sleep", "0"] }, { argv: ["sleep.exe", "0"] },
  { argv: ["sleep", "-0"] }, { argv: ["sleep", "1e-3"] },
  { argv: ["sleep", "Infinity"] }, { argv: ["sleep", "1", "2"] },
  { argv: ["sleep", "9".repeat(400)] },
  { argv: ["sleep", "0"], init: { env: {} } },
  { argv: ["sleep", "0"], init: { stdin: "" } }
]
it.each(nonWaitInputs)("retains external authorization for non-wait input %j", async input => {
  const c = await context()
  c.authorize = vi.fn(async () => { throw Error("external command denied") })
  await expect(new FunctionProcessHost().run(input, c)).rejects.toThrow("external command denied")
  expect(c.authorize).toHaveBeenCalledOnce()
  expect(c.publish).not.toHaveBeenCalled()
})

it("cancels internal waiting and enforces timeout without publishing success", async () => {
  const c = await context()
  const run = new FunctionProcessHost().run({ argv: ["sleep", "1"] }, c)
  setTimeout(() => c.controller.abort(Error("cancelled")), 10)
  await expect(run).rejects.toThrow("cancelled")
  expect(c.publish).not.toHaveBeenCalled()
  const timed = await context()
  await expect(new FunctionProcessHost().run({ argv: ["sleep", "999999999999999999999"],
    init: { timeoutMs: 10 } }, timed)).rejects.toThrow("MODS_PROCESS_TIMEOUT")
  expect(timed.publish).not.toHaveBeenCalled()
})

it("keeps spawn sleep behind the original process authorization", async () => {
  const c = await context()
  c.authorize = vi.fn(async () => { throw Error("spawn denied") })
  const spawned = new FunctionProcessHost().spawn({ argv: ["sleep", "0"] }, c)
  await expect(spawned.stream.next()).rejects.toThrow("spawn denied")
  await expect(spawned.result).rejects.toThrow("spawn denied")
  expect(c.authorize).toHaveBeenCalledOnce()
})

it("checks cwd, revocation and publish fences for internal waiting", async () => {
  const c = await context()
  await expect(new FunctionProcessHost().run({ argv: ["sleep", "0"],
    init: { cwd: "does-not-exist" } }, c)).rejects.toThrow()
  c.assertLive = () => { throw Error("revoked") }
  await expect(new FunctionProcessHost().run({ argv: ["sleep", "0"] }, c)).rejects.toThrow("revoked")
  const during = await context()
  const pending = new FunctionProcessHost().run({ argv: ["sleep", "0.03"] }, during)
  setTimeout(() => { during.assertLive = () => { throw Error("revoked") } }, 5)
  await expect(pending).rejects.toThrow("revoked")
  expect(during.publish).not.toHaveBeenCalled()
  const publish = await context()
  publish.publish = async () => { throw Error("publish denied") }
  await expect(new FunctionProcessHost().run({ argv: ["sleep", "0"] }, publish))
    .rejects.toThrow("publish denied")
  const after = await context()
  after.publish = async value => { after.assertLive = () => { throw Error("stale") }; return value }
  await expect(new FunctionProcessHost().run({ argv: ["sleep", "0"] }, after)).rejects.toThrow("stale")
})

it("validates argv, fields, input, environment and freezes approval arguments", async () => {
  const c = await context()
  const value = await functionProcessRequest(
    { argv: ["x", ""], init: { env: { X: "a" } } },
    c.cwd,
    false
  )
  expect(Object.isFrozen(value.argv)).toBe(true)
  expect(Object.isFrozen(value.env)).toBe(true)
  const invalidInputs: ModObject[] = [
    { argv: [] },
    { argv: ["x\0"] },
    { argv: ["x"], init: { env: { "a=b": "c" } } },
    { argv: ["x"], init: { timeoutMs: 600001 } },
    { argv: ["x"], init: { stdin: "x".repeat(524289) } }
  ]
  for (const input of invalidInputs)
    await expect(functionProcessRequest(input, c.cwd, false)).rejects.toThrow()
})

it("executes exact argv including Windows quotes/backslashes/empty values without shell", async () => {
  const c = await context()
  const argv = ["", "a b", 'a"b', "trailing\\", 'both\\"end\\', "&echo INJECTED", "中文😀"]
  const value = await new FunctionProcessHost().run(
    {
      argv: js(
        "process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exitCode=7",
        argv
      )
    },
    c
  )
  expect(value).toEqual({ exitCode: 7, stdout: JSON.stringify(argv), stderr: "" })
  expect(c.authorize).toHaveBeenCalledOnce()
})

it("forwards stdin and approved env but excludes ambient secrets", async () => {
  const c = await context()
  process.env.MODS_PROCESS_AMBIENT_SECRET = "must-not-inherit"
  try {
    const value = await new FunctionProcessHost().run(
      {
        argv: js(
          "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify([s,process.env.EXPLICIT,process.env.MODS_PROCESS_AMBIENT_SECRET||null,process.cwd()])));"
        ),
        init: { stdin: "中文😀", env: { EXPLICIT: "yes" } }
      },
      c
    )
    expect(JSON.parse(value.stdout as string)).toEqual(["中文😀", "yes", null, c.cwd])
  } finally {
    delete process.env.MODS_PROCESS_AMBIENT_SECRET
  }
})

it("does not start before first pull or after denied/stale approval", async () => {
  const c = await context()
  const spawned = new FunctionProcessHost().spawn({ argv: js("console.log('started')") }, c)
  expect(c.authorize).not.toHaveBeenCalled()
  await spawned.close()
  await expect(spawned.result).rejects.toThrow("MODS_PROCESS_CLOSED")
  c.authorize = async () => {
    throw new Error("denied")
  }
  await expect(
    new FunctionProcessHost().run({ argv: js("console.log('started')") }, c)
  ).rejects.toThrow("denied")
  c.authorize = async () => {
    c.assertLive = () => {
      throw new Error("stale")
    }
  }
  await expect(
    new FunctionProcessHost().run({ argv: js("console.log('started')") }, c)
  ).rejects.toThrow("stale")
})

it("streams stdout and stderr with independent result and UTF8 completeness", async () => {
  const c = await context()
  const spawned = new FunctionProcessHost().spawn(
    {
      argv: js(
        "const b=Buffer.from('中文😀');process.stdout.write(b.subarray(0,2));setTimeout(()=>{process.stdout.write(b.subarray(2));process.stderr.write('err');process.exitCode=3},20)"
      )
    },
    c
  )
  const chunks: Record<string, string> = { stdout: "", stderr: "" }
  for await (const value of spawned.stream) chunks[value.stream as string] += value.text as string
  expect(chunks).toEqual({ stdout: "中文😀", stderr: "err" })
  expect(await spawned.result).toEqual({ code: 3, signal: null })
})

it("drains oversized run output and keeps bounded prefixes without deadlock", async () => {
  const c = await context()
  const value = await new FunctionProcessHost().run(
    {
      argv: js(
        "process.stdout.write('x'.repeat(2*1024*1024));process.stderr.write('y'.repeat(2*1024*1024))"
      )
    },
    c
  )
  expect((value.stdout as string).length).toBe(256 * 1024)
  expect((value.stderr as string).length).toBe(256 * 1024)
})

it("fails nonexistent executable on first pull instead of returning helper status 126", async () => {
  const c = await context()
  const spawned = new FunctionProcessHost().spawn(
    { argv: [path.join(c.cwd, "nonexistent-executable")] },
    c
  )
  await expect(spawned.stream.next()).rejects.toThrow("MODS_PROCESS_START")
  await expect(spawned.result).rejects.toThrow("MODS_PROCESS_START")
})

it("closes an outstanding pull and reaps the process when a consumer breaks", async () => {
  const c = await context()
  const spawned = new FunctionProcessHost().spawn(
    { argv: js("console.log(process.pid);setInterval(()=>{},1000)") },
    c
  )
  const first = await spawned.stream.next()
  const pid = Number(first.value.text)
  const pending = spawned.stream.next()
  const rejection = expect(pending).rejects.toThrow("MODS_PROCESS_CLOSED")
  await spawned.close()
  await rejection
  await expect(spawned.result).rejects.toThrow("MODS_PROCESS_CLOSED")
  expect(() => process.kill(pid, 0)).toThrow()
})

it("aborts pending approval and enforces timeout over the whole process", async () => {
  const c = await context()
  c.authorize = () => new Promise(() => {})
  const value = new FunctionProcessHost().run({ argv: js("setInterval(()=>{},1000)") }, c)
  c.controller.abort(new Error("revoked"))
  await expect(value).rejects.toThrow("revoked")
  const c2 = await context()
  await expect(
    new FunctionProcessHost().run(
      { argv: js("setInterval(()=>{},1000)"), init: { timeoutMs: 250 } },
      c2
    )
  ).rejects.toThrow("MODS_PROCESS_TIMEOUT")
})

it("acknowledges an approved silent process before its first output", async () => {
  const c = await context()
  const spawned = new FunctionProcessHost().spawn({ argv: js("setInterval(()=>{},1000)") }, c)
  const first = spawned.stream.next()
  const rejection = expect(first).rejects.toThrow("MODS_PROCESS_CLOSED")
  await spawned.started
  await spawned.close()
  await rejection
})

it("preserves a complete finite stream across a paused consumer beyond the old drain deadline", async () => {
  const c = await context()
  const spawned = new FunctionProcessHost().spawn(
    { argv: js("process.stdout.write('x'.repeat(2*1024*1024))") },
    c
  )
  const first = await spawned.stream.next()
  let length = (first.value.text as string).length
  await new Promise((resolve) => setTimeout(resolve, 800))
  for await (const value of spawned.stream) length += (value.text as string).length
  expect(length).toBe(2 * 1024 * 1024)
  expect(await spawned.result).toEqual({ code: 0, signal: null })
})

it("cancels a producer while output is backpressured and no consumer is pulling", async () => {
  const c = await context()
  const spawned = new FunctionProcessHost().spawn(
    {
      argv: js(
        "console.log(process.pid);setTimeout(()=>{function write(){while(process.stdout.write('x'.repeat(65536))){}process.stdout.once('drain',write)}write()},30)"
      )
    },
    c
  )
  const first = await spawned.stream.next()
  const pid = Number((first.value.text as string).trim())
  await new Promise((resolve) => setTimeout(resolve, 100))
  await spawned.close()
  await expect(spawned.result).rejects.toThrow("MODS_PROCESS_CLOSED")
  expect(() => process.kill(pid, 0)).toThrow()
})

it("drops an incomplete UTF8 suffix at the bounded run output limit", async () => {
  const c = await context()
  const value = await new FunctionProcessHost().run(
    { argv: js("process.stdout.write('中'.repeat(100000))") },
    c
  )
  expect(value.stdout).toBe("中".repeat(Math.floor((256 * 1024) / 3)))
})

it.skipIf(process.platform !== "win32")("kills the entire Job when its host crashes", async () => {
  const controllerPath = path.resolve("resources/bin/win32/background-job-controller.exe")
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `
    const {spawn}=require('node:child_process');
    const child=spawn(${JSON.stringify(controllerPath)},[process.execPath,'argv',String(process.pid),'-e','console.log(process.pid);setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    console.log(child.pid);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  `
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  )
  let processes: number[] = []
  try {
    const lines = await new Promise<string[]>((resolve, reject) => {
      let text = ""
      const timeout = setTimeout(() => reject(new Error("host startup timed out")), 3000)
      parent.stdout.on("data", (chunk) => {
        text += chunk.toString()
        const lines = text.trim().split(/\r?\n/)
        if (lines.length >= 3) {
          clearTimeout(timeout)
          resolve(lines)
        }
      })
      parent.once("error", reject)
    })
    expect(lines[1]).toBe("MODS_PROCESS_STARTED_V1")
    processes = [Number(lines[0]), Number(lines[2])]
    parent.kill()
    const exists = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let attempt = 0; attempt < 100 && processes.some(exists); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(processes.some(exists)).toBe(false)
    processes = []
  } finally {
    parent.kill()
    for (const pid of processes)
      try {
        process.kill(pid)
      } catch {
        /* Already reaped by Job. */
      }
  }
})

it("reaps a descendant when its immediate parent exits rapidly", async () => {
  const c = await context()
  const value = await new FunctionProcessHost().run(
    {
      argv: js(
        "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});console.log(c.pid);c.unref()"
      )
    },
    c
  )
  const pid = Number((value.stdout as string).trim())
  expect(pid).toBeGreaterThan(0)
  // Unix children which intentionally create a new session require OS-level containment.
  if (process.platform === "win32") expect(() => process.kill(pid, 0)).toThrow()
  else {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* Already exited. */
    }
  }
})
