import { fork as nodeFork } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionProcessHost } from "./process-sdk"
import type { ModJson } from "../../../shared/mods/types"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

let directory: string, client: FunctionRuntimeClient, session: FunctionSession | undefined
const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((value) => value.close(true)))
  vi.restoreAllMocks()
})
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mods-worktree-observer-process-"))
  const host = join(directory, "host.cjs")
  await build({
    entryPoints: [resolve("src/main/mods/v2/host-entry.ts")],
    outfile: host,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    banner: {
      js: `module.paths.push(${JSON.stringify(resolve("node_modules"))});
process.parentPort={on:(_event,fn)=>process.on('message',data=>fn({data})),postMessage:value=>process.send(value)};`
    }
  })
  // Adapt only Electron's carrier. Client, host-entry, QuickJS and both IPC directions are real.
  fork.mockImplementation((path: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const childOptions = {
      env: { ...options.env, NODE_PATH: resolve("node_modules") },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"] as ["ignore", "pipe", "pipe", "ipc"]
    }
    const child = nodeFork(path, args, childOptions)
    return Object.assign(child, { postMessage: child.send.bind(child) })
  })
  client = new FunctionRuntimeClient(host)
}, 30000)
afterAll(async () => {
  await session?.close(true)
  await client?.stopAndDrain()
  vi.restoreAllMocks()
  if (directory) {
    if (
      dirname(directory) !== tmpdir() ||
      !directory.split(/[\\/]/).at(-1)?.startsWith("mods-worktree-observer-process-")
    )
      throw Error("UNEXPECTED_WORKTREE_OBSERVER_TEST_PATH")
    await rm(directory, { recursive: true, force: true })
  }
})

it("preserves the read-only receipt across actual process IPC, old SDK closures and nested engine reads", async () => {
  const run = vi.spyOn(FunctionProcessHost.prototype, "run").mockImplementation(async () => {
    throw Error("writer must not enter native run")
  })
  const spawn = vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(() => {
    throw Error("writer must not enter native spawn")
  })
  const authorize = vi.fn(async () => undefined)
  const stored = new Map<string, ModJson>()
  const writer = JSON.stringify({ argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] })
  const consumer = await client.load(`var __cmbFunctionMod={register(on){
    let saved;
    on("session.start",($,e,next)=>{saved=$;return next(e)});
    on("classic.WorktreeRemove",async($,e,next)=>{
      try{await saved.process.run(${writer})}catch(error){await $.store.set("old",error.message)}
      try{await $.company.write({})}catch(error){await $.store.set("custom",error.message)}
      await $.session.messages();return next(e)
    });
    on("session.messages",async($,e,next)=>{
      try{await saved.process.spawn(${writer}).next()}catch(error){await $.store.set("nested",error.message)}
      return next(e)
    });
  }}`)
  const provider = await client.load(`var __cmbFunctionMod={register(on){
    let writer;
    on("engine.create",async($,e,next)=>{
      const built=await next(e);writer=()=>built.process.run(${writer});
      return {...built,company:{write:writer}}
    });
    on("session.messages",async($,e,next)=>{
      try{await writer()}catch(error){await $.store.set("engine",error.message)}
      return next(e)
    });
  }}`)
  session = new FunctionSession(
    [
      {
        name: "consumer",
        root: directory,
        tier: "user",
        guest: consumer,
        capabilities: [...SESSION_CAPABILITIES]
      },
      {
        name: "provider",
        root: directory,
        tier: "user",
        guest: provider,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: directory,
      threadId: "native-process",
      assertLive: () => undefined,
      publish: async (value) => value,
      authorizeProcess: authorize,
      readSession: async () => [],
      state: () => ({
        get: async (key) => stored.get(key),
        set: async (key, value) => {
          stored.set(key, value)
        },
        delete: (key) => {
          stored.delete(key)
        },
        keys: async () => [...stored.keys()]
      })
    }
  )
  sessions.push(session)
  await session.start()
  const pid = client.stats.pid
  expect(pid).toBeGreaterThan(0)
  expect(pid).not.toBe(process.pid)
  await session.observeNativeEvent(
    "classic.WorktreeRemove",
    {
      hook_event_name: "WorktreeRemove",
      session_id: "native-process",
      transcript_path: "",
      cwd: directory,
      worktree_path: join(directory, "owned")
    },
    {},
    () => {}
  )
  for (const key of ["old", "custom", "nested", "engine"])
    expect(stored.get(key), key).toContain("MODS_WORKTREE_OBSERVER_READ_ONLY")
  expect(authorize).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
  expect(client.stats.pending).toBe(0)
})

it.each(["return", "pull", "cancel-open"])(
  "skips the real cross-process observer with a retained stream before old stream.%s can touch it",
  async (mode) => {
    const ready = Promise.withResolvers<void>(),
      stopped = Promise.withResolvers<void>()
    const terminal = { code: 0, signal: null }
    let closed = false,
      streamSignal: AbortSignal | undefined
    const close = vi.fn(async () => {
      closed = true
      ready.resolve()
      stopped.resolve()
    })
    const spawn = vi
      .spyOn(FunctionProcessHost.prototype, "spawn")
      .mockImplementation((_input, context) => {
        streamSignal = context.signal
        const stop = () => {
          closed = true
          ready.resolve()
          stopped.resolve()
        }
        context.signal.addEventListener("abort", stop, { once: true })
        const stream = (async function* () {
          await ready.promise
          if (closed) return terminal
          yield { stream: "stdout", text: "native ready" }
          await stopped.promise
          return terminal
        })()
        return {
          stream,
          started: ready.promise,
          result: stopped.promise.then(() => terminal),
          close
        }
      })
    const stored = new Map<string, ModJson>()
    const guest = await client.load(`var __cmbFunctionMod={register(on){
      let stream,saved;
      on("session.start",async($,e,next)=>{
        await $.command.register({name:"open",description:"open retained native stream"});return next(e)
      });
      on("command.run",{command:"open"},async $=>{
        saved=$;stream=saved.process.spawn({argv:["controlled-existing-process"]});
        await stream.next();return {text:"native ready"}
      });
      on("classic.WorktreeRemove",async($,e,next)=>{
        await $.store.set("observed",true);
        ${mode === "pull" ? "await stream.next()" : "await stream.return()"};return next(e)
      });
    }}`)
    const value = new FunctionSession(
      [
        {
          name: "stream-owner",
          root: directory,
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: directory,
        threadId: `stream-${mode}`,
        assertLive: () => undefined,
        publish: async (input) => input,
        state: () => ({
          get: async (key) => stored.get(key),
          set: async (key, data) => {
            stored.set(key, data)
          },
          delete: (key) => {
            stored.delete(key)
          },
          keys: async () => [...stored.keys()]
        })
      }
    )
    sessions.push(value)
    await value.start()
    if (mode !== "cancel-open") ready.resolve()
    const opening = value.run("open", "")
    let openingSettled = false
    void opening
      .finally(() => {
        openingSettled = true
      })
      .catch(() => {})
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    if (mode !== "cancel-open") await opening
    expect(value.ownedResourceCount).toBe(1)
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    await value.observeNativeEvent(
      "classic.WorktreeRemove",
      {
        hook_event_name: "WorktreeRemove",
        session_id: `stream-${mode}`,
        transcript_path: "",
        cwd: directory,
        worktree_path: join(directory, "owned")
      },
      {},
      () => {}
    )
    expect(stored.get("observed")).toBeUndefined()
    expect(close).not.toHaveBeenCalled()
    expect(closed).toBe(false)
    expect(streamSignal?.aborted).toBe(false)
    expect(warning).toHaveBeenCalledWith(
      "[Mods] Worktree removal observation skipped: runtime has retained or unsettled work"
    )
    if (mode === "cancel-open") {
      expect(openingSettled).toBe(false)
      ready.resolve()
      await opening
    }
    expect(value.ownedResourceCount).toBe(1)
    expect(streamSignal?.aborted).toBe(false)
  },
  20000
)

it("keeps the main lease after a bounded wait until an abort-ignoring native read actually settles", async () => {
  const entered = Promise.withResolvers<void>(),
    readGate = Promise.withResolvers<ModJson>()
  const stored = new Map<string, ModJson>()
  const guest = await client.load(`var __cmbFunctionMod={register(on){
    let saved,timer;
    on("session.start",async($,e,next)=>{
      for(const name of ["setup","old-private","ordinary"])
        await $.command.register({name,description:name});return next(e)
    });
    on("command.run",{command:"setup"},async $=>{
      saved=$;timer=saved.clock.after(1,()=>{});await $.clock.sleep(40);return {text:"ready"}
    });
    on("command.run",{command:"old-private"},async()=>{
      try{await timer.cancel();return {text:"unexpected private cleanup"}}
      catch(error){return {text:error.message}}
    });
    on("command.run",{command:"ordinary"},async $=>{
      try{await $.telemetry.records();return {text:"ordinary allowed"}}
      catch(error){return {text:error.message}}
    });
    on("classic.WorktreeRemove",async($,e,next)=>{
      await $.store.set("observed",true);await $.session.messages();return next(e)
    });
  }}`)
  const value = new FunctionSession(
    [
      {
        name: "late-reader",
        root: directory,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: directory,
      threadId: "late-reader",
      assertLive: () => undefined,
      publish: async (input) => input,
      readSession: async () => {
        entered.resolve()
        return readGate.promise
      },
      state: () => ({
        get: async (key) => stored.get(key),
        set: async (key, data) => {
          stored.set(key, data)
        },
        delete: (key) => {
          stored.delete(key)
        },
        keys: async () => [...stored.keys()]
      })
    }
  )
  sessions.push(value)
  await value.start()
  await value.run("setup", "")
  expect(value.ownedResourceCount).toBe(0)
  try {
    const observing = value.observeNativeEvent(
      "classic.WorktreeRemove",
      {
        hook_event_name: "WorktreeRemove",
        session_id: "late-reader",
        transcript_path: "",
        cwd: directory,
        worktree_path: join(directory, "owned")
      },
      {},
      () => {}
    )
    // Attach the rejection observer before waiting for the independent native call.
    const outcome = observing.catch((error) => error)
    await entered.promise
    expect(await outcome).toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
    expect(stored.get("observed")).toBe(true)
    expect((await value.run("old-private", "")).text).toContain("MODS_WORKTREE_OBSERVER_READ_ONLY")
    expect((await value.run("ordinary", "")).text).toContain("MODS_WORKTREE_OBSERVER_READ_ONLY")
    // A concurrent native roster fact still completes; it cannot create an external resource.
    await value.observeNativeEvent("session.attach", { surface: "desktop", clientId: "late-client" },
      { clientId: "late-client" }, () => {})
    readGate.resolve([])
    // The actual host promise and its main-process finally run before this fresh native turn.
    await new Promise<void>((done) => setImmediate(done))
    expect((await value.run("ordinary", "")).text).toBe("ordinary allowed")
  } finally {
    readGate.resolve([])
  }
}, 15000)
