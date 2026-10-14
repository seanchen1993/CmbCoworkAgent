import { textInput } from "./input"

export function register(on) {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "component-report",
      description: "整理提供的结果",
      argumentHint: "[结果文本]",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "component-report" }, async ($, event) => {
    const input = textInput(event.args ?? "")
    if (!input.trim()) return { text: "请提供需要整理的结果。" }
    const text = await $.model.complete({
      model: "default",
      prompt: input,
      system:
        "将给定内容整理为简短中文汇报，分别说明完成内容、验证证据、尚存问题。不要补造事实或测试结果。",
      maxTokens: 900
    })
    return { text, output: { text } }
  })
}
