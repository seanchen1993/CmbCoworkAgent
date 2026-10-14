import type { ModJson, ModObject, ModUiChangeScope } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionPluginPromptOrigin } from "../../../shared/mods/v2/plugin-prompt"
import type { FunctionUiSite } from "../../../shared/mods/v2/sites"
import type { FunctionPaneSnapshot, FunctionUiAction } from "../../../shared/mods/v2/ui"
import type { UserInputRequest } from "../../types"
import { FunctionDispatcher } from "./dispatcher"
import { FunctionUiSites } from "./sites"

export const FUNCTION_HOST_ONLY_SITE_LIMIT = 4096
export const FUNCTION_HOST_ONLY_THREAD_LIMIT = 256
export const FUNCTION_HOST_ONLY_THREAD_SITE_LIMIT = 512
export const FUNCTION_HOST_ONLY_MOUNT_LIMIT = 32

interface HostOnlySiteHost {
  capture(workspace: string, threadId: string): () => void
  publish(workspace: string, value: ModJson, signal: AbortSignal): Promise<ModJson>
  changed(threadId: string, scope?: ModUiChangeScope): void
  userMessageOrigin?(threadId: string, messageId: string): FunctionPluginPromptOrigin | undefined
  pendingQuestion?(threadId: string): Readonly<UserInputRequest> | null
}

interface HostOnlyEntry {
  workspace: string
  threadId: string
  controller: AbortController
  assertLive(): void
  sites: FunctionUiSites
  owners: Set<string>
  pending: number
}
interface HostOnlyOwner {
  entry: HostOnlyEntry
  component: FunctionUiSite
}

const repeated = new Set<FunctionUiSite>([
  "TurnDuration",
  "UserMessage",
  "AssistantMessage",
  "CommandOutput",
  "ToolUse",
  "ToolResult",
  "ToolGroup"
])

/** Native display slots share the real drawing/publication pipeline without allocating a guest. */
export class FunctionHostOnlySites {
  private readonly entries = new Map<string, HostOnlyEntry>()
  private readonly owners = new Map<string, HostOnlyOwner>()
  private pending = 0
  private closed = false

  constructor(private readonly host: HostOnlySiteHost) {}

  has(owner: string): boolean {
    return this.owners.has(owner)
  }

  workspaces(): string[] {
    return [...new Set([...this.entries.values()].map((entry) => entry.workspace))]
  }

  private entry(workspace: string, threadId: string): HostOnlyEntry {
    const key = JSON.stringify([workspace, threadId])
    const previous = this.entries.get(key)
    if (previous) {
      previous.assertLive()
      return previous
    }
    if (this.closed) throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    if (this.entries.size >= FUNCTION_HOST_ONLY_THREAD_LIMIT)
      throw new ModFunctionError("MODS_UI_SITE_LIMIT")
    const captured = this.host.capture(workspace, threadId)
    captured()
    const controller = new AbortController()
    const entry = {
      workspace,
      threadId,
      controller,
      owners: new Set<string>(),
      pending: 0
    } as HostOnlyEntry
    entry.assertLive = () => {
      controller.signal.throwIfAborted()
      if (this.closed || this.entries.get(key) !== entry)
        throw new ModFunctionError("MODS_UI_SITE_CLOSED")
      try {
        captured()
      } catch (error) {
        this.retire(entry)
        throw error
      }
    }
    const dispatcher = new FunctionDispatcher([])
    entry.sites = new FunctionUiSites({
      plugins: [],
      assertLive: entry.assertLive,
      changed: (scope) => this.host.changed(threadId, scope),
      userMessageOrigin: (messageId) => this.host.userMessageOrigin?.(threadId, messageId),
      pendingQuestion: () => this.host.pendingQuestion?.(threadId) ?? null,
      publish: async (value) => {
        entry.assertLive()
        const published = await this.host.publish(workspace, value, controller.signal)
        entry.assertLive()
        return published
      },
      dispatch: async (event, input, options) => {
        entry.assertLive()
        const signal = options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal
        signal.throwIfAborted()
        const result = await dispatcher.dispatch(event, input, {
          signal,
          origin: options.origin,
          core: async (_event, received) => {
            entry.assertLive()
            signal.throwIfAborted()
            if (!options.core) throw new ModFunctionError("MODS_UI_ACTION_INVALID")
            const value = await options.core(received, signal)
            entry.assertLive()
            signal.throwIfAborted()
            return value
          }
        })
        entry.assertLive()
        signal.throwIfAborted()
        return result.value
      },
      callback: async () => {
        throw new ModFunctionError("MODS_UI_ACTION_INVALID")
      }
    })
    this.entries.set(key, entry)
    return entry
  }

  async mount(
    workspace: string,
    threadId: string,
    component: FunctionUiSite,
    messageId?: string,
    expectedRequestId?: string
  ): Promise<string> {
    if (this.pending >= FUNCTION_HOST_ONLY_MOUNT_LIMIT)
      throw new ModFunctionError("MODS_UI_SITE_MOUNT_CAPACITY")
    if (this.owners.size + this.pending >= FUNCTION_HOST_ONLY_SITE_LIMIT)
      throw new ModFunctionError("MODS_UI_SITE_LIMIT")
    const entry = this.entry(workspace, threadId)
    if (entry.owners.size + entry.pending >= FUNCTION_HOST_ONLY_THREAD_SITE_LIMIT)
      throw new ModFunctionError("MODS_UI_SITE_LIMIT")
    this.pending++
    entry.pending++
    try {
      entry.assertLive()
      const owner = await entry.sites.mount(component, messageId, expectedRequestId)
      entry.assertLive()
      // FunctionUiSites replaces its singleton slot. Retire that exact routing alias as well.
      if (!repeated.has(component))
        for (const previous of entry.owners)
          if (this.owners.get(previous)?.component === component) {
            this.owners.delete(previous)
            entry.owners.delete(previous)
          }
      this.owners.set(owner, { entry, component })
      entry.owners.add(owner)
      return owner
    } finally {
      this.pending--
      entry.pending--
      this.releaseEmpty(entry)
    }
  }

  private owned(workspace: string, threadId: string, owner: string): HostOnlyEntry {
    const entry = this.owners.get(owner)?.entry
    if (!entry || entry.workspace !== workspace || entry.threadId !== threadId)
      throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    entry.assertLive()
    return entry
  }

  async render(
    workspace: string,
    threadId: string,
    owner: string,
    props: ModObject
  ): Promise<FunctionPaneSnapshot> {
    const entry = this.owned(workspace, threadId, owner)
    const snapshot = await entry.sites.render(owner, props)
    if (this.owned(workspace, threadId, owner) !== entry)
      throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    return snapshot
  }

  async act(workspace: string, threadId: string, owner: string, action: FunctionUiAction) {
    const entry = this.owned(workspace, threadId, owner)
    const result = await entry.sites.act(owner, action)
    if (this.owned(workspace, threadId, owner) !== entry)
      throw new ModFunctionError("MODS_UI_SITE_CLOSED")
    return result
  }

  async unmount(workspace: string, threadId: string, owner: string): Promise<void> {
    if (!this.owners.has(owner)) return
    const entry = this.owned(workspace, threadId, owner)
    try {
      await entry.sites.unmount(owner)
    } finally {
      if (this.owners.get(owner)?.entry === entry) this.owners.delete(owner)
      entry.owners.delete(owner)
      this.releaseEmpty(entry)
    }
  }

  /** Retire a host-created mount which failed admission before its owner was delivered. */
  retireOwner(owner: string): void {
    const entry = this.owners.get(owner)?.entry
    if (!entry) return
    entry.sites.retire(owner)
    this.owners.delete(owner)
    entry.owners.delete(owner)
    this.releaseEmpty(entry)
  }

  private releaseEmpty(entry: HostOnlyEntry): void {
    if (!entry.owners.size && !entry.pending) this.retire(entry)
  }

  private retire(entry: HostOnlyEntry): void {
    const key = JSON.stringify([entry.workspace, entry.threadId])
    if (this.entries.get(key) !== entry) return
    this.entries.delete(key)
    for (const owner of entry.owners) this.owners.delete(owner)
    entry.owners.clear()
    entry.controller.abort(new ModFunctionError("MODS_SCOPE_CHANGED"))
    entry.sites.close()
  }

  invalidate(workspace: string): void {
    for (const entry of this.entries.values()) if (entry.workspace === workspace) this.retire(entry)
  }

  closeThread(threadId: string): void {
    for (const entry of this.entries.values()) if (entry.threadId === threadId) this.retire(entry)
  }

  close(): void {
    this.closed = true
    for (const entry of this.entries.values()) this.retire(entry)
  }
}
