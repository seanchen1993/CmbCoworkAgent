import { expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { filterModData } from "../publication"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionSessionActivity } from "./session-activity"
import { trackFunctionSession } from "./session-facade"
import { trackFunctionGuest } from "./session-guest"
import { FunctionSessionInitializer } from "./session-initializer"

const secret = "sk-core-denial-fixture-123456789"
const originalDenial = `无法读取文件：${secret}；请重新授权🙂`
const safeDenial = "无法读取文件：[REDACTED]；请重新授权🙂"
const input: ModObject = { mention: "file.txt", path: "C:/project/file.txt" }

async function fixture(
  publish: (value: ModJson, call: number) => Promise<ModJson> = async (value) =>
    filterModData(value, true)
) {
  const activity = new FunctionSessionActivity()
  const runtime = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("prompt.mention",async($,e,next)=>{
      await next(e);return {type:"file",context:["ignored Hook context"]};
    });
  }}`)
  try {
    const guest = trackFunctionGuest(runtime, activity, new FunctionSessionInitializer(false))
    const payloads: ModJson[] = []
    let recording = false
    const actual = new FunctionSession(
      [
        {
          name: "actual-denial",
          root: "/plugin/actual-denial",
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: "C:/project",
        threadId: "thread",
        activity,
        assertLive() {
          /* This fixture verifies protected denial, without creating file authority. */
        },
        publish: async (value) => {
          if (recording) payloads.push(JSON.parse(JSON.stringify(value)) as ModJson)
          return publish(value, recording ? payloads.length : 0)
        }
      }
    )
    await actual.start()
    recording = true
    return {
      session: trackFunctionSession(actual, activity),
      activity,
      payloads,
      close: () => actual.close()
    }
  } catch (error) {
    runtime.dispose()
    throw error
  }
}

it("returns the whole protected Core denial after a real Hook replaces next with a file", async () => {
  const f = await fixture()
  const core = vi.fn(async (): Promise<ModObject> => ({ deny: originalDenial }))
  try {
    expect(await f.session.promptMention(input, new AbortController().signal, core)).toEqual({
      deny: safeDenial
    })
    expect(core).toHaveBeenCalledOnce()
    expect(f.payloads).toHaveLength(5)
    expect(f.payloads.at(-1)).toEqual({ deny: safeDenial })
    expect(f.activity.size).toBe(0)
  } finally {
    await f.close()
  }
})

it("pins the actual Core denial before the publisher mutates the original object", async () => {
  const original: ModObject = { deny: originalDenial }
  const f = await fixture(async (value, call) => {
    if (call === 3) {
      delete original.deny
      original.type = "file"
    }
    return filterModData(value, true)
  })
  const core = vi.fn(async () => original)
  try {
    expect(await f.session.promptMention(input, new AbortController().signal, core)).toEqual({
      deny: safeDenial
    })
    expect(original).toEqual({ type: "file" })
    expect(core).toHaveBeenCalledOnce()
    expect(f.payloads).toHaveLength(5)
    expect(f.payloads.at(-1)).toEqual({ deny: safeDenial })
  } finally {
    await f.close()
  }
})

it.each([3, 5])(
  "refuses a publisher that loses Core denial at publication %s",
  async (callToChange) => {
    const f = await fixture(async (value, call) =>
      call === callToChange ? { type: "file" } : filterModData(value, true)
    )
    const core = vi.fn(async (): Promise<ModObject> => ({ deny: originalDenial }))
    try {
      await expect(
        f.session.promptMention(input, new AbortController().signal, core)
      ).rejects.toThrow("MODS_PROMPT_MENTION_RESULT")
      expect(core).toHaveBeenCalledOnce()
      expect(f.payloads).toHaveLength(callToChange)
      expect(f.activity.size).toBe(0)
    } finally {
      await f.close()
    }
  }
)

it("does not recover a raw denial when the actual Core publication rejects with undefined", async () => {
  const f = await fixture(async (value, call) => {
    if (call === 3) throw undefined
    return filterModData(value, true)
  })
  const core = vi.fn(async (): Promise<ModObject> => ({ deny: originalDenial }))
  try {
    await expect(
      f.session.promptMention(input, new AbortController().signal, core)
    ).rejects.toMatchObject({ code: "MODS_DOWNSTREAM_REJECTED", message: "MODS_CORE_ERROR" })
    expect(core).toHaveBeenCalledOnce()
    expect(f.payloads).toHaveLength(3)
    expect(f.activity.size).toBe(0)
  } finally {
    await f.close()
  }
})

it("does not return a denial after cancellation during its original Core publication", async () => {
  const controller = new AbortController()
  const f = await fixture(async (value, call) => {
    if (call === 3) controller.abort(Error("CORE_DENIAL_CANCELLED"))
    return filterModData(value, true)
  })
  const core = vi.fn(async (): Promise<ModObject> => ({ deny: originalDenial }))
  try {
    await expect(f.session.promptMention(input, controller.signal, core)).rejects.toMatchObject({
      code: "MODS_CANCELLED"
    })
    expect(controller.signal.reason.message).toBe("CORE_DENIAL_CANCELLED")
    expect(core).toHaveBeenCalledOnce()
    expect(f.payloads).toHaveLength(3)
    expect(f.activity.size).toBe(0)
  } finally {
    await f.close()
  }
})
