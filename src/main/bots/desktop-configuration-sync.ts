import { existsSync } from "node:fs"
import { join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { subscribeRuntimeConfiguration } from "../runtime-configuration-events"
import { BotConfigurationSync } from "./configuration-sync"
import { syncDesktopBotModels } from "./desktop-model-sync"
import { invalidateBotModelSnapshot } from "./model-config-fence"

let sync: BotConfigurationSync | undefined

/** New-run limits do not revoke the credentials or authority of running tasks.
 * Acknowledge the setting only after an already-enabled Bot configuration is published. */
export async function syncActiveBotExecutionSettings(): Promise<void> {
  const directory = join(getCmbCoworkAgentDataRoot(), "bot-host")
  const path = join(directory, "models.private")
  if (existsSync(path) || existsSync(`${path}.pending`)) await syncDesktopBotModels(directory)
}

export function startDesktopBotConfigurationSync(): void {
  if (sync) return
  const directory = join(getCmbCoworkAgentDataRoot(), "bot-host")
  const path = join(directory, "models.private")
  let activated = existsSync(path) || existsSync(`${path}.pending`)
  const invalidate = () => {
    try {
      invalidateBotModelSnapshot(path)
    } catch {
      console.warn("[Bot] 无法标记后台配置更新，请检查本机存储")
    }
  }
  // Reopening the desktop does not revoke the detached Host's unchanged
  // authority. Live edits still fence synchronously below; startup publishes
  // an atomic snapshot and fails closed if the authoritative settings cannot load.
  sync = new BotConfigurationSync({
    enabled: () => (activated ||= existsSync(path) || existsSync(`${path}.pending`)),
    sync: () => syncDesktopBotModels(directory),
    subscribe: (listener) =>
      subscribeRuntimeConfiguration(() => {
        invalidate()
        listener()
      }),
    // Do not log thrown provider/configuration values: they may include secrets.
    failed: () => {
      invalidate()
      console.warn("[Bot] 后台配置同步失败，将自动重试；配置更新期间暂停使用旧配置")
    }
  })
}

export async function stopDesktopBotConfigurationSync(): Promise<void> {
  const active = sync
  sync = undefined
  await active?.close()
}
