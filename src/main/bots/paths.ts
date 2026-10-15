import { lstatSync, mkdirSync, realpathSync } from "node:fs"
import { join, relative, isAbsolute } from "node:path"
import { botIdentifier } from "../../shared/bots/validation"

/** Control paths are host-owned; no renderer path or model output is accepted here. */
export function botDirectory(root: string, kind: "workspaces" | "memories", botId: string): string {
  botIdentifier(botId)
  mkdirSync(root, { recursive: true })
  const base = realpathSync(root)
  const category = join(base, kind)
  mkdirSync(category, { recursive: true })
  if (lstatSync(category).isSymbolicLink()) throw new Error("Bot 数据目录不能是符号链接")
  const result = join(category, botId)
  mkdirSync(result, { recursive: true })
  if (lstatSync(result).isSymbolicLink()) throw new Error("Bot 工作目录不能是符号链接")
  const actual = realpathSync(result),
    fromRoot = relative(base, actual)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Bot 数据目录超出范围")
  return actual
}
