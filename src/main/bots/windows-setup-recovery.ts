import { join } from "node:path"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { inspectOwnedShellReceiptEntries, OwnedShellReceiptSlot } from "./owned-shell-receipts"
import {
  readNativeShellResourceRecord,
  readNativeShellResourceClosure
} from "./linux-native-resource"
import { windowsProvisioningBinding } from "./windows-provisioning-contract"
import { publishWindowsSetupMarker } from "./windows-setup-marker"
import { botWindowsNativeSetupResult } from "../../shared/bot-windows-native-setup"

/** Resume receipt settlement only. This port never spawns a process or infers
 * closure from PID absence, a marker, or an administrator setup success flag. */
export async function recoverCompletedWindowsSetup(input: {
  directory: string
  resourceRoot: string
  request: { nonce: string; scope: string }
  ledger: BotMaintenanceReceipts
  assertCurrent(): Promise<void>
}): Promise<ReturnType<typeof botWindowsNativeSetupResult.parse> | undefined> {
  const prior = input.ledger.getOperation("windows-setup", input.request.nonce)
  if (!prior) return undefined
  if (
    prior.action !== "setup" ||
    prior.requestSha256 !== BotMaintenanceReceipts.requestHash(input.request)
  )
    throw new Error("初始化请求标识已用于其他环境")
  if (prior.state === "completed") return botWindowsNativeSetupResult.parse(prior.result)
  if (prior.state !== "sealed") return undefined
  const entry = (await inspectOwnedShellReceiptEntries(input.resourceRoot)).find(
    (value) => value.value.nonce === input.request.nonce
  )
  if (!entry) return undefined
  const directory = join(input.resourceRoot, `operation-${entry.slot}`)
  const record = await readNativeShellResourceRecord(directory, entry.value)
  if (
    !record ||
    record.resource.kind !== "verified-windows-atomic-job-v2" ||
    !record.resource.provisioning ||
    windowsProvisioningBinding(record) !== prior.journalSha256
  )
    throw new Error("初始化现场与持久请求不一致")
  const proof = await readNativeShellResourceClosure(directory, entry.value)
  if (!proof) return undefined
  const success = entry.value.runAuthorized && !proof.neverLaunched
  const result = botWindowsNativeSetupResult.parse({
    nonce: input.request.nonce,
    success,
    definitive: true,
    status: {
      state: success ? "initialized" : "unavailable",
      scope: input.request.scope,
      message: success
        ? "管理员初始化已完成；每次命令仍会进行项目权限和原生隔离核验。"
        : "此次初始化未获执行授权，现场已安全关闭；可重新发起初始化。"
    }
  })
  await input.assertCurrent()
  if (success)
    await publishWindowsSetupMarker(
      input.directory,
      {
        scope: input.request.scope,
        nonce: input.request.nonce,
        recordSha256: prior.journalSha256
      },
      input.assertCurrent
    )
  // Completion is durable before cleanup. A lost response returns this same
  // result even after the private slot has been removed.
  input.ledger.completeOperation("windows-setup", input.request.nonce, prior.journalSha256, result)
  await input.assertCurrent()
  const slot = await OwnedShellReceiptSlot.reopenClosed(input.resourceRoot, entry.slot)
  await slot.settle(true)
  return result
}

/** Caller has not allocated/launched a setup resource. Only a reserved intent
 * can become this no-effect terminal; sealed/authorized work must retain the
 * physical proof path. A lost ACK reads the same bounded durable result. */
export async function rejectUnstartedWindowsSetup(input: {
  request: { nonce: string; scope: string }
  ledger: BotMaintenanceReceipts
  result: ReturnType<typeof botWindowsNativeSetupResult.parse>
  assertCurrent(): Promise<void>
}): Promise<ReturnType<typeof botWindowsNativeSetupResult.parse>> {
  const prior = input.ledger.getOperation("windows-setup", input.request.nonce)
  if (
    !prior ||
    prior.action !== "setup" ||
    prior.requestSha256 !== BotMaintenanceReceipts.requestHash(input.request)
  )
    throw new Error("初始化请求标识已用于其他环境")
  if (prior.state !== "reserved") throw new Error("初始化已封存，不能视为未启动")
  const result = botWindowsNativeSetupResult.parse(input.result)
  if (
    result.nonce !== input.request.nonce ||
    result.success ||
    !result.definitive ||
    result.status.state === "initialized"
  )
    throw new Error("未启动初始化回执不一致")
  await input.assertCurrent()
  const binding = "0".repeat(64)
  input.ledger.sealOperation("windows-setup", input.request.nonce, binding)
  input.ledger.completeOperation("windows-setup", input.request.nonce, binding, result)
  return result
}
