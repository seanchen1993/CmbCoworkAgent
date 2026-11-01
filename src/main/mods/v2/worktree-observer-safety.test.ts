import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionProcessHost } from "./process-sdk"
import type { ModJson } from "../../../shared/mods/types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  vi.restoreAllMocks()
})

it("denies a hanging writer before process entry, including nested reads and custom engine delegation", async () => {
  const run = vi.spyOn(FunctionProcessHost.prototype, "run").mockImplementation(async () => {
    throw Error("a writer must never reach the native runner")
  })
  const spawn = vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(() => {
    throw Error("a hanging writer must never reach native spawn")
  })
  const authorize = vi.fn(async () => undefined)
  const tool = vi.fn(async () => ({ value: "must-not-run" }))
  const read = vi.fn(async () => [])
  const debug = vi.fn()
  const state = new Map<string, ModJson>()
  const writer = JSON.stringify([process.execPath, "-e", "setInterval(()=>{},1000)"])
  const consumer = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.WorktreeRemove",async($,e,next)=>{
      const errors={};const attempt=async(name,work)=>{
        try{await work();errors[name]="UNEXPECTED_SUCCESS"}catch(error){errors[name]=error.message}
      };
      await attempt("run",()=>$.process.run({argv:${writer}}));
      await attempt("spawn",()=>$.process.spawn({argv:${writer}}).next());
      await attempt("write",()=>$.fs.write("owned.txt","must-not-write"));
      await attempt("tool",()=>$.tool.call({tool:"write_file",input:{path:"owned.txt",content:"x"}}));
      await attempt("mcp",()=>$.mcp.call({server:"unused",tool:"write",input:{}}));
      await attempt("model",()=>$.model.complete({messages:[]}));
      await attempt("agent",()=>$.agent.spawn({prompt:"write"}));
      await attempt("platform",()=>$.platform.act({}));
      await attempt("command",()=>$.command.run({command:"writer"}));
      await attempt("send",()=>$.session.send({to:"other",text:"write"}));
      await attempt("append",()=>$.session.append({role:"user",text:"write"}));
      await attempt("custom",()=>$.company.write({}));
      await $.session.messages();
      await $.store.set("errors",errors);
      await $.store.set("allowed",await $.session.id());
      await $.ui.log("read-only observer recorded");
      return next(e)
    });
    on("session.messages",async($,e,next)=>{
      try{await $.process.spawn({argv:${writer}}).next()}
      catch(error){await $.store.set("nested",error.message)}
      return next(e)
    });
  }}`)
  const provider = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let savedCoreWriter;
    on("engine.create",async($,e,next)=>{
      const built=await next(e);savedCoreWriter=()=>built.process.run({argv:${writer}});
      return {...built,company:{write:async()=>built.process.run({argv:${writer}})}}
    });
    on("session.messages",async($,e,next)=>{
      try{await savedCoreWriter()}catch(error){await $.store.set("engineNested",error.message)}
      return next(e)
    });
  }}`)
  const providerCalls: string[] = []
  const invoke = provider.invoke.bind(provider)
  provider.invoke = (id, input, host, options) => {
    providerCalls.push(id)
    return invoke(id, input, host, options)
  }
  const session = new FunctionSession(
    [
      {
        name: "consumer",
        root: "/consumer",
        tier: "user",
        guest: consumer,
        capabilities: [...SESSION_CAPABILITIES]
      },
      {
        name: "provider",
        root: "/provider",
        tier: "user",
        guest: provider,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value,
      authorizeProcess: authorize,
      callTool: tool,
      readSession: read,
      debugLog: debug,
      state: () => ({
        get: async (key) => state.get(key),
        set: async (key, value) => {
          state.set(key, value)
        },
        delete: (key) => {
          state.delete(key)
        },
        keys: async () => [...state.keys()]
      })
    }
  )
  sessions.push(session)
  await session.start()
  await session.observeNativeEvent(
    "classic.WorktreeRemove",
    {
      hook_event_name: "WorktreeRemove",
      session_id: "thread",
      transcript_path: "",
      cwd: process.cwd(),
      worktree_path: "native-owned-worktree"
    },
    {},
    () => {}
  )
  const errors = state.get("errors") as Record<string, string>
  expect(Object.keys(errors)).toHaveLength(12)
  for (const [method, error] of Object.entries(errors))
    expect(error, method).toContain("MODS_WORKTREE_OBSERVER_READ_ONLY")
  expect(state.get("nested")).toContain("MODS_WORKTREE_OBSERVER_READ_ONLY")
  expect(state.get("engineNested")).toContain("MODS_WORKTREE_OBSERVER_READ_ONLY")
  expect(state.get("allowed")).toBe("thread")
  expect(read).toHaveBeenCalledOnce()
  expect(debug).toHaveBeenCalledWith("consumer", "read-only observer recorded")
  expect(providerCalls).not.toContain("provider")
  expect(authorize).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()
  expect(tool).not.toHaveBeenCalled()
})

it("does not apply the WorktreeRemove restriction to native desktop observers", async () => {
  const read = vi.fn(async () => ({ observerState: "unchanged-permissions" }))
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.attach",async($,e,next)=>{await $.telemetry.records();return next(e)});
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "desktop",
        root: "/root",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value,
      readSession: read
    }
  )
  sessions.push(session)
  await session.start()
  await session.observeNativeEvent(
    "session.attach",
    { surface: "desktop", clientId: "native" },
    { clientId: "native" },
    () => {}
  )
  expect(read).not.toHaveBeenCalled()
})

it.each(["after", "every"])("cannot schedule a future writer through clock.%s", async (method) => {
  const run = vi.spyOn(FunctionProcessHost.prototype, "run").mockImplementation(async () => {
    throw Error("a delayed writer must not start")
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.WorktreeRemove",async($,e,next)=>{
      $.clock.${method}(1,()=>$.process.run(["node","-e","setInterval(()=>{},1000)"]));
      await $.clock.sleep(10);return next(e)
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "observer",
        root: "/root",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  sessions.push(session)
  await session.start()
  await expect(
    session.observeNativeEvent(
      "classic.WorktreeRemove",
      {
        hook_event_name: "WorktreeRemove",
        session_id: "thread",
        transcript_path: "",
        cwd: process.cwd(),
        worktree_path: "native-owned-worktree"
      },
      {},
      () => {}
    )
  ).rejects.toMatchObject({ code: "MODS_WORKTREE_OBSERVER_READ_ONLY" })
  expect(run).not.toHaveBeenCalled()
})
