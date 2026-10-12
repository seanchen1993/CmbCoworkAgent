import { withInstalledBotNativeConfiguration } from "./native-shell-installed"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { withDesktopBotMaintenance } from "./desktop-client"
import { createWindowsNativeSetupService } from "./windows-native-setup-service"
import { botWindowsNativeSetupRequest } from "../../shared/bot-windows-native-setup"

const service = createWindowsNativeSetupService({
  directory: async () => {
    const directory = join(getCmbCoworkAgentDataRoot(), "bot-host")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return realpath(directory)
  },
  configuration: () => {
    const environment = withInstalledBotNativeConfiguration(process.env)
    return {
      packageDirectory: environment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY ?? "",
      manifestSha256: environment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256 ?? "",
      resourceLimits: {
        pids: environment.CMB_BOT_SHELL_PIDS_MAX ? Number(environment.CMB_BOT_SHELL_PIDS_MAX) : 512,
        memoryBytes: environment.CMB_BOT_SHELL_MEMORY_MAX_BYTES
          ? Number(environment.CMB_BOT_SHELL_MEMORY_MAX_BYTES)
          : 2147483648
      }
    }
  },
  helperEntry: join(__dirname, "bot-shell-owner.js")
})

export const getDesktopWindowsNativeSetupStatus = service.getStatus
export function initializeDesktopWindowsNativeSandbox(raw: unknown) {
  const request = botWindowsNativeSetupRequest.parse(raw)
  if (process.platform !== "win32") return service.initialize(request)
  return withDesktopBotMaintenance(() => service.initialize(request))
}
