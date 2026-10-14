import { textInput } from "./input"

export function register(on, options) {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "component-review",
      description: "检视提供的代码",
      argumentHint: "[代码或变更说明]",
      immediate: true
    })
    return next(event)
  })
  on("command.run", { command: "component-review" }, async ($, event) => {
    const input = textInput(event.args ?? "")
    if (!input.trim()) return { text: "请提供需要检视的代码或变更说明。" }
    const text = await $.model.complete({
      model: "default",
      prompt: input,
      system:
        "请检视用户提供的代码，说明具体缺陷、依据和建议。没有证据时明确说明，不声称已运行测试。检视重点：" +
        (options.focus || "正确性与边界条件"),
      maxTokens: 1200
    })
    return { text, output: { text } }
  })
}
