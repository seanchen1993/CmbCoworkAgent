import { app } from "electron"
import { join, resolve } from "node:path"
import { checkFunctionPlugin } from "./check"
import { FunctionRuntimeClient } from "../v2/runtime-client"

/** Dedicated headless entry: does not initialize application databases, accounts or the renderer. */
const args = process.argv.slice(2)
void app.whenReady().then(async () => {
  const client = new FunctionRuntimeClient(join(__dirname, "function-mod-host.js"))
  try {
    const [command, directory, ...rest] = args
    if (!["check", "inspect"].includes(command) || !directory || rest.length) {
      console.error("Usage: openwork plugin check|inspect <directory>")
      app.exit(2)
      return
    }
    const report = await checkFunctionPlugin(resolve(directory), (code, options) =>
      client.load(code, options)
    )
    console.log(JSON.stringify(report, null, 2))
    client.stop()
    app.exit(report.valid ? 0 : 1)
  } catch (error) {
    client.stop()
    console.error(error instanceof Error ? error.message : "MODS_CHECK_FAILED")
    app.exit(1)
  }
})
