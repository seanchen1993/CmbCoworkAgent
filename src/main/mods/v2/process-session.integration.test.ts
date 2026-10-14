import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import type { FunctionHostCall } from "../../../shared/mods/v2/contracts"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionSessionActivity } from "./session-activity"
import { FunctionProcessHost } from "./process-sdk"
import { FunctionDispatchDeadline } from "./dispatch-deadline"

const sessions: FunctionSession[] = []

it("fences module calls after quit even outside classic ALS and preserves cleanup validation", async () => {
  const { session, moduleHost } = await fixture("return {}")
  await session.start()
  const drain = new FunctionDispatchDeadline(20)
  session.prepareQuitDrain(drain)
  await new Promise(resolve => setTimeout(resolve, 35))
  await expect(moduleHost("resource.ui", { method: "ui.log", args: { text: "late" } },
    new AbortController().signal)).rejects.toMatchObject({ code: "MODS_DISPATCH_TIMEOUT" })
  // Original absent-handle close stays idempotent; malformed cleanup still fails validation.
  await expect(moduleHost("resource.close", { id: "absent" }, new AbortController().signal))
    .resolves.toEqual({})
  await expect(moduleHost("resource.close", {}, new AbortController().signal))
    .rejects.toMatchObject({ code: "MODS_RESOURCE_ARGUMENTS" })
  drain.close()
})

it("shares the end cut with real process middleware and closes a broken-out child through its native module proof", async () => {
  const actual = FunctionProcessHost.prototype.spawn
  let closed = 0
  const spawn = vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function(
    this: FunctionProcessHost, ...args
  ) {
    const process = actual.apply(this, args)
    return { ...process, close: async () => { closed++; await process.close() } }
  })
  const { session, guest } = await fixture("return {}", `
    on("session.end",async($,e,next)=>{
      const stream=$.process.spawn({argv:${command("process.stdout.write('ready');setInterval(()=>{},1000)")}});
      for await(const chunk of stream){break};try{await stream.result}catch{};return next(e);
    });
    on("process.spawn",async function*($,e,next){
      if(next.budget.ms>1500)throw Error("reset end budget");
      return yield* next(e);
    });
  `)
  const cuts: Array<{ event: string; cut?: string }> = []
  const invoke = guest.invoke.bind(guest)
  guest.invoke = (id, input, host, options) => {
    cuts.push({ event: options.event, cut: options.dispatchCutNs })
    return invoke(id, input, host, options)
  }
  try {
    await session.start()
    await session.end("clear")
    const end = cuts.find(row => row.event === "session.end")!
    const processFrames = cuts.filter(row => row.event === "process.spawn")
    expect(processFrames.length).toBeGreaterThan(1)
    expect(processFrames.every(row => row.cut === end.cut)).toBe(true)
    expect(closed).toBe(1)
    session.assertRetirementHealthy()
  } finally { spawn.mockRestore() }
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})

async function fixture(body: string, hooks = "", extra: Partial<FunctionSessionHost> = {}) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"test",description:"test"});return next(e)
    });on("command.run",async($,e,next)=>{${body}});${hooks}
  }}`)
  let moduleHost!: FunctionHostCall
  const bind = guest.bindModuleHost.bind(guest)
  guest.bindModuleHost = (host, onDispose) => {
    moduleHost = host
    bind(host, onDispose)
  }
  const authorize = vi.fn(async () => {})
  const session = new FunctionSession(
    [
      {
        name: "process",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: process.cwd(),
      threadId: "process-session",
      assertLive: vi.fn(),
      authorizeProcess: authorize,
      publish: async (v) => v,
      ...extra
    }
  )
  sessions.push(session)
  return { session, authorize, guest, moduleHost }
}
const command = (body: string) => JSON.stringify([process.execPath, "-e", body])

it("keeps sleep inside process middleware and the effect policy without OS approval", async () => {
  const effect = vi.fn<NonNullable<FunctionSessionHost["runEffect"]>>(async (_plugin, method, _input, _signal, run) => {
    expect(method).toBe("process.run")
    return run()
  })
  const { session, authorize } = await fixture('return await $.process.run(["sleep","0"]);',
    'on("process.run",async($,e,next)=>next({...e,argv:["sleep","0.01"]}));',
    { runEffect: effect })
  expect(await session.run("test", "")).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  expect(effect).toHaveBeenCalledOnce()
  expect(authorize).not.toHaveBeenCalled()
  const denied = await fixture('return await $.process.run(["sleep","0"]);', "", {
    runEffect: async () => { throw Error("policy denied") }
  })
  await expect(denied.session.run("test", "")).rejects.toThrow("policy denied")
  expect(denied.authorize).not.toHaveBeenCalled()
})

it("pauses the actual outer command budget while its module channel reads slow native process output", async () => {
  const { session, guest } = await fixture(`
    const stream=$.process.spawn({argv:${command("process.stdout.write('first');setTimeout(()=>process.stdout.write('second'),220)")}});
    let text="";for await(const chunk of stream)text+=chunk.text;
    return {text,code:(await stream.result).code};`,
    `on("process.spawn",async function*($,e,next){return yield* next(e)})`)
  const invoke = guest.invoke.bind(guest)
  guest.invoke = (id, input, host, options) => invoke(id, input, host,
    options.event === "command.run" ? { ...options, ownBudgetMs: 80 } : options)
  expect(await session.run("test", "")).toEqual({ text: "firstsecond", code: 0 })
  expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
})

it("keeps a rejected process occupied until its actual backend cleanup completes", async () => {
  const activity = new FunctionSessionActivity()
  const cleanup = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const actual = FunctionProcessHost.prototype.spawn
  const spawn = vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function (
    this: FunctionProcessHost,
    ...args
  ) {
    const backend = actual.apply(this, args)
    const close = backend.close.bind(backend)
    return {
      ...backend,
      close: async () => {
        entered.resolve()
        await cleanup.promise
        await close()
      }
    }
  })
  try {
    const { session } = await fixture(
      `
      const stream=$.process.spawn({argv:${command("process.stdout.write('ready');setInterval(()=>{},1000)")}});
      for await(const chunk of stream){break}
      try{await stream.result}catch{};return {closed:true};`,
      "",
      { activity }
    )
    const run = session.run("test", "")
    await entered.promise
    expect(activity.size).toBeGreaterThan(0)
    expect(activity.pauseIfIdle()).toBe(false)
    cleanup.resolve()
    expect(await run).toEqual({ closed: true })
    await vi.waitFor(() => expect(activity.size).toBe(0))
  } finally {
    cleanup.resolve()
    spawn.mockRestore()
  }
})

it("runs argv through the operation hook before approving the final command", async () => {
  const { session, authorize } = await fixture(
    `return await $.process.run(${command("process.stdout.write('before')")});`,
    `on("process.run",async($,e,next)=>next({...e,argv:${command("process.stdout.write('after')")}}));`
  )
  expect(await session.run("test", "")).toEqual({ exitCode: 0, stdout: "after", stderr: "" })
  expect(authorize).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ argv: JSON.parse(command("process.stdout.write('after')")) }),
    expect.any(AbortSignal)
  )
})

it("consumes a background process after creator return and logs its final result", async () => {
  const { session } = await fixture(`
    const stream=$.process.spawn({argv:${command("setTimeout(()=>process.stdout.write('later'),80)")}});
    (async()=>{for await(const chunk of stream)$.ui.log(chunk.text);
      $.ui.log("exit="+(await stream.result).code)})();
    return {started:true};`)
  expect(await session.run("test", "")).toEqual({ started: true })
  await vi.waitFor(
    async () =>
      expect((await session.logSnapshot()).map((row) => row.text)).toEqual(["later", "exit=0"]),
    { timeout: 5000 }
  )
})

it("early iterator return rejects result and closes a quiet child", async () => {
  const { session, guest } = await fixture(`
    const stream=$.process.spawn({argv:${command("process.stdout.write('ready');setInterval(()=>{},1000)")}});
    for await(const chunk of stream){break}
    try{await stream.result;return {closed:false}}catch{return {closed:true}};`)
  expect(await session.run("test", "")).toEqual({ closed: true })
  await session.close()
  expect(guest.stats.disposed).toBe(true)
})

it("finishes effect accounting before normal resource close aborts its signal", async () => {
  let settled = false
  const { session } = await fixture(
    `
    const stream=$.process.spawn({argv:${command("process.stdout.write('done')")}});
    for await(const chunk of stream){}
    return {code:(await stream.result).code};`,
    "",
    {
      runEffect: async (_plugin, _method, _input, signal, run) => {
        const result = await run()
        await new Promise((resolve) => setTimeout(resolve, 50))
        signal.throwIfAborted()
        settled = true
        return result
      }
    }
  )
  expect(await session.run("test", "")).toEqual({ code: 0 })
  expect(settled).toBe(true)
})

it("applies streaming hooks to argv and chunks without restarting the command", async () => {
  const { session, authorize } = await fixture(
    `
    const stream=$.process.spawn({argv:${command("process.stdout.write('before')")}});
    let text="";for await(const chunk of stream)text+=chunk.text;
    return {text,code:(await stream.result).code};`,
    `
    on("process.spawn",async function*($,e,next){
      const stream=next({...e,argv:${command("process.stdout.write('after')")}});
      for await(const chunk of stream)yield {...chunk,text:chunk.text.toUpperCase()};
      return await stream.result;
    });`
  )
  expect(await session.run("test", "")).toEqual({ text: "AFTER", code: 0 })
  expect(authorize).toHaveBeenCalledTimes(1)
})

it("a stream hook can yield and finish without starting any process", async () => {
  const { session, authorize } = await fixture(
    `
    const stream=$.process.spawn({argv:${command("process.stdout.write('never')")}});
    let text="";for await(const chunk of stream)text+=chunk.text;
    return {text,code:(await stream.result).code};`,
    `
    on("process.spawn",async function*(){
      yield {stream:"stdout",text:"virtual"};return {code:0,signal:null};
    });`
  )
  expect(await session.run("test", "")).toEqual({ text: "virtual", code: 0 })
  expect(authorize).not.toHaveBeenCalled()
})

it("iterator return cancels a pending approval before a child can launch", async () => {
  let approvalSignal: AbortSignal | undefined
  let allow!: () => void
  const approval = new Promise<void>((resolve) => {
    allow = resolve
  })
  const { session } = await fixture(
    `
    const stream=$.process.spawn({argv:${command("process.stdout.write('must not start')")}});
    const pull=stream.next();pull.catch(()=>{});
    await $.clock.sleep(60);
    await stream.return();
    try{await stream.result;return {cancelled:false}}catch{return {cancelled:true}};`,
    "",
    {
      authorizeProcess: async (_plugin, _request, signal) => {
        approvalSignal = signal
        await approval
      }
    }
  )
  try {
    expect(await session.run("test", "")).toEqual({ cancelled: true })
    expect(approvalSignal?.aborted).toBe(true)
    allow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await session.logSnapshot()).toEqual([])
  } finally {
    allow()
  }
})

it("reclaims ACK-race cancellation tombstones without exhausting the module quota", async () => {
  const { session, guest, moduleHost, authorize } = await fixture(
    `
    for(let i=0;i<66;i++){
      const stream=$.process.spawn({argv:["virtual"]});
      for await(const chunk of stream){break}
    }return {completed:66};`,
    `on("process.spawn",async function*(){
      yield {stream:"stdout",text:"virtual"};return {code:0,signal:null};
    });`
  )
  const invoke = guest.invoke.bind(guest)
  vi.spyOn(guest, "invoke").mockImplementation((id, input, host, options) =>
    invoke(
      id,
      input,
      async (method, args, signal) => {
        const reply = await host(method, args, signal)
        if (method === "process.spawn") {
          // The host removed its opening record, but the guest has not received its ACK yet.
          await moduleHost("resource.cancel-open", { handle: (args as ModJson[])[1] }, signal)
        }
        return reply
      },
      options
    )
  )
  expect(await session.run("test", "")).toEqual({ completed: 66 })
  expect(authorize).not.toHaveBeenCalled()
})

it("retains cancellation after a locally rejected RPC so its delayed host open cannot launch", async () => {
  const { session, guest, moduleHost, authorize } = await fixture(`
    const stream=$.process.spawn({argv:${command("process.stdout.write('must not start')")}});
    try{await stream.next()}catch{}
    await stream.return();await $.clock.sleep(40);return {cancelled:true};`)
  const invoke = guest.invoke.bind(guest)
  let delayed: Promise<unknown> | undefined
  vi.spyOn(guest, "invoke").mockImplementation((id, input, host, options) =>
    invoke(
      id,
      input,
      async (method, args, signal) => {
        if (method !== "process.spawn") return host(method, args, signal)
        await moduleHost("resource.cancel-open", { handle: (args as ModJson[])[1] }, signal)
        delayed = new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
          host(method, args, signal).then(
            () => "unexpected open",
            (error: Error) => error.message
          )
        )
        throw Error("Simulated local reply rejection")
      },
      options
    )
  )
  expect(await session.run("test", "")).toEqual({ cancelled: true })
  expect(await delayed).toContain("MODS_CANCELLED")
  expect(authorize).not.toHaveBeenCalled()
})
