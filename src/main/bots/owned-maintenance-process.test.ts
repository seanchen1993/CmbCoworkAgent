import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { windowsOwnedMaintenanceLaunch } from "./owned-maintenance-process"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})
it.each([false, true])(
  "executes the actual Windows Node bootstrap with an ordered owner frame when parent scheduling is delayed=%s",
  async (delayed) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-maintenance-bootstrap-")))
    roots.push(root)
    const entry = join(root, "entry.cjs"),
      request = {
        action: "create",
        nonce: "b40fd861-3e98-4d37-8cd3-99c0080608f0",
        literal: '`$()\\n"'
      }
    await writeFile(
      entry,
      `process.stdout.write(JSON.stringify({type:"started",pid:process.pid})+"\\n"); let bytes=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",part=>bytes+=part); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({type:"received",pid:process.pid,request:JSON.parse(bytes)})+"\\n"));`
    )
    const launch = windowsOwnedMaintenanceLaunch({
      executable: process.execPath,
      args: [entry],
      request,
      controller: "not-executed-on-macos"
    })
    // Exercise generated source on macOS/Linux/Windows. This proves bootstrap
    // transport, not the Windows kernel Job behavior (requires Windows machine).
    const child = spawn(process.execPath, [], { stdio: ["pipe", "pipe", "pipe"] })
    const output: Buffer[] = [],
      errors: Buffer[] = []
    child.stdout.on("data", (part) => output.push(part))
    child.stderr.on("data", (part) => errors.push(part))
    const completed = once(child, "close")
    child.stdin.end(
      delayed
        ? launch.stdin
            .toString()
            .replace(
              'child.once("spawn", () => {',
              'child.once("spawn", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);'
            )
        : launch.stdin
    )
    expect((await completed)[0], Buffer.concat(errors).toString()).toBe(0)
    const frames = Buffer.concat(output)
      .toString()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(frames).toHaveLength(3)
    expect(frames[0]).toEqual({ type: "owner", pid: frames[1].pid })
    expect(frames[0].pid).not.toBe(child.pid)
    expect(frames[1]).toMatchObject({ type: "started" })
    expect(frames[2]).toMatchObject({ type: "received", request })
  }
)
