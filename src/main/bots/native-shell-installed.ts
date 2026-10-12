import { lstatSync, realpathSync } from "node:fs"
import { join } from "node:path"
import {
  botNativeDistributionPin,
  embeddedBotNativeDistribution,
  type BotNativeDistributionPin
} from "./native-shell-release"

interface InstalledNativeContext {
  pin: BotNativeDistributionPin | null
  platform: NodeJS.Platform
  arch: string
  resourcesDirectory: string
}

/** Privileged Main/Host startup only. Explicit deployment configuration,
 * including an explicitly empty value, retains its strict validation path.
 * Workers still receive only the ordinary command environment allowlist. */
export function withInstalledBotNativeConfiguration(
  source: NodeJS.ProcessEnv,
  context: InstalledNativeContext = {
    pin: embeddedBotNativeDistribution(),
    platform: process.platform,
    arch: process.arch,
    resourcesDirectory: process.resourcesPath ?? join(__dirname, "../resources")
  }
): NodeJS.ProcessEnv {
  const environment = { ...source }
  if (
    source.CMB_BOT_NATIVE_SANDBOX_DIRECTORY !== undefined ||
    source.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256 !== undefined ||
    !context.pin
  )
    return environment
  const pin = botNativeDistributionPin.parse(context.pin)
  if (pin.platform !== context.platform || pin.arch !== context.arch) return environment
  // Installing files alone cannot create a delegated kernel scope. Keep
  // chat/browser Host startup available until deployment supplies this port.
  if (pin.platform === "linux" && !source.CMB_BOT_DELEGATED_CGROUP_DIRECTORY) return environment
  try {
    const resources = realpathSync(context.resourcesDirectory)
    const directory = join(resources, "bot-native-sandbox", `${pin.platform}-${pin.arch}`)
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
      return environment
    environment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY = directory
    environment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256 = pin.manifestSha256
  } catch {
    // Missing/inaccessible optional files do not prevent chatting. The native
    // factory remains unavailable and cannot dispatch a command without them.
  }
  return environment
}
