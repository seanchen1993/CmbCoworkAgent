import { expect, it } from "vitest"
import { describeModTools } from "./mods-tool-descriptions"

it("changes provider-facing descriptions while retaining name schema and real executor", async () => {
  class Tool {
    name = "read_file"
    description = "old"
    schema = { type: "object" }
    invoke() {
      return "real"
    }
  }
  const tool = new Tool()
  const [updated] = await describeModTools(
    [tool],
    async (input) => {
      expect(input).not.toHaveProperty("schema")
      return { description: "read actual source" }
    },
    () => {}
  )
  expect(updated).toBeInstanceOf(Tool)
  expect(updated.invoke()).toBe("real")
  expect(updated.schema).toBe(tool.schema)
  expect(updated.name).toBe(tool.name)
  expect(updated.description).toBe("read actual source")
  expect(tool.description).toBe("old")
})

it("handles OpenAI descriptors and refuses unsupported deferred placement", async () => {
  const tool = {
    type: "function",
    function: { name: "tool", parameters: { type: "object" }, description: "old" }
  }
  const [updated] = await describeModTools(
    [tool],
    async () => ({ description: "new" }),
    () => {}
  )
  expect(updated.function.parameters).toBe(tool.function.parameters)
  expect(updated.function.description).toBe("new")
  await expect(
    describeModTools(
      [tool],
      async () => ({ description: "new", isDeferred: true }),
      () => {}
    )
  ).rejects.toThrow("MODS_TOOL_DESCRIPTION_UNSUPPORTED")
})
