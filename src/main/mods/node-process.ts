import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import type { ModParentPort, ModProcessLauncher } from "./process-contract"

const MAX_MOD_FRAME_BYTES = 8 * 1024 * 1024

/** No shell, inherited model credentials, renderer, or arbitrary child executable. */
export const launchNodeModProcess: ModProcessLauncher = (entry, options) => {
  const child = spawn(process.execPath, [entry], {
    windowsHide: true,
    env: { ...options.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced"
  })
  const events = new EventEmitter()
  let queuedBytes = 0
  const fail = (error: Error) => {
    events.emit("error", error)
    child.kill()
  }
  child.on("message", (message) => events.emit("message", message))
  child.on("error", (error) => events.emit("error", error))
  child.on("exit", (code) => events.emit("exit", code))
  return Object.assign(events, {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    postMessage(message: unknown) {
      if (!child.connected) {
        fail(new Error("MODS_HOST_DISCONNECTED"))
        return
      }
      const size = Buffer.byteLength(JSON.stringify(message))
      if (queuedBytes + size > MAX_MOD_FRAME_BYTES) {
        fail(new Error("MODS_HOST_CAPACITY"))
        return
      }
      queuedBytes += size
      try {
        child.send(message as Parameters<typeof child.send>[0], (error) => {
          queuedBytes -= size
          if (error) fail(error)
        })
      } catch (error) {
        queuedBytes -= size
        fail(error instanceof Error ? error : new Error("MODS_HOST_SEND_FAILED"))
      }
    },
    kill() {
      child.kill()
    }
  })
}

/** Keep the existing host-entry handlers and wire messages unchanged. */
export function modParentPort<Request, Response>(): ModParentPort<Request, Response> {
  const electron = (process as NodeJS.Process & { parentPort?: ModParentPort<Request, Response> })
    .parentPort
  if (electron) return electron
  if (!process.send) throw new Error("MODS_PARENT_CHANNEL_REQUIRED")
  process.once("disconnect", () => process.exit(0))
  let queuedBytes = 0
  return {
    on(_event, listener) {
      process.on("message", (data) => listener({ data: data as Request }))
    },
    postMessage(message) {
      if (!process.connected || !process.send) return
      const size = Buffer.byteLength(JSON.stringify(message))
      if (queuedBytes + size > MAX_MOD_FRAME_BYTES) {
        process.exit(1)
        return
      }
      queuedBytes += size
      process.send(message as Parameters<NonNullable<NodeJS.Process["send"]>>[0], (error) => {
        queuedBytes -= size
        if (error) process.exit(1)
      })
    }
  }
}
