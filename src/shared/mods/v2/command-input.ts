import type { ModCommandDescriptor } from "../types"

export function parseFunctionCommandInput(
  text: string,
  commands: readonly ModCommandDescriptor[]
): { descriptor: ModCommandDescriptor; args: string } | null {
  const match = /^\/([A-Za-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/.exec(text.trimStart())
  if (!match) return null
  const descriptor = commands.find(
    (command) => command.apiVersion === "cmb.mods/v2" && command.command === match[1]
  )
  return descriptor ? { descriptor, args: match[2] ?? "" } : null
}
