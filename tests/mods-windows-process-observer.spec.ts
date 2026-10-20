import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readWindowsProcessIdentities } from "./support/mods-windows-process-observer"

async function main() {
  assert.equal(process.platform, "win32", "This suite requires the real Windows process provider")
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdio: "ignore"
  })
  const exited = once(child, "exit")
  try {
    assert(child.pid)
    const before = await readWindowsProcessIdentities([process.pid, child.pid])
    assert.equal(before.length, 2)
    assert.equal(before.find((row) => row.pid === child.pid)!.parent, process.pid)
    const owner = before.find((row) => row.pid === process.pid)!
    assert(Number.isFinite(Date.parse(owner.born)))
    // Terminate only this test's owned child handle, never a PID returned by the observer.
    child.kill()
    await exited
    const after = await readWindowsProcessIdentities([process.pid, child.pid])
    assert.deepEqual(after, [owner])
    console.log(
      "PASS native Windows observer retains parent/birth identity and proves owned child exit"
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
