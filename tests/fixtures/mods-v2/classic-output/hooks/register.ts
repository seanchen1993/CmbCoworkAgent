export function register(on) {
  let calls = 0
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "classic-observation-mode",
      description: "Test failure observation"
    })
    return next(e)
  })
  on("command.run", { command: "classic-observation-mode" }, async ($, e) => {
    await $.store.set("observationMode", e.args)
    return { text: "OBS_MODE:" + e.args }
  })
  on("classic.PreToolUse", async ($, e, next) => {
    if (e.tool?.includes("mods_error")) $.ui.log("OBS_PRE:" + JSON.stringify(e))
    return next(e)
  })
  on("classic.PostToolUseFailure", async ($, e, next) => {
    if (e.tool_name?.includes("mods_error")) {
      $.ui.log("OBS_FAILURE:" + JSON.stringify(e))
      if ((await $.store.get("observationMode")) === "stall") {
        await $.model.complete({
          model: "custom:mods-model-fixture",
          prompt: "[stall] MCP failure observation",
          maxTokens: 64
        })
        $.ui.log("OBS_LATE_FINISH")
      }
    }
    return next(e)
  })
  on("classic.PostToolUse", async ($, e, next) => {
    const result = await next(e)
    if (e.tool_name?.includes("mods_error")) $.ui.log("OBS_POST:" + JSON.stringify(e))
    if (e.tool_name?.includes("mods_error"))
      return {
        ...result,
        updatedToolOutput: "WRONG_GENERIC_MCP_OUTPUT",
        updatedMCPToolOutput: { text: "CLASSIC_MCP_REPLACEMENT", isError: false }
      }
    if (e.tool_name !== "read_file") return result
    calls++
    return { ...result, updatedToolOutput: "CLASSIC_MODEL_REPLACEMENT_" + calls }
  })
}
