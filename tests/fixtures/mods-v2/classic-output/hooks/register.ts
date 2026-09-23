export function register(on) {
  let calls = 0
  on("classic.PostToolUse", async ($, e, next) => {
    const result = await next(e)
    if (e.tool_name !== "read_file") return result
    calls++
    return { ...result, updatedToolOutput: "CLASSIC_MODEL_REPLACEMENT_" + calls }
  })
}
