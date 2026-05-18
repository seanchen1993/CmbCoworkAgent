import { ChildProcess } from "child_process"
import { fileURLToPath, pathToFileURL } from "url"
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  MessageConnection,
  RequestType,
  RequestType0,
  NotificationType,
  NotificationType0
} from "vscode-jsonrpc/node"
import type {
  LspDiagnostic, LspLocation, LspHoverResult, LspSymbol,
  LspCallHierarchyItem, LspCallHierarchyIncomingCall, LspCallHierarchyOutgoingCall, LspJavaRuntimeName
} from "../types"

// LSP protocol types (subset)
interface InitializeParams {
  processId: number | null
  rootUri: string
  capabilities: Record<string, unknown>
  initializationOptions?: Record<string, unknown>
}

interface Position {
  line: number
  character: number
}

interface Range {
  start: Position
  end: Position
}

interface Location {
  uri: string
  range: Range
}

interface TextDocumentIdentifier {
  uri: string
}

interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier
  position: Position
}

interface DidOpenTextDocumentParams {
  textDocument: {
    uri: string
    languageId: string
    version: number
    text: string
  }
}

interface PublishDiagnosticsParams {
  uri: string
  diagnostics: Array<{
    range: Range
    severity?: number
    message: string
    source?: string
  }>
}

interface SymbolInformation {
  name: string
  kind: number
  location: Location
  containerName?: string
}

interface DocumentSymbol {
  name: string
  kind: number
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
}

interface Hover {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>
  range?: Range
}

interface CallHierarchyItem {
  name: string
  kind: number
  tags?: number[]
  detail?: string
  uri: string
  range: Range
  selectionRange: Range
  data?: unknown
}

interface CallHierarchyIncomingCall {
  from: CallHierarchyItem
  fromRanges: Range[]
}

interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem
  fromRanges: Range[]
}

// Symbol kind map
const SYMBOL_KIND_MAP: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter"
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const RETRY_DELAYS = [500, 1000, 2000]
const CONTENT_MODIFIED_CODE = -32801
const DIAGNOSTICS_DEBOUNCE_MS = 150

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

function pathToUri(filePath: string): string {
  if (filePath.startsWith("file://")) return filePath
  return pathToFileURL(filePath).href
}

function convertLocation(loc: Location): LspLocation {
  return {
    file: uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    column: loc.range.start.character + 1,
    endLine: loc.range.end.line + 1,
    endColumn: loc.range.end.character + 1
  }
}

function convertRange(range: Range): { startLine: number; startColumn: number; endLine: number; endColumn: number } {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

function convertCallHierarchyItem(item: CallHierarchyItem): LspCallHierarchyItem {
  return {
    name: item.name,
    kind: SYMBOL_KIND_MAP[item.kind] ?? `Kind(${item.kind})`,
    detail: item.detail,
    file: uriToPath(item.uri),
    range: convertRange(item.range),
    selectionRange: convertRange(item.selectionRange)
  }
}

function severityToString(severity?: number): LspDiagnostic["severity"] {
  switch (severity) {
    case 1: return "error"
    case 2: return "warning"
    case 3: return "info"
    case 4: return "hint"
    default: return "warning"
  }
}

function extractHoverContent(contents: Hover["contents"]): string {
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) {
    return contents.map((c) => typeof c === "string" ? c : c.value).join("\n\n")
  }
  if (typeof contents === "object" && "value" in contents) return contents.value
  return String(contents)
}

const TERMINAL_PROJECT_STATUSES = new Set(["OK", "WARNING", "ERROR"])

function isTerminalProjectStatus(message: string | null): boolean {
  return message !== null && TERMINAL_PROJECT_STATUSES.has(message)
}

export type DiagnosticsCallback = (diagnostics: LspDiagnostic[]) => void
export type StartupStatusChangeCallback = () => void

const INIT_TIMEOUT = 45_000
const SERVICE_READY_TIMEOUT = 60_000
const PROJECT_READY_TIMEOUT = 20_000
const HOVER_MAX_RETRIES = 5
const HOVER_RETRY_DELAY = 50
const SHUTDOWN_REQUEST = new RequestType0<unknown, unknown>("shutdown")
const EXIT_NOTIFICATION = new NotificationType0("exit")

interface ProjectRuntimeSetting {
  name: LspJavaRuntimeName
  path: string
  default?: boolean
}

export class LspClient {
  private connection: MessageConnection
  private process: ChildProcess
  private projectRoot: string
  private projectRuntimes: ProjectRuntimeSetting[]
  private initialized = false
  /** Map of file URI → version. File stays "open" for the LSP session lifetime. */
  private openFiles = new Map<string, number>()
  private diagnosticsMap = new Map<string, LspDiagnostic[]>()
  private onDiagnosticsChange: DiagnosticsCallback | null = null
  private diagnosticsDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private callHierarchyCache = new Map<string, CallHierarchyItem[]>()
  private serviceReadyResolve: (() => void) | null = null
  private serviceReadyPromise: Promise<void>
  private projectReadyResolve: (() => void) | null = null
  private projectImportCompletePromise: Promise<void>
  private initSettings: Record<string, unknown> | null = null
  private onStartupStatusChange: StartupStatusChangeCallback | null = null
  private lastLanguageStatusType: string | null = null
  private lastLanguageStatusMessage: string | null = null
  private startupStatusSnapshot = ""
  private serviceReady = false
  private serviceReadyTimedOut = false
  private projectReady = false
  private projectReadyTimedOut = false
  private projectStatus: string | null = null

  constructor(
    childProcess: ChildProcess,
    projectRoot: string,
    options?: {
      projectRuntimes?: ProjectRuntimeSetting[]
    }
  ) {
    this.process = childProcess
    this.projectRoot = projectRoot
    this.projectRuntimes = options?.projectRuntimes ?? []

    // Early failure detection: check if process is already dead
    if (childProcess.exitCode !== null) {
      throw new Error(`JDTLS process terminated immediately with exit code ${childProcess.exitCode}`)
    }

    if (!childProcess.stdout || !childProcess.stdin) {
      throw new Error("JDTLS process missing stdio streams")
    }

    // Setup ready events for waiting on index completion
    this.serviceReadyPromise = new Promise<void>((resolve) => { this.serviceReadyResolve = resolve })
    this.projectImportCompletePromise = new Promise<void>((resolve) => { this.projectReadyResolve = resolve })

    this.connection = createMessageConnection(
      new StreamMessageReader(childProcess.stdout),
      new StreamMessageWriter(childProcess.stdin)
    )

    // Listen for language/status to detect index completion
    this.connection.onNotification(
      new NotificationType<{ type: string; message: string }>("language/status"),
      (params) => {
        console.log("[LSP] language/status:", params.type, params.message)
        let changed = false
        const nextType = params.type ?? null
        const nextMessage = params.message ?? null
        if (this.lastLanguageStatusType !== nextType || this.lastLanguageStatusMessage !== nextMessage) {
          this.lastLanguageStatusType = nextType
          this.lastLanguageStatusMessage = nextMessage
          changed = true
        }
        if (params.type === "ServiceReady" && params.message === "ServiceReady") {
          if (!this.serviceReady) {
            this.serviceReady = true
            changed = true
          }
          if (this.serviceReadyTimedOut) {
            this.serviceReadyTimedOut = false
            changed = true
          }
          this.serviceReadyResolve?.()
        }
        if (params.type === "ProjectStatus") {
          if (this.projectStatus !== nextMessage) {
            this.projectStatus = nextMessage
            changed = true
          }
          if (isTerminalProjectStatus(nextMessage)) {
            if (this.projectReadyTimedOut) {
              this.projectReadyTimedOut = false
              changed = true
            }
            this.projectReadyResolve?.()
          }
          if (params.message === "OK") {
            if (!this.projectReady) {
              this.projectReady = true
              changed = true
            }
          }
        }
        if (changed) this.emitStartupStatusChange()
      }
    )

    // Listen for diagnostics with debounce
    this.connection.onNotification(
      new NotificationType<PublishDiagnosticsParams>("textDocument/publishDiagnostics"),
      (params) => {
        const file = uriToPath(params.uri)
        const diags: LspDiagnostic[] = params.diagnostics.map((d) => ({
          file,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
          severity: severityToString(d.severity),
          message: d.message,
          source: d.source
        }))
        this.diagnosticsMap.set(file, diags)

        if (this.diagnosticsDebounceTimer) {
          clearTimeout(this.diagnosticsDebounceTimer)
        }
        this.diagnosticsDebounceTimer = setTimeout(() => {
          this.diagnosticsDebounceTimer = null
          this.onDiagnosticsChange?.(this.getAllDiagnostics())
        }, DIAGNOSTICS_DEBOUNCE_MS)
      }
    )

    // Handle workspace/configuration requests from JDTLS
    this.connection.onRequest(
      new RequestType<unknown, unknown[], unknown>("workspace/configuration"),
      () => [this.initSettings ?? {}]
    )

    // Handle capability registration requests
    this.connection.onRequest(new RequestType<unknown, void, unknown>("client/registerCapability"), () => {})

    // Handle workspace folders requests
    this.connection.onRequest(
      new RequestType<unknown, unknown[], unknown>("workspace/workspaceFolders"),
      () => [{ name: "workspace", uri: pathToUri(this.projectRoot) }]
    )

    // Silently handle other JDTLS notifications
    this.connection.onNotification(new NotificationType("window/logMessage"), () => {})
    this.connection.onNotification(new NotificationType("$/progress"), () => {})
    this.connection.onNotification(new NotificationType("language/actionableNotification"), () => {})

    this.connection.listen()
  }

  setDiagnosticsCallback(cb: DiagnosticsCallback | null): void {
    this.onDiagnosticsChange = cb
  }

  setStartupStatusCallback(cb: StartupStatusChangeCallback | null): void {
    this.onStartupStatusChange = cb
  }

  async initialize(): Promise<void> {
    const rootUri = pathToUri(this.projectRoot)

    // Detect Maven settings
    const os = await import("os")
    const path = await import("path")
    const fs = await import("fs")
    const defaultMavenSettings = path.join(os.homedir(), ".m2", "settings.xml")
    const mavenUserSettings = fs.existsSync(defaultMavenSettings) ? defaultMavenSettings : null

    const settings: Record<string, unknown> = {
      java: {
        jdt: {
          ls: {
            lombokSupport: { enabled: true }
          }
        },
        configuration: {
          checkProjectSettingsExclusions: false,
          updateBuildConfiguration: "interactive",
          maven: {
            userSettings: mavenUserSettings,
            globalSettings: null,
            notCoveredPluginExecutionSeverity: "warning"
          },
          runtimes: this.projectRuntimes
        },
        import: {
          maven: { enabled: true, offline: { enabled: false } },
          gradle: { enabled: true, wrapper: { enabled: false }, offline: { enabled: false }, annotationProcessing: { enabled: true } },
          exclusions: [
            "**/node_modules/**",
            "**/.metadata/**",
            "**/archetype-resources/**",
            "**/META-INF/maven/**",
            "**/target/**",
            "**/build/**",
            "**/.gradle/**",
            "**/bin/**",
            "**/out/**",
            "**/.settings/**",
            "**/.idea/**",
            "**/.vscode/**"
          ],
          generatesMetadataFilesAtProjectRoot: false
        },
        maven: { downloadSources: true, updateSnapshots: false },
        eclipse: { downloadSources: true },
        autobuild: { enabled: true },
        references: { includeAccessors: true, includeDecompiledSources: true },
        project: {
          importOnFirstTimeStartup: "automatic",
          importHint: true,
          referencedLibraries: ["lib/**/*.jar"],
          resourceFilters: ["node_modules", "\\.git", "target", "build", "\\.gradle", "bin", "out"]
        },
        server: { launchMode: "Standard" },
        trace: { server: "off" }
      }
    }

    this.initSettings = settings

    const initParams: InitializeParams = {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: true, didSave: true },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          implementation: { dynamicRegistration: false },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) }
          },
          publishDiagnostics: { relatedInformation: true },
          callHierarchy: { dynamicRegistration: false }
        },
        workspace: {
          symbol: { dynamicRegistration: false, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: true },
          configuration: true
        }
      },
      initializationOptions: {
        bundles: [],
        workspaceFolders: [rootUri],
        settings
      }
    }

    let initTimer: ReturnType<typeof setTimeout> | undefined
    let initResult: unknown
    try {
      initResult = await Promise.race([
        this.connection.sendRequest(new RequestType<InitializeParams, unknown, unknown>("initialize"), initParams),
        new Promise((_, reject) => {
          initTimer = setTimeout(() => reject(new Error("JDTLS initialization timed out (45s)")), INIT_TIMEOUT)
        })
      ])
    } finally {
      if (initTimer) clearTimeout(initTimer)
    }

    console.log("[LSP] Initialized:", JSON.stringify(initResult).slice(0, 200))

    // Send initialized notification
    this.connection.sendNotification(new NotificationType("initialized"), {})

    // Send didChangeConfiguration (required by JDTLS to apply settings)
    this.connection.sendNotification(
      new NotificationType("workspace/didChangeConfiguration"),
      { settings }
    )

    this.initialized = true

    // Wait for JDTLS service to be ready
    console.log("[LSP] Waiting for service ready...")
    const serviceReady = await this.waitForReady(this.serviceReadyPromise, SERVICE_READY_TIMEOUT, () => {
      if (!this.serviceReadyTimedOut) {
        this.serviceReadyTimedOut = true
        this.emitStartupStatusChange()
      }
      console.warn("[LSP] Service ready timeout, proceeding anyway")
    })
    if (serviceReady && !this.serviceReady) {
      this.serviceReady = true
      this.emitStartupStatusChange()
    }
    console.log("[LSP] Service ready")

    // Wait for project import to complete (Maven/Gradle)
    console.log("[LSP] Waiting for project import...")
    await this.waitForReady(this.projectImportCompletePromise, PROJECT_READY_TIMEOUT, () => {
      if (!this.projectReadyTimedOut) {
        this.projectReadyTimedOut = true
        this.emitStartupStatusChange()
      }
      console.warn(`[LSP] Project ready timeout after ${Math.round(PROJECT_READY_TIMEOUT / 1000)}s, proceeding anyway`)
    })
    console.log(`[LSP] Project import complete, startup complete (status=${this.projectStatus ?? "unknown"})`)
  }

  isReady(): boolean {
    return this.initialized
  }

  getStartupStatus(): {
    serviceReady: boolean
    serviceReadyTimedOut: boolean
    projectReady: boolean
    projectReadyTimedOut: boolean
    projectStatus: string | null
    languageStatusType: string | null
    languageStatusMessage: string | null
  } {
    return {
      serviceReady: this.serviceReady,
      serviceReadyTimedOut: this.serviceReadyTimedOut,
      projectReady: this.projectReady,
      projectReadyTimedOut: this.projectReadyTimedOut,
      projectStatus: this.projectStatus,
      languageStatusType: this.lastLanguageStatusType,
      languageStatusMessage: this.lastLanguageStatusMessage
    }
  }

  private emitStartupStatusChange(): void {
    const nextSnapshot = JSON.stringify(this.getStartupStatus())
    if (nextSnapshot === this.startupStatusSnapshot) return
    this.startupStatusSnapshot = nextSnapshot
    this.onStartupStatusChange?.()
  }

  async openFile(filePath: string, text: string): Promise<void> {
    if (!this.initialized) throw new Error("LSP not initialized")

    const sizeBytes = Buffer.byteLength(text, "utf-8")
    if (sizeBytes > MAX_FILE_SIZE) {
      throw new Error(
        `File too large for LSP: ${filePath} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB, max 10 MB)`
      )
    }

    const uri = pathToUri(filePath)

    if (this.openFiles.has(uri)) {
      // File already open — notify file watcher, then send didChange
      this.connection.sendNotification(
        new NotificationType("workspace/didChangeWatchedFiles"),
        { changes: [{ uri, type: 2 /* Changed */ }] }
      )
      const version = (this.openFiles.get(uri) ?? 0) + 1
      this.openFiles.set(uri, version)
      this.connection.sendNotification(
        new NotificationType("textDocument/didChange"),
        {
          textDocument: { uri, version },
          contentChanges: [{ text }]
        }
      )
      // Invalidate stale call hierarchy entries for this file
      this.invalidateCallHierarchyCache(filePath)
    } else {
      // New file — notify file watcher as Created, then didOpen
      this.connection.sendNotification(
        new NotificationType("workspace/didChangeWatchedFiles"),
        { changes: [{ uri, type: 1 /* Created */ }] }
      )
      const version = 1
      this.openFiles.set(uri, version)
      const params: DidOpenTextDocumentParams = {
        textDocument: { uri, languageId: "java", version, text }
      }
      this.connection.sendNotification(
        new NotificationType<DidOpenTextDocumentParams>("textDocument/didOpen"),
        params
      )
    }
  }

  /** Invalidate call hierarchy cache entries for a file (after didChange). */
  private invalidateCallHierarchyCache(filePath: string): void {
    const prefix = `${filePath}:`
    for (const key of this.callHierarchyCache.keys()) {
      if (key.startsWith(prefix)) this.callHierarchyCache.delete(key)
    }
  }

  // Retry wrapper for ContentModified (-32801) errors
  private async sendRequestWithRetry<P, R>(
    type: RequestType<P, R, unknown>,
    params: P,
    maxRetries = 3
  ): Promise<R> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.connection.sendRequest(type, params)
      } catch (err: unknown) {
        const isContentModified =
          err && typeof err === "object" && "code" in err && (err as { code: number }).code === CONTENT_MODIFIED_CODE
        if (!isContentModified || attempt >= maxRetries) throw err
        const delay = RETRY_DELAYS[attempt] ?? 2000
        console.warn(`[LSP] ContentModified, retry ${attempt + 1}/${maxRetries} after ${delay}ms`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    throw new Error("unreachable")
  }

  private async waitForReady(
    promise: Promise<void>,
    timeoutMs: number,
    onTimeout: () => void
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            onTimeout()
            resolve(false)
          }, timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // All public methods use 1-based line/column
  async definition(filePath: string, line: number, column: number): Promise<LspLocation[]> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const params: TextDocumentPositionParams = {
      textDocument: { uri: pathToUri(filePath) },
      position: { line: line - 1, character: column - 1 }
    }
    const result = await this.sendRequestWithRetry(
      new RequestType<TextDocumentPositionParams, Location | Location[] | null, unknown>("textDocument/definition"),
      params
    )
    if (!result) return []
    const locations = Array.isArray(result) ? result : [result]
    return locations.map(convertLocation)
  }

  async references(filePath: string, line: number, column: number): Promise<LspLocation[]> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const params = {
      textDocument: { uri: pathToUri(filePath) },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true }
    }
    const result = await this.sendRequestWithRetry(
      new RequestType<typeof params, Location[] | null, unknown>("textDocument/references"),
      params
    )
    return (result ?? []).map(convertLocation)
  }

  async hover(filePath: string, line: number, column: number): Promise<LspHoverResult | null> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const params: TextDocumentPositionParams = {
      textDocument: { uri: pathToUri(filePath) },
      position: { line: line - 1, character: column - 1 }
    }
    const type = new RequestType<TextDocumentPositionParams, Hover | null, unknown>("textDocument/hover")

    // JDTLS lazily loads javadoc — first request often returns incomplete info.
    // Retry up to 5 times, keeping the best (richest) result.
    const scoreHover = (r: Hover | null): number => {
      if (!r) return 0
      const c = r.contents
      if (Array.isArray(c)) return 2000 + c.length
      if (typeof c === "object" && "value" in c) return 1000 + c.value.length
      if (typeof c === "string") return 1000 + c.length
      return 1
    }

    let bestResult = await this.sendRequestWithRetry(type, params)
    let bestScore = scoreHover(bestResult)

    for (let i = 0; i < HOVER_MAX_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, HOVER_RETRY_DELAY))
      const newResult = await this.sendRequestWithRetry(type, params)
      const newScore = scoreHover(newResult)
      if (newScore > bestScore) {
        bestResult = newResult
        bestScore = newScore
      }
    }

    if (!bestResult) return null
    return {
      contents: extractHoverContent(bestResult.contents),
      range: bestResult.range ? convertRange(bestResult.range) : undefined
    }
  }

  async implementation(filePath: string, line: number, column: number): Promise<LspLocation[]> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const params: TextDocumentPositionParams = {
      textDocument: { uri: pathToUri(filePath) },
      position: { line: line - 1, character: column - 1 }
    }
    const result = await this.sendRequestWithRetry(
      new RequestType<TextDocumentPositionParams, Location | Location[] | null, unknown>("textDocument/implementation"),
      params
    )
    if (!result) return []
    const locations = Array.isArray(result) ? result : [result]
    return locations.map(convertLocation)
  }

  async documentSymbols(filePath: string): Promise<LspSymbol[]> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const params = { textDocument: { uri: pathToUri(filePath) } }
    const result = await this.sendRequestWithRetry(
      new RequestType<typeof params, (SymbolInformation | DocumentSymbol)[] | null, unknown>("textDocument/documentSymbol"),
      params
    )
    if (!result) return []
    return this.flattenSymbols(result, filePath)
  }

  async workspaceSymbol(query: string): Promise<LspSymbol[]> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const result = await this.sendRequestWithRetry(
      new RequestType<{ query: string }, SymbolInformation[] | null, unknown>("workspace/symbol"),
      { query }
    )
    if (!result) return []
    return result.map((s) => ({
      name: s.name,
      kind: SYMBOL_KIND_MAP[s.kind] ?? `Kind(${s.kind})`,
      file: uriToPath(s.location.uri),
      line: s.location.range.start.line + 1,
      column: s.location.range.start.character + 1,
      containerName: s.containerName
    }))
  }

  async prepareCallHierarchy(filePath: string, line: number, column: number): Promise<LspCallHierarchyItem[]> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const params: TextDocumentPositionParams = {
      textDocument: { uri: pathToUri(filePath) },
      position: { line: line - 1, character: column - 1 }
    }
    const result = await this.sendRequestWithRetry(
      new RequestType<TextDocumentPositionParams, CallHierarchyItem[] | null, unknown>("textDocument/prepareCallHierarchy"),
      params
    )
    if (!result || result.length === 0) return []
    // Cache raw items for incomingCalls/outgoingCalls
    const key = `${filePath}:${line}:${column}`
    this.callHierarchyCache.set(key, result)
    return result.map(convertCallHierarchyItem)
  }

  async incomingCalls(filePath: string, line: number, column: number): Promise<LspCallHierarchyIncomingCall[]> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const key = `${filePath}:${line}:${column}`
    let items = this.callHierarchyCache.get(key)
    if (!items) {
      const params: TextDocumentPositionParams = {
        textDocument: { uri: pathToUri(filePath) },
        position: { line: line - 1, character: column - 1 }
      }
      items = await this.sendRequestWithRetry(
        new RequestType<TextDocumentPositionParams, CallHierarchyItem[] | null, unknown>("textDocument/prepareCallHierarchy"),
        params
      ) ?? []
      this.callHierarchyCache.set(key, items)
    }
    if (items.length === 0) return []
    const result = await this.sendRequestWithRetry(
      new RequestType<{ item: CallHierarchyItem }, CallHierarchyIncomingCall[] | null, unknown>("callHierarchy/incomingCalls"),
      { item: items[0] }
    )
    if (!result) return []
    return result.map((c) => ({
      from: convertCallHierarchyItem(c.from),
      fromRanges: c.fromRanges.map(convertRange)
    }))
  }

  async outgoingCalls(filePath: string, line: number, column: number): Promise<LspCallHierarchyOutgoingCall[]> {
    if (!this.initialized) throw new Error("LSP not initialized")
    const key = `${filePath}:${line}:${column}`
    let items = this.callHierarchyCache.get(key)
    if (!items) {
      const params: TextDocumentPositionParams = {
        textDocument: { uri: pathToUri(filePath) },
        position: { line: line - 1, character: column - 1 }
      }
      items = await this.sendRequestWithRetry(
        new RequestType<TextDocumentPositionParams, CallHierarchyItem[] | null, unknown>("textDocument/prepareCallHierarchy"),
        params
      ) ?? []
      this.callHierarchyCache.set(key, items)
    }
    if (items.length === 0) return []
    const result = await this.sendRequestWithRetry(
      new RequestType<{ item: CallHierarchyItem }, CallHierarchyOutgoingCall[] | null, unknown>("callHierarchy/outgoingCalls"),
      { item: items[0] }
    )
    if (!result) return []
    return result.map((c) => ({
      to: convertCallHierarchyItem(c.to),
      fromRanges: c.fromRanges.map(convertRange)
    }))
  }

  getAllDiagnostics(): LspDiagnostic[] {
    const all: LspDiagnostic[] = []
    for (const diags of this.diagnosticsMap.values()) {
      all.push(...diags)
    }
    return all
  }

  getDiagnostics(filePath?: string): LspDiagnostic[] {
    if (!filePath) return this.getAllDiagnostics()
    // diagnosticsMap is keyed by raw file paths (from uriToPath of incoming notifications),
    // so we just look up directly — no round-trip through pathToUri.
    return this.diagnosticsMap.get(filePath) ?? []
  }

  /** True if the JDTLS process has already exited (regardless of how). */
  private hasExited(): boolean {
    return this.process.exitCode !== null || this.process.signalCode !== null
  }

  async shutdown(): Promise<void> {
    if (this.diagnosticsDebounceTimer) {
      clearTimeout(this.diagnosticsDebounceTimer)
      this.diagnosticsDebounceTimer = null
    }
    // Drop call hierarchy cache (avoids stale items if a new client is spawned)
    this.callHierarchyCache.clear()

    if (!this.initialized) {
      this.disposeConnection()
      this.killProcessTree("SIGKILL")
      return
    }

    this.initialized = false

    // Stage 1: Graceful shutdown via LSP protocol
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.connection.sendRequest(SHUTDOWN_REQUEST),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("shutdown timeout")), 2_000)
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
      await this.connection.sendNotification(EXIT_NOTIFICATION)
      console.log("[LSP] Graceful shutdown sent")
    } catch (e) {
      console.warn("[LSP] Graceful shutdown failed:", e)
    }

    // Close stdin to signal EOF before terminating
    this.disposeConnection()

    // If JDTLS already exited (graceful shutdown succeeded), we're done.
    if (this.hasExited()) {
      console.log("[LSP] JDTLS already exited gracefully")
      return
    }

    // Stage 2: Terminate process tree (parent + Gradle/Maven children)
    console.log("[LSP] Terminating process tree...")
    this.killProcessTree("SIGTERM")
    try {
      await new Promise<void>((resolve, reject) => {
        if (this.hasExited()) { resolve(); return }
        const timer = setTimeout(() => reject(new Error("terminate timeout")), 5_000)
        this.process.once("exit", () => { clearTimeout(timer); resolve() })
      })
      console.log("[LSP] Process tree terminated")
      return
    } catch {
      // Stage 3: Force kill process tree
      if (this.hasExited()) return
      console.warn("[LSP] Terminate timed out, force killing process tree...")
      this.killProcessTree("SIGKILL")
      await new Promise<void>((resolve) => {
        if (this.hasExited()) { resolve(); return }
        const timer = setTimeout(resolve, 2_000)
        this.process.once("exit", () => { clearTimeout(timer); resolve() })
      })
      console.log("[LSP] Process tree force killed")
    }
  }

  /** Kill the entire process group (JDTLS + Gradle/Maven children) */
  private killProcessTree(signal: NodeJS.Signals): void {
    try {
      if (this.hasExited()) return
      const pid = this.process.pid
      if (pid && process.platform !== "win32") {
        // Kill the process group (negative PID) — requires detached: true in spawn
        process.kill(-pid, signal)
      } else {
        this.process.kill(signal)
      }
    } catch { /* process already exited */ }
  }

  private disposeConnection(): void {
    try {
      this.connection.end()
    } catch { /* connection already closed */ }
    try {
      this.connection.dispose()
    } catch { /* connection already disposed */ }
  }

  private flattenSymbols(symbols: (SymbolInformation | DocumentSymbol)[], filePath: string): LspSymbol[] {
    const result: LspSymbol[] = []
    for (const s of symbols) {
      if ("location" in s) {
        result.push({
          name: s.name,
          kind: SYMBOL_KIND_MAP[s.kind] ?? `Kind(${s.kind})`,
          file: uriToPath(s.location.uri),
          line: s.location.range.start.line + 1,
          column: s.location.range.start.character + 1,
          containerName: s.containerName
        })
      } else {
        result.push({
          name: s.name,
          kind: SYMBOL_KIND_MAP[s.kind] ?? `Kind(${s.kind})`,
          file: filePath,
          line: s.selectionRange.start.line + 1,
          column: s.selectionRange.start.character + 1
        })
        if (s.children) {
          result.push(...this.flattenSymbols(s.children, filePath))
        }
      }
    }
    return result
  }
}
