import { test } from "vitest"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { build } from "esbuild"

async function realIPC(mode: "during-setup" | "already-disconnected"): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-witness-eof-")))
  try {
    const module = join(root, "lifetime.cjs")
    // Compile the actual production primitive, rather than a fixture copy.
    await build({
      entryPoints: [join(__dirname, "owned-shell-parent-lifetime.ts")],
      outfile: module,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      logLevel: "silent"
    })
    const fixture = join(root, "witness.cjs")
    await writeFile(
      fixture,
      `const {observeOwnedShellParentEOF}=require(${JSON.stringify(module)});
      const {setTimeout:delay}=require('node:timers/promises');
      (async()=>{
        const startBefore=${JSON.stringify(mode)}==='during-setup';
        let parent=startBefore?observeOwnedShellParentEOF():undefined;
        process.stdout.write('setup-start\\n');
        await delay(100);
        parent??=observeOwnedShellParentEOF();
        parent.ready({witnessReady:true});
        await parent.disconnected;
        process.stdout.write(JSON.stringify({cleanupReachable:true,connected:process.connected,kernelTested:false})+'\\n');
      })().catch(error=>{process.stderr.write(String(error));process.exitCode=1});
    `,
      { flag: "wx", mode: 0o600 }
    )
    const child = fork(fixture, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
    assert.ok(child.stdout && child.stderr)
    let stdout = "",
      stderr = ""
    child.stdout.on("data", (part) => {
      stdout += part.toString()
      if (stdout.includes("setup-start\n") && child.connected) child.disconnect()
    })
    child.stderr.on("data", (part) => {
      stderr += part.toString()
    })
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000)
    let exitCode: number | null
    try {
      ;[exitCode] = await once(child, "exit")
    } finally {
      clearTimeout(deadline)
    }
    assert.equal(exitCode, 0, stderr)
    assert.deepEqual(JSON.parse(stdout.split("\n").filter(Boolean).at(-1)!), {
      cleanupReachable: true,
      connected: false,
      kernelTested: false
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
test("actual parent IPC EOF during awaited witness validation is latched before readiness", async () =>
  realIPC("during-setup"))
test("a witness that reaches validation after actual parent IPC EOF cannot await forever", async () =>
  realIPC("already-disconnected"))
