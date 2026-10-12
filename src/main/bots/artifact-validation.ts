import { BotDomainError } from "../../shared/bot-types"
import * as v from "./validation"

export function validateBotFileName(input: unknown): string {
  const name = v.text(input, "文件名", 200)
  if (
    /[\\/:<>"|?*]/.test(name) ||
    v.hasControlCharacters(name) ||
    /^\.|[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new BotDomainError("invalid_filename", "文件名不能包含路径或系统保留名称")
  return name
}
