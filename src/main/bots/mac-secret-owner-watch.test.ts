import { expect, it } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { BOT_MAC_SECRET_OWNER_WATCH } from "./mac-secret-owner-watch"
import { botShellEnvironment } from "./shell-contract"

it.skipIf(process.platform === "win32")(
  "terminates an orphaned helper even while its main thread is synchronously blocked",
  async () => {
    const program = `
      const { Worker } = require("node:worker_threads")
      const owner = new Worker(${JSON.stringify(BOT_MAC_SECRET_OWNER_WATCH)}, { eval: true, execArgv: [], env: {} })
      owner.once("message", () => {
        process.stdout.write("native-call-blocked")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      })
      owner.once("error", () => process.exit(2))
    `
    const child = spawn(process.execPath, ["-e", program], {
      env: botShellEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe", "pipe"]
    })
    const deadline = setTimeout(() => child.kill("SIGTERM"), 5000)
    const closed = once(child, "close")
    try {
      child.stderr!.resume()
      const [ready] = await Promise.race([
        once(child.stdout!, "data"),
        closed.then(() => {
          throw new Error("Helper exited before entering the blocked call")
        })
      ])
      expect(ready.toString()).toBe("native-call-blocked")
      expect(child.exitCode).toBeNull()
      // The task owner disappears; stdin was already closed before the native call.
      child.stdio[3]!.destroy()
      expect(await closed).toEqual([null, "SIGKILL"])
    } finally {
      clearTimeout(deadline)
      child.kill("SIGKILL")
      for (const stream of child.stdio) stream?.destroy()
    }
  },
  8000
)
