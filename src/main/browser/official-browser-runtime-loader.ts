import { pathToFileURL } from "url"
import type { BrowserPerformanceBudget } from "./browser-performance-budget"
import { DEFAULT_BROWSER_PERFORMANCE_BUDGET } from "./browser-performance-budget"

type BrowserRuntimeGlobals = Record<string, unknown>
type BrowserRuntimeGlobalThis = typeof globalThis & { nodeRepl?: unknown }

interface OfficialBrowserRuntimeModule {
  setupBrowserRuntime?: (options: { globals: BrowserRuntimeGlobals }) => Promise<void> | void
}

export interface OfficialBrowserRuntimeSetupResult {
  setupExecuted: boolean
}

const runtimeModuleCache = new Map<
  string,
  Promise<(options: { globals: BrowserRuntimeGlobals }) => Promise<void> | void>
>()

function restoreGlobalProcess(snapshot: {
  globalObject: any
  globalProcess: any
  process: any
}): void {
  const writableGlobalThis = globalThis as any
  writableGlobalThis.process = snapshot.process
  writableGlobalThis.global = snapshot.globalObject
  if (snapshot.globalObject && typeof snapshot.globalObject === "object") {
    ;(snapshot.globalObject as { process?: unknown }).process = snapshot.globalProcess
  }
}

function asRuntimeModule(value: unknown, clientPath: string): OfficialBrowserRuntimeModule {
  if (!value || typeof value !== "object") {
    throw new Error(`Browser runtime module did not load from ${clientPath}`)
  }
  return value as OfficialBrowserRuntimeModule
}

export async function loadOfficialBrowserRuntime(
  clientPath: string
): Promise<(options: { globals: BrowserRuntimeGlobals }) => Promise<void> | void> {
  const cached = runtimeModuleCache.get(clientPath)
  if (cached) return cached

  const promise = (async () => {
    const writableGlobalThis = globalThis as any
    const snapshot = {
      globalObject: writableGlobalThis.global,
      globalProcess:
        writableGlobalThis.global && typeof writableGlobalThis.global === "object"
          ? (writableGlobalThis.global as { process?: unknown }).process
          : undefined,
      process: writableGlobalThis.process
    }
    try {
      const moduleValue = await import(pathToFileURL(clientPath).href)
      const module = asRuntimeModule(moduleValue, clientPath)
      if (typeof module.setupBrowserRuntime !== "function") {
        throw new Error(`Browser runtime client is missing setupBrowserRuntime: ${clientPath}`)
      }
      return module.setupBrowserRuntime
    } finally {
      restoreGlobalProcess(snapshot)
    }
  })()
  runtimeModuleCache.set(clientPath, promise)
  return promise
}

export function bindOfficialBrowserRuntimeGlobals(globals: BrowserRuntimeGlobals): void {
  ;(globalThis as BrowserRuntimeGlobalThis).nodeRepl = globals.nodeRepl
}

function hasBrowserRuntime(globals: BrowserRuntimeGlobals): boolean {
  const agent = globals.agent
  return Boolean(
    agent &&
      typeof agent === "object" &&
      "browsers" in agent &&
      (agent as { browsers?: unknown }).browsers != null
  )
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function setupOfficialBrowserRuntime(options: {
  clientPath: string
  globals: BrowserRuntimeGlobals
  budget?: BrowserPerformanceBudget
}): Promise<OfficialBrowserRuntimeSetupResult> {
  bindOfficialBrowserRuntimeGlobals(options.globals)
  if (hasBrowserRuntime(options.globals)) return { setupExecuted: false }

  const budget = options.budget ?? DEFAULT_BROWSER_PERFORMANCE_BUDGET
  const setupBrowserRuntime = await loadOfficialBrowserRuntime(options.clientPath)
  await withTimeout(
    Promise.resolve(setupBrowserRuntime({ globals: options.globals })),
    budget.bootstrapTimeoutMs,
    "Browser official runtime setup"
  )
  return { setupExecuted: true }
}
