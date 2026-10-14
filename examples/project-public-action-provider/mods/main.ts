import type { Register } from "claude-code"
export const register: Register<"project-public-action-provider"> = (on) => {
  on("session.start", async ($, event, next) => { await $.command.register({ name: "project-public-action-provider", description: "公开文本整理步骤", immediate: true }); return next(event) })
  on("command.run", { command: "project-public-action-provider" }, (_sdk, event) => {
    let text = event.args ?? ""
    try {
      const envelope: unknown = JSON.parse(text)
      if (envelope && typeof envelope === "object" && "version" in envelope && envelope.version === 1 && "input" in envelope && envelope.input && typeof envelope.input === "object" && "text" in envelope.input && typeof envelope.input.text === "string") text = envelope.input.text
    } catch { /* Ordinary slash commands accept plain text. */ }
    const summary = "整理结果：" + "\n" + text
    return { text: summary, output: { text: summary } }
  })
}
