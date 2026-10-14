import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionCopyResult } from "../../../shared/mods/v2/desktop-actions"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
async function fixture(
  hooks = "",
  copy: FunctionCopyResult = { isCopied: true },
  publish: (value: ModJson) => Promise<ModJson> = async (value) => value,
  neighbor = ""
) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"desk",description:"Desktop"});return next(e)});
    on("command.run",async($,e)=>({text:JSON.stringify(e.args==="selection"?await $.ui.selection():
      e.args==="panes"?await $.ui.panes():await $.ui.copy({text:"secret text"}))}));
    ${hooks}
  }}`)
  const copies: ModObject[] = []
  let bindingLive = true
  let selected: { text: string; requestId?: string } | undefined = {
    text: "secret chosen",
    requestId: "actual-row"
  }
  const session = new FunctionSession(
    [
      {
        name: "desktop",
        root: "/desktop",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      },
      ...(neighbor
        ? [
            {
              name: "neighbor",
              root: "/neighbor",
              tier: "user" as const,
              guest: await FunctionGuestRuntime.create(
                `var __cmbFunctionMod={register(on){${neighbor}}}`
              ),
              capabilities: [...SESSION_CAPABILITIES]
            }
          ]
        : [])
    ],
    {
      workspace: "/workspace",
      threadId: "t",
      assertLive: () => undefined,
      publish,
      prepareDesktop: async () => ({
        assertLive() {
          if (!bindingLive) throw Error("original binding changed")
        },
        copy: async (input) => {
          copies.push({ ...input })
          return input.surface === "desktop" ? copy : { isCopied: false, reason: "no-surface" }
        },
        selection: async () => selected,
        clearSelection: async () => {},
        drawings: async () => []
      })
    }
  )
  sessions.push(session)
  await session.start()
  return {
    session,
    copies,
    run: (args = "") => session.run("desk", args),
    rebind: () => {
      bindingLive = false
    },
    empty: () => {
      selected = undefined
    }
  }
}
it("uses operation envelopes, mutable supported surfaces and protected final copy text", async () => {
  const f = await fixture(
    `on("ui.copy",async($,e,next)=>next({...e,text:e.text+" edited"}));`,
    { isCopied: true },
    async (value) => JSON.parse(JSON.stringify(value).replaceAll("secret", "redacted"))
  )
  expect((await f.run()).text).toBe('{"isCopied":true}')
  expect(f.copies).toEqual([{ text: "redacted text edited", surface: "desktop" }])
})
it("the actual copy core receives transformations from a second independent plugin", async () => {
  const f = await fixture(
    "",
    { isCopied: true },
    undefined,
    `on("ui.copy",async($,e,next)=>next({...e,text:"[combined] "+e.text}));`
  )
  expect((await f.run()).text).toBe('{"isCopied":true}')
  expect(f.copies).toEqual([{ text: "[combined] secret text", surface: "desktop" }])
})
it("a hook may rewrite the surface, but no new surface or native success is invented", async () => {
  const f = await fixture(`on("ui.copy",async($,e,next)=>next({...e,surface:"mobile"}));`)
  expect((await f.run()).text).toBe('{"isCopied":false,"reason":"no-surface"}')
  expect(f.copies[0].surface).toBe("mobile")
})
it.each([`({value:{isCopied:true}})`, `({deny:"refused"})`])(
  "does not turn %s into a clipboard write",
  async (result) => {
    const f = await fixture(`on("ui.copy",async()=>${result});`)
    expect((await f.run()).text).toBe('{"isCopied":false,"reason":"refused"}')
    expect(f.copies).toHaveLength(0)
  }
)
it("cannot claim success after the real clipboard refuses", async () => {
  const f = await fixture(
    `on("ui.copy",async($,e,next)=>{await next(e);return {value:{isCopied:true}}});`,
    { isCopied: false, reason: "no-clipboard" }
  )
  expect((await f.run()).text).toBe('{"isCopied":false,"reason":"refused"}')
})
it("a blocked sibling copy cannot borrow another nested call's native proof", async () => {
  const f = await fixture(`
    on("ui.copy",async($,e)=>{await $.ui.copy({text:"shown"});return {value:await $.ui.copy({text:"blocked"})}});
    on("ui.copy",{text:"blocked"},async()=>({value:{isCopied:true}}));`)
  expect((await f.run()).text).toBe('{"isCopied":false,"reason":"refused"}')
  expect(f.copies).toHaveLength(1)
  expect(f.copies[0].text).toBe("shown")
})
it("selection is protected before the outer hook sees it and operations skip only themselves", async () => {
  const f = await fixture(
    `
    on("ui.selection",async($)=>({value:await $.ui.selection()}));
    on("ui.selection",{},async($,e,next)=>{const result=await next(e);return {value:{...result.value,text:result.value.text+" neighbor"}}});`,
    { isCopied: true },
    async (value) => JSON.parse(JSON.stringify(value).replaceAll("secret", "redacted"))
  )
  expect((await f.run("selection")).text).toBe(
    '{"text":"redacted chosen neighbor","requestId":"actual-row"}'
  )
})
it("panes query runs its own chain without starting a drawing", async () => {
  const f = await fixture(`on("ui.panes",async($,e,next)=>next(e));`)
  expect((await f.run("panes")).text).toBe("[]")
})
it("empty native selection keeps the SDK undefined contract", async () => {
  const f = await fixture(
    `on("ui.selection",async($,e,next)=>{const answer=await next(e);if(answer.value!==undefined)throw Error("not empty");return answer});`
  )
  f.empty()
  expect((await f.run("selection")).text).toBeUndefined()
})
it.each(["ui.copy", "ui.selection", "ui.panes"])(
  "%s checks the original binding after protected core publication",
  async (method) => {
    const binding: { revoke?: () => void } = {}
    const f = await fixture(
      `on("${method}",async($,e,next)=>next(e));`,
      { isCopied: true },
      async (value) => {
        if (value && typeof value === "object" && Object.hasOwn(value, "value")) binding.revoke?.()
        return value
      }
    )
    binding.revoke = f.rebind
    await expect(
      f.run(method === "ui.copy" ? "" : method === "ui.selection" ? "selection" : "panes")
    ).rejects.toThrow("binding changed")
  }
)
it("a short-circuit result cannot bypass the captured binding at publication", async () => {
  const binding: { revoke?: () => void } = {}
  const f = await fixture(
    `on("ui.selection",()=>({value:{text:"invented"}}));`,
    { isCopied: true },
    async (value) => {
      if (value && typeof value === "object" && Object.hasOwn(value, "value")) binding.revoke?.()
      return value
    }
  )
  binding.revoke = f.rebind
  await expect(f.run("selection")).rejects.toThrow("binding changed")
})
