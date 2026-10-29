import type { ModCommandDescriptor, ModObject } from "../../../../shared/mods/types"
import { parseModCommandInput } from "../../../../shared/mods/command-input"
import { parseFunctionCommandInput } from "../../../../shared/mods/v2/command-input"

export function mayBeModCommand(text: string): boolean {
  return /^\/[A-Za-z0-9_-]+(?:\s|$)/.test(text) && !/^\/(?:goal|browser)(?:\s|$)/i.test(text)
}

/** The menu is only a cache. Resolve against the host before deciding to send slash text to a model. */
export async function resolveModSubmission(
  text: string,
  load: () => Promise<ModCommandDescriptor[]>
): Promise<{ descriptor: ModCommandDescriptor; args: ModObject } | null> {
  if (!mayBeModCommand(text)) return null
  const commands = await load()
  const direct = parseFunctionCommandInput(text, commands)
  if (direct) return { descriptor: direct.descriptor, args: { text: direct.args } }
  const legacy = parseModCommandInput(text)
  if (!legacy) return null
  const descriptor = commands.find((entry) => entry.command === legacy.command)
  if (!descriptor) throw new Error("此命令尚未授权或已变更，请在项目 Mods 设置中检查权限。")
  return { descriptor, args: legacy.args }
}
