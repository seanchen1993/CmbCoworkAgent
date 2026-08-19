import {
  isDedicatedBrowserNativeMessagingHostLaunch,
  runBrowserNativeMessagingHost
} from "./browser-native-messaging-host"

if (!isDedicatedBrowserNativeMessagingHostLaunch()) {
  process.stderr.write(
    "[CmbBrowserNativeHost] Missing native host flag or trusted extension origin\n"
  )
  process.exitCode = 1
} else {
  void runBrowserNativeMessagingHost().catch((error) => {
    process.stderr.write(
      `[CmbBrowserNativeHost] ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 1
  })
}
