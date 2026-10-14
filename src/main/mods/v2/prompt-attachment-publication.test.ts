import { expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { filterModData } from "../publication"
import { ModRuntimeAuthorities, type ModRuntimeAuthority } from "../runtime-instance"
import { FunctionGuestRuntime } from "./guest-runtime"
import { withFunctionAgentExecution } from "./host-call"
import { bindHostPromptOccurrence } from "./prompt-cache"
import { publishPromptAttachmentInput } from "./prompt-attachment-publication"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionSessionActivity } from "./session-activity"
import { trackFunctionSession } from "./session-facade"
import { trackFunctionGuest } from "./session-guest"
import { FunctionSessionInitializer } from "./session-initializer"

const secret = "sk-secret-token-123456789"
const question: ModObject = {
  type: "file", text: secret, origin: { kind: "engine" }, agentId: "attachment-agent"
}
const safeQuestion: ModObject = { ...question, text: "[REDACTED]" }
const suppressed = { type: "text", text: "[Non-text output suppressed by project policy]" }

it.each(["image", "image_url", "audio", "file", "resource"])(
  "preserves only the standard %s label while protecting the complete actual input",
  async type => {
    const original: ModObject = { ...question, type }
    const publish = vi.fn(async (payload: ModObject): Promise<ModJson> => {
      expect(payload).toEqual({
        text: secret, origin: { kind: "engine" }, agentId: "attachment-agent"
      })
      expect(payload).not.toBe(original)
      expect(payload.origin).not.toBe(original.origin)
      return filterModData(payload, true)
    })
    expect(await publishPromptAttachmentInput(original, publish)).toEqual({
      ...safeQuestion, type
    })
    expect(publish).toHaveBeenCalledOnce()
    expect(original.text).toBe(secret)
    expect(filterModData(original, true)).toEqual(suppressed)
  }
)

it("keeps arbitrary labels and all plan detail in the original protected payload", async () => {
  const publish = vi.fn(async (payload: ModObject): Promise<ModJson> => filterModData(payload, true))
  expect(await publishPromptAttachmentInput({ ...question, type: secret }, publish))
    .toEqual({ ...safeQuestion, type: "[REDACTED]" })
  const plan: ModObject = {
    type: "plan_mode", text: secret, origin: { kind: "hook", event: "PlanMode" },
    detail: { planFilePath: secret, hasPlan: true, reminder: "full" }
  }
  expect(await publishPromptAttachmentInput(plan, publish)).toEqual({
    ...plan, text: "[REDACTED]",
    detail: { planFilePath: "[REDACTED]", hasPlan: true, reminder: "full" }
  })
  expect(publish).toHaveBeenCalledTimes(2)
  expect(publish.mock.calls[0][0].type).toBe(secret)
  expect(publish.mock.calls[1][0]).toEqual(plan)
})

it("pins the first standard label without restoring raw text, origin or detail after publication", async () => {
  const original: ModObject = structuredClone(question)
  expect(await publishPromptAttachmentInput(original, async payload => {
    original.type = "image"
    original.text = "late raw text"
    original.origin = { kind: "plugin", event: "late" }
    expect(payload).toEqual({
      text: secret, origin: { kind: "engine" }, agentId: "attachment-agent"
    })
    return filterModData({ ...payload, text: `${payload.text} protected tail` }, true)
  })).toEqual({ ...safeQuestion, text: "[REDACTED] protected tail" })
})

it("rejects accessors and illegal nested media before publication rather than extending the schema", async () => {
  const publish = vi.fn(async (payload: ModObject): Promise<ModJson> => filterModData(payload, true))
  let getters = 0
  for (const field of ["type", "text", "origin"]) {
    const input: ModObject = structuredClone(question)
    Object.defineProperty(input, field, { enumerable: true, get() { getters++; return secret } })
    await expect(publishPromptAttachmentInput(input, publish)).rejects.toThrow("MODS_JSON_ACCESSOR")
  }
  await expect(publishPromptAttachmentInput({ ...question, extra: { type: "file", body: secret } }, publish))
    .rejects.toThrow("MODS_PROMPT_ATTACHMENT_INPUT")
  await expect(publishPromptAttachmentInput({ ...question, detail: { type: "file", body: secret } }, publish))
    .rejects.toThrow("MODS_PROMPT_ATTACHMENT_DETAIL")
  expect(getters).toBe(0)
  expect(publish).not.toHaveBeenCalled()
  expect(filterModData({ nested: { type: "file", body: secret }, secret }, true))
    .toEqual({ nested: suppressed, secret: "[REDACTED]" })
})

it("validates the protected input without recovering missing fields or unprotected media", async () => {
  await expect(publishPromptAttachmentInput(question, async () => ({ text: "protected" })))
    .rejects.toThrow("MODS_PROMPT_ATTACHMENT_INPUT")
  await expect(publishPromptAttachmentInput(question, async () => ({ origin: { kind: "engine" } })))
    .rejects.toThrow("MODS_PROMPT_ATTACHMENT_INPUT")
  await expect(publishPromptAttachmentInput(question, async payload =>
    filterModData({ ...payload, extra: { type: "file", body: secret } }, true)))
    .rejects.toThrow("MODS_PROMPT_ATTACHMENT_INPUT")
  let getters = 0
  await expect(publishPromptAttachmentInput(question, async () => {
    const result: ModObject = { text: "protected", origin: { kind: "engine" } }
    Object.defineProperty(result, "text", { enumerable: true, get() { getters++; return secret } })
    return result
  })).rejects.toThrow("MODS_JSON_ACCESSOR")
  expect(getters).toBe(0)
})

it("keeps original rejection, undefined and cancellation without returning the raw input", async () => {
  const failure = Error("actual attachment publisher rejected")
  await expect(publishPromptAttachmentInput(question, async () => { throw failure }))
    .rejects.toBe(failure)
  await expect(publishPromptAttachmentInput(question, async () => { throw undefined }))
    .rejects.toBeUndefined()
  await expect(publishPromptAttachmentInput(question, async () => undefined))
    .rejects.toThrow("MODS_PROMPT_ATTACHMENT_INPUT")
  const controller = new AbortController()
  await expect(publishPromptAttachmentInput(question, async () => {
    controller.abort(failure)
    controller.signal.throwIfAborted()
    return question
  })).rejects.toBe(failure)
  expect(question.text).toBe(secret)
})

async function trackedFixture(hooks: string) {
  const activity = new FunctionSessionActivity()
  const registry = new ModRuntimeAuthorities()
  const { authority } = registry.create({
    workspace: "C:/project", threadId: "attachment-thread", turnId: "turn", agentId: "main"
  })
  let runtime: FunctionGuestRuntime | undefined
  let actual: FunctionSession | undefined
  try {
    runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${hooks}}}`)
    const guest = trackFunctionGuest(runtime, activity, new FunctionSessionInitializer(false))
    const payloads: ModJson[] = []
    const sessionOwner = new FunctionSession([{
      name: "attachment", root: "/plugin/attachment", tier: "user", guest,
      capabilities: [...SESSION_CAPABILITIES]
    }], {
      workspace: authority.workspace, threadId: authority.threadId, activity,
      assertLive() { /* Real publication/entry and authority are checked separately in this fixture. */ },
      publish: async value => {
        payloads.push(structuredClone(value))
        // Actual production preflight, not a claim that this fixture runs the policy utilityProcess.
        return filterModData(value, true)
      }
    })
    actual = sessionOwner
    const session = trackFunctionSession(sessionOwner, activity)
    await session.start()
    payloads.length = 0
    return { session, activity, authority, payloads, close: async () => {
      try { await sessionOwner.close() } finally { registry.close(); activity.close() }
    } }
  } catch (error) {
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => actual?.close()),
      Promise.resolve().then(() => runtime?.dispose()),
      Promise.resolve().then(() => registry.close()),
      Promise.resolve().then(() => activity.close())
    ])
    const failures = settled.filter(result => result.status === "rejected")
    if (failures.length) throw new AggregateError([error, ...failures.map(result => result.reason)],
      "Attachment fixture creation and cleanup failed")
    throw error
  }
}

function within<T>(authority: ModRuntimeAuthority, run: () => Promise<T>): Promise<T> {
  return withFunctionAgentExecution({
    workspace: authority.workspace, threadId: authority.threadId, turnId: authority.turnId,
    agentId: authority.agentId, runtimeAuthority: authority, userInitiated: false,
    leased: false, immediate: false
  }, run)
}

it("protects genuine tracked composition at all seven original publications and keeps its source cache", async () => {
  const f = await trackedFixture(`on("prompt.attachment",async($,e,next)=>{
    if(e.type!=="file"||e.text!=="[REDACTED]"||e.origin.kind!=="engine")throw Error("bad protected input");
    return await next(e);
  });`)
  const core = vi.fn(async (received: ModObject): Promise<ModObject> => {
    expect(received).toEqual(safeQuestion)
    expect(f.activity.withinEntry).toBe(true)
    return { text: received.text }
  })
  bindHostPromptOccurrence(core, "prompt.attachment", {})
  const request = () => within(f.authority, () =>
    f.session.promptComposition("prompt.attachment", question, new AbortController().signal, core))
  try {
    expect(await request()).toEqual({ text: "[REDACTED]" })
    expect(core).toHaveBeenCalledOnce()
    expect(f.payloads).toHaveLength(7)
    expect(f.payloads.filter(value => typeof value === "object" && value !== null &&
      !Array.isArray(value) && Object.hasOwn(value, "origin"))).toEqual([
      { text: secret, origin: { kind: "engine" }, agentId: "attachment-agent" },
      { text: "[REDACTED]", origin: { kind: "engine" }, agentId: "attachment-agent" },
      { text: "[REDACTED]", origin: { kind: "engine" }, agentId: "attachment-agent" }
    ])
    f.payloads.length = 0
    expect(await request()).toEqual({ text: "[REDACTED]" })
    expect(core).toHaveBeenCalledOnce()
    expect(f.payloads).toHaveLength(2)
    expect(f.activity.size).toBe(0)
  } finally { await f.close() }
})

it("keeps genuine attachment type and origin pins while allowing a real Hook to omit text", async () => {
  const f = await trackedFixture(`on("prompt.attachment",async($,e,next)=>{
    await next({...e,type:"image",origin:{kind:"plugin",event:"forged"}});return {text:null};
  });`)
  const core = vi.fn(async (received: ModObject): Promise<ModObject> => {
    expect(received).toEqual(safeQuestion)
    return { text: received.text }
  })
  try {
    expect(await within(f.authority, () => f.session.promptComposition("prompt.attachment",
      question, new AbortController().signal, core))).toEqual({ text: "[REDACTED]" })
    expect(core).toHaveBeenCalledOnce()
  } finally { await f.close() }
  const omitted = await trackedFixture('on("prompt.attachment",()=>({text:null}));')
  const noCore = vi.fn(async (): Promise<ModObject> => ({ text: "unused" }))
  try {
    expect(await within(omitted.authority, () => omitted.session.promptComposition("prompt.attachment",
      question, new AbortController().signal, noCore))).toEqual({ text: null })
    expect(noCore).not.toHaveBeenCalled()
    expect(omitted.payloads).toHaveLength(4)
  } finally { await omitted.close() }
})

it("protects the real SDK direct attachment path under its original runtime authority", async () => {
  const f = await trackedFixture(`
    on("session.start",async($,e,next)=>{await $.command.register({name:"attachment",description:"Actual attachment"});return next(e)});
    on("command.run",{command:"attachment"},async($)=>({text:JSON.stringify(await $.prompt.attachment({
      type:"file",text:"${secret}",origin:{kind:"engine"},agentId:"sdk-data"
    }))}));
  `)
  try {
    expect(await within(f.authority, () => f.session.run("attachment", "")))
      .toMatchObject({ text: '{"text":"[REDACTED]"}' })
    const inputs = f.payloads.filter(value => typeof value === "object" && value !== null &&
      !Array.isArray(value) && Object.hasOwn(value, "origin"))
    expect(inputs).toEqual([{ text: secret, origin: { kind: "engine" }, agentId: "sdk-data" }])
    expect(f.payloads.filter(value => typeof value === "object" && value !== null &&
      !Array.isArray(value) && value.text === "[REDACTED]")).toHaveLength(2)
    expect(f.activity.size).toBe(0)
  } finally { await f.close() }
})
