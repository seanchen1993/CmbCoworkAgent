import { AsyncResource } from "node:async_hooks"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionPluginPromptOrigin } from "../../../shared/mods/v2/plugin-prompt"
import {
  samePromptSubmissionOrigin,
  validatePromptSubmissionInput,
  validatePromptSubmissionResult
} from "../../../shared/mods/v2/prompt-submission"

export interface FunctionPluginPromptScope {
  readonly workspace: string
  readonly threadId: string
  readonly origin: FunctionPluginPromptOrigin
  readonly signal: AbortSignal
  assertLive(): void
}

export interface FunctionPluginPromptLease {
  assertCurrent(): void
  release(): void | Promise<void>
}

export interface FunctionPluginPromptQueueHost {
  busy(threadId: string): boolean
  claim(threadId: string): FunctionPluginPromptLease | undefined
  run(
    scope: FunctionPluginPromptScope,
    input: ModObject,
    framed: boolean,
    lease: FunctionPluginPromptLease,
    signal: AbortSignal,
    started: () => void
  ): Promise<void>
  onIdle(listener: (threadId: string) => void): () => void
  error?(error: unknown): void
}

interface Entry {
  scope: FunctionPluginPromptScope
  controller: AbortController
  signal: AbortSignal
  detach(): void
  input?: ModObject
  final?: ModObject
  ready: boolean
  started: boolean
  running: boolean
  removed: boolean
  framed: boolean
  resolve(value: ModObject): void
  reject(error: unknown): void
  result: Promise<ModObject>
}

export interface FunctionPluginPromptTicket {
  readonly signal: AbortSignal
  assertLive(): void
  cancel(error: unknown): void
  deferUntil(ready: Promise<unknown>): void
  accept(input: ModObject): ModObject
  finish(value: ModObject): void
  fail(error: unknown): void
  wait(): Promise<ModObject>
  close(): void
}

/** Private resident ownership: dispatch admission, core commit and native start are distinct. */
export class FunctionPluginPromptQueue {
  private readonly entries = new Set<Entry>()
  private readonly queues = new Map<string, Entry[]>()
  private readonly draining = new Set<string>()
  private readonly rates = new Map<string, number[]>()
  // Constructed by the resident host, outside any SDK child. Native runs and their
  // terminal lease callbacks must not inherit a child's private ALS guards.
  private readonly dispatchOwner = new AsyncResource("mods-plugin-prompt-queue", {
    requireManualDestroy: true
  })
  private readonly stopIdle: () => void
  private closed = false

  constructor(
    private readonly host: FunctionPluginPromptQueueHost,
    private readonly now = performance.now.bind(performance)
  ) {
    this.stopIdle = host.onIdle((threadId) => this.wake(threadId))
  }

  get size(): number {
    return this.entries.size
  }

  reserve(scope: FunctionPluginPromptScope): FunctionPluginPromptTicket {
    scope.signal.throwIfAborted()
    scope.assertLive()
    if (this.closed) throw new ModFunctionError("MODS_PLUGIN_PROMPT_CLOSED")
    const sameThread = [...this.entries].filter((e) => e.scope.threadId === scope.threadId)
    if (
      this.entries.size >= 64 ||
      sameThread.length >= 16 ||
      sameThread.filter((e) => e.scope.origin.name === scope.origin.name).length >= 8
    )
      throw new ModFunctionError("MODS_PLUGIN_PROMPT_CAPACITY")
    const controller = new AbortController()
    let resolve!: Entry["resolve"], reject!: Entry["reject"]
    const result = new Promise<ModObject>((yes, no) => {
      resolve = yes
      reject = no
    })
    void result.catch(() => {})
    const entry: Entry = {
      scope,
      controller,
      signal: AbortSignal.any([controller.signal, scope.signal]),
      detach: () => scope.signal.removeEventListener("abort", abort),
      ready: false,
      started: false,
      running: false,
      removed: false,
      framed: scope.origin.asUser !== true,
      resolve,
      reject,
      result
    }
    const abort = () => this.cancel(entry, scope.signal.reason)
    scope.signal.addEventListener("abort", abort, { once: true })
    this.entries.add(entry)
    let startupReady = true
    return {
      signal: entry.signal,
      assertLive: () => this.assert(entry),
      cancel: (error) => this.cancel(entry, error),
      deferUntil: (ready) => {
        this.assert(entry)
        startupReady = false
        void ready.then(
          () => {
            startupReady = true
            if (entry.final) entry.ready = true
            this.wake(scope.threadId)
          },
          (error) => this.cancel(entry, error)
        )
      },
      accept: (input) => {
        this.assert(entry)
        validatePromptSubmissionInput(input)
        if (
          !samePromptSubmissionOrigin(input.origin, scope.origin) ||
          input.wait !== false ||
          input.turnId !== undefined
        )
          throw new ModFunctionError("MODS_PINNED_INPUT")
        if (!entry.input) {
          this.charge(scope)
          entry.input = structuredClone(input)
          const queue = this.queues.get(scope.threadId) ?? []
          queue.push(entry)
          this.queues.set(scope.threadId, queue)
        }
        return this.accepted(entry)
      },
      finish: (value) => {
        this.assert(entry)
        validatePromptSubmissionResult(
          value,
          entry.input ?? {
            text: "",
            origin: scope.origin,
            wait: false
          }
        )
        if (!entry.input) {
          entry.resolve(structuredClone(value))
          this.remove(entry)
          return
        }
        entry.final = structuredClone(value)
        entry.framed = scope.origin.asUser !== true && value.origin !== undefined
        entry.ready = startupReady
        this.wake(scope.threadId)
      },
      fail: (error) => {
        entry.reject(error)
        if (entry.removed) return
        try {
          this.assert(entry)
        } catch (failure) {
          this.cancel(entry, failure)
          return
        }
        // A failure after a real core commit cannot erase that accepted effect.
        if (entry.input) {
          entry.final = this.accepted(entry)
          entry.ready = startupReady
          this.wake(scope.threadId)
        } else this.remove(entry)
      },
      wait: () => result,
      close: () => {
        // A committed effect belongs to this queue, not to its public result waiter.
        if (entry.removed) return
        try {
          this.assert(entry)
        } catch (error) {
          this.cancel(entry, error)
          return
        }
        if (!entry.input) this.cancel(entry, new ModFunctionError("MODS_RESOURCE_CLOSED"))
      }
    }
  }

  private accepted(entry: Entry): ModObject {
    if (!entry.input) throw new ModFunctionError("MODS_PLUGIN_PROMPT_NOT_ACCEPTED")
    return {
      text: entry.input.text,
      origin: structuredClone(entry.scope.origin),
      ...(entry.input.context === undefined
        ? {}
        : { context: structuredClone(entry.input.context) })
    }
  }

  private assert(entry: Entry): void {
    if (this.closed || entry.removed) throw new ModFunctionError("MODS_PLUGIN_PROMPT_CLOSED")
    entry.signal.throwIfAborted()
    entry.scope.assertLive()
  }

  private charge(scope: FunctionPluginPromptScope): void {
    const now = this.now()
    for (const [key, times] of this.rates)
      if (times.every((time) => now - time >= 60000)) this.rates.delete(key)
    const key = JSON.stringify([scope.workspace, scope.origin.name])
    const times = (this.rates.get(key) ?? []).filter((time) => now - time < 60000)
    if (times.length >= 20 || (!this.rates.has(key) && this.rates.size >= 128))
      throw new ModFunctionError("MODS_PLUGIN_PROMPT_RATE_LIMIT")
    times.push(now)
    this.rates.set(key, times)
  }

  private wake(threadId: string): void {
    if (this.closed || this.draining.has(threadId) || !this.queues.has(threadId)) return
    this.draining.add(threadId)
    queueMicrotask(() => {
      this.dispatchOwner.runInAsyncScope(() => {
        void this.drain(threadId)
      })
    })
  }

  private async drain(threadId: string): Promise<void> {
    try {
      while (!this.closed) {
        const entry = this.queues.get(threadId)?.[0]
        if (!entry) break
        try {
          this.assert(entry)
        } catch (error) {
          this.cancel(entry, error)
          continue
        }
        if (!entry.ready) break
        try {
          if (this.host.busy(threadId)) break
        } catch (error) {
          this.cancel(entry, error)
          continue
        }
        let lease: FunctionPluginPromptLease | undefined
        try {
          lease = this.host.claim(threadId)
        } catch (error) {
          this.cancel(entry, error)
          continue
        }
        if (!lease) break
        try {
          lease.assertCurrent()
          this.assert(entry)
          entry.running = true
          await this.host.run(
            entry.scope,
            structuredClone(entry.input!),
            entry.framed,
            lease,
            entry.signal,
            () => {
              this.assert(entry)
              lease!.assertCurrent()
              if (entry.started) return
              entry.started = true
              entry.resolve(structuredClone(entry.final!))
            }
          )
          if (!entry.started) entry.reject(new ModFunctionError("MODS_PLUGIN_PROMPT_NOT_STARTED"))
        } catch (error) {
          entry.reject(error)
        } finally {
          try {
            await lease.release()
          } catch (error) {
            entry.reject(error)
            try {
              this.host.error?.(error)
            } catch {
              /* Cleanup must still release queue capacity. */
            }
          } finally {
            this.remove(entry)
          }
        }
      }
    } finally {
      this.draining.delete(threadId)
    }
  }

  private cancel(entry: Entry, error: unknown): void {
    if (entry.removed) return
    entry.reject(error)
    entry.controller.abort(error)
    if (!entry.running) this.remove(entry)
  }

  private remove(entry: Entry): void {
    if (entry.removed) return
    entry.removed = true
    entry.detach()
    this.entries.delete(entry)
    const queue = this.queues.get(entry.scope.threadId)
    if (queue) {
      const index = queue.indexOf(entry)
      if (index >= 0) queue.splice(index, 1)
      if (!queue.length) this.queues.delete(entry.scope.threadId)
      else this.wake(entry.scope.threadId)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.dispatchOwner.emitDestroy()
    this.stopIdle()
    for (const entry of this.entries)
      this.cancel(entry, new ModFunctionError("MODS_PLUGIN_PROMPT_CLOSED"))
  }
}
