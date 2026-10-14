import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionConfigRows } from "./config-row-registry"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function fixture(hooks = "", protect = false) {
  let value = true,
    revision = 0,
    alive = true,
    locked = false
  const write = vi.fn((next: unknown) => {
    value = next as boolean
    revision++
  })
  const configChanged = vi.fn()
  const rows = new FunctionConfigRows()
  rows.add({
    key: "gitChangeNoticeEnabled",
    storageKey: "global:git",
    label: "Git notice",
    description: "secret description",
    kind: "boolean",
    provider: { plugin: "engine", tier: "core" },
    validate: (next) => typeof next === "boolean",
    locked: () => locked,
    cell: { read: () => ({ value, revision: String(revision) }), write }
  })
  let text = "secret value",
    textRevision = 0
  rows.add({
    key: "other.tone",
    storageKey: "other:tone",
    label: "Voice",
    kind: "text",
    provider: { plugin: "other", tier: "user" },
    validate: (next) => typeof next === "string",
    locked: () => false,
    cell: {
      read: () => ({ value: text, revision: String(textRevision) }),
      write: (next) => {
        text = next as string
        textRevision++
      }
    }
  })
  const caller = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"probe",description:"probe"});return next(e)});
    on("config.*",()=>{throw Error("caller must be excluded")});
    on("config.set",()=>({deny:"caller second handler must also be excluded"}));
    on("command.run",async($,e)=>{
      try {
      const request=JSON.parse(e.args);
      if(request.op==="list")return {rows:await $.config.list()};
      if(request.op==="invalidate"){await $.ui.invalidate("config.describe");return {ok:true}};
      return {result:await $.config.set({key:request.key,value:request.value})};
      } catch(error) { return {error:error.code||error.message} }
    });
  }}`)
  const other = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${hooks}}}`)
  const observed = vi.spyOn(other, "invoke")
  const publish = vi.fn(async (entry: unknown) =>
    protect ? JSON.parse(JSON.stringify(entry).replaceAll("secret", "[protected]")) : entry
  )
  const session = new FunctionSession(
    [
      {
        name: "caller",
        root: "/caller",
        tier: "user",
        guest: caller,
        capabilities: [...SESSION_CAPABILITIES]
      },
      {
        name: "other",
        root: "/other",
        tier: "user",
        guest: other,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "config",
      configRows: rows,
      configChanged,
      assertLive: () => {
        if (!alive) throw Error("MODS_TEST_SCOPE_CHANGED")
      },
      publish: async (entry) => publish(entry) as never
    }
  )
  sessions.push(session)
  const run = (request: object) => session.run("probe", JSON.stringify(request))
  await session.start()
  return {
    session,
    configChanged,
    rows,
    run,
    write,
    observed,
    publish,
    value: () => value,
    replace: (next: boolean) => write(next),
    cancel: () => {
      alive = false
    },
    lock: () => {
      locked = true
    }
  }
}

it("real SDK lists actual rows while excluding every config handler of its caller", async () => {
  const f = await fixture(`
    on("config.list",async($,e,next)=>{const result=await next(e);return {value:result.value.map(row=>({...row,label:row.label+" other"}))}});
    on("config.describe",async($,e,next)=>{const result=await next(e);return {...result,description:"help"}});
  `)
  const result = await f.run({ op: "list" })
  expect(result).toMatchObject({
    rows: [
      {
        key: "gitChangeNoticeEnabled",
        label: "Git notice other",
        value: true,
        description: "help"
      },
      { key: "other.tone", label: "Voice other", value: "secret value" }
    ]
  })
  expect(f.write).not.toHaveBeenCalled()
})

it("other config handlers see the actual SDK caller in next.origin across all three events", async () => {
  const f = await fixture(`
    function verify(next){if(next.origin.plugin!=="caller"||next.origin.tier!=="user")throw Error("wrong origin")}
    on("config.list",async($,e,next)=>{verify(next);return next(e)});
    on("config.describe",async($,e,next)=>{verify(next);return {...await next(e),description:"caller witnessed"}});
    on("config.set",async($,e,next)=>{verify(next);if(e.origin.name!=="caller")throw Error("wrong input origin");return {deny:"caller witnessed"}});
  `)
  expect(await f.run({ op: "list" })).toMatchObject({
    rows: [{ description: "caller witnessed" }, { description: "caller witnessed" }]
  })
  expect(await f.run({ key: "gitChangeNoticeEnabled", value: false })).toEqual({
    result: { deny: "caller witnessed" }
  })
  expect(f.write).not.toHaveBeenCalled()
})

it("config.list is a real operation: other plugins can deny and short-circuit it", async () => {
  const denied = await fixture('on("config.list",()=>({deny:"Not available"}));')
  expect(await denied.run({ op: "list" })).toEqual({ error: "MODS_OPERATION_DENIED" })
  expect(
    denied.observed.mock.calls.filter((call) => call[3]?.event === "config.describe")
  ).toHaveLength(0)
  const short = await fixture('on("config.list",()=>({value:[]}));')
  expect(await short.run({ op: "list" })).toEqual({ rows: [] })
  expect(short.write).not.toHaveBeenCalled()
})

it("SDK set uses the scalar protocol and honors another plugin's adjustment", async () => {
  const f = await fixture('on("config.set",async($,e,next)=>next({...e,value:!e.value}));')
  expect(await f.run({ key: "gitChangeNoticeEnabled", value: true })).toEqual({
    result: { value: false }
  })
  expect(f.value()).toBe(false)
  expect(f.write).toHaveBeenCalledOnce()
})

it("hidden rows disappear from lists but can still be set, while locked values refuse writes", async () => {
  const f = await fixture(
    'on("config.describe",async($,e,next)=>({...await next(e),isHidden:true}));'
  )
  expect(await f.run({ op: "list" })).toEqual({ rows: [] })
  expect(await f.run({ key: "gitChangeNoticeEnabled", value: false })).toEqual({
    result: { value: false }
  })
  f.lock()
  expect(await f.run({ key: "gitChangeNoticeEnabled", value: true })).toMatchObject({
    result: { deny: expect.any(String) }
  })
  expect(f.write).toHaveBeenCalledOnce()
})

it("denials and fabricated successes do not write; a denial after a commit cannot hide it", async () => {
  for (const returned of ['{deny:"No"}', '{deny:""}', '{deny:"x".repeat(5000)}', "{value:false}"]) {
    const f = await fixture(`on("config.set",()=>(${returned}));`)
    expect(await f.run({ key: "gitChangeNoticeEnabled", value: false })).toMatchObject({
      result: { deny: expect.any(String) }
    })
    expect(f.write).not.toHaveBeenCalled()
  }
  const f = await fixture(
    'on("config.set",async($,e,next)=>{await next(e);await next({...e,value:true});return {deny:"pretend refusal"}});'
  )
  expect(await f.run({ key: "gitChangeNoticeEnabled", value: false })).toEqual({
    result: { value: false }
  })
  expect(f.write).toHaveBeenCalledOnce()
})

it("an original native owner guard survives nested SDK configuration publication", async () => {
  const f = await fixture(
    'on("config.describe",async($,e,next)=>{await $.config.set({key:"gitChangeNoticeEnabled",value:false});return next(e)});'
  )
  let owned = true
  f.publish.mockImplementation(async (entry: unknown) => {
    const value = entry as { origin?: { kind?: string; name?: string } }
    if (value?.origin?.kind === "plugin" && value.origin.name === "other") owned = false
    return entry
  })
  await expect(
    f.session.withConfigurationGuard(
      () => {
        if (!owned) throw Error("NATIVE_OWNER_CHANGED")
      },
      () => f.session.configuration.list()
    )
  ).rejects.toThrow("NATIVE_OWNER_CHANGED")
  expect(f.write).not.toHaveBeenCalled()
})

it("menu caches metadata, refreshes real values and ignores SDK descriptions in that cache", async () => {
  const f = await fixture(
    'let count=0;on("config.describe",async($,e,next)=>({...await next(e),description:String(++count)}));'
  )
  const first = await f.session.configuration.list()
  const again = await f.session.configuration.list()
  expect(first).toEqual(again)
  expect(first[0].description).toBe("1")
  f.replace(false)
  expect((await f.session.configuration.list())[0].value).toBe(false)
  // Native menu includes caller's optional failing hooks; SDK bypasses its entire group.
  expect(await f.run({ op: "list" })).toMatchObject({
    rows: [{ description: "3" }, { description: "4" }]
  })
  expect((await f.session.configuration.list())[0].description).toBe("1")
  await f.run({ op: "invalidate" })
  expect(f.configChanged).toHaveBeenLastCalledWith("schema")
  expect((await f.session.configuration.list())[0].description).toBe("5")
})

it("protected public previous is not used as the raw private CAS proof", async () => {
  const f = await fixture(
    'on("config.set",async($,e,next)=>{if(e.previous.includes("secret"))throw Error("raw leak");return next(e)});',
    true
  )
  expect(await f.run({ key: "other.tone", value: "warm" })).toEqual({ result: { value: "warm" } })
  expect(
    (await f.session.configuration.list()).find((row) => row.key === "other.tone")?.value
  ).toBe("warm")
  expect(JSON.stringify(await f.run({ op: "list" }))).not.toContain("secret")
})

it("set rejects unknown keys, malformed values and keeps fixed key/provider/previous/origin", async () => {
  const f = await fixture(
    'on("config.set",async($,e,next)=>next({...e,key:"other.tone",previous:"forged",provider:{plugin:"other",tier:"user"},origin:{kind:"composer"}}));'
  )
  expect(await f.run({ key: "unknown", value: false })).toEqual({
    error: "MODS_CONFIG_UNKNOWN_KEY"
  })
  expect(f.write).not.toHaveBeenCalled()
  expect(await f.run({ key: "gitChangeNoticeEnabled", value: "invalid" })).toMatchObject({
    result: { deny: expect.any(String) }
  })
  expect(f.write).not.toHaveBeenCalled()
  expect(await f.run({ key: "gitChangeNoticeEnabled", value: false })).toEqual({
    result: { value: false }
  })
  expect(f.rows.snapshot().find((row) => row.key === "other.tone")?.value).toBe("secret value")
})

it("publication revalidates the original scope before a native cell write", async () => {
  const f = await fixture()
  f.publish.mockImplementationOnce(async (entry) => {
    f.cancel()
    return entry
  })
  await expect(
    f.session.configuration.set("gitChangeNoticeEnabled", false, { kind: "composer" })
  ).rejects.toThrow("MODS_TEST_SCOPE_CHANGED")
  expect(f.write).not.toHaveBeenCalled()
})
