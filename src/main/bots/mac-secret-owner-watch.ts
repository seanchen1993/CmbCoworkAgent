/** Runs in a Node worker inside the disposable Electron helper. Keychain calls
 * can synchronously block the main thread, so ownership and the hard deadline
 * must be observed on a separate event loop. No credentials enter this worker. */
export const BOT_MAC_SECRET_OWNER_WATCH = String.raw`
const { Socket } = require("node:net")
const { parentPort } = require("node:worker_threads")
const stop = () => process.kill(process.pid, "SIGKILL")
try {
  const owner = new Socket({ fd: 3, readable: true, writable: false })
  owner.on("end", stop)
  owner.on("error", stop)
  owner.resume()
  setTimeout(stop, 30_000)
  parentPort.postMessage("ready")
} catch {
  stop()
}
`
