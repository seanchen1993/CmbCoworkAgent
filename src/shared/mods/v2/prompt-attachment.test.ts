import { expect, it } from "vitest"
import type { ModObject } from "../types"
import { validatePromptAttachmentInput, validatePromptAttachmentResult } from "./prompt-attachment"

const input = { text: "BODY", origin: { kind: "engine" } }
it("validates only the declared plan detail structures and keeps unknown detail absent", () => {
  for (const [type, detail] of [
    ["plan_mode", { reminder: "full", planFilePath: "/plan.md", hasPlan: false }],
    ["plan_mode_exit", { planFilePath: "/plan.md", hasPlan: true }],
    ["plan_mode_reentry", { planFilePath: "/plan.md" }]
  ] as const)
    expect(() => validatePromptAttachmentInput({ ...input, type, detail })).not.toThrow()
  for (const type of ["plan_mode", "plan_mode_exit", "plan_mode_reentry"])
    expect(() => validatePromptAttachmentInput({ ...input, type })).not.toThrow()
  expect(() => validatePromptAttachmentInput({ ...input, type: "output_style" })).not.toThrow()
  const invalid: ModObject[] = [
    { ...input, type: "file", detail: {} },
    { ...input, type: "plan_mode", detail: {} },
    { ...input, type: "plan_mode", detail: { reminder: "fake", planFilePath: "p", hasPlan: true } },
    {
      ...input,
      type: "plan_mode_exit",
      detail: { planFilePath: "p", hasPlan: true, claimed: true }
    }
  ]
  for (const value of invalid)
    expect(() => validatePromptAttachmentInput(value)).toThrow(/MODS_PROMPT_ATTACHMENT_DETAIL/)
})

it("accepts null only as an attachment result and rejects extra fields", () => {
  expect(() => validatePromptAttachmentResult({ text: null })).not.toThrow()
  expect(() => validatePromptAttachmentResult({ text: "BODY" })).not.toThrow()
  expect(() => validatePromptAttachmentResult({ text: null, origin: { kind: "engine" } })).toThrow()
})
