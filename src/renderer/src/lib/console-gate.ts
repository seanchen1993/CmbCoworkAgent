type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug"
type ConsoleFn = (...args: unknown[]) => void

interface ConsoleGateApi {
  enable: () => boolean
  disable: () => boolean
  isEnabled: () => boolean
  help: () => string
}

interface MainLogPayload {
  level?: string
  message?: string
}

interface IpcRendererBridge {
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => (() => void) | void
}

type ConsoleGateWindow = Window & typeof globalThis & {
  __CMBConsoleLogs?: ConsoleGateApi
  __CMBConsoleEnabled?: boolean
  __CMBConsoleNative?: Record<ConsoleMethod, ConsoleFn>
  __CMBConsoleMuted?: Record<ConsoleMethod, ConsoleFn>
  __CMBMainLogCleanup?: (() => void) | null
  logOn?: () => boolean
  logOff?: () => boolean
  logState?: () => boolean
  electron?: {
    ipcRenderer?: IpcRendererBridge
  }
}

const methods: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"]
const MAIN_LOG_TOGGLE_CHANNEL = "debug:set-main-console-forwarding"
const MAIN_LOG_EVENT_CHANNEL = "debug:main-console-log"

function envFlagOn(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized === "1"
    || normalized === "true"
    || normalized === "on"
    || normalized === "yes"
    || normalized === "y"
}

const globalWindow = window as ConsoleGateWindow
if (!globalWindow.__CMBConsoleNative) {
  globalWindow.__CMBConsoleNative = methods.reduce<Record<ConsoleMethod, ConsoleFn>>((acc, method) => {
    acc[method] = console[method].bind(console)
    return acc
  }, {} as Record<ConsoleMethod, ConsoleFn>)
}

if (!globalWindow.__CMBConsoleMuted) {
  globalWindow.__CMBConsoleMuted = methods.reduce<Record<ConsoleMethod, ConsoleFn>>((acc, method) => {
    acc[method] = () => {}
    return acc
  }, {} as Record<ConsoleMethod, ConsoleFn>)
}

if (typeof globalWindow.__CMBConsoleEnabled !== "boolean") {
  globalWindow.__CMBConsoleEnabled = envFlagOn(import.meta.env.VITE_CONSOLE_LOG_DEFAULT_ON)
}

function applyConsoleState(): void {
  const nativeConsole = globalWindow.__CMBConsoleNative as Record<ConsoleMethod, ConsoleFn>
  const mutedConsole = globalWindow.__CMBConsoleMuted as Record<ConsoleMethod, ConsoleFn>
  const active = globalWindow.__CMBConsoleEnabled ? nativeConsole : mutedConsole
  for (const method of methods) {
    console[method] = active[method] as Console[typeof method]
  }
}
applyConsoleState()

function getIpcRenderer(): IpcRendererBridge | undefined {
  return globalWindow.electron?.ipcRenderer
}

function syncMainForwarding(enabled: boolean): void {
  const ipcRenderer = getIpcRenderer()
  if (!ipcRenderer) return
  try {
    ipcRenderer.send(MAIN_LOG_TOGGLE_CHANNEL, enabled)
  } catch {
    // Ignore bridge errors; renderer logging should still work.
  }
}

function methodFromLevel(level?: string): ConsoleMethod {
  switch ((level || "").toUpperCase()) {
    case "WARN":
      return "warn"
    case "ERROR":
      return "error"
    case "DEBUG":
      return "debug"
    default:
      return "log"
  }
}

function ensureMainLogListener(): void {
  if (globalWindow.__CMBMainLogCleanup) return
  const ipcRenderer = getIpcRenderer()
  if (!ipcRenderer) return

  const off = ipcRenderer.on(MAIN_LOG_EVENT_CHANNEL, (payloadValue: unknown) => {
    const payload = payloadValue as MainLogPayload
    if (!globalWindow.__CMBConsoleEnabled) return
    const nativeConsole = globalWindow.__CMBConsoleNative as Record<ConsoleMethod, ConsoleFn>
    const method = methodFromLevel(payload?.level)
    const text = typeof payload?.message === "string" ? payload.message : String(payload?.message ?? "")
    nativeConsole[method](`[main] ${text}`)
  })

  globalWindow.__CMBMainLogCleanup = typeof off === "function" ? off : null
}

ensureMainLogListener()
syncMainForwarding(Boolean(globalWindow.__CMBConsoleEnabled))

const api: ConsoleGateApi = {
  enable: () => {
    globalWindow.__CMBConsoleEnabled = true
    applyConsoleState()
    const nativeConsole = globalWindow.__CMBConsoleNative as Record<ConsoleMethod, ConsoleFn>
    syncMainForwarding(true)
    nativeConsole.info("[ConsoleGate] Renderer console logs enabled")
    return true
  },
  disable: () => {
    globalWindow.__CMBConsoleEnabled = false
    applyConsoleState()
    syncMainForwarding(false)
    const nativeConsole = globalWindow.__CMBConsoleNative as Record<ConsoleMethod, ConsoleFn>
    nativeConsole.info("[ConsoleGate] Renderer console logs disabled")
    return false
  },
  isEnabled: () => Boolean(globalWindow.__CMBConsoleEnabled),
  help: () => "Use window.logOn() / window.logOff() / window.logState()"
}

globalWindow.__CMBConsoleLogs = api
globalWindow.logOn = api.enable
globalWindow.logOff = api.disable
globalWindow.logState = api.isEnabled
