import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { BotTransportClient, type BotHostDescriptor } from "./transport-client"
import { syncDesktopBotModels } from "./desktop-model-sync"
import { botHostStartupEnvironment } from "./host-startup-environment"
import { requestBotHostUpgrade } from "./host-upgrade"
import { BotHostLock } from "./host-lock"
import type { BotHostStatus } from "../../shared/bot-api"
import { BotDomainError } from "../../shared/bot-types"
import { ComputerMaintenanceSupervision } from "./computer-maintenance-supervision"
import { readVerifiedComputerStartupProgress } from "./computer-startup-progress"
import { inspectDesktopBotShellResources } from "./desktop-owned-shell-maintenance"
import { BotShellMaintenanceBlocked } from "./owned-shell-maintenance-fence"

let client: BotTransportClient | undefined
let connecting: Promise<BotTransportClient> | undefined
let launchFailure: { error: unknown; attempts: number; retryAt: number } | undefined
let maintenance: string | undefined
interface DesktopBotMaintenanceParticipant {
  drain(): Promise<void>
  end(): void
}
let maintenanceParticipant: DesktopBotMaintenanceParticipant | undefined

export function registerDesktopBotMaintenanceParticipant(
  participant: DesktopBotMaintenanceParticipant
): () => void {
  if (maintenanceParticipant && maintenanceParticipant !== participant)
    throw new Error("Bot 维护参与者已注册")
  maintenanceParticipant = participant
  return () => {
    if (maintenanceParticipant === participant) maintenanceParticipant = undefined
  }
}
export function assertDesktopBotConnectionAvailable(): void {
  if (maintenance) throw new BotDomainError("host_maintenance", maintenance)
}

const startupTimeoutMs = 30_000
const probeTimeoutMs = 3000

function readHostDescriptor(path: string): BotHostDescriptor | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BotHostDescriptor
  } catch (error) {
    // The lock owner removes this file on exit. An existence check followed by
    // a read races that normal shutdown, especially during offline maintenance.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** Only bound connection probes, never an already submitted domain operation. */
async function probeWithin<T>(
  candidate: BotTransportClient,
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (timeoutMs <= 0) throw new Error("Bot 后台连接超时")
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          candidate.close()
          reject(new Error("Bot 后台连接超时"))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The desktop only launches/connects; it never writes the Host database or owns its timers. */
export async function getDesktopBotClient(): Promise<BotTransportClient> {
  assertDesktopBotConnectionAvailable()
  connecting ??= getOrConnect()
    .then((connected) => {
      launchFailure = undefined
      return connected
    })
    .catch((error: unknown) => {
      // Snapshot polling must not start a new heavy Host every second after a
      // persistent startup failure. A cached rejection does not extend the wait.
      if (!launchFailure || error !== launchFailure.error) {
        const attempts = Math.min(5, (launchFailure?.attempts ?? 0) + 1)
        launchFailure = {
          error,
          attempts,
          retryAt: performance.now() + Math.min(60_000, 5000 * 2 ** (attempts - 1))
        }
      }
      throw error
    })
    .finally(() => {
      connecting = undefined
    })
  return connecting
}

/** Do not queue renderer writes across a restore; their original data may no longer exist. */
export async function withDesktopBotMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  return runDesktopBotMaintenance(operation, "Bot 数据正在备份或恢复，请稍后重试")
}

/** User-requested restart shares the same idle admission and shutdown handshake
 * as maintenance. A stale window must not restart a replacement Host. */
export async function restartDesktopBotHost(hostId: string): Promise<BotHostStatus> {
  await runDesktopBotMaintenance(async () => {}, "Bot 后台正在重启，请稍后重试", false, hostId)
  return (await getDesktopBotClient()).call("status")
}

/** Keep both desktop admission and the cross-process lifetime lock until exit.
 * A successful installer launch is a handoff, not the end of maintenance.
 */
export async function withDesktopBotUpdate(operation: () => Promise<void>): Promise<void> {
  await runDesktopBotMaintenance(
    async () => {
      const directory = join(getCmbCoworkAgentDataRoot(), "bot-host")
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const lock = BotHostLock.acquire(directory)
      if (!lock) throw new Error("Bot 后台仍在运行，未开始安装；请稍后重试")
      const release = () => lock.release()
      process.once("exit", release)
      try {
        await operation()
      } catch (error) {
        process.off("exit", release)
        release()
        throw error
      }
    },
    "应用正在安装更新，Bot 将在重启后恢复",
    true
  )
}

async function runDesktopBotMaintenance<T>(
  operation: () => Promise<T>,
  reason: string,
  retainOnSuccess = false,
  expectedHostId?: string
): Promise<T> {
  if (maintenance) throw new Error(maintenance)
  maintenance = reason
  const participant = maintenanceParticipant
  let succeeded = false
  let temporary: BotTransportClient | undefined
  const perform = async () => {
    const value = await operation()
    succeeded = true
    launchFailure = undefined
    return value
  }
  try {
    await participant?.drain()
    // Never start a damaged database just to restore it. A competing Host is
    // still excluded by the maintenance process's lifetime lock.
    await connecting?.catch(() => {})
    const descriptor = join(getCmbCoworkAgentDataRoot(), "bot-host", "host.json")
    let current = client
    if (!current) {
      try {
        const value = readHostDescriptor(descriptor)
        if (value && value.hostId !== "starting") {
          temporary = current = new BotTransportClient(value)
        }
      } catch {
        /* The process lock, never this descriptor, decides ownership. */
      }
    }
    if (!current) {
      if (expectedHostId)
        throw new BotDomainError("host_unavailable", "无法确认 Bot 后台状态，请重新连接后重试")
      return await perform()
    }
    const candidate = current
    let status
    try {
      status = await probeWithin(candidate, () => candidate.call("status"), probeTimeoutMs)
    } catch {
      current.close()
      client = undefined
      if (expectedHostId)
        throw new BotDomainError("host_unavailable", "无法确认 Bot 后台状态，请重新连接后重试")
      return await perform()
    }
    if (expectedHostId && status.hostId !== expectedHostId)
      throw new BotDomainError("host_changed", "Bot 后台已更新，请刷新状态后重试")
    // A known resource block must not strand an otherwise usable Host. This
    // observer read can only reject; ready still requires the original idle
    // handshake and the offline owner's exclusive physical-resource fence.
    const { review } = await inspectDesktopBotShellResources(
      join(getCmbCoworkAgentDataRoot(), "bot-host")
    )
    if (review.state === "requires_review") throw new BotShellMaintenanceBlocked(review)
    const result = await probeWithin(
      candidate,
      () => candidate.restartIfIdle(status.hostId),
      probeTimeoutMs
    )
    if (!result.accepted)
      throw new BotDomainError("host_busy", result.reason || "请先完成或停止当前 Bot 任务")
    current.close()
    client = undefined
    for (let attempt = 0; attempt < 120; attempt++) {
      const latest = readHostDescriptor(descriptor)
      if (!latest) return await perform()
      if (latest.hostId !== status.hostId) throw new Error("其他窗口已启动 Bot 后台，请稍后重试")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Bot 后台尚未退出，未执行维护操作，请稍后重试")
  } finally {
    temporary?.close()
    if (!retainOnSuccess || !succeeded) {
      maintenance = undefined
      participant?.end()
    }
  }
}

async function getOrConnect(): Promise<BotTransportClient> {
  await syncDesktopBotModels(join(getCmbCoworkAgentDataRoot(), "bot-host"))
  if (client) {
    try {
      if (await acceptCurrentClient(client, await client.call("status"))) return client
    } catch {
      client.close()
    }
    client = undefined
  }
  return connectOrLaunch()
}

async function acceptCurrentClient(
  candidate: BotTransportClient,
  status: BotHostStatus,
  deadline = performance.now() + startupTimeoutMs
): Promise<boolean> {
  if (
    !(await requestBotHostUpgrade(candidate, status, undefined, {
      negativePreflight: async () => {
        const { review } = await inspectDesktopBotShellResources(
          join(getCmbCoworkAgentDataRoot(), "bot-host")
        )
        if (review.state === "requires_review") return `${review.title}：${review.hint}`
        return performance.now() >= deadline
          ? "核对期间连接时限已过，请保留当前后台并稍后重试"
          : null
      },
      restartIfIdle: (hostId) => {
        // The async negative reader may return just before this continuation
        // crosses the deadline. Without a submitted RPC, keep the usable client.
        const remaining = deadline - performance.now()
        if (remaining <= 0)
          return Promise.resolve({
            accepted: false,
            reason: "核对期间连接时限已过，请保留当前后台并稍后重试"
          })
        return probeWithin(candidate, () => candidate.restartIfIdle(hostId), remaining)
      }
    }))
  )
    return true
  candidate.close()
  // Wait for the old lifetime-lock owner to remove/replace its descriptor before launching.
  const descriptorPath = join(getCmbCoworkAgentDataRoot(), "bot-host", "host.json")
  const until = Math.min(deadline, performance.now() + 12_000)
  while (performance.now() < until) {
    const current = readHostDescriptor(descriptorPath)
    if (!current) return false
    if (current.hostId !== status.hostId) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("旧 Bot 后台尚未退出，请稍后重试")
}

async function connectOrLaunch(): Promise<BotTransportClient> {
  // A fixed attempt count incorrectly reports a slow module load/migration as
  // failure, and does not bound a stale descriptor whose socket stops replying.
  let deadline = performance.now() + startupTimeoutMs
  const recovering = new ComputerMaintenanceSupervision()
  let nextRecoveryProbe = 0
  const directory = join(getCmbCoworkAgentDataRoot(), "bot-host")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const descriptorPath = join(directory, "host.json")
  const tryConnect = async (): Promise<BotTransportClient | undefined> => {
    const descriptor = readHostDescriptor(descriptorPath)
    if (!descriptor || descriptor.hostId === "starting") return undefined
    const candidate = new BotTransportClient(descriptor)
    try {
      const status = await probeWithin(
        candidate,
        () => candidate.call("status"),
        Math.min(probeTimeoutMs, deadline - performance.now())
      )
      if (status.hostId !== descriptor.hostId) throw new Error("Bot Host identity mismatch")
      if (!(await acceptCurrentClient(candidate, status, deadline))) return undefined
      client = candidate
      return candidate
    } catch {
      candidate.close()
      return undefined
    }
  }
  const existing = await tryConnect().catch(() => undefined)
  if (existing) return existing
  // Always probe an existing authenticated owner first: a slow/other launcher
  // can become ready during backoff. Only creating a new process is deferred.
  if (launchFailure && performance.now() < launchFailure.retryAt) throw launchFailure.error
  if (performance.now() >= deadline) throw new Error("Bot 后台连接超时，请稍后重试")
  const entry = join(__dirname, "bot-host.js")
  if (!existsSync(entry)) throw new Error("Bot 后台构建产物缺失，请先构建应用")
  const env: NodeJS.ProcessEnv = {
    ...botHostStartupEnvironment(process.env),
    ELECTRON_RUN_AS_NODE: "1"
  }
  // The lock-owning Host writes and rotates its own private log. No inherited
  // descriptor pins a renamed file or depends on the desktop remaining alive.
  const child = spawn(process.execPath, [entry, "--data-dir", directory], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env
  })
  let failed = false
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    // A concurrent launcher can lose the lifetime lock and exit successfully;
    // keep waiting for the actual owner rather than treating that as a crash.
    failed = code !== 0 || signal !== null
  }
  const onError = () => {
    failed = true
  }
  child.once("exit", onExit)
  child.on("error", onError)
  try {
    await new Promise<void>((resolve, reject) => {
      const spawned = () => {
        child.off("error", rejected)
        resolve()
      }
      const rejected = () => {
        child.off("spawn", spawned)
        reject(new Error("Bot 后台启动失败，请检查应用安装是否完整"))
      }
      child.once("spawn", spawned)
      child.once("error", rejected)
    })
    child.unref()
    while (performance.now() < deadline) {
      const connected = await tryConnect().catch(() => undefined)
      if (connected) return connected
      if (performance.now() >= nextRecoveryProbe) {
        nextRecoveryProbe = performance.now() + 1000
        const progress = await readVerifiedComputerStartupProgress(
          directory,
          readHostDescriptor(descriptorPath)
        )
        if (progress) recovering.accept(progress)
        if (progress && recovering.alive()) deadline = Math.max(deadline, performance.now() + 2000)
      }
      if (failed && !recovering.alive())
        throw new Error("Bot 后台启动失败；详情见 bot-host/host.log")
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now())))
      )
    }
    throw new Error("Bot 后台连接超时，可能仍在启动，请稍后重试；详情见 bot-host/host.log")
  } finally {
    child.off("exit", onExit)
    child.off("error", onError)
  }
}
