import { expect, it } from "vitest"
import type { ModJson, ModObject } from "../types"
import {
  assertFunctionPluginPromptSource,
  functionPluginPromptArgs,
  functionPluginPromptModelText
} from "./plugin-prompt"
import { validatePromptSubmissionInput, validatePromptSubmissionResult } from "./prompt-submission"

it("accepts only SDK words and optional asUser, without attachment payload claims", () => {
  expect(functionPluginPromptArgs({ text: "task", asUser: true, attachments: [] })).toEqual({
    text: "task",
    asUser: true
  })
  const invalid: ModJson[] = [
    { text: " " },
    { text: "task", asUser: false },
    { text: "task", origin: { kind: "composer" } },
    { text: "task", context: ["hidden"] },
    { text: "task", wait: false },
    { text: "task", turnId: "forged" },
    { text: "task", attachments: [{ type: "image" }] }
  ]
  for (const value of invalid)
    expect(() => functionPluginPromptArgs(value)).toThrow("MODS_PLUGIN_PROMPT_ARGUMENTS")
})

it("rejects current or held forbidden sources despite an old allowed SDK origin", () => {
  for (const source of ["command.run", "prompt.submit", "tool.call", "prompt.compose"]) {
    expect(() => assertFunctionPluginPromptSource(source)).toThrow(
      expect.objectContaining({ code: "MODS_PLUGIN_PROMPT_SOURCE_HELD" })
    )
    expect(() => assertFunctionPluginPromptSource("ui.press", source)).toThrow(
      expect.objectContaining({ code: "MODS_PLUGIN_PROMPT_SOURCE_HELD" })
    )
  }
  for (const source of [
    "session.start",
    "turn.start",
    "turn.step",
    "turn.complete",
    "clock.after",
    "ui.render",
    "ui.press",
    "ui.message"
  ])
    expect(() => assertFunctionPluginPromptSource(source)).not.toThrow()
  expect(() => assertFunctionPluginPromptSource("session.end")).toThrow(
    "MODS_PLUGIN_PROMPT_SOURCE_UNSUPPORTED"
  )
})

it("validates real plugin event origins and allows a final result to omit framing", () => {
  const input = { text: "task", origin: { kind: "plugin", name: "actual" }, wait: false }
  expect(() => validatePromptSubmissionInput(input)).not.toThrow()
  expect(() => validatePromptSubmissionResult({ text: "final" }, input)).not.toThrow()
  expect(() =>
    validatePromptSubmissionResult(
      {
        text: "final",
        origin: {
          name: "actual",
          kind: "plugin"
        }
      },
      input
    )
  ).not.toThrow()
  const invalidOrigins: ModObject[] = [
    { kind: "composer" },
    { kind: "plugin", name: "forged" },
    { kind: "plugin", name: "actual", asUser: true }
  ]
  for (const origin of invalidOrigins)
    expect(() => validatePromptSubmissionResult({ text: "task", origin }, input)).toThrow(
      "MODS_PROMPT_SUBMIT_RESULT"
    )
})

it("asUser or omitted model framing never changes the host plugin identity", () => {
  const origin = { kind: "plugin" as const, name: "actual" }
  expect(functionPluginPromptModelText("task", origin, true)).toBe(
    "The actual plugin sent a message:\n\ntask"
  )
  expect(functionPluginPromptModelText("task", origin, false)).toBe("task")
  expect(functionPluginPromptModelText("task", { ...origin, asUser: true }, true)).toBe("task")
  expect(origin).toEqual({ kind: "plugin", name: "actual" })
})
