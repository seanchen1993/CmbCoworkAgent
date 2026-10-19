import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { BotError } from "../../shared/bots/contracts"

/** Listing IDs stay relative. Runtime and preview export may opt into absolute paths inside this workspace. */
export async function resolveBotWorkspaceFile(
  workspace: string,
  fileId: string,
  options: { allowAbsolute?: boolean } = {}
): Promise<string> {
  if (
    !fileId ||
    fileId.length > 4096 ||
    fileId.includes("\0") ||
    (isAbsolute(fileId) && !options.allowAbsolute) ||
    (/^[a-z]:|^\\\\/i.test(fileId) && !(options.allowAbsolute && isAbsolute(fileId)))
  )
    throw new BotError("INVALID_INPUT", "请提供当前工作目录内的文件路径，保留子目录名称")
  const root = await realpath(workspace),
    candidate = resolve(workspace, fileId)
  const inside = (base: string, path: string) => {
    const part = relative(base, path)
    return (
      part !== ".." &&
      !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(part)
    )
  }
  // macOS /tmp and /var may be aliases of /private; accept either spelling of this workspace.
  if (
    !inside(resolve(workspace), candidate) &&
    !inside(root, candidate) &&
    !(options.allowAbsolute && isAbsolute(fileId))
  )
    throw new BotError("INVALID_INPUT", "文件不在此 Bot 工作目录中")
  const actual = await realpath(candidate)
  if (!inside(root, actual)) throw new BotError("INVALID_INPUT", "文件链接超出此 Bot 工作目录")
  const stat = await lstat(actual)
  if (!stat.isFile()) throw new BotError("INVALID_INPUT", "只能使用普通文件")
  return actual
}
