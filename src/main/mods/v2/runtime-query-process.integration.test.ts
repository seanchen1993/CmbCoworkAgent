import { fork as nodeFork } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { build } from "esbuild"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { withPlatformQuery } from "./platform-query-scope"
import type { FunctionHostCall, FunctionInvocation } from "../../../shared/mods/v2/contracts"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionProcessHost } from "./process-sdk"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

let directory: string
let client: FunctionRuntimeClient
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mods-query-process-"))
  const entry = join(directory, "host.cjs")
  await build({
    entryPoints: [resolve("src/main/mods/v2/host-entry.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    banner: {
      js: `module.paths.push(${JSON.stringify(resolve("node_modules"))});
process.parentPort={on:(_event,fn)=>process.on('message',data=>fn({data})),postMessage:value=>process.send(value)};`
    }
  })
  // Only the Electron carrier is adapted. Production client, host-entry, QuickJS and IPC are real.
  fork.mockImplementation((path: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const childOptions = {
      env: { ...options.env, NODE_PATH: resolve("node_modules") },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"] as ["ignore", "pipe", "pipe", "ipc"]
    }
    const child = nodeFork(path, args, childOptions)
    return Object.assign(child, { postMessage: child.send.bind(child) })
  })
  client = new FunctionRuntimeClient(entry)
}, 30000)
afterAll(async () => {
  client?.stop()
  if (directory) {
    if (
      dirname(directory) !== tmpdir() ||
      !directory.split(/[\\/]/).at(-1)?.startsWith("mods-query-process-")
    )
      throw Error("UNEXPECTED_TEST_CLEANUP_PATH")
    await rm(directory, { recursive: true, force: true })
  }
})
const options: FunctionInvocation = {
  event: "query",
  origin: { plugin: "engine", tier: "core" },
  capabilities: [...SESSION_CAPABILITIES],
  plugin: { name: "query", root: "/query" }
}
const unexpected: FunctionHostCall = async () => {
  throw Error("UNEXPECTED_HOST_EFFECT")
}

it("fences existing resource handles in an actual child process and still cleans them up", async () => {
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    let timer,release;
    on("start",$=>{timer=$.clock.after(100,()=>{});return {}});
    on("query",()=>{timer.cancel();return {}});
    on("late",()=>{new Promise(resolve=>{release=resolve}).then(()=>timer.cancel());return {}});
    on("release",()=>{release();return {}});
  }}`)
  const moduleHost = vi.fn(async () => ({}))
  guest.bindModuleHost!(moduleHost)
  const start = async () => guest.invoke("0", {}, async () => ({ value: { id: "timer" } }), options)
  try {
    await start()
    await withPlatformQuery(new AbortController().signal, () =>
      guest.invoke("1", {}, unexpected, options)
    )
    expect(moduleHost).not.toHaveBeenCalled()
    await start()
    await withPlatformQuery(new AbortController().signal, () =>
      guest.invoke("2", {}, unexpected, options)
    )
    await guest.invoke("3", {}, unexpected, options)
    expect(moduleHost).not.toHaveBeenCalled()
    await start()
    await guest.invoke("1", {}, unexpected, options)
    await vi.waitFor(() => expect(moduleHost).toHaveBeenCalledOnce())
  } finally {
    await guest.dispose()
  }
})

it("rejects real child process query SDK writes and permits the following ordinary invocation", async () => {
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"write",description:"write"});return next(e)});
    on("command.run",async $=>{
      try{await $.process.run(['sleep','0']);return {escaped:true}}
      catch(error){return {error:String(error)}}
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "query",
        root: "/query",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "child-query",
      assertLive() { /* This isolated fixture keeps the enclosing runtime live. */ },
      publish: async (value) => value
    }
  )
  try {
    await session.start()
    expect(
      await withPlatformQuery(new AbortController().signal, () => session.run("write", ""))
    ).toMatchObject({ error: expect.stringContaining("MODS_QUERY_EFFECT_DENIED") })
    expect(await session.run("write", "")).toEqual({ escaped: true })
  } finally {
    await session.close(true)
  }
})

it("delivers the original cancellation code to a suspended child callback and preserves its successor", async () => {
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    let failure='';
    on("read",async $=>{try{await $.session.id()}catch(error){failure=error.code+':'+error.message}return {}});
    on("status",()=>({failure}));
  }}`)
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const controller = new AbortController()
  try {
    const first = withPlatformQuery(controller.signal, () =>
      guest.invoke(
        "0",
        {},
        async () => {
          entered.resolve()
          await release.promise
          return { value: "late" }
        },
        options
      )
    ).catch((error) => error)
    await entered.promise
    controller.abort()
    expect(await first).toBeInstanceOf(Error)
    const status = await guest.invoke("1", {}, unexpected, options)
    expect(status).toEqual({ value: { failure: "MODS_CANCELLED:MODS_CANCELLED" } })
    expect(
      await withPlatformQuery(new AbortController().signal, () =>
        guest.invoke("0", {}, async () => ({ value: "successor" }), options)
      )
    ).toEqual({ value: {} })
  } finally {
    release.resolve()
    await guest.dispose()
  }
})

it("rejects child SDK filesystem writes before they reach the host", async () => {
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    on("write",async $=>{try{await $.fs.write("query-forbidden.txt","forbidden");return {escaped:true}}
      catch(error){return {error:String(error)}}});
  }}`)
  const host = vi.fn<FunctionHostCall>(async () => ({ value: null }))
  try {
    expect(
      await withPlatformQuery(new AbortController().signal, () =>
        guest.invoke("0", {}, host, options)
      )
    ).toMatchObject({ value: { error: expect.stringContaining("MODS_QUERY_EFFECT_DENIED") } })
    expect(host).not.toHaveBeenCalled()
    expect(await guest.invoke("0", {}, host, options)).toEqual({ value: { escaped: true } })
    expect(host).toHaveBeenCalledOnce()
    expect(host.mock.calls[0]?.[0]).toBe("fs.write")
  } finally {
    await guest.dispose()
  }
})

it("denies next and return on an existing native process through child IPC and preserves cleanup", async () => {
  const actual = FunctionProcessHost.prototype.spawn
  let closed = 0
  const spawn = vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function (
    this: FunctionProcessHost,
    ...args
  ) {
    const child = actual.apply(this, args)
    return {
      ...child,
      close: async () => {
        closed++
        await child.close()
      }
    }
  })
  const argv = JSON.stringify([
    process.execPath,
    "-e",
    "process.stdout.write('ready');setInterval(()=>process.stdout.write('tick'),40)"
  ])
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    let stream;
    on("session.start",async($,e,next)=>{await $.command.register({name:"start",description:"start"});return next(e)});
    on("command.run",async $=>{stream=$.process.spawn({argv:${argv}});stream.result.catch(()=>{});await stream.next();return {started:true}});
    on("query",async($,e)=>{try{await(e.close?stream.return():stream.next());return {escaped:true}}
      catch(error){return {error:String(error)}}});
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "query",
        root: "/query",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "child-process-query",
      assertLive() { /* This isolated fixture keeps the enclosing runtime live. */ },
      authorizeProcess: async () => {},
      publish: async (value) => value
    }
  )
  try {
    expect(await session.run("start", "")).toEqual({ started: true })
    for (const close of [false, true]) {
      expect(
        await withPlatformQuery(new AbortController().signal, () =>
          guest.invoke("2", { close }, unexpected, options)
        )
      ).toMatchObject({ value: { error: expect.stringContaining("MODS_QUERY_EFFECT_DENIED") } })
      expect(closed).toBe(0)
    }
    await session.close()
    expect(closed).toBe(1)
  } finally {
    await session.close(true)
    spawn.mockRestore()
  }
})

it("rejects unawaited SDK work as stale when its child callback finishes normally", async () => {
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    let failure='';
    on("read",$=>{ $.session.id().catch(error=>{failure=error.code+':'+error.message});return {} });
    on("status",()=>({failure}));
  }}`)
  const release = Promise.withResolvers<void>()
  try {
    expect(
      await guest.invoke(
        "0",
        {},
        async () => {
          await release.promise
          return { value: "late" }
        },
        options
      )
    ).toEqual({ value: {} })
    expect(await guest.invoke("1", {}, unexpected, options)).toEqual({
      value: { failure: "MODS_STALE_INVOCATION:MODS_STALE_INVOCATION" }
    })
  } finally {
    release.resolve()
    await guest.dispose()
  }
})
