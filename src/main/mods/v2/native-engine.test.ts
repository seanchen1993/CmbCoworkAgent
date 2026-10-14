import { expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject } from "../../../shared/mods/v2/contracts"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"
import { FunctionNativeDrawing, functionNativePresentation } from "./native-engine"

const engine = (ref: number): FunctionUiElement => ({ type: "engine", ref })
const input = (text = "private original"): ModObject => ({
  surface: "desktop",
  component: "UserMessage",
  requestId: "owner",
  props: { text, origin: { kind: "unclassified" }, isExpanded: false }
})
const unchanged = async (value: ModJson): Promise<ModJson> => value

it("rechecks publication policy on a later snapshot of the same drawing", async () => {
  const drawing = new FunctionNativeDrawing(input(), () => {})
  drawing.beginPublication()
  await drawing.protect(engine(0), unchanged)
  drawing.beginPublication()
  let called = false
  const safe = await drawing.protect(engine(0), async (value) => {
    called = true
    return (value as ModObject[]).map((entry) => ({
      ...entry,
      props: { ...(entry.props as ModObject), text: "changed safe policy" }
    }))
  })
  expect(called).toBe(true)
  expect(safe.entries[0].props.text).toBe("changed safe policy")
})

it("keeps legacy cosmetic changes while validating their actual presentation schema", () => {
  const duration = { word: "Baked", durationMs: 2000 }
  expect(
    functionNativePresentation("TurnDuration", { ...duration, durationMs: 6000 }, duration)
  ).toEqual({ word: "Baked", durationMs: 6000 })
  expect(() =>
    functionNativePresentation("TurnDuration", { ...duration, durationMs: -1 }, duration)
  ).toThrow("MODS_UI_SITE_PROPS")
  const spinner = { word: "Working", message: null, suffix: "", mode: "responding" }
  expect(
    functionNativePresentation("Spinner", { ...spinner, mode: "thinking" }, spinner).mode
  ).toBe("thinking")
  expect(() =>
    functionNativePresentation("Spinner", { ...spinner, mode: "execute" }, spinner)
  ).toThrow("MODS_UI_SITE_PROPS")
  expect(
    functionNativePresentation(
      "InfoNotice",
      { text: "safe", command: "display only" },
      { text: "original", command: null }
    )
  ).toEqual({ text: "safe", command: "display only" })
})

it("protects ref zero and unknown refs without publishing the raw original", async () => {
  const drawing = new FunctionNativeDrawing(input(), () => {})
  const output = await drawing.protect(engine(999), async (value) => {
    expect(Array.isArray(value)).toBe(true)
    return (value as ModObject[]).map((entry) => ({
      ref: entry.ref,
      props: { ...(entry.props as ModObject), text: "safe body" }
    }))
  })
  expect(output.entries).toEqual([
    {
      ref: 0,
      props: {
        text: "safe body",
        origin: { kind: "unclassified" },
        isExpanded: false
      }
    }
  ])
  expect(output.nativeUnchanged).toBe(false)
  expect(JSON.stringify(output)).not.toContain("private original")
})

it("keeps genuine core inputs in one draw, while another draw starts a separate table", async () => {
  const original = input("first")
  const drawing = new FunctionNativeDrawing(original, () => {})
  expect(
    drawing.keep({ ...original, props: { ...(original.props as ModObject), text: "second" } })
  ).toEqual(engine(1))
  const view = await drawing.protect(engine(1), unchanged)
  expect(view.entries.map((entry) => entry.props.text)).toEqual(["first", "second"])
  const next = new FunctionNativeDrawing(input("new original"), () => {})
  const other = await next.protect(engine(1), unchanged)
  expect(other.entries.map((entry) => entry.props.text)).toEqual(["new original"])
})

it("does not borrow later mutations of the supplied input as pinned host facts", async () => {
  const original = input()
  const drawing = new FunctionNativeDrawing(original, () => {})
  const originalProps = original.props as ModObject
  originalProps.text = "changed outside"
  originalProps.origin = { kind: "plugin", name: "forged" }
  expect((await drawing.protect(engine(0), unchanged)).entries[0].props.text).toBe(
    "private original"
  )
  expect(() => drawing.keep(original)).toThrow("MODS_PINNED_INPUT")
})

it("rejects an injected identity or ref and does not accept half of a protected batch", async () => {
  const original = input()
  const drawing = new FunctionNativeDrawing(original, () => {})
  drawing.keep({ ...original, props: { ...(original.props as ModObject), text: "second" } })
  let calls = 0
  await expect(
    drawing.protect(engine(1), async (value) => {
      calls++
      const entries = value as ModObject[]
      return [
        entries[0],
        {
          ...entries[1],
          props: {
            ...(entries[1].props as ModObject),
            origin: { kind: "plugin", name: "forged" }
          }
        }
      ]
    })
  ).rejects.toThrow("MODS_UI_NATIVE_PUBLICATION")
  const view = await drawing.protect(engine(1), async (value) => {
    calls++
    expect(value as unknown[]).toHaveLength(2)
    return value
  })
  expect(calls).toBe(2)
  expect(view.entries).toHaveLength(2)
  await expect(
    new FunctionNativeDrawing(original, () => {}).protect(engine(0), async (value) =>
      (value as ModObject[]).map((entry) => ({ ...entry, ref: 77 }))
    )
  ).rejects.toThrow("MODS_UI_NATIVE_PUBLICATION")
})

it("protects a newly referenced real input after tree publication without reusing raw props", async () => {
  const original = input()
  const drawing = new FunctionNativeDrawing(original, () => {})
  drawing.keep({ ...original, props: { ...(original.props as ModObject), text: "new secret" } })
  const seen: number[][] = []
  const publish = async (value: ModJson): Promise<ModJson> => {
    const entries = value as ModObject[]
    seen.push(entries.map((entry) => entry.ref as number))
    return entries.map((entry) => ({
      ...entry,
      props: {
        ...(entry.props as ModObject),
        text: "safe"
      }
    }))
  }
  await drawing.protect(engine(0), publish)
  const final = await drawing.protect(engine(1), publish)
  expect(seen).toEqual([[0], [1]])
  expect(final.entries.every((entry) => entry.props.text === "safe")).toBe(true)
})

it("rejects stale host receipts after actual publication waiting", async () => {
  let live = true
  const drawing = new FunctionNativeDrawing(input(), () => {
    if (!live) throw Error("ACTUAL_OWNER_RETIRED")
  })
  const gate = Promise.withResolvers<ModJson>()
  const pending = drawing.protect(engine(0), () => gate.promise)
  live = false
  gate.resolve([{ ref: 0, props: input().props }])
  await expect(pending).rejects.toThrow("ACTUAL_OWNER_RETIRED")
})

it("allows trusted ToolGroup body protection but pins actual row identities and order", () => {
  const call: ModObject = {
    tool_use_id: "actual",
    tool: "Read",
    input: { path: "private path" },
    output: "private output",
    isRunning: false,
    isErrored: false,
    isInterrupted: false
  }
  const original: ModObject = { calls: [call], isActive: false, isExpanded: false }
  const safe = { ...original, calls: [{ ...call, input: { path: "safe" }, output: "safe" }] }
  expect(functionNativePresentation("ToolGroup", safe, original)).toEqual(safe)
  expect(() =>
    functionNativePresentation(
      "ToolGroup",
      {
        ...safe,
        calls: [{ ...call, tool_use_id: "other" }]
      },
      original
    )
  ).toThrow("MODS_UI_NATIVE_PUBLICATION")
  expect(() =>
    new FunctionNativeDrawing(
      {
        surface: "desktop",
        component: "ToolGroup",
        requestId: "owner",
        props: original
      },
      () => {}
    ).keep({
      surface: "desktop",
      component: "ToolGroup",
      requestId: "owner",
      props: safe
    })
  ).toThrow("MODS_PINNED_INPUT")
})

it("caps actual refs and pins Ask answer meaning despite rewritten display wording", () => {
  const original = input()
  const drawing = new FunctionNativeDrawing(original, () => {})
  for (let index = 0; index < 64; index++) drawing.keep(original)
  expect(() => drawing.keep(original)).toThrow("MODS_UI_NATIVE_REF_LIMIT")
  const question = {
    id: "question",
    header: "Q",
    question: "original",
    options: [
      { label: "Yes", description: "original description" },
      { label: "No", description: "other description" }
    ]
  }
  const before: ModObject = { tool: "request_user_input", questions: [question] }
  const safe = { tool: "request_user_input", questions: [{ ...question, question: "safe" }] }
  expect(isModObject(functionNativePresentation("AskUserQuestion", safe, before))).toBe(true)
  expect(() =>
    functionNativePresentation(
      "AskUserQuestion",
      {
        ...safe,
        questions: [{ ...question, options: [question.options[1], question.options[0]] }]
      },
      before
    )
  ).toThrow("MODS_PINNED_INPUT")
})
