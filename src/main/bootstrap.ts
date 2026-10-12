import { BOT_MAC_SECRET_HELPER_FLAG } from "./bots/mac-secret-protocol"

// Select the isolated credential process before loading desktop services, logging,
// settings or the single-instance lock. The installed app identity stays the same.
if (process.argv.includes(BOT_MAC_SECRET_HELPER_FLAG)) {
  void import("./bots/mac-secret-helper-entry").catch(() => process.exit(1))
} else {
  void import("./index").catch((error) => {
    console.error("[Main] Application startup failed", error)
    process.exit(1)
  })
}
