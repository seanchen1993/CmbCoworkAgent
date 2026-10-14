import { AsyncLocalStorage } from "node:async_hooks"
import type { ModIdentity } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionSession } from "./session"
import { independentPromptFrame, type IndependentPromptFrame } from "./model-prompt-frame"

interface StartupScope {
  readonly workspace: string
  readonly threadId: string
  readonly session: FunctionSession
  readonly entry: object
  assertLive(): void
  assertRequest(request: Readonly<ModIdentity>): void
}
interface ActiveStartup extends StartupScope {
  active: boolean
  failure?: unknown
  readonly requests: WeakMap<IndependentPromptFrame, StartupPromptAccess>
}
export interface StartupPromptAccess {
  readonly session: FunctionSession
  assertLive(): void
}

/** Private host receipts bind actual startup and actual independent model preparation. */
export class FunctionStartupModelRoute {
  private readonly scopes = new AsyncLocalStorage<ActiveStartup>()

  async run<T>(scope: StartupScope, operation: () => Promise<T>): Promise<T> {
    const receipt: ActiveStartup = { ...scope, active: true, requests: new WeakMap() }
    try {
      return await this.scopes.run(receipt, operation)
    } finally {
      receipt.active = false
    }
  }

  fresh<T>(operation: () => Promise<T>): Promise<T> {
    return this.scopes.exit(operation)
  }

  assertOrdinaryEntry(workspace: string, threadId: string, method: PropertyKey): void {
    const startup = this.scopes.getStore()
    if (!startup || startup.workspace !== workspace || startup.threadId !== threadId) return
    if (!startup.active) throw new ModFunctionError("MODS_STARTUP_SCOPE_EXPIRED")
    // Pure source discovery does not enter the unfinished runtime.
    if (method === "effectiveStatus") return
    throw new ModFunctionError(
      "MODS_CONFIG_RELOAD_REENTRANT",
      "组件启动期间不能再次进入自己的任务处理链；请将此操作放到启动完成后。",
      true
    )
  }

  assertStatus(workspace: string, threadId: string): void {
    const startup = this.scopes.getStore()
    if (!startup || startup.workspace !== workspace || startup.threadId !== threadId) return
    if (!startup.active) throw new ModFunctionError("MODS_STARTUP_SCOPE_EXPIRED")
    if (startup.failure) throw startup.failure
  }

  captureGuard(workspace: string, threadId: string): (() => void) | undefined {
    const original = this.scopes.getStore()
    if (!original) return undefined
    const check = () => {
      if (!original.active || this.scopes.getStore() !== original)
        throw new ModFunctionError("MODS_STARTUP_SCOPE_EXPIRED")
      if (original.workspace !== workspace || original.threadId !== threadId)
        throw new ModFunctionError("MODS_SCOPE_CHANGED")
      if (original.failure) throw original.failure
      try {
        original.assertLive()
      } catch (error) {
        original.failure ??= error
        throw error
      }
    }
    check()
    return check
  }

  capturePrompt(workspace: string, threadId: string): StartupPromptAccess | undefined {
    const original = this.scopes.getStore()
    if (!original) return undefined
    const checkStartup = this.captureGuard(workspace, threadId)!
    const frame = independentPromptFrame()
    const request = frame?.request
    if (
      !frame?.active ||
      !request ||
      request.workspace !== workspace ||
      request.threadId !== threadId
    )
      throw new ModFunctionError("MODS_STARTUP_MODEL_REQUEST_REQUIRED")
    const found = original.requests.get(frame)
    if (found) {
      found.assertLive()
      return found
    }
    const proof: StartupPromptAccess = Object.freeze({
      session: original.session,
      assertLive: () => {
        checkStartup()
        if (
          independentPromptFrame() !== frame ||
          !frame.active ||
          frame.request !== request ||
          original.requests.get(frame) !== proof ||
          proof.session !== original.session
        )
          throw new ModFunctionError("MODS_STARTUP_MODEL_REQUEST_EXPIRED")
        original.assertRequest(request)
      }
    })
    original.requests.set(frame, proof)
    proof.assertLive()
    return proof
  }
}
