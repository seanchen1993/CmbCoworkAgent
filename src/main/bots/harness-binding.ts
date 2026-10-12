import { isAbsolute } from "node:path"
import { botHarnessBindingSchema, type BotHarnessBinding } from "../../shared/bot-harness-context"
import { BotDomainError } from "../../shared/bot-types"

export function parseBotHarnessBinding(value: unknown): BotHarnessBinding | null {
  if (value == null) return null
  const result = botHarnessBindingSchema.safeParse(value)
  if (!result.success || result.data.instructionWorkspacePaths.some((path) => !isAbsolute(path)))
    throw new BotDomainError("invalid_input", "项目绑定或授权的指令目录无效")
  return {
    ...result.data,
    instructionWorkspacePaths: [...new Set(result.data.instructionWorkspacePaths)]
  }
}
