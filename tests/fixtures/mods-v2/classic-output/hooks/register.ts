export function register(on) {
  let calls = 0
  on("classic.PostToolUse", async ($, e, next) => {
    const result = await next(e)
    if (e.tool_name?.includes("mods_error")) return {
      ...result, updatedToolOutput: "WRONG_GENERIC_MCP_OUTPUT",
      updatedMCPToolOutput: { text: "CLASSIC_MCP_REPLACEMENT", isError: false }
    }
    if (e.tool_name !== "read_file") return result
    calls++
    return { ...result, updatedToolOutput: "CLASSIC_MODEL_REPLACEMENT_" + calls }
  })
}
