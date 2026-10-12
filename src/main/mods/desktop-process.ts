import { utilityProcess } from "electron"
import { EventEmitter } from "node:events"
import type { ModProcessLauncher } from "./process-contract"

export const launchDesktopModProcess: ModProcessLauncher = (entry, options) => {
  const child = utilityProcess.fork(entry, [], { ...options, stdio: "pipe" })
  const events = new EventEmitter()
  child.on("message", (message) => events.emit("message", message))
  child.on("exit", (code) => events.emit("exit", code))
  child.on("error", () => events.emit("error", new Error("MODS_HOST_ERROR")))
  Object.defineProperty(events, "pid", { get: () => child.pid })
  return Object.assign(events, {
    stdout: child.stdout,
    stderr: child.stderr,
    postMessage(message: unknown) {
      child.postMessage(message)
    },
    kill() {
      child.kill()
    }
  })
}
