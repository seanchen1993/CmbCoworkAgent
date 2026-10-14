export function textInput(args: string): string {
  try {
    const value = JSON.parse(args)
    if (value?.version === 1 && typeof value.input?.text === "string") return value.input.text
  } catch {
    // Ordinary slash commands carry plain text, while Flow actions carry a typed envelope.
  }
  return args
}
