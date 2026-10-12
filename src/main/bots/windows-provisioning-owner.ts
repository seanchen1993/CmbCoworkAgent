import { spawn } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { readPrivateJson, writePrivateJson } from "./backup-io"
import { readNativeShellResourceRecord } from "./linux-native-resource"
import { ownedShellReceiptSchema, OWNED_SHELL_RECEIPT_BYTES } from "./owned-shell-receipt-contract"
import { verifyNativeShellPackage } from "./native-shell-package"
import {
  windowsProvisioningAuthorization,
  windowsProvisioningTerminal,
  windowsProvisioningBinding
} from "./windows-provisioning-contract"
import { botShellEnvironment } from "./shell-contract"
import { verifyOwnedShellArtifact } from "./owned-shell-artifact"
/** Static role of the existing pinned owner entry. It never runs a model
 * command or opens Store. UAC's external helper is accounted for by requiring
 * actual fixed CLI success before the durable provisioning terminal. */
export async function runWindowsBotSandboxSetupOwner(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows provisioning owner requires Windows")
  const directory = process.env.CMB_BOT_SHELL_RECEIPT_DIRECTORY,
    packageDirectory = process.env.CMB_BOT_NATIVE_SANDBOX_DIRECTORY,
    manifest = process.env.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256
  if (!directory || !packageDirectory || !manifest)
    throw new Error("Windows setup private startup is incomplete")
  const readReceipt = async () =>
    ownedShellReceiptSchema.parse(
      (await readPrivateJson(directory, "owner.json", OWNED_SHELL_RECEIPT_BYTES)).value
    )
  const origin = await readReceipt(),
    record = await readNativeShellResourceRecord(directory, origin)
  if (
    !record ||
    record.resource.kind !== "verified-windows-atomic-job-v2" ||
    !record.resource.provisioning ||
    record.resource.jobName !== process.env.CMB_BOT_RESOURCE_JOB
  )
    throw new Error("Windows setup has no atomic resource")
  await verifyOwnedShellArtifact({ entry: process.argv[1], sha256: origin.helperSha256 })
  const pkg = await verifyNativeShellPackage(packageDirectory, manifest)
  if (
    pkg.manifest.ownerProtocol !== "cmb-atomic-windows-job-v2" ||
    pkg.cli.sha256 !== record.resource.provisioning.cliSha256 ||
    pkg.jobOwner?.sha256 !== record.resource.providerSha256
  )
    throw new Error("Windows setup package differs from reserved scope")
  const home = record.resource.provisioning.codexHome,
    nonce = origin.nonce,
    binding = windowsProvisioningBinding(record)
  const assertCurrent = async () => {
    const now = await readReceipt()
    const current = await readNativeShellResourceRecord(directory, now)
    if (!current || windowsProvisioningBinding(current) !== binding)
      throw new Error("Windows setup scope changed")
    await pkg.assertCurrent()
    const pin = await lstat(home.path, { bigint: true })
    if (
      !pin.isDirectory() ||
      pin.isSymbolicLink() ||
      String(pin.dev) !== home.dev ||
      String(pin.ino) !== home.ino ||
      (await realpath(home.path)) !== home.path
    )
      throw new Error("Windows setup home changed")
    return now
  }
  const until = Date.now() + 30_000
  for (;;) {
    const current = await assertCurrent()
    try {
      const grant = windowsProvisioningAuthorization.parse(
        (await readPrivateJson(directory, "native-setup-authorized.json", 4096)).value
      )
      if (
        grant.nonce !== nonce ||
        grant.recordSha256 !== binding ||
        !current.runAuthorized ||
        current.helperPid !== process.pid ||
        current.workerPid !== process.pid
      )
        throw new Error("Windows setup authorization differs")
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (Date.now() >= until) throw new Error("Windows setup authorization timed out")
    await delay(25)
  }
  await assertCurrent()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      pkg.cli.entry,
      ["sandbox", "setup", "--elevated", "--current-user", "--codex-home", home.path],
      {
        cwd: home.path,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        env: { ...botShellEnvironment(process.env), CODEX_HOME: home.path }
      }
    )
    child.once("error", reject)
    child.once("close", (code, signal) =>
      code === 0 && signal === null
        ? resolve()
        : reject(new Error("Windows provisioning did not report complete"))
    )
  })
  await assertCurrent()
  await writePrivateJson(
    join(directory, "native-setup-terminal.json"),
    windowsProvisioningTerminal.parse({
      format: 1,
      nonce,
      recordSha256: binding,
      cliSha256: pkg.cli.sha256,
      completed: true
    })
  )
}
