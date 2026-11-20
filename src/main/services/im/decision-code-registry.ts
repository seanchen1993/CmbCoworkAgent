import { randomBytes } from "node:crypto"
import { isNotificationPendingForTarget } from "../../../shared/app-notifications"
import { isNotificationVisible } from "../notification-read-model"
import { notificationService } from "../notification-service"

interface CodeOwner {
  principalId: string
  conversationKey: string
}
interface CodeEntry extends CodeOwner {
  notificationId: string
}

/** Only short-code identity, ownership and consumption; decisions stay in their source. */
export class ImDecisionCodeRegistry {
  private readonly codes = new Map<string, CodeEntry>()

  constructor(private readonly label: string) {}

  allocate(entry: CodeEntry): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const code = randomBytes(3).toString("hex").toUpperCase()
      if (!this.codes.has(code)) {
        this.codes.set(code, entry)
        return code
      }
    }
    throw new Error(`unable to allocate a unique ${this.label} code`)
  }

  resolve(
    input: CodeOwner & { code: string }
  ): { code: string; entry: CodeEntry } | { message: string } {
    const code = input.code.trim().toUpperCase()
    if (!/^[A-F0-9]{6}$/u.test(code)) return { message: `${this.label}短码无效，请核对后重试。` }
    const entry = this.codes.get(code)
    if (!entry) return { message: `${this.label}短码不存在、已失效或已使用。` }
    if (
      entry.principalId !== input.principalId ||
      entry.conversationKey !== input.conversationKey
    ) {
      return { message: `该${this.label}短码不属于当前招乎会话。` }
    }
    if (!this.isAvailable(entry.notificationId)) {
      this.codes.delete(code)
      return { message: `${this.label}短码不存在、已失效或已使用。` }
    }
    return { code, entry }
  }

  settle(code: string, applied: boolean): void {
    const entry = this.codes.get(code)
    if (entry && (applied || !this.isAvailable(entry.notificationId))) {
      this.removeNotification(entry.notificationId)
    }
  }

  removeNotification(notificationId: string): void {
    for (const [code, entry] of this.codes) {
      if (entry.notificationId === notificationId) this.codes.delete(code)
    }
  }

  private isAvailable(notificationId: string): boolean {
    const value = notificationService.get(notificationId)
    return isNotificationPendingForTarget(value, "im") && isNotificationVisible(value)
  }
}
