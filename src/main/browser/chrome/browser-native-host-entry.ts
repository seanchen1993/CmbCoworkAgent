import {
  isDedicatedBrowserNativeMessagingHostLaunch,
  runBrowserNativeMessagingHost
} from "./browser-native-messaging-host"
import { writeBrowserNativeHostLog } from "./browser-native-host-log"

if (!isDedicatedBrowserNativeMessagingHostLaunch()) {
  writeBrowserNativeHostLog("Missing native host flag or trusted extension origin")
  process.exitCode = 1
} else {
  void runBrowserNativeMessagingHost().catch((error) => {
    writeBrowserNativeHostLog(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
