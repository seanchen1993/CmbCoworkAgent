import { afterAll } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { BotShellProcess } from "./shell-process"
import { prepareMacBotShell } from "./mac-shell-sandbox"
import { verifyOwnedShellArtifact } from "./owned-shell-artifact"
import type { OwnedShellResource } from "./owned-shell-process"
import { acquireShellTestHostLease } from "./shell-test-host-lease"
import { createBotHostShellFactory } from "./host-shell-factory"
import { inspectOwnedShellReceiptEntries } from "./owned-shell-receipts"
import {
  ownedShellMaintenanceOwner,
  inspectBotOwnedShellMaintenance
} from "./owned-shell-maintenance-fence"
import { loadWindowsNativeTestConfiguration } from "./windows-native-test-configuration"

/** Component fixtures use the actual compiled owner and Cmb worker, with the
 * real Mac compiler. No constructor fallback or worker-owned fake authority.
 * Linux component execution covers group lifetime only; its native filesystem
 * acceptance is separate. Windows uses the explicitly initialized real native factory; kernel acceptance
 * remains a separate required target-platform gate. */
const codeRoots: string[] = []
const retainedCodeRoots = new Set<string>()
// Test runtimes may change the application home for their own model/worktree
// fixtures. Native authority stays bound to the explicitly prepared CI scope.
const windowsFixtureEnvironment = Object.fromEntries(
  [
    "CMB_BOT_NATIVE_WINDOWS_TEST",
    "CMB_COWORK_AGENT_HOME",
    "CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY",
    "CMB_BOT_NATIVE_SANDBOX_DIRECTORY",
    "CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256"
  ].map((key) => [key, process.env[key]])
)
let compiled: Promise<{ helper: string; worker: string }> | undefined
async function compiledEntries(): Promise<{ helper: string; worker: string }> {
  if (process.env.CMB_BOT_SHELL_TEST_COMPILED === "1")
    return {
      helper: resolve("out/main/bot-shell-owner.js"),
      worker: resolve("out/main/bot-shell.js")
    }
  if (!compiled)
    compiled = (async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-shell-test-code-")))
      codeRoots.push(root)
      await writeFile(join(root, "package.json"), '{"type":"commonjs"}')
      await symlink(await realpath(resolve("node_modules")), join(root, "node_modules"), "junction")
      const entries = { helper: "owned-shell-helper-entry", worker: "shell-worker-entry" }
      for (const [name, entry] of Object.entries(entries))
        await build({
          entryPoints: [resolve(`src/main/bots/${entry}.ts`)],
          outfile: join(root, `${name}.cjs`),
          bundle: true,
          platform: "node",
          format: "cjs",
          target: "node22",
          packages: "external",
          define: {
            "import.meta.url": JSON.stringify(pathToFileURL(join(root, `${name}.cjs`)).href)
          },
          logLevel: "silent"
        })
      return { helper: join(root, "helper.cjs"), worker: join(root, "worker.cjs") }
    })()
  return compiled
}
afterAll(async () => {
  for (const root of codeRoots.splice(0))
    if (!retainedCodeRoots.has(root)) await rm(root, { recursive: true, force: true })
}, 10_000)
async function pinned(entry: string): Promise<{ entry: string; sha256: string }> {
  const value = {
    entry,
    sha256: createHash("sha256")
      .update(await readFile(entry))
      .digest("hex")
  }
  await verifyOwnedShellArtifact(value)
  return value
}
export async function createTrustedBotShellTestRunner(
  cleanup: Array<() => unknown | Promise<unknown>>,
  options: { workerEntry?: string; resourceReady?: (value: OwnedShellResource) => void } = {}
): Promise<BotShellProcess> {
  const entries = await compiledEntries()
  if (process.platform === "win32") return createWindowsRunner(cleanup, entries, options)
  const helper = await pinned(entries.helper),
    worker = await pinned(options.workerEntry ?? entries.worker)
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-shell-test-owner-")))
  const controlRoot = join(directory, "resources")
  await mkdir(controlRoot, { mode: 0o700 })
  const pin = await lstat(controlRoot, { bigint: true })
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const origin = {
    hostId: `fixture-${randomUUID()}`,
    dataEpoch: "fixture-epoch",
    policySha256: helper.sha256
  }
  const runtimeReadRoots = [await realpath(resolve("node_modules"))]
  return new BotShellProcess(async (request, signal) => {
    signal.throwIfAborted()
    const launcher = {
      entry: worker.entry,
      executable: process.env.CMB_BOT_NODE ?? process.execPath,
      execArgv: [] as string[]
    }
    const prepared =
      process.platform === "darwin"
        ? await prepareMacBotShell(
            { ...request, protectedRoots: [directory, ...(request.protectedRoots ?? [])] },
            launcher,
            runtimeReadRoots
          )
        : { launcher, close: async () => {} }
    return {
      helper,
      controlRoot,
      origin,
      launch: {
        entry: worker.entry,
        entrySha256: worker.sha256,
        cwd: request.cwd,
        startupCwd: await realpath(request.workspaceRoot ?? request.cwd),
        executable: prepared.launcher.executable!,
        execArgv: prepared.launcher.execArgv ?? [],
        environment:
          "environment" in prepared.launcher
            ? Object.fromEntries(
                Object.entries(prepared.launcher.environment ?? {}).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string"
                )
              )
            : {}
      },
      assertCurrent: async (currentSignal) => {
        currentSignal.throwIfAborted()
        const now = await lstat(controlRoot, { bigint: true })
        if (
          now.dev !== pin.dev ||
          now.ino !== pin.ino ||
          !now.isDirectory() ||
          now.isSymbolicLink()
        )
          throw new Error("Test fixture resource root changed")
      },
      resourceReady: options.resourceReady,
      releasePrepared: async (knownClosed) => {
        if (knownClosed) await prepared.close()
      }
    }
  })
}

/** Uses the real prepared native Host and the same factory as the five Windows
 * kernel checks. An unprepared Windows machine fails rather than using group
 * cleanup or a fixture-supplied capability. */
async function createWindowsRunner(
  cleanup: Array<() => unknown | Promise<unknown>>,
  entries: { helper: string; worker: string },
  options: { workerEntry?: string; resourceReady?: (value: OwnedShellResource) => void }
) {
  const configuration = await loadWindowsNativeTestConfiguration(windowsFixtureEnvironment)
  const lease = acquireShellTestHostLease(configuration.directory)
  const lock = lease.lock
  const hostId = `windows-native-fixture-${randomUUID()}`
  let worker = entries.worker
  // Keep immutable code outside the writable project. The source fixtures may
  // bundle their worker next to the project; moving identical bytes preserves
  // the native installed-code write guard instead of granting that parent.
  let relocatedRoot: string | undefined
  try {
    await lease.prepare(async () => {
      const review = await inspectBotOwnedShellMaintenance(
        configuration.directory,
        ownedShellMaintenanceOwner(lock)
      )
      if (review.state !== "ready") throw new Error("Unproven Windows fixture resources retained")
    })
    if (options.workerEntry) {
      const original = await pinned(options.workerEntry)
      relocatedRoot = await realpath(await mkdtemp(join(tmpdir(), "cmb-windows-fixture-code-")))
      codeRoots.push(relocatedRoot)
      await symlink(
        await realpath(resolve("node_modules")),
        join(relocatedRoot, "node_modules"),
        "junction"
      )
      worker = join(relocatedRoot, "worker.cjs")
      await copyFile(original.entry, worker, constants.COPYFILE_EXCL)
      if ((await pinned(worker)).sha256 !== original.sha256)
        throw new Error("Windows fixture worker changed during relocation")
    }
    const factory = await createBotHostShellFactory({
      ...configuration,
      helperEntry: entries.helper,
      workerEntry: worker,
      hostId: () => hostId,
      dataEpoch: () => "shell-tests",
      assertOwnership: lease.assertCurrent
    })
    cleanup.push(async () => {
      try {
        await lock.checkCurrent()
        if (
          (
            await inspectOwnedShellReceiptEntries(join(configuration.directory, "shell-resources"))
          ).some((entry) => entry.value.hostId === hostId)
        ) {
          for (const root of codeRoots) retainedCodeRoots.add(root)
          // Throw before older fixture cleanup callbacks delete the workspace.
          throw new Error("Unproven Windows Shell fixture retained; workspace/code cleanup stopped")
        }
        if (relocatedRoot) {
          await rm(relocatedRoot, { recursive: true, force: false })
          const index = codeRoots.indexOf(relocatedRoot)
          if (index >= 0) codeRoots.splice(index, 1)
        }
      } catch (error) {
        lease.retain()
        for (const root of codeRoots) retainedCodeRoots.add(root)
        throw error
      } finally {
        lease.release()
      }
    })
    return new BotShellProcess(async (request, signal) => ({
      ...(await factory(request, signal)),
      resourceReady: options.resourceReady
    }))
  } catch (error) {
    if (relocatedRoot) retainedCodeRoots.add(relocatedRoot)
    lease.release()
    throw error
  }
}
