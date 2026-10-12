import { test } from "vitest"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, realpath, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { BotHostLock } from "./host-lock"
import { createBotHostShellFactory } from "./host-shell-factory"
import { BotOwnedShellProcess, BotOwnedShellUnknown } from "./owned-shell-process"
import {
  inspectBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { botShellResultSandboxName, type BotShellRequest } from "./shell-contract"
const configuration = {
  packageDirectory: process.env.CMB_BOT_NATIVE_SANDBOX_DIRECTORY ?? "",
  manifestSha256: process.env.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256 ?? "",
  delegatedCgroupDirectory: process.env.CMB_BOT_DELEGATED_CGROUP_DIRECTORY ?? ""
}
const buildDirectory = process.env.CMB_BOT_NATIVE_BUILD_DIRECTORY
// A skip is explicitly not native acceptance. Deployment must supply a fixed
// built package, compiled production owner/worker and actual delegated kernel.
const native = test.runIf(
  process.platform === "linux" &&
    Boolean(
      buildDirectory &&
      configuration.packageDirectory &&
      configuration.manifestSha256 &&
      configuration.delegatedCgroupDirectory
    )
)
async function fixture(
  action: (f: {
    root: string
    workspace: string
    factory: Awaited<ReturnType<typeof createBotHostShellFactory>>
    owner: ReturnType<typeof ownedShellMaintenanceOwner>
  }) => Promise<void>
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-linux-native-"))),
    workspace = join(root, "project"),
    data = join(root, "host")
  await mkdir(workspace, { mode: 0o700 })
  await mkdir(data, { mode: 0o700 })
  const lock = BotHostLock.acquire(data)
  assert.ok(lock)
  try {
    const factory = await createBotHostShellFactory({
      directory: data,
      helperEntry: join(buildDirectory!, "bot-shell-owner.js"),
      workerEntry: join(buildDirectory!, "bot-shell.js"),
      linuxNative: configuration,
      hostId: () => "actual-linux-native",
      dataEpoch: () => "epoch",
      assertOwnership: async (signal) => {
        signal.throwIfAborted()
        await lock.checkCurrent()
        signal.throwIfAborted()
      }
    })
    await action({ root: data, workspace, factory, owner: ownedShellMaintenanceOwner(lock) })
  } finally {
    let removable = false
    try {
      const review = await inspectBotOwnedShellMaintenance(data, ownedShellMaintenanceOwner(lock))
      removable = review.state === "ready" && review.entries.length === 0
    } catch {
      /* Preserve unknown evidence. */
    }
    lock.release()
    if (removable) await rm(root, { recursive: true, force: true })
    else console.error(`Native acceptance preserved its unresolved private fixture: ${root}`)
  }
}
function request(cwd: string, command: string): BotShellRequest {
  return {
    runId: "native-test",
    cwd,
    workspaceRoot: cwd,
    command,
    timeoutMs: 30_000,
    execution: { resourceDirectory: buildDirectory!, windowsSandbox: "none" }
  }
}
native(
  "actual Linux fixed helper admits only after isolation probe and drains the kernel before maintenance",
  async () =>
    fixture(async (f) => {
      const input = request(f.workspace, "printf LINUX_NATIVE_COMPLETE"),
        signal = new AbortController().signal
      const options = await f.factory(input, signal),
        start = new BotOwnedShellProcess(options).start(input, signal)
      await start.admitted
      const result = await start.completion
      assert.equal(result.exitCode, 0)
      assert.equal(botShellResultSandboxName(result), "linux-codex-cgroup-v2")
      assert.match(result.output, /LINUX_NATIVE_COMPLETE/)
      const review = await inspectBotOwnedShellMaintenance(f.root, f.owner)
      assert.equal(review.state, "ready")
      assert.deepEqual(review.entries, [])
    }),
  90_000
)
native(
  "actual Linux owner interruption closes detached descendants; no replay and restoration fence becomes ready",
  async () =>
    fixture(async (f) => {
      const ticker = join(f.workspace, "ticker"),
        marker = join(f.workspace, "leader-ready")
      const childSource = `const fs=require('node:fs');let n=0;const t=setInterval(()=>fs.appendFileSync(${JSON.stringify(ticker)},String(++n)+'\\n'),40);setTimeout(()=>{clearInterval(t);process.exit()},15000)`
      const source = `const fs=require('node:fs'),{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'}).unref();fs.writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>process.exit(),20000)`
      const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
      const input = request(f.workspace, `${quote(process.execPath)} -e ${quote(source)}`),
        controller = new AbortController()
      const options = await f.factory(input, controller.signal)
      let helperPid: number | undefined
      options.resourceReady = (value) => {
        helperPid = value.helperPid
        assert.equal(value.containment, "verified-linux-cgroup-v2")
      }
      const start = new BotOwnedShellProcess(options).start(input, controller.signal)
      void start.completion.catch(() => {})
      await start.admitted
      const until = performance.now() + 10_000
      while (performance.now() < until) {
        if (
          await readFile(ticker).then(
            (bytes) => bytes.length > 0,
            () => false
          )
        )
          break
        await delay(25)
      }
      assert.ok(
        await readFile(ticker).then(
          (bytes) => bytes.length > 0,
          () => false
        ),
        "Detached ticker must actually run before interruption"
      )
      assert.ok(helperPid)
      // Fresh, authenticated live operation PID only. Production never sends a
      // signal to a PID recovered from old persisted diagnostic records.
      process.kill(-helperPid, "SIGKILL")
      await assert.rejects(
        start.completion,
        (error) =>
          error instanceof BotOwnedShellUnknown &&
          error.requestMayHaveStarted &&
          error.resourceClosed
      )
      const before = await readFile(ticker, "utf8")
      await delay(200)
      assert.equal(await readFile(ticker, "utf8"), before)
      assert.equal((await inspectBotOwnedShellMaintenance(f.root, f.owner)).state, "ready")
    }),
  90_000
)
