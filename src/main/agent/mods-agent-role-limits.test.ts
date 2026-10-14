import { expect, it, vi } from "vitest"
import { createModAgentRoleLimits } from "./mods-agent-role-limits"

type ModelHook = (
  request: { tools: { name: string }[] },
  handler: unknown
) => Promise<{ tools: unknown }>
type ToolHook = (
  request: { toolCall: { name: string; id: string } },
  handler: unknown
) => Promise<{ status: string }>

it("filters advertised tools and refuses a hallucinated or late dynamic tool before execution", async () => {
  const middleware = createModAgentRoleLimits({ allowedToolNames: ["read_file"] })
  const model = vi.fn(async (request) => request)
  const tools = [{ name: "read_file" }, { name: "write_file" }, { name: "mcp__new__write" }]
  // The middleware is exercised without building a graph or making a model request.
  const value = await (middleware.wrapModelCall as unknown as ModelHook)({ tools }, model)
  expect(value.tools).toEqual([{ name: "read_file" }])
  const execute = vi.fn()
  const result = await (middleware.wrapToolCall as unknown as ToolHook)(
    { toolCall: { name: "mcp__new__write", id: "call" } },
    execute
  )
  expect(result.status).toBe("error")
  expect(execute).not.toHaveBeenCalled()
})
it("counts actual middleware model calls, including failed calls, and blocks before the next request", async () => {
  const middleware = createModAgentRoleLimits({ maxTurns: 2 })
  const model = vi.fn().mockRejectedValueOnce(new Error("transport")).mockResolvedValue("done")
  const run = () => (middleware.wrapModelCall as unknown as ModelHook)({ tools: [] }, model)
  await expect(run()).rejects.toThrow("transport")
  expect(await run()).toBe("done")
  await expect(run()).rejects.toThrow("MODS_AGENT_MAX_TURNS")
  expect(model).toHaveBeenCalledTimes(2)
})
