/** Short stack-only CPU sample of the explicitly selected isolated Electron main process. */
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

async function main() {
  const run = resolve(process.argv[2])
  const port = Number(process.argv[3])
  assert(run.includes("lean-live-20261030") && port > 0)
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    webSocketDebuggerUrl: string
  }>
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise<void>((done) => socket.addEventListener("open", () => done(), { once: true }))
  let sequence = 0
  const pending = new Map<number, (value: unknown) => void>()
  socket.addEventListener("message", (message) => {
    const value = JSON.parse(String(message.data))
    if (value.id) {
      pending.get(value.id)?.(value.result)
      pending.delete(value.id)
    }
  })
  const send = (method: string) =>
    new Promise<unknown>((done) => {
      const id = ++sequence
      pending.set(id, done)
      socket.send(JSON.stringify({ id, method }))
    })
  await send("Profiler.enable")
  await send("Profiler.start")
  await new Promise((done) => setTimeout(done, 3000))
  const result = await send("Profiler.stop")
  writeFileSync(join(run, "main-idle-profile.json"), JSON.stringify(result))
  await send("Profiler.disable")
  socket.close()
}
void main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
