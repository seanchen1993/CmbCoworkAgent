/** Some OpenAI-compatible providers return leading reasoning in the content field. */
export function splitBotInlineReasoning(text: string): { body: string; reasoning: string } {
  const start = /^\s*<think>\s*/i.exec(text)
  if (!start) return { body: text, reasoning: "" }
  const rest = text.slice(start[0].length)
  const end = /<\/think>/i.exec(rest)
  return end
    ? {
        body: rest.slice(end.index + end[0].length).trimStart(),
        reasoning: rest.slice(0, end.index).trim()
      }
    : { body: "", reasoning: rest.trim() }
}
