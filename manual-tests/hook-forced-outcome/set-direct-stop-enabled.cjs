const fs = require("fs")
const path = require("path")

const workspace = process.argv[2] || "C:/360Downloads"
const enabledArg = String(process.argv[3] || "").toLowerCase()
const enabled = enabledArg === "true" || enabledArg === "1" || enabledArg === "on"
const hookPath = path.join(workspace, ".cmbdevclaw", "hooks", "direct-user-prompt-stop.json")

if (!fs.existsSync(hookPath)) {
  throw new Error(`Hook file not found: ${hookPath}`)
}

const hook = JSON.parse(fs.readFileSync(hookPath, "utf8"))
hook.enabled = enabled
fs.writeFileSync(hookPath, `${JSON.stringify(hook, null, 2)}\n`, "utf8")

console.log(`${enabled ? "Enabled" : "Disabled"} ${hookPath}`)
