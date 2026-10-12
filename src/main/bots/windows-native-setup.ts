import { mkdir, lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { ProcessProtocol } from "../agent/process-protocol"
import { verifyNativeShellPackage } from "./native-shell-package"
import {
  probeWindowsBotNativeOwner,
  type WindowsBotNativeProvider
} from "./windows-native-resource"
import {
  assertBotOwnedShellMaintenance,
  assertBotOwnedShellMaintenanceOwner,
  type OwnedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import type { WindowsBotShellConfiguration } from "./windows-host-shell-factory"
/** Main/service provisioning port for the explicit administrator setup action.
 * All argv are fixed and package-bound. This must not be called from a model
 * tool, task retry, or a generic shell approval. A successful setup exit alone
 * is never command/native capability: the per-operation live probe remains. */
export async function prepareWindowsBotSandboxSetup(input: {
  directory: string
  configuration: WindowsBotShellConfiguration
  owner: OwnedShellMaintenanceOwner
  signal: AbortSignal
}): Promise<{
  protocol: ProcessProtocol
  environment: Record<string, string>
  requiresAdministrator: true
  provider: WindowsBotNativeProvider
  home: { path: string; dev: string; ino: string }
  packageIdentity: { directory: string; manifestSha256: string; cliSha256: string }
  assertCurrent(): Promise<void>
}> {
  if (process.platform !== "win32") throw new Error("Windows sandbox setup requires Windows")
  const directory = await realpath(input.directory)
  if (directory !== input.directory) throw new Error("Windows setup Host root has a path alias")
  await assertBotOwnedShellMaintenance(directory, input.owner, input.signal)
  const pkg = await verifyNativeShellPackage(
    input.configuration.packageDirectory,
    input.configuration.manifestSha256,
    input.signal
  )
  if (
    pkg.manifest.platform !== "win32" ||
    !pkg.setup ||
    !pkg.jobOwner ||
    pkg.manifest.ownerProtocol !== "cmb-atomic-windows-job-v2"
  )
    throw new Error("Windows atomic sandbox setup package is incomplete")
  const capabilities = await probeWindowsBotNativeOwner(pkg.jobOwner, input.signal)
  const home = join(directory, "native-codex-home")
  await mkdir(home, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
  const pin = await lstat(home, { bigint: true })
  const assertCurrent = async () => {
    await assertBotOwnedShellMaintenanceOwner(directory, input.owner, input.signal)
    await pkg.assertCurrent(input.signal)
    const now = await lstat(home, { bigint: true })
    if (
      !now.isDirectory() ||
      now.isSymbolicLink() ||
      now.dev !== pin.dev ||
      now.ino !== pin.ino ||
      (await realpath(home)) !== home
    )
      throw new Error("Windows native setup home changed")
    input.signal.throwIfAborted()
  }
  await assertCurrent()
  return {
    requiresAdministrator: true,
    assertCurrent,
    provider: {
      artifact: pkg.jobOwner,
      capabilities,
      limits: input.configuration.resourceLimits ?? { pids: 512, memoryBytes: 2147483648 }
    },
    home: { path: home, dev: String(pin.dev), ino: String(pin.ino) },
    packageIdentity: {
      directory: pkg.directory,
      manifestSha256: pkg.manifestSha256,
      cliSha256: pkg.cli.sha256
    },
    environment: { CODEX_HOME: home },
    protocol: {
      executable: pkg.cli.entry,
      args: ["sandbox", "setup", "--elevated", "--current-user", "--codex-home", home],
      stdin: "",
      shell: false,
      sensitiveArguments: true,
      onOutput: () => {}
    }
  }
}
