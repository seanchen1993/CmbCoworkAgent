import { createHash } from "node:crypto"
import { hostname, userInfo } from "node:os"
import { realpathSync } from "node:fs"
import type { BotHostLock } from "./host-lock"
import type { BotLocalComputerTarget } from "../../shared/bot-local-tool-permission"
import { BotDomainError } from "../../shared/bot-types"
import { canonicalJson } from "./validation"

export interface BotLocalToolAuthority {
  readonly target: BotLocalComputerTarget
  assertCurrent(): void
}

/** Reuses the held installation lock and its physical root, outside every writable
 * project. No credential, hostname alone, renderer ID or checkpoint is authority. */
export function createBotLocalToolAuthority(
  directory: string,
  lock: Pick<BotHostLock, "assertCurrent" | "recoveryOwnershipIdentity">
): BotLocalToolAuthority {
  const root = realpathSync(directory),
    user = userInfo(),
    identity = lock.recoveryOwnershipIdentity()
  const platform = process.platform
  if (!["darwin", "win32", "linux"].includes(platform))
    throw new BotDomainError("local_computer_unavailable", "此平台不支持本机项目访问")
  const target: BotLocalComputerTarget = {
    id: createHash("sha256")
      .update(canonicalJson({ root, identity, uid: user.uid, user: user.username, platform }))
      .digest("hex"),
    label: `${hostname().slice(0, 150)} · 本机`,
    platform: platform as BotLocalComputerTarget["platform"]
  }
  return Object.freeze({
    target: Object.freeze(target),
    assertCurrent() {
      lock.assertCurrent()
      if (
        realpathSync(directory) !== root ||
        canonicalJson(lock.recoveryOwnershipIdentity()) !== canonicalJson(identity)
      )
        throw new BotDomainError(
          "local_computer_changed",
          "本机执行身份已变化，请重启后台并重新确认权限"
        )
    }
  })
}
