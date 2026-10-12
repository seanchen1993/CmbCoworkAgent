import { createBotPeerDispatchAdmission } from "./peer-dispatch-admission"
import {
  assertBotOwnedShellMaintenance,
  inspectBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { recoverClosedBotShellResources } from "./owned-shell-recovery"
import { recoverClosedNativeDesktopResources } from "./native-desktop-recovery"
import { createBotHostShellFactory } from "./host-shell-factory"
import { BotShellProcess } from "./shell-process"
import { withInstalledBotNativeConfiguration } from "./native-shell-installed"
import { BotSharedWorkspace } from "./shared-workspace"
import { randomBytes, createHash } from "node:crypto"
import { chmodSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { prepareBotHostSocket } from "./host-socket"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"
import { BotStore } from "./store"
import { BotHost, closeBotHostBackgroundActivity } from "./host"
import { BotRpcServer } from "./rpc"
import type { BotHostDescriptor } from "./transport-client"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotArtifacts } from "./artifacts"
import { botBrowserFileReceiver } from "./browser-files"
import type { BotHostLock } from "./host-lock"
import { BotTeachService } from "./teach-service"
import { BotSecretRequests } from "./secret-requests"
import { BotSecretVault } from "./secret-vault"
import { MacBotSecretProtection } from "./mac-secret-protection"
import { BOT_BUILD_ID } from "./host-build"
import { BotMemorySynthesis } from "./memory-synthesis"
import { botMemoryModels } from "./memory-model"
import { recoverBotRestore } from "./backups"
import { recoverBotComputerCheckpoint } from "./computer-checkpoint-service"
import { repairLegacyComputerGeneration } from "./legacy-computer-generation"
import { BotSkillCatalogSync } from "./skill-catalog-sync"
import { BotWebhookServer } from "./webhook-server"
import { BotBackupScheduler } from "./backup-scheduler"
import { BotStorageMonitor } from "./storage-monitor"
import { installBotNetwork, type BotNetwork } from "./network"
import { createBotLocalToolAuthority } from "./local-tool-authority"
import { BotDomainError } from "../../shared/bot-types"
import { NativeDesktopBroker } from "./native-desktop-broker"
import { NativeDesktopControlStore } from "./native-desktop-control-store"
import { createWindowsNativeDesktopFactory } from "./windows-native-desktop-factory"
import { readBotOwnedShellArtifact } from "./host-shell-factory"
import { NativeDesktopNoAllocationError } from "./native-desktop-transport"
import { NativeBotTeachSource } from "./teach-native-source"

/** Called only after the bootstrap owns the lifetime lock and installs diagnostics. */
export async function startBotHost(directory: string, lock: BotHostLock): Promise<void> {
  // OS-selected data directories can use aliases such as /var on macOS.
  // Resolve once under the held lifetime lock; subsequent resource guards
  // still require the exact physical root and its original inode identity.
  await lock.checkCurrent()
  directory = await realpath(directory)
  await lock.checkCurrent()
  const token = randomBytes(32).toString("hex")
  const identity = createHash("sha256").update(`${directory}:${token}`).digest("hex").slice(0, 24)
  const socket = prepareBotHostSocket(directory, identity, lock)
  const socketPath = socket.path
  const descriptor: BotHostDescriptor = {
    version: BOT_PROTOCOL_VERSION,
    pid: process.pid,
    hostId: "starting",
    socketPath,
    token,
    buildId: BOT_BUILD_ID
  }
  let store: BotStore | undefined, host: BotHost | undefined, server: BotRpcServer | undefined
  let memory: BotMemorySynthesis | undefined
  let skillCatalog: BotSkillCatalogSync | undefined
  let teach: BotTeachService | undefined
  let files: BotArtifacts | undefined
  let network: BotNetwork | undefined
  const nativeLifetime = new AbortController()
  const computer = new LocalBotComputerProvider(join(directory, "browser-profile"))
  let stopping: Promise<void> | undefined
  const cleanup = (releaseLock = true): Promise<void> => {
    // Every shutdown trigger joins the same physical cleanup. A second signal or
    // restart callback must not report success while the first still owns resources.
    stopping ??= (async () => {
      const deadline = setTimeout(() => process.exit(1), 10_000)
      deadline.unref()
      try {
        host?.storage?.close()
        // Start every abort synchronously. Awaiting a listener first would leave
        // model configuration readers and independent function sessions active.
        const background = closeBotHostBackgroundActivity(host, memory)
        nativeLifetime.abort(new Error("Bot Host is shutting down"))
        await host?.webhooks?.close()
        socket.assertCurrent()
        await server?.close()
        socket.close()
        const outcomes = await background
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason
        await skillCatalog?.close()
        await teach?.close()
        await host?.secretRequests?.vault.close()
        await computer.shutdown()
        await files?.close()
        await network?.close()
        store?.close()
        if (releaseLock) lock.release()
        clearTimeout(deadline)
      } catch (error) {
        // Keep the lifetime lock until process exit if a worker did not shut down cleanly.
        console.error(
          "[BotHost] Shutdown failed",
          error instanceof Error ? error.message : "unknown"
        )
        process.exit(1)
      }
    })()
    return stopping
  }
  try {
    network = await installBotNetwork()
    lock.publish(descriptor)
    // Current physical-resource evidence is outside every rollback scope.
    // A closed OS lock alone does not prove a crashed command stopped.
    await assertBotOwnedShellMaintenance(directory, ownedShellMaintenanceOwner(lock))
    await recoverClosedBotShellResources(directory, ownedShellMaintenanceOwner(lock))
    await recoverClosedNativeDesktopResources(directory, ownedShellMaintenanceOwner(lock))
    // The global computer journal owns all component replacements. Do not
    // initialize Store, browser, shared workspace or legacy journals early.
    await recoverBotComputerCheckpoint(directory, lock, { token })
    lock.assertCurrent()
    await recoverBotRestore(directory, undefined, () => lock.assertCurrent())
    lock.assertCurrent()
    repairLegacyComputerGeneration(directory, lock)
    lock.assertCurrent()
    const sharedWorkspace = await BotSharedWorkspace.open(directory)
    store = new BotStore(join(directory, "bots.sqlite"), undefined, undefined, sharedWorkspace.path)
    store.localTools.bind(createBotLocalToolAuthority(directory, lock))
    store.recoverAbandonedAtStartup()
    skillCatalog = new BotSkillCatalogSync(store, join(directory, "models.private"))
    skillCatalog.start()
    computer.persistence = store
    files = new BotArtifacts(join(directory, "objects"), store)
    await files.recover()
    store.browserDownloads.recoverAtStartup()
    const downloadStore = store,
      downloadFiles = files
    computer.humanDownloadReceiver = (botId, conversationId, threadRootId, taskRunId) =>
      botBrowserFileReceiver({
        botId,
        conversationId: conversationId ?? downloadStore.directConversation(botId).id,
        threadRootId,
        ...(taskRunId ? { taskRunId } : {}),
        store: downloadStore,
        files: downloadFiles
      })
    teach = new BotTeachService(join(directory, "teach"), store, computer)
    teach.recover()
    const nativeEnvironment = withInstalledBotNativeConfiguration(process.env)
    const shellFactory = await createBotHostShellFactory({
      directory,
      ...(process.platform === "linux" &&
      (nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY ||
        nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256 ||
        nativeEnvironment.CMB_BOT_DELEGATED_CGROUP_DIRECTORY)
        ? {
            linuxNative: {
              packageDirectory: nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY ?? "",
              manifestSha256: nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256 ?? "",
              delegatedCgroupDirectory: nativeEnvironment.CMB_BOT_DELEGATED_CGROUP_DIRECTORY ?? "",
              resourceLimits: {
                pids: nativeEnvironment.CMB_BOT_SHELL_PIDS_MAX
                  ? Number(nativeEnvironment.CMB_BOT_SHELL_PIDS_MAX)
                  : 512,
                memoryBytes: nativeEnvironment.CMB_BOT_SHELL_MEMORY_MAX_BYTES
                  ? Number(nativeEnvironment.CMB_BOT_SHELL_MEMORY_MAX_BYTES)
                  : 2 * 1024 * 1024 * 1024
              }
            }
          }
        : {}),
      ...(process.platform === "win32" &&
      (nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY ||
        nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256)
        ? {
            windowsNative: {
              packageDirectory: nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY ?? "",
              manifestSha256: nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256 ?? "",
              resourceLimits: {
                pids: nativeEnvironment.CMB_BOT_SHELL_PIDS_MAX
                  ? Number(nativeEnvironment.CMB_BOT_SHELL_PIDS_MAX)
                  : 512,
                memoryBytes: nativeEnvironment.CMB_BOT_SHELL_MEMORY_MAX_BYTES
                  ? Number(nativeEnvironment.CMB_BOT_SHELL_MEMORY_MAX_BYTES)
                  : 2 * 1024 * 1024 * 1024
              }
            }
          }
        : {}),
      helperEntry: join(__dirname, "bot-shell-owner.js"),
      workerEntry: join(__dirname, "bot-shell.js"),
      hostId: () => host!.id,
      dataEpoch: () => store!.dataEpoch(),
      assertOwnership: async (signal) => {
        signal.throwIfAborted()
        await lock.checkCurrent()
        host?.assertOwnership()
        signal.throwIfAborted()
      }
    })
    const runtime = new CmbBotRuntime(join(directory, "models.private"), computer, {
      shell: new BotShellProcess(shellFactory),
      sharedWorkspace,
      skillCatalog,
      files,
      teach,
      secretRequests: new BotSecretRequests(
        store,
        computer,
        new BotSecretVault(
          join(directory, "secrets.private"),
          store,
          process.platform === "darwin" && process.versions.electron
            ? new MacBotSecretProtection()
            : undefined
        )
      )
    })
    host = new BotHost(store, runtime, 4, computer, files, teach)
    host.bindPeerDispatchAdmission(
      createBotPeerDispatchAdmission(store, directory, ownedShellMaintenanceOwner(lock), () =>
        lock.assertCurrent()
      )
    )
    teach.bindFailureReporter((notice, error) => host!.reportFailure(notice, error))
    host.bindOwnership(lock, async () => {
      await cleanup()
      process.exit(1)
    })
    host.bindIdleRestartPreflight((signal) =>
      inspectBotOwnedShellMaintenance(directory, ownedShellMaintenanceOwner(lock), signal)
    )
    if (
      process.platform === "win32" &&
      nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY &&
      nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256
    ) {
      const nativeStore = store,
        nativeHost = host
      const controls = new NativeDesktopControlStore(nativeStore)
      let opening: ReturnType<typeof createWindowsNativeDesktopFactory> | undefined
      const assertOperational = () => {
        nativeLifetime.signal.throwIfAborted()
        lock.assertCurrent()
        nativeHost.assertComputerSupervision()
      }
      const native = new NativeDesktopBroker({
        hostId: nativeHost.id,
        dataEpoch: () => nativeStore.dataEpoch(),
        assertOperational,
        assertSupervision: () => nativeHost.assertComputerSupervision(),
        assertOwner: (botId, taskRunId) => {
          nativeStore.getBot(botId)
          if (taskRunId) throw new Error("工作应用尚未授予子任务，不能复用浏览器授权")
        },
        assertBotInput: (botId) => {
          if (computer.controlHeld(botId))
            throw new BotDomainError("computer_human_held", "请先归还 Bot 浏览器控制权")
        },
        loadHumanHeld: (botId, taskRunId) => controls.held(botId, taskRunId),
        saveHumanHeld: (botId, taskRunId, held) => controls.save(botId, taskRunId, held),
        launch: async (scope) => {
          assertOperational()
          opening ??= (async () =>
            createWindowsNativeDesktopFactory(
              {
                directory,
                bootstrap: await readBotOwnedShellArtifact(
                  join(__dirname, "bot-native-desktop-owner.js")
                ),
                getBot: (botId) => nativeStore.getBot(botId),
                sharedWorkspace,
                hostId: () => nativeHost.id,
                dataEpoch: () => nativeStore.dataEpoch(),
                protectedRoots: () => [directory],
                signal: nativeLifetime.signal,
                assertOperational,
                assertCurrentSync: () => {
                  lock.assertCurrent()
                  nativeHost.assertOwnership()
                },
                assertOwnership: async (signal) => {
                  signal.throwIfAborted()
                  await lock.checkCurrent()
                  nativeHost.assertOwnership()
                  signal.throwIfAborted()
                }
              },
              {
                packageDirectory: nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_DIRECTORY!,
                manifestSha256: nativeEnvironment.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256!,
                resourceLimits: {
                  pids: nativeEnvironment.CMB_BOT_SHELL_PIDS_MAX
                    ? Number(nativeEnvironment.CMB_BOT_SHELL_PIDS_MAX)
                    : 512,
                  memoryBytes: nativeEnvironment.CMB_BOT_SHELL_MEMORY_MAX_BYTES
                    ? Number(nativeEnvironment.CMB_BOT_SHELL_MEMORY_MAX_BYTES)
                    : 2 * 1024 * 1024 * 1024
                }
              }
            ))().catch((error) => {
            // Factory creation prepares trusted code/policy only. Actual Job
            // allocation occurs later in its returned per-surface launcher.
            opening = undefined
            throw new NativeDesktopNoAllocationError(error)
          })
          return (await opening)(scope)
        }
      })
      nativeHost.nativeComputer = native
      computer.bindOtherComputerGuard((botId, taskRunId) => {
        if (!taskRunId && native.controlHeld(botId))
          throw new BotDomainError("computer_human_held", "请先归还 Bot 工作应用控制权")
      })
      runtime.bindNativeComputer(native)
      teach.bindNativeSource(
        async () =>
          new NativeBotTeachSource(native, async () => (await computer.get()).teachEncoderPage())
      )
    }
    host.webhooks = new BotWebhookServer(
      store,
      () => host?.tick(),
      () => host!.assertOwnership()
    )
    host.backups = new BotBackupScheduler(store.backupSchedule, directory, host.id, undefined, () =>
      host!.assertOwnership()
    )
    host.backups.bindFailureReporter((notice, error) => host!.reportFailure(notice, error))
    const diskStore = store
    host.storage = new BotStorageMonitor(() => [
      { volume: "Bot 数据所在磁盘", path: directory },
      { volume: "共享工作目录所在磁盘", path: sharedWorkspace.path },
      ...[
        ...new Set(
          diskStore.listBots().flatMap((bot) => (bot.workspacePath ? [bot.workspacePath] : []))
        )
      ].map((path, index) => ({ volume: `项目所在磁盘 ${index + 1}`, path }))
    ])
    await host.webhooks.start()
    server = new BotRpcServer(host, token, async () => {
      await cleanup()
      process.exit(0)
    })
    socket.assertCurrent()
    await server.listen(socketPath)
    socket.assertCurrent()
    if (process.platform !== "win32") chmodSync(socketPath, 0o600)
    socket.assertCurrent()
    descriptor.hostId = host.id
    lock.publish(descriptor)
    host.start()
    host.backups.start()
    host.storage.start()
    memory = new BotMemorySynthesis(
      store,
      botMemoryModels(join(directory, "models.private"), store)
    )
    memory.bindFailureReporter((notice, error) => host!.reportFailure(notice, error))
    memory.start()
    console.info("[BotHost] Ready", { hostId: host.id, buildId: BOT_BUILD_ID })
    process.on("SIGTERM", () => {
      void cleanup().then(() => process.exit(0))
    })
    process.on("SIGINT", () => {
      void cleanup().then(() => process.exit(0))
    })
  } catch (error) {
    await cleanup(false)
    throw error
  }
}
