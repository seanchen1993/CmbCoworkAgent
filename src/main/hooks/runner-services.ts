import { AsyncLocalStorage } from "node:async_hooks"
import type { HookContext } from "./runner-core"
import type { HookConfig, HookEvent, HookResult } from "./types"

/** Dependencies formerly captured from desktop singletons by runner.ts. A Bot
 * supplies its own authorization, model snapshot and durable audit adapter.
 * Type-only imports cannot load Electron or desktop state in a Host process.
 */
export interface HookRunnerServices {
  getHookLoggingConfig: typeof import("../storage").getHookLoggingConfig
  getUserInfo: typeof import("../storage").getUserInfo
  getAvailableModelConfigOrDefault?: typeof import("../models/registry").getAvailableModelConfigOrDefault
  getModelConfigByRef?: typeof import("../models/registry").getModelConfigByRef
  persistHookResultRecord: typeof import("./log-record").persistHookResultRecord
  trackEvent?: typeof import("../services/event-reporter").trackEvent
  signal?: AbortSignal
  createPromptModel?: (
    modelRef: string | undefined,
    timeoutMs: number
  ) => import("@langchain/openai").ChatOpenAI | null
  /** Headless work must remain inside the active leased task, including hooks
   * configured as async by a desktop plugin. No detached privileged callbacks. */
  forceSynchronous?: boolean
  assertCurrent?: () => Promise<void> | void
  /** Optional host-owned executor. Receives the original stdin protocol and
   * returns raw Hook output; the shared parser still enforces decision semantics. */
  execute?: (input: {
    hook: HookConfig
    event: HookEvent
    context: HookContext
    env: Record<string, string>
    payload: string
    timeoutMs: number
  }) => Promise<HookResult>
}

const scope = new AsyncLocalStorage<HookRunnerServices>()
export function withHookRunnerServices<T>(services: HookRunnerServices, run: () => T): T {
  return scope.run(services, run)
}
export function hookRunnerServices(): HookRunnerServices {
  const services = scope.getStore()
  if (!services) throw new Error("Hook execution requires an explicit host adapter")
  return services
}
