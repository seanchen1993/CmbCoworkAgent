import { existsSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { BrowserWindow } from "electron"
import { spawnJdtls, checkJdtlsAvailable, getVsixStatus } from "./server"
import { buildGlobalRuntimeContext, buildProjectRuntimeContext } from "./runtimes"
import { LspClient } from "./client"
import { getLspConfig, saveLspConfig } from "../storage"
import type {
  LspDiagnostic, LspLocation, LspHoverResult, LspSymbol,
  LspCallHierarchyItem, LspCallHierarchyIncomingCall, LspCallHierarchyOutgoingCall,
  LspLifecycleState, LspServerState, LspStatus
} from "../types"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_RESTARTS = 3
const RESTART_COOLDOWN = 5_000 // 5s between restarts
const CRASH_RESET_WINDOW = 60_000 // crashes outside this window reset count

// --- State ---

interface ServerEntry {
  client: LspClient
  state: LspServerState
}

interface CrashRecord {
  count: number
  lastTime: number
}

interface StartupStatusSnapshot {
  serviceReady: boolean
  serviceReadyTimedOut: boolean
  projectReady: boolean
  projectReadyTimedOut: boolean
  projectStatus: string | null
  languageStatusType: string | null
  languageStatusMessage: string | null
}

const servers = new Map<string, ServerEntry>()
const broken = new Set<string>() // projectRoots that failed spawn/init
const spawning = new Map<string, Promise<void>>() // in-flight spawn dedup
// Crash counts keyed by projectRoot — survives entry replacement during restart
const crashCounts = new Map<string, CrashRecord>()

// --- Broadcast ---

function broadcastDiagnostics(diagnostics: LspDiagnostic[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("lsp:diagnostics", diagnostics)
  }
}

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("lsp:changed")
  }
}

// --- Crash recovery ---

function setupCrashRecovery(projectRoot: string, entry: ServerEntry): void {
  const proc = entry.client["process"] // access ChildProcess
  if (!proc) return

  proc.once("exit", (code: number | null, signal: string | null) => {
    // Only handle unexpected exits (not our own shutdown)
    if (entry.state !== "running") return

    console.warn(`[LSP] JDTLS crashed for ${projectRoot} (code=${code}, signal=${signal})`)
    entry.state = "error"

    // Crash count lives in projectRoot-keyed Map, survives entry replacement
    const record = crashCounts.get(projectRoot) ?? { count: 0, lastTime: 0 }
    const now = Date.now()
    if (now - record.lastTime > CRASH_RESET_WINDOW) {
      // Last crash was outside the reset window — start fresh
      record.count = 0
    }
    record.count++
    record.lastTime = now
    crashCounts.set(projectRoot, record)

    if (record.count > MAX_RESTARTS) {
      console.error(`[LSP] Max restarts (${MAX_RESTARTS}) exceeded for ${projectRoot}, marking broken`)
      broken.add(projectRoot)
      servers.delete(projectRoot)
      broadcastChanged()
      return
    }

    console.log(`[LSP] Restarting JDTLS for ${projectRoot} (attempt ${record.count}/${MAX_RESTARTS})...`)
    servers.delete(projectRoot)
    broadcastChanged()

    setTimeout(() => {
      startLsp(projectRoot).catch((e) => {
        console.error(`[LSP] Restart failed for ${projectRoot}:`, e)
        broken.add(projectRoot)
        broadcastChanged()
      })
    }, RESTART_COOLDOWN)
  })
}

// --- Lifecycle ---

export async function startLsp(projectRoot: string): Promise<void> {
  // Spawn dedup: if another caller is already starting this server, wait for it
  const inflight = spawning.get(projectRoot)
  if (inflight) {
    return inflight
  }

  // Already running
  const existing = servers.get(projectRoot)
  if (existing?.state === "running") {
    console.log("[LSP] Already running for:", projectRoot)
    return
  }
  if (existing?.state === "starting") {
    console.log("[LSP] Already starting for:", projectRoot)
    return
  }

  // Broken — don't retry
  if (broken.has(projectRoot)) {
    throw new Error(`LSP server for ${projectRoot} is broken (too many failures). Restart the app to retry.`)
  }

  const task = doStartLsp(projectRoot)
  spawning.set(projectRoot, task)
  task.finally(() => {
    if (spawning.get(projectRoot) === task) {
      spawning.delete(projectRoot)
    }
  })
  return task
}

async function doStartLsp(projectRoot: string): Promise<void> {
  const check = checkJdtlsAvailable()
  if (!check.available) {
    const errMsg = check.error ?? "JDTLS not available"
    saveLspConfig({ lastError: errMsg })
    broadcastChanged()
    throw new Error(errMsg)
  }

  const config = getLspConfig()
  const maxHeapMb = config.maxHeapMb || 1024
  const runtimeContext = buildProjectRuntimeContext(projectRoot, config)
  if (!runtimeContext.selectedRuntime) {
    const errMsg = "未探测到可用 JDK，请先在 LSP 配置中设置有效的 JDK Home"
    saveLspConfig({ lastError: errMsg })
    broadcastChanged()
    throw new Error(errMsg)
  }

  // Track state as "starting"
  const entry: ServerEntry = {
    client: null as unknown as LspClient,
    state: "starting"
  }
  let client: LspClient | null = null

  try {
    const child = spawnJdtls({ projectRoot, maxHeapMb })
    client = new LspClient(child, projectRoot, {
      projectRuntimes: runtimeContext.settingsRuntimes
    })

    entry.client = client
    servers.set(projectRoot, entry)
    broadcastChanged()

    client.setDiagnosticsCallback((diags) => {
      broadcastDiagnostics(diags)
    })
    client.setStartupStatusCallback(() => {
      const current = servers.get(projectRoot)
      if (current?.client === client) {
        broadcastChanged()
      }
    })

    await client.initialize()

    entry.state = "running"
    saveLspConfig({ lastError: null })
    broadcastChanged()
    console.log("[LSP] Started for:", projectRoot)

    // Watch for unexpected crashes
    setupCrashRecovery(projectRoot, entry)
  } catch (e) {
    entry.state = "error"
    servers.delete(projectRoot)
    if (client) {
      client.setDiagnosticsCallback(null)
      client.setStartupStatusCallback(null)
      try {
        await client.shutdown()
      } catch (shutdownError) {
        console.warn(`[LSP] Error cleaning up failed startup for ${projectRoot}:`, shutdownError)
      }
    }
    const errMsg = e instanceof Error ? e.message : String(e)
    saveLspConfig({ lastError: errMsg })
    broadcastChanged()
    throw e
  }
}

export async function stopLsp(projectRoot: string): Promise<void> {
  const entry = servers.get(projectRoot)
  if (!entry) return

  entry.state = "stopped" // prevent crash recovery from firing
  try {
    await entry.client.shutdown()
  } catch (e) {
    console.warn("[LSP] Error during shutdown:", e)
  } finally {
    servers.delete(projectRoot)
    broadcastChanged()
  }
}

export async function stopAllLsp(): Promise<void> {
  const shutdowns = Array.from(servers.entries()).map(async ([root, entry]) => {
    entry.state = "stopped"
    try {
      await entry.client.shutdown()
    } catch (e) {
      console.warn(`[LSP] Error shutting down for ${root}:`, e)
    }
  })
  await Promise.all(shutdowns)
  servers.clear()
}

export function isLspRunning(projectRoot: string): boolean {
  const entry = servers.get(projectRoot)
  return entry?.state === "running"
}

export function getLspState(projectRoot: string): LspServerState | null {
  return servers.get(projectRoot)?.state ?? null
}

export function getClient(projectRoot: string): LspClient | null {
  const entry = servers.get(projectRoot)
  return entry?.state === "running" ? entry.client : null
}

export function getLspStatus(projectRoot: string | null): LspStatus {
  const config = getLspConfig()
  const vsixStatus = getVsixStatus()
  const runtimeContext = projectRoot
    ? buildProjectRuntimeContext(projectRoot, config)
    : buildGlobalRuntimeContext(config)

  const entry = projectRoot ? (servers.get(projectRoot) ?? null) : null
  const startupStatus: StartupStatusSnapshot = entry?.client.getStartupStatus() ?? {
    serviceReady: false,
    serviceReadyTimedOut: false,
    projectReady: false,
    projectReadyTimedOut: false,
    projectStatus: null,
    languageStatusType: null,
    languageStatusMessage: null
  }

  const serviceConfirmed = startupStatus.serviceReady || startupStatus.languageStatusType === "ServiceReady"
  const projectImported = startupStatus.projectReady || startupStatus.projectStatus === "OK"

  let degradedReason: string | null = null
  if (runtimeContext.missingRuntime) {
    degradedReason = `当前项目要求 ${runtimeContext.missingRuntime}，但没有对应的可用 JDK 路径`
  } else if (projectImported) {
    degradedReason = null
  } else if (startupStatus.projectStatus === "WARNING") {
    degradedReason = "当前项目存在构建或类路径告警，LSP 可能只有部分语义能力可用"
  } else if (startupStatus.projectStatus && startupStatus.projectStatus !== "OK" && startupStatus.projectStatus !== "WARNING") {
    degradedReason = `JDTLS 项目状态为 ${startupStatus.projectStatus}`
  } else if (startupStatus.projectReadyTimedOut) {
    degradedReason = "项目导入在超时前未完成，LSP 可能只有部分语义能力可用"
  } else if (!serviceConfirmed && startupStatus.serviceReadyTimedOut) {
    degradedReason = "LSP 服务未在超时前确认就绪"
  }

  const serverState = entry?.state ?? "stopped"
  const progressMessage = formatProgressMessage(startupStatus)
  const lifecycle = resolveLifecycle(serverState, startupStatus, degradedReason)
  const statusText = resolveStatusText(lifecycle)
  const projectStatusText = resolveProjectStatusText(lifecycle, startupStatus, progressMessage)

  return {
    projectRoot,
    state: serverState,
    lifecycle,
    statusText,
    projectStatusText,
    progressMessage,
    vsixAvailable: vsixStatus.available,
    vsixSource: vsixStatus.source,
    vsixPath: vsixStatus.path,
    serviceReady: startupStatus.serviceReady,
    serviceReadyTimedOut: startupStatus.serviceReadyTimedOut,
    projectReady: startupStatus.projectReady,
    projectReadyTimedOut: startupStatus.projectReadyTimedOut,
    projectStatus: startupStatus.projectStatus,
    projectRequirement: runtimeContext.projectRequirement,
    runtimes: runtimeContext.runtimes,
    selectedRuntime: runtimeContext.selectedRuntime,
    manualJavaHomeStatus: runtimeContext.manualJavaHomeStatus,
    missingRuntime: runtimeContext.missingRuntime,
    degradedReason,
    warningReason: null
  }
}

function formatProgressMessage(startupStatus: StartupStatusSnapshot): string | null {
  const type = startupStatus.languageStatusType
  const message = startupStatus.languageStatusMessage?.trim() || null
  if (!message) return null
  if (type === "ServiceReady" && message === "ServiceReady") return "Java Language Server 已就绪"
  if (type === "ProjectStatus") {
    return message === "OK" ? "项目导入完成" : `项目状态: ${message}`
  }
  return message
}

function resolveLifecycle(
  serverState: LspServerState,
  startupStatus: StartupStatusSnapshot,
  degradedReason: string | null
): LspLifecycleState {
  if (serverState === "error") return "error"
  if (serverState === "stopped") return "stopped"
  if (serverState === "starting") {
    return startupStatus.serviceReady ? "importing" : "starting"
  }
  if (degradedReason) return "degraded"
  if (startupStatus.serviceReady && !startupStatus.projectReady && !startupStatus.projectReadyTimedOut) {
    return "importing"
  }
  return "ready"
}

function resolveStatusText(lifecycle: LspLifecycleState): string {
  switch (lifecycle) {
    case "starting":
      return "启动中..."
    case "importing":
      return "项目导入中..."
    case "ready":
      return "运行中"
    case "degraded":
      return "运行中（部分可用）"
    case "error":
      return "启动失败"
    case "stopped":
    default:
      return "已停止"
  }
}

function resolveProjectStatusText(
  lifecycle: LspLifecycleState,
  startupStatus: StartupStatusSnapshot,
  progressMessage: string | null
): string {
  if (startupStatus.projectStatus === "OK" || startupStatus.projectReady) {
    return "OK"
  }
  if (startupStatus.projectStatus && startupStatus.projectStatus !== "OK") {
    return startupStatus.projectStatus
  }

  switch (lifecycle) {
    case "starting":
      return progressMessage ?? "正在启动 Java Language Server"
    case "importing":
      return progressMessage ?? "正在导入项目"
    case "degraded":
      if (startupStatus.projectReadyTimedOut) return "导入超时，可能仅部分可用"
      if (startupStatus.serviceReadyTimedOut) return "服务就绪确认超时"
      return progressMessage ?? "部分可用"
    case "error":
      return "启动失败"
    case "ready":
      return "OK"
    case "stopped":
    default:
      return "未启动"
  }
}

// --- File helpers ---

async function ensureFileOpen(client: LspClient, filePath: string): Promise<void> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  const stat = statSync(filePath)
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(
      `File too large for LSP: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 10 MB)`
    )
  }
  const content = readFileSync(filePath, "utf-8")
  await client.openFile(filePath, content)
}

// --- High-level operations ---

export async function lspDefinition(projectRoot: string, filePath: string, line: number, column: number): Promise<LspLocation[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.definition(filePath, line, column)
}

export async function lspReferences(projectRoot: string, filePath: string, line: number, column: number): Promise<LspLocation[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.references(filePath, line, column)
}

export async function lspHover(projectRoot: string, filePath: string, line: number, column: number): Promise<LspHoverResult | null> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.hover(filePath, line, column)
}

export async function lspImplementation(projectRoot: string, filePath: string, line: number, column: number): Promise<LspLocation[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.implementation(filePath, line, column)
}

export async function lspDocumentSymbols(projectRoot: string, filePath: string): Promise<LspSymbol[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.documentSymbols(filePath)
}

export async function lspWorkspaceSymbol(projectRoot: string, query: string): Promise<LspSymbol[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  return client.workspaceSymbol(query)
}

export function lspDiagnostics(projectRoot: string, filePath?: string): LspDiagnostic[] {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  return client.getDiagnostics(filePath)
}

export async function lspPrepareCallHierarchy(projectRoot: string, filePath: string, line: number, column: number): Promise<LspCallHierarchyItem[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.prepareCallHierarchy(filePath, line, column)
}

export async function lspIncomingCalls(projectRoot: string, filePath: string, line: number, column: number): Promise<LspCallHierarchyIncomingCall[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.incomingCalls(filePath, line, column)
}

export async function lspOutgoingCalls(projectRoot: string, filePath: string, line: number, column: number): Promise<LspCallHierarchyOutgoingCall[]> {
  const client = getClient(projectRoot)
  if (!client) throw new Error("LSP not running. Start it first.")
  await ensureFileOpen(client, filePath)
  return client.outgoingCalls(filePath, line, column)
}

/** Detect if a directory is a Java project */
export function detectJavaProject(dirPath: string): boolean {
  const markers = ["pom.xml", "build.gradle", "build.gradle.kts", ".classpath"]
  return markers.some((m) => existsSync(join(dirPath, m)))
}
