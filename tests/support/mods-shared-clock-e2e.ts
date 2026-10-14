import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ElectronApplication } from "playwright"

/** Verify the actual Electron native clock before sharing a private absolute cut over IPC. */
export async function verifySharedClock(
  app: ElectronApplication,
  workspace: string,
  artifacts: string,
  pass: (label: string) => void
): Promise<void> {
  const script = join(workspace, "mods-monotonic-clock-child.cjs")
  writeFileSync(script, `process.parentPort.on("message",event=>{
    process.parentPort.postMessage({id:event.data.id,tick:process.hrtime.bigint().toString(),
      node:process.version,uv:process.versions.uv,platform:process.platform});
  });`)
  // tsx's keepNames helper is outside the serialized callback. Install it in this isolated
  // test application without replacing either process's native clock.
  await app.evaluate(() => {
    Object.defineProperty(globalThis, "__name", {
      value: Function("value", "return value"), configurable: true
    })
  })
  const result = await app.evaluate(async ({ utilityProcess }, script) => {
    const child = utilityProcess.fork(script, [], { stdio: "pipe", serviceName: "mods-shared-clock-test" })
    const samples: Array<{ before: string; tick: string; after: string; id: number;
      node: string; uv: string; platform: string }> = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("utility spawn timed out")), 5000)
        child.once("spawn", () => { clearTimeout(timer); resolve() })
        child.once("exit", (code) => { clearTimeout(timer); reject(Error(`utility exited ${code}`)) })
      })
      for (let id = 0; id < 8; id++) {
        const before = process.hrtime.bigint().toString()
        const reply = await new Promise<{ tick: string; id: number; node: string; uv: string; platform: string }>((resolve, reject) => {
          const timeout = setTimeout(() => { cleanup(); reject(Error("utility clock reply timed out")) }, 5000)
          const message = (packet: { tick: string; id: number; node: string; uv: string; platform: string }) => {
            if (packet.id !== id) return
            cleanup(); resolve(packet)
          }
          const exit = (code: number) => { cleanup(); reject(Error(`utility exited ${code}`)) }
          const cleanup = () => { clearTimeout(timeout); child.off("message", message); child.off("exit", exit) }
          child.on("message", message)
          child.on("exit", exit)
          child.postMessage({ id })
        })
        const after = process.hrtime.bigint().toString()
        if (BigInt(reply.tick) < BigInt(before) || BigInt(reply.tick) > BigInt(after))
          throw Error("Electron and utility clocks do not share the same monotonic epoch")
        samples.push({ before, ...reply, after })
      }
      return { samples, electron: process.versions.electron, mainNode: process.version,
        mainUv: process.versions.uv, scope: "Actual Electron main and separate utility process monotonic epoch brackets" }
    } finally { child.kill() }
  }, script)
  assert.equal(result.samples.length, 8)
  assert(result.samples.every(row => row.platform === process.platform))
  writeFileSync(join(artifacts, "shared-monotonic-clock.json"), JSON.stringify(result, null, 2))
  pass("Actual Electron main and utility process share the monotonic epoch in eight independently acknowledged samples")
}
