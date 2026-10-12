import { test } from "vitest"
import assert from "node:assert/strict"
import { mkdtemp, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createLocalSandboxClass } from "../agent/local-sandbox-core"
import * as windows from "../agent/windows-sandbox-state"
const createSandbox = () =>
  createLocalSandboxClass({
    ...windows,
    getWindowsSandboxMode: () => "none",
    runElevatedSetupForPaths: async () => ({
      success: false,
      error: "Test does not initialize native Windows"
    })
  })
async function fixture(
  action: (directory: string, Sandbox: ReturnType<typeof createSandbox>) => Promise<void>
) {
  const Sandbox = createSandbox()
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-routing-")))
  try {
    await action(root, Sandbox)
  } finally {
    await Sandbox.killAllAndWait(5000)
    await rm(root, { recursive: true, force: true })
  }
}
test("original Cmb command path still executes the approved native shell without an adapter", async () =>
  fixture(async (root, Sandbox) => {
    const sandbox = new Sandbox({
      rootDir: root,
      runId: "legacy-cmb-routing",
      windowsSandbox: "none",
      timeout: 5000,
      retrySpawnFailures: false
    })
    const result = await sandbox.execute("printf LEGACY_CMB_OK")
    assert.equal(result.exitCode, 0)
    assert.match(result.output, /LEGACY_CMB_OK/)
  }))
test("Bot ordinary, exact Hook and background commands all reach the private adapter before spawn", async () =>
  fixture(async (root, Sandbox) => {
    const routed: string[] = []
    const sandbox = new Sandbox({
      rootDir: root,
      runId: "bot-routing",
      windowsSandbox: "none",
      timeout: 5000,
      processOwnership: "inherited-worker-resource",
      retrySpawnFailures: false,
      commandIsolation: async (input) => {
        routed.push(input.command)
        if (input.protocol)
          return { protocol: input.protocol, environment: { CMB_NATIVE_ROUTING_TEST: "hook" } }
        return {
          protocol: {
            executable: process.execPath,
            args: ["-e", "process.stdout.write('ADAPTER_'+process.env.CMB_NATIVE_ROUTING_TEST)"],
            stdin: "",
            shell: false,
            onOutput: () => {}
          },
          environment: {
            CMB_NATIVE_ROUTING_TEST: input.command.includes("BACKGROUND")
              ? "BACKGROUND"
              : "ORDINARY"
          }
        }
      }
    })
    const ordinary = await sandbox.execute("echo ORDINARY")
    assert.equal(ordinary.exitCode, 0)
    assert.match(ordinary.output, /ADAPTER_ORDINARY/)
    const chunks: Buffer[] = []
    const hook = await sandbox.executeRaw("echo HOOK", "none", 5000, undefined, {
      cwd: root,
      protocol: {
        executable: process.execPath,
        args: [
          "-e",
          "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.stdout.write(process.env.CMB_NATIVE_ROUTING_TEST+':'+s))"
        ],
        stdin: "凭证\n",
        shell: false,
        onOutput: (stream, bytes) => {
          if (stream === "stdout") chunks.push(bytes)
        }
      }
    })
    assert.equal(hook.exitCode, 0)
    assert.equal(Buffer.concat(chunks).toString("utf8"), "hook:凭证\n")
    let taskId: string | undefined
    const started = await sandbox.executeBackground("echo BACKGROUND", root, (id) => {
      taskId = id
    })
    assert.ok(taskId, started)
    const until = Date.now() + 5000
    while (Date.now() < until) {
      const value = sandbox.getTaskOutput(taskId!)
      if (value?.completed) {
        assert.ok(typeof value.output === "string")
        assert.match(value.output, /ADAPTER_BACKGROUND/)
        break
      }
      await delay(20)
    }
    assert.equal(sandbox.getTaskOutput(taskId!)?.completed, true)
    assert.deepEqual(routed, ["echo ORDINARY", "echo HOOK", "echo BACKGROUND"])
  }))
test("the legacy executor cannot accept a Bot adapter without a physical owner", () => {
  const Sandbox = createSandbox()
  assert.throws(
    () =>
      new Sandbox({
        rootDir: tmpdir(),
        runId: "invalid-adapter",
        commandIsolation: async () => {
          throw new Error("must not run")
        }
      }),
    /requires an owned Bot resource/
  )
})
