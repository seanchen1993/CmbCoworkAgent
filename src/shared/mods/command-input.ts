import type { ModObject } from "./types"
import { parseModJson } from "./validation"

export function parseModCommandInput(text: string): { command: string; args: ModObject } | null {
  if (!/^\/mod(?:\s|$)/i.test(text.trim())) return null
  const match = text.trim().match(/^\/mod\s+([a-zA-Z0-9_.:-]{1,160})(?:\s+([\s\S]*))?$/i)
  if (!match) throw new Error("用法：/mod 模块:命令，可在后面附加 JSON 对象参数。")
  if (text.length > 16_000) throw new Error("Mods 命令参数过长。")
  let args: unknown
  try {
    args = parseModJson(match[2]?.trim() || "{}")
  } catch {
    throw new Error("Mods 命令参数必须是合法 JSON 对象。")
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Mods 命令参数必须是 JSON 对象。")
  return { command: match[1], args: args as ModObject }
}
