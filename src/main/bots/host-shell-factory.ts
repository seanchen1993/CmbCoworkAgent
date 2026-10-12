import { lazyBotNativeShellFactory } from "./native-shell-factory-lazy"
import {
  createWindowsBotHostShellFactory,
  type WindowsBotShellConfiguration
} from "./windows-host-shell-factory"
import {
  createLinuxBotHostShellFactory,
  type LinuxBotShellConfiguration
} from "./linux-host-shell-factory"
import { isAbsolute } from "node:path"
import { BotDomainError } from "../../shared/bot-types"
import { resolvePhysicalBotProcessArtifact } from "./physical-process-entry"
import type { BotShellOwnedFactory } from "./shell-process"

export interface BotHostShellBinding {
  directory: string
  helperEntry: string
  workerEntry: string
  hostId(): string
  dataEpoch(): string
  assertOwnership(signal: AbortSignal): Promise<void>
  /** Native-backed non-Mac preparation is injected by its actual Host package;
   * no model-config 'none' or platform guess is an isolation capability. */
  windowsNative?: WindowsBotShellConfiguration
  linuxNative?: LinuxBotShellConfiguration
  platformFactory?: BotShellOwnedFactory
}
export async function readBotOwnedShellArtifact(
  entry: string
): Promise<{ entry: string; sha256: string }> {
  if (!isAbsolute(entry)) throw new Error("Bot 命令构建入口必须为绝对路径")
  return resolvePhysicalBotProcessArtifact(entry)
}
/** A Host-only factory; native authority never enters RPC/model tool arguments.
 * macOS production has no proven native command-lifetime isolation backend.
 * Preserve browser/files/takeover without preparing or spawning a command. */
export async function createBotHostShellFactory(
  binding: BotHostShellBinding
): Promise<BotShellOwnedFactory> {
  if (process.platform === "darwin") {
    const unavailableReason = "当前 Mac 后台不提供系统命令执行；可使用工作浏览器、文件和人工接管。"
    return Object.freeze(
      Object.assign(
        async (
          _request: Parameters<BotShellOwnedFactory>[0],
          signal: AbortSignal
        ): Promise<never> => {
          signal.throwIfAborted()
          throw new BotDomainError("shell_unavailable", unavailableReason)
        },
        { unavailableReason }
      )
    )
  }
  const windowsNative = binding.windowsNative
  if (process.platform === "win32" && windowsNative)
    return lazyBotNativeShellFactory(
      async (signal) =>
        createWindowsBotHostShellFactory(binding, windowsNative, {
          helper: await readBotOwnedShellArtifact(binding.helperEntry),
          worker: await readBotOwnedShellArtifact(binding.workerEntry),
          signal
        }),
      binding.assertOwnership
    )
  const linuxNative = binding.linuxNative
  if (process.platform === "linux" && linuxNative)
    return lazyBotNativeShellFactory(
      async (signal) =>
        createLinuxBotHostShellFactory(binding, linuxNative, {
          helper: await readBotOwnedShellArtifact(binding.helperEntry),
          worker: await readBotOwnedShellArtifact(binding.workerEntry),
          signal
        }),
      binding.assertOwnership
    )
  return async (request, signal) => {
    signal.throwIfAborted()
    await binding.assertOwnership(signal)
    if (!binding.platformFactory) throw new Error("本机 Bot 原生命令隔离组件未通过核验，未运行命令")
    return binding.platformFactory(request, signal)
  }
}
