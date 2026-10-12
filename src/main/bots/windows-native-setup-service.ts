import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { once } from "node:events"
import { BotHostLock } from "./host-lock"
import {
  ownedShellMaintenanceOwner,
  inspectBotOwnedShellMaintenance,
  BOT_OWNED_SHELL_RESOURCE_DIRECTORY
} from "./owned-shell-maintenance-fence"
import { OwnedShellReceiptSlot, inspectOwnedShellReceiptEntries } from "./owned-shell-receipts"
import { prepareWindowsBotSandboxSetup } from "./windows-native-setup"
import {
  prepareWindowsNativeShellResource,
  startWindowsNativeShellController,
  closeUnlaunchedWindowsNativeReservation
} from "./windows-native-resource"
import {
  readNativeShellResourceClosure,
  readNativeShellResourceRecord
} from "./linux-native-resource"
import {
  windowsProvisioningAuthorization,
  windowsProvisioningBinding
} from "./windows-provisioning-contract"
import { readPrivateJson, writePrivateJson } from "./backup-io"
import { recoverCompletedWindowsSetup, rejectUnstartedWindowsSetup } from "./windows-setup-recovery"
import { readBotOwnedShellArtifact } from "./host-shell-factory"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { botShellEnvironment } from "./shell-contract"
import { safeSensitiveErrorText } from "../error-text"
import {
  botWindowsNativeSetupRequest,
  botWindowsNativeSetupStatus,
  botWindowsNativeSetupResult,
  type BotWindowsNativeSetupStatus
} from "../../shared/bot-windows-native-setup"
import { windowsSetupMarker, publishWindowsSetupMarker } from "./windows-setup-marker"
import type { WindowsBotShellConfiguration } from "./windows-host-shell-factory"
/** Trusted Main/service coordinator. Paths are process startup ports, never
 * renderer/model request fields. The same ledger, Job owner and recovery
 * transaction is shared by desktop setup and isolated native CI acceptance. */
export function createWindowsNativeSetupService(ports: {
  directory(): Promise<string>
  configuration(): WindowsBotShellConfiguration
  helperEntry: string
}) {
  const root = ports.directory
  const config = ports.configuration
  function scopeOf(directory: string, identity: unknown) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          format: 1,
          directory,
          identity,
          manifest: config().manifestSha256
        })
      )
      .digest("hex")
  }
  const status = (state: BotWindowsNativeSetupStatus["state"], message: string, scope?: string) =>
    botWindowsNativeSetupStatus.parse({
      state,
      message,
      ...(scope ? { scope } : {})
    })
  async function getStatus(): Promise<BotWindowsNativeSetupStatus> {
    if (process.platform !== "win32")
      return status("unavailable", "Bot 原生 Windows 沙箱仅在 Windows 上初始化。")
    if (!config().packageDirectory || !config().manifestSha256)
      return status("unavailable", "尚未安装经过校验的 Bot 原生 Windows 组件。")
    const directory = await root(),
      held = BotHostLock.acquire(directory),
      lock = held ?? BotHostLock.observe(directory)
    try {
      const owner = ownedShellMaintenanceOwner(lock),
        scope = scopeOf(directory, owner.root),
        review = await inspectBotOwnedShellMaintenance(directory, owner)
      if (review.state !== "ready")
        return status(
          "requires_review",
          "有命令或初始化过程尚未确认停止，请先查看命令现场。",
          scope
        )
      let initialized = false
      try {
        initialized =
          windowsSetupMarker.parse(
            (await readPrivateJson(directory, "windows-native-setup.json", 4096)).value
          ).scope === scope
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      return status(
        initialized ? "initialized" : "setup_available",
        initialized
          ? "管理员初始化已完成；每次命令仍会核验项目权限和原生隔离。"
          : "Bot 使用独立的原生组件与登录环境，需要一次管理员初始化。",
        scope
      )
    } catch (error) {
      return status(
        "unavailable",
        safeSensitiveErrorText(error instanceof Error ? error.message : "无法读取初始化状态", 512)
      )
    } finally {
      held?.release()
    }
  }
  /** Exact nonce retries only read a sealed/complete operation; unknown effects
   * cannot launch provisioning again. The persistent resource slot precedes the
   * native launch and remains the cross-process maintenance barrier on crash. */
  function initialize(raw: unknown) {
    const request = botWindowsNativeSetupRequest.parse(raw)
    if (process.platform !== "win32")
      return Promise.resolve(
        botWindowsNativeSetupResult.parse({
          nonce: request.nonce,
          success: false,
          definitive: true,
          status: status("unavailable", "Bot 原生 Windows 沙箱仅在 Windows 上初始化。")
        })
      )
    return (async () => {
      const directory = await root(),
        lock = BotHostLock.acquire(directory)
      if (!lock) throw new Error("Bot 后台仍在运行，未开始管理员初始化")
      const controller = new AbortController(),
        signal = controller.signal
      let ledger: BotMaintenanceReceipts | undefined
      try {
        const owner = ownedShellMaintenanceOwner(lock),
          scope = scopeOf(directory, owner.root)
        const reply = (success: boolean, definitive: boolean, value: BotWindowsNativeSetupStatus) =>
          botWindowsNativeSetupResult.parse({
            nonce: request.nonce,
            success,
            definitive,
            status: value
          })
        ledger = new BotMaintenanceReceipts(directory)
        const prior = ledger.getOperation("windows-setup", request.nonce)
        if (
          prior &&
          (prior.action !== "setup" ||
            prior.requestSha256 !== BotMaintenanceReceipts.requestHash(request))
        )
          throw new Error("初始化请求标识已用于其他环境")
        if (prior?.state === "completed") return botWindowsNativeSetupResult.parse(prior.result)
        const resourceRoot = join(directory, BOT_OWNED_SHELL_RESOURCE_DIRECTORY)
        await mkdir(resourceRoot, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error
        })
        const recovered = await recoverCompletedWindowsSetup({
          directory,
          resourceRoot,
          request,
          ledger,
          assertCurrent: async () => {
            await lock.checkCurrent()
          }
        })
        if (recovered) return recovered
        const entries = await inspectOwnedShellReceiptEntries(resourceRoot)
        if (
          prior?.state === "sealed" ||
          entries.some((entry) => entry.value.nonce === request.nonce)
        )
          return reply(
            false,
            false,
            status(
              "requires_review",
              "此次初始化的执行状态待确认，请查看现场；不会重复执行。",
              request.scope
            )
          )
        if (request.scope !== scope) {
          if (prior?.state === "reserved") {
            // Reserved is durably before native launch. An exact rejected result
            // must also be terminal, so later configuration changes cannot revive
            // this nonce after the UI acknowledged that no setup was performed.
            const rejected = reply(
              false,
              true,
              status("unavailable", "本次请求未开始初始化，环境已变化，请重新读取状态。", scope)
            )
            const notStarted = "0".repeat(64)
            ledger.sealOperation("windows-setup", request.nonce, notStarted)
            ledger.completeOperation("windows-setup", request.nonce, notStarted, rejected)
            return rejected
          }
          return reply(
            false,
            false,
            status("requires_review", "初始化环境发生变化，请保留原请求并查看现场。", request.scope)
          )
        }
        const review = await inspectBotOwnedShellMaintenance(directory, owner)
        if (review.state !== "ready")
          return reply(false, false, status("requires_review", review.hint, scope))
        if (prior?.state === "reserved") ledger.releaseOperation("windows-setup", request.nonce)
        ledger.reserveOperation(
          "windows-setup",
          request.nonce,
          "setup",
          BotMaintenanceReceipts.requestHash(request),
          { reserved: true, padding: " ".repeat(7168) }
        )
        let prep: Awaited<ReturnType<typeof prepareWindowsBotSandboxSetup>>,
          helper: Awaited<ReturnType<typeof readBotOwnedShellArtifact>>
        try {
          prep = await prepareWindowsBotSandboxSetup({
            directory,
            configuration: config(),
            owner,
            signal
          })
          helper = await readBotOwnedShellArtifact(ports.helperEntry)
        } catch (error) {
          // No provisioning resource or setup CLI exists yet. Package/ABI/read
          // failures can be acknowledged without trapping the UI in an unknown
          // task, while the same nonce remains terminal across reopen.
          return rejectUnstartedWindowsSetup({
            request,
            ledger,
            result: reply(
              false,
              true,
              status(
                "unavailable",
                safeSensitiveErrorText(
                  error instanceof Error ? error.message : "初始化准备失败，未启动管理员初始化",
                  512
                ),
                scope
              )
            ),
            assertCurrent: async () => {
              await lock.checkCurrent()
              signal.throwIfAborted()
            }
          })
        }
        const slot = await OwnedShellReceiptSlot.allocate(resourceRoot, {
          nonce: request.nonce,
          hostId: "main-windows-provisioning",
          dataEpoch: "native-environment",
          runId: "native-sandbox-setup",
          helperSha256: helper.sha256,
          workerSha256: helper.sha256,
          nativeProviderSha256: prep.provider.artifact.sha256,
          policySha256: BotMaintenanceReceipts.requestHash({
            scope,
            package: prep.packageIdentity,
            home: prep.home
          }),
          containment: "verified-windows-atomic-job-v2"
        })
        let nativeRecord: Awaited<ReturnType<typeof prepareWindowsNativeShellResource>> | undefined,
          childStarted = false,
          knownClosed = false,
          success = false,
          failure: unknown
        try {
          nativeRecord = await prepareWindowsNativeShellResource({
            directory: slot.directory,
            origin: slot.snapshot(),
            provider: prep.provider,
            provisioning: {
              cliSha256: prep.packageIdentity.cliSha256,
              codexHome: prep.home
            },
            signal,
            assertCurrent: async () => {
              await lock.checkCurrent()
              await prep.assertCurrent()
            }
          })
          const binding = windowsProvisioningBinding(nativeRecord)
          ledger.sealOperation("windows-setup", request.nonce, binding)
          await prep.assertCurrent()
          const native = startWindowsNativeShellController({
            provider: prep.provider,
            record: nativeRecord,
            directory: slot.directory,
            executable: process.execPath,
            helperEntry: helper.entry,
            cwd: prep.home.path,
            timeoutMs: 300_000,
            environment: {
              ...botShellEnvironment(process.env),
              ELECTRON_RUN_AS_NODE: "1",
              CMB_BOT_WINDOWS_PROVISIONING: "1",
              CMB_BOT_SHELL_RECEIPT_DIRECTORY: slot.directory,
              CMB_BOT_NATIVE_SANDBOX_DIRECTORY: prep.packageIdentity.directory,
              CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: prep.packageIdentity.manifestSha256
            },
            failure: (error) => {
              failure ??= error
            }
          })
          childStarted = native.child.pid !== undefined
          const closed = once(native.child, "close")
          const timer = setTimeout(() => {
            failure ??= new Error("管理员初始化超时，关闭状态待确认")
            native.stop()
          }, 315_000)
          try {
            const pid = await native.ready
            await lock.checkCurrent()
            await prep.assertCurrent()
            signal.throwIfAborted()
            await slot.ready(pid, pid)
            await slot.authorizeRun()
            await lock.checkCurrent()
            await prep.assertCurrent()
            await writePrivateJson(
              join(slot.directory, "native-setup-authorized.json"),
              windowsProvisioningAuthorization.parse({
                format: 1,
                nonce: request.nonce,
                recordSha256: binding
              })
            )
            const [code, exitSignal] = await closed
            if (failure) throw failure
            knownClosed = !!(await readNativeShellResourceClosure(slot.directory, slot.snapshot()))
            if (code !== 0 || exitSignal !== null || !knownClosed)
              throw new Error("管理员初始化未交付可核验的完成结果，请查看现场")
            await lock.checkCurrent()
            await prep.assertCurrent()
            await publishWindowsSetupMarker(
              directory,
              { scope, nonce: request.nonce, recordSha256: binding },
              async () => {
                await lock.checkCurrent()
                await prep.assertCurrent()
              }
            )
            success = true
          } finally {
            clearTimeout(timer)
            native.stop()
            if (native.child.exitCode === null && native.child.signalCode === null) await closed
          }
        } catch (error) {
          failure = error
        } finally {
          if (!childStarted && !nativeRecord)
            nativeRecord = await readNativeShellResourceRecord(slot.directory, slot.snapshot())
          if (!childStarted && nativeRecord) {
            await closeUnlaunchedWindowsNativeReservation(slot.directory, nativeRecord)
            knownClosed = true
          }
          if (knownClosed) {
            await slot.closed()
          } else await slot.settle(false)
        }
        const result = reply(
          success,
          success || knownClosed || !childStarted,
          status(
            success
              ? "initialized"
              : childStarted && !knownClosed
                ? "requires_review"
                : "unavailable",
            success
              ? "管理员初始化已完成；每次命令仍会进行项目权限和原生隔离核验。"
              : safeSensitiveErrorText(
                  failure instanceof Error ? failure.message : "初始化状态待确认",
                  512
                ),
            scope
          )
        )
        if (result.definitive && nativeRecord)
          ledger.completeOperation(
            "windows-setup",
            request.nonce,
            windowsProvisioningBinding(nativeRecord),
            result
          )
        if (knownClosed) {
          await lock.checkCurrent()
          await slot.settle(true)
        }
        return result
      } finally {
        controller.abort()
        ledger?.close()
        lock.release()
      }
    })()
  }

  return { getStatus, initialize }
}
