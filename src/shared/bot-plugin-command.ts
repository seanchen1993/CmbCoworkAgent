/** Explicit composer syntax, never inferred from a model, quoted text or routine. */
export type BotPluginCommand =
  | { kind: "list"; page?: number }
  | { kind: "run"; name: string; args: string }

export function parseBotPluginCommand(text: string): BotPluginCommand | undefined {
  if (/^\/plugins\s*$/.test(text)) return { kind: "list" }
  const page = /^\/plugins[ \t]+([1-9][0-9]{0,3})\s*$/.exec(text)
  if (page) return { kind: "list", page: Number(page[1]) }
  const match =
    /^\/plugin[ \t]+([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127})(?:[ \t]+|\r?\n|$)([\s\S]*)$/.exec(text)
  if (!match) return undefined
  return { kind: "run", name: match[1], args: match[2] }
}
