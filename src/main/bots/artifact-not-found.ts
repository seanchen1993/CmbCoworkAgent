import { BotDomainError } from "../../shared/bot-types"

/** Distinguish an absent file ID from a missing task or broken execution scope. */
export class BotArtifactNotFound extends BotDomainError {
  constructor() {
    super("not_found", "文件不存在")
  }
}
