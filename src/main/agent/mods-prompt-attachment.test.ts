import { afterEach, expect, it, vi } from "vitest"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { createModAttachmentTransform } from "./mods-prompt-attachment"
import type { ModObject } from "../../shared/mods/types"
import { functionCallAuthority, withFunctionAgentExecution } from "../mods/v2/host-call"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"

const owners: ModRuntimeAuthorities[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.close() })
function fixture(agentId = "main") {
  const ownersForTest = new ModRuntimeAuthorities()
  owners.push(ownersForTest)
  const { authority } = ownersForTest.create({ workspace: "/p", threadId: "t",
    turnId: "turn", agentId })
  const dispatch = vi.fn(async (_w: string, _t: string, _event: string, input: ModObject) =>
    ({ text: input.text }))
  const options = { type: "output_style", origin: { kind: "engine" },
    captureRuntime: () => () => authority.assertLive(),
    authority: () => authority, enabled: () => true, dispatch }
  return { authority, ownersForTest, options, dispatch }
}

it("publishes the actual producer body and actual loop identity without a wrapper", async () => {
  const f = fixture("private-child")
  const transform = createModAttachmentTransform(f.options)
  expect(await transform("BODY", new AbortController().signal)).toBe("BODY")
  expect(f.dispatch).toHaveBeenCalledWith("/p", "t", "prompt.attachment",
    { type: "output_style", text: "BODY", origin: { kind: "engine" }, agentId: "private-child" },
    expect.any(AbortSignal), expect.any(Function))
})

it("enters the actual producer owner even without ambient scope or under another parent", async () => {
  const f = fixture("actual-child")
  f.dispatch.mockImplementation(async (_w, _t, _event, input) => {
    expect(functionCallAuthority("/p", "t")).toBe(f.authority)
    return { text: input.text }
  })
  const transform = createModAttachmentTransform(f.options)
  expect(await transform("BODY", new AbortController().signal, {})).toBe("BODY")
  const parent = fixture("parent")
  await withFunctionAgentExecution({ workspace: "/p", threadId: "t", turnId: "turn",
    agentId: parent.authority.agentId, runtimeAuthority: parent.authority,
    userInitiated: true, leased: true, immediate: false }, async () => {
    expect(await transform("BODY", new AbortController().signal, {})).toBe("BODY")
    expect(functionCallAuthority("/p", "t")).toBe(parent.authority)
  })
})

it("disabled does not dispatch or inspect an expired owner", async () => {
  const f = fixture()
  f.ownersForTest.close()
  expect(await createModAttachmentTransform({ ...f.options, enabled: () => false })("BODY"))
    .toBe("BODY")
  expect(f.dispatch).not.toHaveBeenCalled()
})

it("never publishes after cancellation or runtime revocation", async () => {
  const f = fixture()
  const controller = new AbortController()
  f.dispatch.mockImplementation(async () => { controller.abort(); return { text: "CHANGED" } })
  await expect(createModAttachmentTransform(f.options)("BODY", controller.signal)).rejects.toThrow()
  const g = fixture()
  g.dispatch.mockImplementation(async () => { g.ownersForTest.close(); return { text: "CHANGED" } })
  await expect(createModAttachmentTransform(g.options)("BODY", new AbortController().signal))
    .rejects.toThrow(/MODS_RUNTIME/)
})

it("real producer entry supports SDK calculation and settled reuse without any ambient owner", async () => {
  const f = fixture()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let count=0;
    on("prompt.attachment",{type:"output_style"},async($,e,next)=>{
      const calculated=await $.prompt.attachment({type:"trial",text:"SDK_OWNER",origin:{kind:"engine"}});
      if(calculated.text!=="SDK_OWNER")throw Error("WRONG_SDK");
      await next(e);return {text:"COUNT:"+(++count)}
    })
  }}`)
  const session = new FunctionSession([{ name: "attachment", root: "/attachment", tier: "user",
    guest, capabilities: [...SESSION_CAPABILITIES] }], { workspace: "/p", threadId: "t",
    assertLive() { /* The producer capture checks the actual fixture runtime. */ },
    publish: async value => structuredClone(value) })
  const transform = createModAttachmentTransform({ ...f.options,
    dispatch: (_w, _t, event, input, signal, core) => session.promptComposition(event, input, signal, core)
  })
  const occurrence = {}
  try {
    expect(await transform("BODY", new AbortController().signal, occurrence)).toBe("COUNT:1")
    expect(await transform("BODY", new AbortController().signal, occurrence)).toBe("COUNT:1")
    expect(await transform("BODY", new AbortController().signal, {})).toBe("COUNT:2")
  } finally {
    await session.close()
  }
})
