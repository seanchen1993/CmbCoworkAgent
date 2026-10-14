import { expect, it } from "vitest"
import { createNativePluginPromptRun, nativePluginPromptRun } from "./mods-plugin-prompt-entry"

it("rejects serialized, cloned and mismatched plugin receipts at the native entry", () => {
  const input = {
    workspace: "project",
    threadId: "thread",
    text: "actual",
    context: ["hidden"],
    origin: { kind: "plugin" as const, name: "source" },
    framed: true,
    assertLive: () => {},
    started: () => {}
  }
  const receipt = createNativePluginPromptRun(input)
  expect(nativePluginPromptRun(receipt, "thread", "actual")).toBe(receipt)
  expect(() => nativePluginPromptRun(input, "thread", "actual")).toThrow("RECEIPT_INVALID")
  expect(() => nativePluginPromptRun({ ...receipt }, "thread", "actual")).toThrow("RECEIPT_INVALID")
  expect(() => nativePluginPromptRun(receipt, "another", "actual")).toThrow("RECEIPT_INVALID")
  expect(() => nativePluginPromptRun(receipt, "thread", "rewritten")).toThrow("RECEIPT_INVALID")
  input.context.push("late")
  input.origin.name = "forged"
  expect(receipt.context).toEqual(["hidden"])
  expect(receipt.origin.name).toBe("source")
})

it("rechecks real lifetime even for an authentic receipt", () => {
  let live = true
  const receipt = createNativePluginPromptRun({
    workspace: "project",
    threadId: "thread",
    text: "actual",
    context: [],
    origin: { kind: "plugin", name: "source" },
    framed: false,
    assertLive: () => {
      if (!live) throw Error("REVOKED")
    },
    started: () => {}
  })
  live = false
  expect(() => nativePluginPromptRun(receipt, "thread", "actual")).toThrow("REVOKED")
  expect(nativePluginPromptRun(undefined, "thread", "ordinary user input")).toBeUndefined()
})
