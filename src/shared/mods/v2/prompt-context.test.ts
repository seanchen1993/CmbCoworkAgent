import { expect, it } from "vitest"
import { synchronizePromptContext, validatePromptContext } from "./prompt-context"

const files = [{ path: "/project/AGENTS.md", kind: "project", content: "PROJECT" }]
const original = { blocks: [{ name: "claudeMd", text: "NATIVE_WRAPPER_PROJECT" }],
  instructionFiles: files }

it("retains native rendering for an unchanged list and inherits omitted files", () => {
  expect(synchronizePromptContext(original, original)).toEqual(original)
  expect(synchronizePromptContext({ blocks: original.blocks }, original)).toEqual(original)
})

it("renders changed file content/order directly without reading claimed paths", () => {
  const changed = [{ path: "C:/not-readable/secret.md", kind: "managed", content: "ONLY_PROVIDED" },
    ...files]
  const output = synchronizePromptContext({ ...original, instructionFiles: changed }, original)
  expect(output.blocks).toEqual([{ name: "claudeMd",
    text: "# C:/not-readable/secret.md\n\nONLY_PROVIDED\n\n# /project/AGENTS.md\n\nPROJECT" }])
  expect(output.instructionFiles).toEqual(changed)
})

it("clears provenance after text rewrite and cannot resurrect it through omitted fields", () => {
  const changed = synchronizePromptContext({ ...original,
    blocks: [{ name: "claudeMd", text: "REWRITTEN" }] }, original)
  expect(Object.hasOwn(changed, "instructionFiles")).toBe(false)
  expect(synchronizePromptContext({ blocks: changed.blocks }, changed)).toEqual(changed)
})

it("adds instructions to an originally empty workspace from supplied file content", () => {
  const output = synchronizePromptContext({ blocks: [], instructionFiles: files },
    { blocks: [], instructionFiles: [] })
  expect(output.blocks).toEqual([{ name: "claudeMd", text: "# /project/AGENTS.md\n\nPROJECT" }])
  expect(output.instructionFiles).toEqual(files)
})

it("removes the instruction block with an empty list, and never re-adds a dropped block", () => {
  expect(synchronizePromptContext({ ...original, instructionFiles: [] }, original))
    .toEqual({ blocks: [], instructionFiles: [] })
  expect(synchronizePromptContext({ blocks: [], instructionFiles: files }, original))
    .toEqual({ blocks: [], instructionFiles: [] })
})

it("keeps unknown provenance absent and rejects bad shape, duplicate names and oversized input", () => {
  const opaque = { blocks: [{ name: "claudeMd", text: "HARNESS" }] }
  expect(synchronizePromptContext(opaque, opaque)).toEqual(opaque)
  for (const value of [{ blocks: [opaque.blocks[0], opaque.blocks[0]] },
    { ...original, instructionFiles: [{ ...files[0], path: "../secret" }] },
    { blocks: [{ name: "a", text: "x".repeat(512 * 1024) }] }])
    expect(() => validatePromptContext(value)).toThrow(/MODS_PROMPT_CONTEXT/)
})
