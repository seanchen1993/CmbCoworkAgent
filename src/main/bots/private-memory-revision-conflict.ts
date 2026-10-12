import { BotDomainError } from "../../shared/bot-types"

/** A CAS mismatch on an active private entry already scoped to its owning Bot.
 * Other owners, deleted entries and revoked task authority never use this type.
 */
export class BotPrivateMemoryRevisionConflict extends BotDomainError {
  constructor() {
    super("revision_conflict", "记忆已修改或版本不匹配")
  }
}
