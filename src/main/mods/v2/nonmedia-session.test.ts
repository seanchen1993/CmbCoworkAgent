import { expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionPlugin } from "./dispatcher"

async function plugin(name: string, code: string): Promise<FunctionPlugin> {
  return {
    name,
    root: process.cwd(),
    tier: "user",
    capabilities: [...SESSION_CAPABILITIES],
    environment: { read: ["MOD_TEST_STAGE", "LANG"], write: ["MOD_TEST_STAGE", "LANG", "PATH"] },
    guest: await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:${JSON.stringify(name)},description:"test"});return next(e)});
      ${code.replaceAll('on("command.run",', `on("command.run",{command:${JSON.stringify(name)}},`)}
    }}`)
  }
}

it("writes a source-scoped environment into real run/spawn children without changing the host", async () => {
  const original = process.env.MOD_TEST_STAGE
  const owner = await plugin(
    "owner",
    `on("command.run",async($)=>{
    await $.env.set("MOD_TEST_STAGE","ready");
    const read=await $.env.get("MOD_TEST_STAGE");
    const argv=[${JSON.stringify(process.execPath)},"-e","process.stdout.write(process.env.MOD_TEST_STAGE || 'unset')"];
    const run=await $.process.run(argv);
    const stream=$.process.spawn({argv}); let chunks="";
    for await(const c of stream) if(c.stream==="stdout") chunks+=c.text;
    await $.env.set("MOD_TEST_STAGE",undefined);
    const unset=(await $.process.run(argv)).stdout;
    const denied=await $.env.set("PATH","unsafe");
    return {read,run:run.stdout,chunks,unset,denied:!!denied.deny};
  });`
  )
  const other = await plugin(
    "other",
    `on("command.run",async($)=>{
    let denied=false;try{await $.env.get("MOD_TEST_STAGE")}catch(e){denied=e.code==="MODS_ENV_READ_DENIED"}
    return {denied};
  });`
  )
  const session = new FunctionSession([owner, other], {
    workspace: process.cwd(),
    threadId: "env",
    assertLive() {
      /* The fixture retains authority until teardown. */
    },
    publish: async (value) => value,
    authorizeProcess: async () => {}
  })
  try {
    expect(await session.run("owner", "")).toEqual({
      read: "ready",
      run: "ready",
      chunks: "ready",
      unset: "unset",
      denied: true
    })
    expect(await session.run("other", "")).toEqual({ denied: true })
    expect(process.env.MOD_TEST_STAGE).toBe(original)
  } finally {
    await session.close()
  }
})

it("runs actual telemetry middleware and retains bounded protected local diagnostics only", async () => {
  const owner = await plugin(
    "owner",
    `on("command.run",async($)=>{
    await $.telemetry.log({event:"created",props:{count:1}});
    await $.telemetry.mark({feature:"creator",kind:"ok"});
    return await $.telemetry.records();
  });`
  )
  const observer = await plugin(
    "observer",
    `on("telemetry.log",async($,e,next)=>next({...e,props:{count:2}}));`
  )
  const session = new FunctionSession([owner, observer], {
    workspace: process.cwd(),
    threadId: "telemetry",
    assertLive() {
      /* The fixture retains authority until teardown. */
    },
    publish: async (value) => value
  })
  try {
    const result = await session.run("owner", "")
    expect(result.delivery).toBe("local-only")
    expect(result.records).toEqual([
      {
        method: "telemetry.log",
        at: expect.any(Number),
        input: { to: "anthropic", event: "created", props: { count: 2 } }
      },
      {
        method: "telemetry.mark",
        at: expect.any(Number),
        input: { feature: "creator", kind: "ok" }
      }
    ])
  } finally {
    await session.close()
  }
})

it("never fabricates identity, a terminal blit or notification receipt", async () => {
  const owner = await plugin(
    "owner",
    `on("command.run",async($)=>({
    identity:await $.session.identity(),
    terminal:await $.ui.notify("Ready"),
    desktop:await $.ui.notify("Ready",{surface:"desktop"}),
    raster:await $.ui.blit({requestId:"pane",key:"frame",cells:""})
  }));`
  )
  const notify = vi.fn(async () => ({ isSent: true, channel: "desktop" }))
  const session = new FunctionSession([owner], {
    workspace: process.cwd(),
    threadId: "native",
    assertLive() {
      /* The fixture retains authority until teardown. */
    },
    publish: async (value) => value,
    notifyDesktop: notify
  })
  try {
    const result = await session.run("owner", "")
    expect(result.identity).toEqual({ deny: expect.any(String) })
    expect(result.terminal).toEqual({ isSent: false, reason: "no-surface" })
    expect(result.desktop).toEqual({ isSent: true, channel: "desktop" })
    expect(result.raster).toEqual({ deny: expect.any(String) })
    expect(notify).toHaveBeenCalledOnce()
  } finally {
    await session.close()
  }
})

it("does not let a short-circuit Hook claim native notification delivery", async () => {
  const owner = await plugin(
    "owner",
    `on("command.run",async($)=>await $.ui.notify("Ready",{surface:"desktop"}));`
  )
  const blocker = await plugin(
    "blocker",
    `on("ui.notify",()=>({value:{isSent:true,channel:"desktop"}}));`
  )
  const notify = vi.fn(async () => ({ isSent: true, channel: "desktop" }))
  const session = new FunctionSession([owner, blocker], {
    workspace: process.cwd(),
    threadId: "refused",
    assertLive() {
      /* The fixture retains authority until teardown. */
    },
    publish: async (value) => value,
    notifyDesktop: notify
  })
  try {
    expect(await session.run("owner", "")).toEqual({ isSent: false, reason: "refused" })
    expect(notify).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})
