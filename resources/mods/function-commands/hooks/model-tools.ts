export function register(on) {
  on("session.start", {}, async ($, e, next) => {
    await $.command.register({
      name: "claw-tool-hooks",
      description: "开关模型工具规则示例",
      argumentHint: "[on|off]",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "claw-tool-hooks" }, async ($, e) => {
    const mode = e.args.trim()
    if (mode === "on" || mode === "off") await $.store.set("model-tool-hooks", mode === "on")
    const enabled = (await $.store.get("model-tool-hooks")) === true
    return {
      text: enabled
        ? "模型工具规则已开启：claw-notes 读取 Mods 记录，claw-blocked 拒绝读取。"
        : "模型工具规则已关闭。输入 /claw-tool-hooks on 开启。"
    }
  })
  on("tool.call", { tool: "read_file" }, async ($, e, next) => {
    if (next.origin.plugin !== "engine" || (await $.store.get("model-tool-hooks")) !== true)
      return next(e)
    if (e.file_path === "claw-blocked") return { deny: "此路径已被 Claw Mod 拒绝读取。" }
    const result = await next(
      e.file_path === "claw-notes" ? { ...e, file_path: "mods-sdk-note.txt" } : e
    )
    return { ...result, context: [...(result.context ?? []), "本轮读取已通过自定义 Claw 检查。"] }
  })
}
