import { expect, it } from "vitest"
import { equalFunctionUserConfigDraft, functionUserConfigDraft } from "./user-config-draft"
import type { FunctionUserConfigView } from "../../../shared/mods/v2/user-config-view"

const field: FunctionUserConfigView["fields"][number] = {
  key: "list",
  label: "List",
  description: "List",
  type: "string",
  multiple: true,
  supported: true,
  required: false
}
it("retains actual list boundaries and distinguishes comma-joined lookalikes", () => {
  const value = ["a,b", "a\nb", "", "a,b"]
  const draft = functionUserConfigDraft({ ...field, value })
  expect(draft).toEqual(value)
  expect(draft).not.toBe(value)
  expect(equalFunctionUserConfigDraft(["a,b"], ["a", "b"])).toBe(false)
  expect(equalFunctionUserConfigDraft(["a", "b"], ["a", "b"])).toBe(true)
})
it("displays a legacy scalar as one draft without splitting or mutating its stored value", () => {
  const source = { ...field, value: "a,b\nc" }
  expect(functionUserConfigDraft(source)).toEqual(["a,b\nc"])
  expect(source.value).toBe("a,b\nc")
  expect(functionUserConfigDraft({ ...field, value: "" })).toEqual([])
  expect(functionUserConfigDraft({ ...field, multiple: false, value: false })).toBe(false)
})
