import { expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { PlatformBehaviors } from "./platform-behaviors"
import type { PlatformCapabilityInfo } from "../../../shared/mods/v2/platform-capabilities"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"

function info(id: string, phase = "replace"): PlatformCapabilityInfo {
  return {
    ref: { provider: "author", id, version: "1.0.0" },
    source: { provider: "author", digest: "a".repeat(64), generation: "one" },
    available: true,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id,
      version: "1.0.0",
      title: id,
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "format",
          title: "format",
          inputSchema: {},
          outputSchema: {},
          requiredPermissions: [],
          cancellable: true,
          idempotency: "keyed"
        }
      ],
      presentation: {
        type: "behavior",
        apiVersion: "devclaw.behavior/v1",
        id,
        title: id,
        point: "ui.toast",
        phase,
        action: "format"
      }
    }
  }
}

it("previews conflicts without executing guest code, explicitly applies and restores real native output", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.toast",async($,input,next)=>{const result=await next({...input,text:"Author: "+input.text});return result})
  }}`)
  const invoke = vi.fn(async (_binding, input, next, signal) => {
    const result = await guest.invoke(
      "0",
      input,
      async (method, args) => {
        if (method !== "next") throw Error("UNEXPECTED_CAPABILITY")
        return { value: await next((args as ModObject).input as ModObject) }
      },
      {
        event: "ui.toast",
        origin: { plugin: "author", tier: "user" },
        capabilities: [],
        plugin: { name: "author", root: "/author" },
        signal
      }
    )
    return result.value!
  })
  const native: string[] = [],
    original = async (value: ModObject) => {
      native.push(String(value.text))
      return { delivered: true }
    }
  const registry = new PlatformBehaviors({
    capabilities: () => [info("one"), info("two")],
    assertCurrent: () => {},
    invoke,
    validateInput: (_, value) => {
      if (typeof value.text !== "string") throw Error("INVALID_NATIVE_INPUT")
    },
    changed: () => {}
  })
  try {
    const conflict = registry.preview(["author/one", "author/two"])
    expect(conflict.canApply).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    expect(() => registry.apply(conflict.previewId, conflict.revision)).toThrow()
    await registry.run("ui.toast", { text: "first" }, original, new AbortController().signal)
    expect(native).toEqual(["first"])
    const preview = registry.preview(["author/one"])
    registry.apply(preview.previewId, preview.revision)
    await registry.run("ui.toast", { text: "second" }, original, new AbortController().signal)
    expect(native).toEqual(["first", "Author: second"])
    registry.disable()
    await registry.run("ui.toast", { text: "third" }, original, new AbortController().signal)
    expect(native.at(-1)).toBe("third")
  } finally {
    guest.dispose()
  }
})

it("never repeats a delegated native operation after an optional author error", async () => {
  const original = vi.fn(async (input: ModObject) => input)
  const registry = new PlatformBehaviors({
    capabilities: () => [info("one")],
    assertCurrent: () => {},
    invoke: async (_, input, next) => {
      await next(input)
      throw Error("AUTHOR_FAILED_AFTER_DELEGATE")
    },
    validateInput: () => {},
    changed: () => {}
  })
  const preview = registry.preview(["author/one"])
  registry.apply(preview.previewId, preview.revision)
  await expect(
    registry.run("ui.toast", { text: "once" }, original, new AbortController().signal)
  ).resolves.toEqual({ text: "once" })
  expect(original).toHaveBeenCalledOnce()
})

it("fails closed across native authorization changes and discards stale apply previews", async () => {
  const descriptor = info("one"),
    original = vi.fn(async () => ({}))
  const registry = new PlatformBehaviors({
    capabilities: () => [descriptor],
    assertCurrent: () => {
      throw new ModFunctionError("MODS_CAPABILITY_DENIED")
    },
    invoke: async () => ({}),
    validateInput: () => {},
    changed: () => {}
  })
  const preview = registry.preview(["author/one"])
  expect(() => registry.apply(preview.previewId, preview.revision)).toThrow(
    "MODS_CAPABILITY_DENIED"
  )
  descriptor.source.generation = "replacement"
  expect(() => registry.apply(preview.previewId, preview.revision)).toThrow(
    "MODS_PLATFORM_BEHAVIOR_PREVIEW_STALE"
  )
  expect(original).not.toHaveBeenCalled()
})

it("detects dependency cycles and missing prerequisites before applying", () => {
  const first = info("one", "before"),
    second = info("two", "before")
  first.descriptor.presentation!.after = ["author/two"]
  second.descriptor.presentation!.after = ["author/one"]
  first.descriptor.presentation!.requires = ["author/two"]
  const registry = new PlatformBehaviors({
    capabilities: () => [first, second],
    assertCurrent: () => {},
    invoke: async () => ({}),
    validateInput: () => {},
    changed: () => {}
  })
  expect(registry.preview(["author/one"]).missing).not.toEqual([])
  expect(registry.preview(["author/one", "author/two"]).conflicts).toContain(
    "声明的行为顺序存在循环"
  )
})
