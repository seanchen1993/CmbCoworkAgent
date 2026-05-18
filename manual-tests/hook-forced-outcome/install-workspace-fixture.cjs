const fs = require("fs")
const path = require("path")

const workspace = process.argv[2] || "C:/360Downloads"
const fixtureDir = path.join(workspace, "manual-tests", "hook-forced-outcome")
const hooksDir = path.join(workspace, ".cmbdevclaw", "hooks")

fs.mkdirSync(fixtureDir, { recursive: true })
fs.mkdirSync(hooksDir, { recursive: true })

fs.copyFileSync(
  path.join(__dirname, "forced-outcome-recorder.cjs"),
  path.join(fixtureDir, "forced-outcome-recorder.cjs")
)
fs.copyFileSync(path.join(__dirname, "reset-log.cjs"), path.join(fixtureDir, "reset-log.cjs"))
fs.copyFileSync(
  path.join(__dirname, "set-direct-stop-enabled.cjs"),
  path.join(fixtureDir, "set-direct-stop-enabled.cjs")
)
fs.copyFileSync(path.join(__dirname, "README.md"), path.join(fixtureDir, "README.md"))

const scriptPath = path.join(fixtureDir, "forced-outcome-recorder.cjs").replace(/\\/g, "/")

const sessionStartHook = {
  event: "SessionStart",
  matcher: "*",
  type: "command",
  command: `node ${scriptPath} session-start-halt`,
  forcedOutcome: "always-halt",
  forcedReason: "FORCED_SESSION_START_HALT",
  timeout: 8000,
  enabled: true
}

const notificationHook = {
  event: "Notification",
  matcher: "*",
  type: "command",
  command: `node ${scriptPath} notification-revise`,
  forcedOutcome: "always-revise",
  forcedReason: "FORCED_NOTIFICATION_REVISE",
  timeout: 8000,
  enabled: true
}

const directPromptStopHook = {
  event: "UserPromptSubmit",
  matcher: "*",
  type: "command",
  command: `node ${scriptPath} direct-prompt-stop`,
  timeout: 8000,
  enabled: false
}

fs.writeFileSync(
  path.join(hooksDir, "forced-session-start-halt.json"),
  `${JSON.stringify(sessionStartHook, null, 2)}\n`,
  "utf8"
)
fs.writeFileSync(
  path.join(hooksDir, "forced-notification-revise.json"),
  `${JSON.stringify(notificationHook, null, 2)}\n`,
  "utf8"
)
fs.writeFileSync(
  path.join(hooksDir, "direct-user-prompt-stop.json"),
  `${JSON.stringify(directPromptStopHook, null, 2)}\n`,
  "utf8"
)

console.log(`Installed forced-outcome hook fixture into ${workspace}`)
console.log(`Recorder: ${path.join(fixtureDir, "forced-outcome-recorder.cjs")}`)
console.log(`Hooks dir: ${hooksDir}`)
