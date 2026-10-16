// Test-only presentation suppression through the ordinary Node inspector. The ASAR is unchanged.
import { spawn } from "node:child_process"
import WebSocket from "ws"
const binary = process.env.CMB_COMPOSITION_BINARY
const presentation = process.env.CMB_COMPOSITION_PRESENTATION
if (!binary || !presentation) throw Error("COMPOSITION_PACKAGE_LAUNCH_CONFIG_REQUIRED")
const child = spawn(
  binary,
  [
    ...process.argv.slice(2).map((arg) => (arg === "--inspect=0" ? "--inspect-brk=0" : arg)),
    ...(process.env.CMB_E2E_DISABLE_GPU === "1" ? ["--disable-gpu", "--in-process-gpu"] : [])
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
)
child.stdout.pipe(process.stdout)
let connection
let buffer = ""
let sequence = 0
let initialized = false
const pending = new Map()
const timer = setTimeout(() => fail(Error("COMPOSITION_PACKAGE_PRESENTATION_TIMEOUT")), 30000)
function fail(error) {
  console.error(error)
  connection?.close()
  child.kill()
  process.exitCode = 1
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    connection.send(JSON.stringify({ id, method, params }))
  })
}
child.stderr.on("data", (chunk) => {
  buffer += chunk.toString()
  for (;;) {
    const end = buffer.indexOf("\n")
    if (end < 0) break
    const line = buffer.slice(0, end + 1)
    buffer = buffer.slice(end + 1)
    if (line.includes("Waiting for the debugger to disconnect")) connection?.close()
    const address = /^Debugger listening on (ws:\/\/[^\s]+)/.exec(line)?.[1]
    if (!address || connection) {
      process.stderr.write(line)
      continue
    }
    connection = new WebSocket(address)
    connection.on("error", fail)
    connection.on("open", async () => {
      try {
        await send("Debugger.enable")
        await send("Runtime.runIfWaitingForDebugger")
      } catch (error) {
        fail(error)
      }
    })
    connection.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.id) {
          const item = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) item?.reject(Error(JSON.stringify(message.error)))
          else item?.resolve(message.result)
        }
        if (message.method === "NodeWorker.attachedToWorker") {
          console.error("[Composition inspector] resume worker", message.params.workerInfo.title)
          await send("NodeWorker.sendMessageToWorker", {
            sessionId: message.params.sessionId,
            message: JSON.stringify({ id: 1, method: "Runtime.runIfWaitingForDebugger" })
          })
          await send("NodeWorker.detach", { sessionId: message.params.sessionId })
        }
        if (message.method === "Debugger.paused" && !initialized) {
          initialized = true
          const result = await send("Runtime.evaluate", {
            expression: `require(${JSON.stringify(presentation)})`,
            includeCommandLineAPI: true
          })
          if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
          await send("NodeWorker.enable", { waitForDebuggerOnStart: true })
          await send("Debugger.resume")
          await send("Debugger.disable")
          clearTimeout(timer)
          process.stderr.write(line)
        }
      } catch (error) {
        fail(error)
      }
    })
  }
})
child.on("error", fail)
child.on("exit", (code) => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
