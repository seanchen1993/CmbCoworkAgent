import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type { BotPluginPaneAction, BotPluginPaneView } from "../../shared/bot-plugin-panes"
import { isBotPluginPresentationAction } from "../../shared/bot-plugin-panes"
import type { FunctionPaneSnapshot } from "../../shared/mods/v2/ui"
import { FunctionModsManager } from "../mods/v2/manager-core"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { acquireBotModControlStore } from "./mods-control-stores"
import type { BotFunctionPresentation } from "./function-presentation"
import { withFunctionAgentExecution } from "../mods/v2/host-call"

type ManagerInputs = ConstructorParameters<typeof FunctionModsManager>
export type BotFunctionHost = ManagerInputs[1]
type Entry = {
  botId: string
  manager: FunctionModsManager
  configuration: string
  releaseStore(): void
  owner?: symbol
  retired: boolean
  revision: number
  id: string
  panes: FunctionPaneSnapshot[]
  error?: string
  messageId: string
  lastUsed: number
  presentation?: BotFunctionPresentation
  redraw?: ReturnType<typeof setTimeout>
  refreshing?: boolean
  dirty?: boolean
}
type Scope = { entry: Entry; host: BotFunctionHost; active: boolean }

export interface BotFunctionSession {
  readonly id: string
  functions: FunctionModsManager
  capture(workspace: string, threadId: string): Promise<void>
  release(): void
}

/** Keep guest closures across turns, never the authority of the turn that
 * created them. Each call enters an expiring scope with its current run's host.
 * This service belongs to one exclusive Bot Host, not the desktop singleton. */
export class BotFunctionSessions {
  private readonly entries = new Map<string, Entry>()
  private readonly scopes = new AsyncLocalStorage<Scope>()
  private closed = false
  private sequence = 0

  constructor(private readonly capacity = 24) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128)
      throw new Error("Invalid Bot plugin session capacity")
  }

  acquire(input: {
    botId: string
    key: string
    configuration: string
    storePath: string
    host: BotFunctionHost
    createClient: ManagerInputs[2]
    persistent: boolean
    messageId: string
    presentation?: () => BotFunctionPresentation
  }): BotFunctionSession {
    if (this.closed) throw new ModFunctionError("MODS_DISABLED")
    let entry = this.entries.get(input.key)
    if (entry?.owner) throw new ModFunctionError("MODS_SESSION_BUSY")
    if (entry && entry.configuration !== input.configuration) {
      this.retire(input.key, entry)
      entry = undefined
    }
    if (!entry) {
      if (this.entries.size >= this.capacity) {
        const idle = [...this.entries]
          .filter(([, value]) => !value.owner && !value.panes.length)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
        if (idle) this.retire(...idle)
      }
      if (this.entries.size >= this.capacity) throw new ModFunctionError("MODS_SESSION_CAPACITY")
      entry = this.createEntry(
        input.botId,
        input.configuration,
        input.storePath,
        input.createClient,
        input.messageId,
        input.presentation
      )
      this.entries.set(input.key, entry)
    }
    const current = entry
    current.lastUsed = ++this.sequence
    const owner = Symbol(input.key)
    current.owner = owner
    let released = false
    const activeCalls = new Set<Scope>()
    const release = () => {
      if (released) return
      released = true
      for (const call of activeCalls) call.active = false
      activeCalls.clear()
      if (current.owner === owner) current.owner = undefined
      if (!input.persistent) this.retire(input.key, current)
    }
    const functions = new Proxy(current.manager, {
      get: (target, key, receiver) => {
        if (key === "close") return release
        const value = Reflect.get(target, key, receiver)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          const inherited = this.scopes.getStore()
          if (inherited && (!inherited.active || inherited.entry !== current))
            throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
          if (released || current.retired || current.owner !== owner)
            throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
          const call: Scope = { entry: current, host: input.host, active: true }
          activeCalls.add(call)
          const finish = () => {
            call.active = false
            activeCalls.delete(call)
          }
          try {
            const result: unknown = this.scopes.run(call, () => Reflect.apply(value, target, args))
            if (result instanceof Promise) return result.finally(finish)
            finish()
            return result
          } catch (error) {
            finish()
            throw error
          }
        }
      }
    })
    return {
      id: current.id,
      functions,
      async capture(workspace, threadId) {
        try {
          const panes = await functions.panes(workspace, threadId)
          if (released || current.retired || current.owner !== owner)
            throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
          current.panes = structuredClone(panes)
          current.error = undefined
        } catch {
          current.panes = []
          current.error = "插件面板暂不可用，请重新运行打开面板的插件命令。"
        }
        current.revision++
      },
      release
    }
  }

  /** Projection reads never start guests or execute plugin rendering code. */
  view(key: string): BotPluginPaneView {
    const entry = this.entries.get(key)
    return entry && !entry.retired
      ? {
          sessionId: entry.id,
          revision: entry.revision,
          busy: Boolean(entry.owner),
          panes: structuredClone(entry.panes),
          ...(entry.error ? { error: entry.error } : {})
        }
      : { sessionId: null, revision: 0, busy: false, panes: [] }
  }

  async currentView(key: string): Promise<BotPluginPaneView> {
    const entry = this.entries.get(key)
    if (!entry) return this.view(key)
    try {
      await entry.presentation?.current()
    } catch (error) {
      this.retire(key, entry)
      throw error
    }
    if (this.entries.get(key) !== entry) throw new ModFunctionError("MODS_UI_STALE_ACTION")
    return this.view(key)
  }

  actionOrigin(key: string, input: BotPluginPaneAction): string {
    const entry = this.entries.get(key)
    const pane = entry?.panes.find((p) => p.key === input.action.pane)
    if (
      !entry ||
      entry.retired ||
      entry.id !== input.sessionId ||
      !pane ||
      pane.generation !== (input.target === "pane" ? input.action.generation : input.generation) ||
      (input.target === "client" &&
        !pane.clients?.some((client) => client.id === input.action.instance))
    )
      throw new ModFunctionError("MODS_UI_STALE_ACTION")
    return entry.messageId
  }

  async presentationInput(key: string, input: BotPluginPaneAction): Promise<string> {
    if (!isBotPluginPresentationAction(input)) throw new ModFunctionError("MODS_UI_ACTION_REQUIRED")
    const messageId = this.actionOrigin(key, input),
      entry = this.entries.get(key)!
    if (!entry.presentation) throw new ModFunctionError("MODS_UI_STALE_ACTION")
    const { workspace, threadId } = entry.presentation.scope
    await this.present(entry, () =>
      withFunctionAgentExecution(
        {
          workspace,
          threadId,
          userInitiated: false,
          leased: false,
          immediate: true
        },
        async () => {
          if (input.target === "pane") await entry.manager.act(workspace, threadId, input.action)
          else await entry.manager.clientAct(workspace, threadId, input.action)
          const panes = await entry.manager.panes(workspace, threadId)
          if (entry.retired) throw new ModFunctionError("MODS_UI_STALE_ACTION")
          entry.panes = structuredClone(panes)
          entry.error = undefined
          entry.revision++
        }
      )
    )
    return messageId
  }

  // A separate lexical scope keeps resident workers from retaining a completed
  // run's host object, model snapshot, approvals, tools or transcript.
  private createEntry(
    botId: string,
    configuration: string,
    storePath: string,
    createClient: ManagerInputs[2],
    messageId: string,
    presentation?: () => BotFunctionPresentation
  ): Entry {
    const control = acquireBotModControlStore(storePath)
    // Only presentation invalidation may outlive a run. No guest execution,
    // policy publication or capability call has a fallback to the last host.
    let current: Entry
    const scope = (): Scope => {
      const value = this.scopes.getStore()
      if (!value?.active || value.entry !== current || current.retired)
        throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
      return value
    }
    const host = new Proxy({} as BotFunctionHost, {
      get: (_target, key: keyof BotFunctionHost) => {
        if (key === "background") return <T>(run: () => Promise<T>) => this.present(current, run)
        if (key === "changed")
          return () => {
            current.revision++
            this.queueProjection(current)
          }
        const value = scope().host[key]
        if (typeof value !== "function") return value
        // Resolve again when invoked: keeping a function must not retain a
        // completed run's authority or acquire a later caller's authority.
        const origin = scope()
        return (...args: unknown[]) => {
          if (scope() !== origin) throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
          return Reflect.apply(value, origin.host, args)
        }
      }
    })
    try {
      current = {
        botId,
        manager: new FunctionModsManager(control.store, host, createClient),
        configuration: configuration,
        releaseStore: control.release,
        retired: false,
        revision: 0,
        id: randomUUID(),
        panes: [],
        messageId: messageId,
        lastUsed: ++this.sequence,
        presentation: presentation?.()
      }
      return current
    } catch (error) {
      control.release()
      throw error
    }
  }

  private async present<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
    if (entry.retired || !entry.presentation) throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
    await entry.presentation.current()
    if (entry.retired) throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
    const scope: Scope = { entry, host: entry.presentation.host, active: true }
    try {
      return await this.scopes.exit(() => this.scopes.run(scope, operation))
    } finally {
      scope.active = false
    }
  }

  private queueProjection(entry: Entry): void {
    if (entry.retired || !entry.presentation) return
    entry.dirty = true
    if (entry.redraw || entry.refreshing) return
    entry.redraw = setTimeout(() => {
      entry.redraw = undefined
      entry.refreshing = true
      entry.dirty = false
      const { workspace, threadId } = entry.presentation!.scope
      void this.present(entry, () =>
        withFunctionAgentExecution(
          {
            workspace,
            threadId,
            userInitiated: false,
            leased: false,
            immediate: true
          },
          async () => {
            const panes = await entry.manager.panes(workspace, threadId)
            if (entry.retired) return
            entry.panes = structuredClone(panes)
            entry.error = undefined
            entry.revision++
          }
        )
      )
        .catch(() => {
          if (!entry.retired) {
            entry.panes = []
            entry.error = "插件面板暂不可用，请重新运行打开面板的插件命令。"
            entry.revision++
          }
        })
        .finally(() => {
          entry.refreshing = false
          if (entry.dirty) this.queueProjection(entry)
        })
    }, 100)
    entry.redraw.unref()
  }

  private retire(key: string, entry: Entry): void {
    if (entry.retired) return
    entry.retired = true
    clearTimeout(entry.redraw)
    if (this.entries.get(key) === entry) this.entries.delete(key)
    try {
      entry.manager.close()
    } finally {
      entry.presentation?.close()
      entry.releaseStore()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [key, entry] of this.entries) this.retire(key, entry)
  }

  closeBot(botId: string): void {
    for (const [key, entry] of this.entries) if (entry.botId === botId) this.retire(key, entry)
  }
}
