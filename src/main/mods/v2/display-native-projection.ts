import { createHash, randomUUID } from "node:crypto"
import type { ModJson, ModObject, ModUiChangeScope } from "../../../shared/mods/types"
import { encodeModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  FUNCTION_PASSIVE_DISPLAY_SITES,
  functionSiteProps,
  validateFunctionSiteTree,
  type FunctionUiSite
} from "../../../shared/mods/v2/sites"
import type { FunctionDisplaySnapshot } from "../../../shared/mods/v2/display-snapshot"
import type { FunctionDisplaySnapshotData } from "../../../shared/mods/v2/display-snapshot"
import type { FunctionPluginPromptOrigin } from "../../../shared/mods/v2/plugin-prompt"
import {
  functionHostMessageProps,
  functionHostMessagePublication,
  functionMessageTextMode
} from "../../../shared/mods/v2/host-message"
import { FunctionNativeDrawing } from "./native-engine"
import {
  FunctionDisplayScopes,
  type FunctionDisplayScope,
  type FunctionDisplayScopeInput
} from "./display-scopes"
import { FunctionDisplaySnapshotCache } from "./display-snapshot-cache"

export interface FunctionNativeDisplayAdmission {
  version: string
  assertCurrent(): void
  /** Identity-only checks for private bookkeeping; public and async boundaries still use full checks. */
  assertIdentity?(): void
}
interface DisplayRowVersion {
  digest: string
  version: string
}
export interface FunctionPreparedDisplayRead {
  readonly scope: FunctionDisplayScope
  readonly key: string
  readonly input: ModObject
  readonly row: DisplayRowVersion
}
interface ProjectionHost {
  capture(workspace: string, threadId: string): FunctionDisplayScopeInput
  publish(workspace: string, value: ModJson, signal: AbortSignal): Promise<ModJson>
  userMessageOrigin?(threadId: string, messageId: string): FunctionPluginPromptOrigin | undefined
  changed?(threadId: string, scope: ModUiChangeScope): void
}

/** Host-only publication, with the same input and output protection as an owned drawing.
 * No Pane, guest, callback generation or fabricated owner is allocated for passive text.
 */
export class FunctionNativeDisplayProjection {
  private readonly scopes = new FunctionDisplayScopes()
  // Main uses 14 MiB; all providers in each renderer separately share a 2 MiB budget.
  // Additional renderer processes have their own budget, not one application-wide 16 MiB pool.
  private readonly cache = new FunctionDisplaySnapshotCache(this.scopes, {
    maxBytes: 14 * 1024 * 1024
  })
  private readonly active = new Map<
    string,
    { workspace: string; threadId: string; scopeId: string }
  >()
  private readonly lifetime = new AbortController()
  private readonly unretainedMessages = new Set<{
    workspace: string
    threadId: string
    controller: AbortController
  }>()
  private readonly guestReads = new Map<string, Promise<void>>()
  private readonly rows = new WeakMap<FunctionDisplayScope, Map<string, DisplayRowVersion>>()

  constructor(private readonly host: ProjectionHost) {}

  private rowKey(component: FunctionUiSite, presentationId: string, messageId?: string): string {
    return createHash("sha256")
      .update(encodeModJson({ component, presentationId, messageId: messageId ?? null }))
      .digest("hex")
  }

  /** A real owner takes over future dependency notifications; release its old passive proof. */
  discard(
    workspace: string,
    threadId: string,
    component: FunctionUiSite,
    presentationId: string,
    messageId?: string
  ): void {
    const entry = this.active.get(JSON.stringify([workspace, threadId]))
    const scope = entry && this.scopes.read(entry.scopeId)
    if (!scope) return
    const key = this.rowKey(component, presentationId, messageId)
    this.rows.get(scope)?.delete(key)
    this.cache.deleteEntry(scope, key)
  }

  /** Native children have a real host guard, but no persistent DB/thread cache identity.
   * Publish once without registering a scope or retaining data in either display cache.
   */
  async readUnretainedMessage(
    workspace: string,
    threadId: string,
    component: FunctionUiSite,
    props: ModObject,
    admission: FunctionNativeDisplayAdmission,
    presentationId?: string,
    messageId?: string
  ): Promise<FunctionDisplaySnapshot> {
    if (
      presentationId !== undefined &&
      (typeof presentationId !== "string" || !presentationId || presentationId.length > 2048)
    )
      throw new ModFunctionError("MODS_DISPLAY_KEY_INVALID")
    const operation = { workspace, threadId, controller: new AbortController() }
    const signal = AbortSignal.any([this.lifetime.signal, operation.controller.signal])
    const current = () => {
      signal.throwIfAborted()
      admission.assertCurrent()
    }
    this.unretainedMessages.add(operation)
    try {
      current()
      const facts =
        component === "UserMessage"
          ? {
              ...props,
              origin: (messageId && this.host.userMessageOrigin?.(threadId, messageId)) || {
                kind: "unclassified"
              }
            }
          : props
      const input = functionHostMessageProps(component, facts)
      const data = await this.protectHostMessage(component, input, async (value) => {
        current()
        const result = await this.host.publish(workspace, value, signal)
        current()
        return result
      })
      current()
      return {
        // An opaque read identity, never a fabricated persistent scope or authority.
        scopeId: "unretained:" + randomUUID(),
        key: createHash("sha256")
          .update(
            encodeModJson({
              component,
              presentationId: presentationId ?? null,
              messageId: messageId ?? null
            })
          )
          .digest("hex"),
        version: randomUUID(),
        // Already expired for retention; the committed view keeps its normal live ticket.
        expiresAt: 0,
        data
      }
    } finally {
      try {
        current()
      } finally {
        this.unretainedMessages.delete(operation)
      }
    }
  }

  private async protectHostMessage(
    component: FunctionUiSite,
    input: ModObject,
    publish: (value: ModJson) => Promise<ModJson>
  ): Promise<FunctionDisplaySnapshotData> {
    const safeInput = functionHostMessagePublication(component, await publish(input), input)
    const safeOutput = functionHostMessagePublication(component, await publish(safeInput), input)
    return { component, hostMessage: safeOutput }
  }

  prepareRead(
    workspace: string,
    threadId: string,
    component: FunctionUiSite,
    props: ModObject,
    presentationId: string,
    messageId?: string
  ): FunctionPreparedDisplayRead {
    this.lifetime.signal.throwIfAborted()
    if (
      !presentationId ||
      presentationId.length > 2048 ||
      !FUNCTION_PASSIVE_DISPLAY_SITES.includes(component)
    )
      throw new ModFunctionError("MODS_DISPLAY_KEY_INVALID")
    const facts: ModObject =
      component === "UserMessage"
        ? {
            ...props,
            origin: (messageId && this.host.userMessageOrigin?.(threadId, messageId)) || {
              kind: "unclassified"
            }
          }
        : props
    const wholeMessage =
      ["UserMessage", "AssistantMessage"].includes(component) &&
      typeof facts.text === "string" &&
      functionMessageTextMode(facts.text) === "host-message"
    const input = wholeMessage
      ? functionHostMessageProps(component, facts)
      : functionSiteProps(component, facts)
    const slot = JSON.stringify([workspace, threadId])
    const previous = this.active.get(slot)
    if (previous) {
      try {
        this.scopes.read(previous.scopeId)
      } catch {
        this.cache.deleteScope(previous.scopeId)
        this.active.delete(slot)
      }
    }
    if (!this.active.has(slot) && this.active.size >= 256) {
      const oldest = this.active.entries().next().value
      if (oldest) {
        this.cache.deleteScope(oldest[1].scopeId)
        this.active.delete(oldest[0])
      }
    }
    const scope = this.scopes.capture(this.host.capture(workspace, threadId))
    const prior = this.active.get(slot)
    if (prior && prior.scopeId !== scope.id) this.cache.deleteScope(prior.scopeId)
    this.active.delete(slot)
    this.active.set(slot, { workspace, threadId, scopeId: scope.id })
    const key = this.rowKey(component, presentationId, messageId)
    const versions = this.rows.get(scope) ?? new Map<string, DisplayRowVersion>()
    const digest = createHash("sha256").update(encodeModJson(input)).digest("hex")
    const old = versions.get(key)
    const row = old?.digest === digest ? old : Object.freeze({ digest, version: randomUUID() })
    versions.delete(key)
    while (versions.size >= 96) versions.delete(versions.keys().next().value!)
    versions.set(key, row)
    this.rows.set(scope, versions)
    return Object.freeze({ scope, key, input, row })
  }

  private version(
    read: FunctionPreparedDisplayRead,
    admission: FunctionNativeDisplayAdmission
  ): string {
    return createHash("sha256").update(admission.version).update(read.row.version).digest("hex")
  }

  /** This closure deliberately retains no raw input or prepared-read object. */
  private guard(
    scope: FunctionDisplayScope,
    key: string,
    row: DisplayRowVersion,
    admission: FunctionNativeDisplayAdmission
  ): () => void {
    return () => {
      this.lifetime.signal.throwIfAborted()
      this.scopes.assertCurrent(scope)
      if (admission.assertIdentity) admission.assertIdentity()
      else admission.assertCurrent()
      if (this.rows.get(scope)?.get(key) !== row)
        throw new ModFunctionError("MODS_DISPLAY_ROW_CHANGED")
    }
  }

  lookup(
    read: FunctionPreparedDisplayRead,
    admission: FunctionNativeDisplayAdmission
  ): FunctionDisplaySnapshot | null {
    admission.assertCurrent()
    try {
      this.guard(read.scope, read.key, read.row, admission)()
      return this.cache.read(read.scope, read.key, this.version(read, admission))
    } finally {
      admission.assertCurrent()
    }
  }

  /** Only proved passive draws may wait here. Followers never receive another drawing's owner.
   * They recheck their own admission and read the retained data, or obtain their own real owner.
   */
  async reuseOrRun<T>(
    read: FunctionPreparedDisplayRead,
    admission: FunctionNativeDisplayAdmission,
    run: () => Promise<T>,
    reuse: (snapshot: FunctionDisplaySnapshot) => T
  ): Promise<T> {
    admission.assertCurrent()
    try {
      const id = JSON.stringify([read.scope.id, read.key, this.version(read, admission)])
      for (;;) {
        this.guard(read.scope, read.key, read.row, admission)()
        const pending = this.guestReads.get(id)
        if (!pending) break
        await pending
        // Each waiter has its own full source/permission fence after the physical producer.
        const cached = this.lookup(read, admission)
        if (cached) return reuse(cached)
      }
      if (this.guestReads.size >= 256) throw new ModFunctionError("MODS_DISPLAY_PENDING_LIMIT")
      let complete!: () => void
      const settled = new Promise<void>((resolve) => {
        complete = resolve
      })
      this.guestReads.set(id, settled)
      try {
        return await run()
      } finally {
        if (this.guestReads.get(id) === settled) this.guestReads.delete(id)
        complete()
      }
    } finally {
      admission.assertCurrent()
    }
  }

  private invalidateRow(threadId: string, key: string): () => void {
    let notified = false
    return () => {
      if (notified) return
      notified = true
      this.host.changed?.(threadId, `site-projection:${key}`)
    }
  }

  reclaimDependencies(
    read: FunctionPreparedDisplayRead,
    admission: FunctionNativeDisplayAdmission
  ): boolean {
    admission.assertCurrent()
    try {
      this.guard(read.scope, read.key, read.row, admission)()
      return this.cache.evictOldest(read.scope)
    } finally {
      // Eviction releases dependencies and notifies observers; neither is a pure region.
      admission.assertCurrent()
      this.guard(read.scope, read.key, read.row, admission)()
    }
  }

  remember(
    read: FunctionPreparedDisplayRead,
    threadId: string,
    admission: FunctionNativeDisplayAdmission,
    data: FunctionDisplaySnapshotData,
    dependencies: { current(): boolean; release(): void; listen?(listener: () => void): void }
  ): FunctionDisplaySnapshot | undefined {
    let handedOff = false
    try {
      admission.assertCurrent()
      const { scope, key, row } = read
      const version = this.version(read, admission)
      const invalidated = this.invalidateRow(threadId, key)
      dependencies.listen?.(invalidated)
      const proof = this.cache.captureProof(scope, {
        version,
        assertCurrent: this.guard(scope, key, row, admission),
        reusable: true,
        dependencies,
        onEvict: invalidated
      })
      if (!proof) return undefined
      handedOff = true
      try {
        this.cache.write(scope, key, proof, data)
        // A guest's dependency subscription must actually survive the owner handoff.
        // Oversized or disabled-cache writes are valid display, but keep the real owner.
        return this.cache.read(scope, key, version) ?? undefined
      } catch (error) {
        this.cache.releaseProof(proof)
        throw error
      }
    } finally {
      try {
        if (!handedOff) dependencies.release()
      } finally {
        admission.assertCurrent()
      }
    }
  }

  async read(
    workspace: string,
    threadId: string,
    component: FunctionUiSite,
    props: ModObject,
    presentationId: string,
    admission: FunctionNativeDisplayAdmission,
    messageId?: string
  ): Promise<FunctionDisplaySnapshot> {
    const read = this.prepareRead(workspace, threadId, component, props, presentationId, messageId)
    return this.readPrepared(workspace, component, read, admission)
  }

  async readPrepared(
    workspace: string,
    component: FunctionUiSite,
    read: FunctionPreparedDisplayRead,
    admission: FunctionNativeDisplayAdmission,
    retain = true
  ): Promise<FunctionDisplaySnapshot> {
    admission.assertCurrent()
    try {
      return await this.produce(workspace, component, read, admission, retain)
    } finally {
      admission.assertCurrent()
    }
  }

  private async produce(
    workspace: string,
    component: FunctionUiSite,
    read: FunctionPreparedDisplayRead,
    admission: FunctionNativeDisplayAdmission,
    retain: boolean
  ): Promise<FunctionDisplaySnapshot> {
    const { scope, key, input, row } = read
    const version = this.version(read, admission)
    const current = this.guard(scope, key, row, admission)
    current()
    const cached = retain ? this.cache.read(scope, key, version) : null
    if (cached) return cached
    const proof = this.cache.captureProof(scope, {
      version,
      assertCurrent: current,
      reusable: true
    })
    if (!proof) throw new ModFunctionError("MODS_DISPLAY_PROOF_INVALID")
    return this.cache.resolve(
      scope,
      key,
      proof,
      async () => {
        const assertCurrent = current
        const publish = async (value: ModJson): Promise<ModJson> => {
          assertCurrent()
          admission.assertCurrent()
          const result = await this.host.publish(workspace, value, this.lifetime.signal)
          admission.assertCurrent()
          assertCurrent()
          return result
        }
        if (
          ["UserMessage", "AssistantMessage"].includes(component) &&
          typeof input.text === "string" &&
          functionMessageTextMode(input.text) === "host-message"
        ) {
          // Existing oversized/empty messages have never entered the guest render API.
          // Keep that ceiling and whole-Markdown semantics, but protect both boundaries.
          const result = await this.protectHostMessage(component, input, publish)
          assertCurrent()
          return result
        }
        const received: ModObject = {
          surface: "desktop",
          component,
          requestId: randomUUID(),
          props: input
        }
        const drawing = new FunctionNativeDrawing(received, assertCurrent)
        const tree = drawing.keep(received)
        validateFunctionSiteTree(tree)
        drawing.beginPublication()
        await drawing.protect(tree, publish)
        // Publish the output tree too: native input protection alone is not output protection.
        const output = await publish({ tree })
        if (!isModObject(output) || Object.keys(output).some((key) => key !== "tree"))
          throw new ModFunctionError("MODS_UI_PUBLICATION")
        validateFunctionSiteTree(output.tree)
        const nativeContent = await drawing.protect(output.tree, publish)
        assertCurrent()
        return { component, tree: output.tree, nativeContent }
      },
      retain
    )
  }

  /** Native-only projections may have no guest session or legacy site owner to enumerate. */
  workspaces(): string[] {
    return [
      ...new Set(
        [...this.active.values(), ...this.unretainedMessages].map((entry) => entry.workspace)
      )
    ]
  }

  invalidate(workspace?: string, threadId?: string, notify = false): void {
    const changed = new Set<string>()
    for (const operation of this.unretainedMessages)
      if (
        (workspace === undefined || operation.workspace === workspace) &&
        (threadId === undefined || operation.threadId === threadId)
      ) {
        operation.controller.abort(new ModFunctionError("MODS_DISPLAY_SCOPE_CHANGED"))
        changed.add(operation.threadId)
      }
    for (const [key, entry] of this.active)
      if (
        (workspace === undefined || entry.workspace === workspace) &&
        (threadId === undefined || entry.threadId === threadId)
      ) {
        this.cache.deleteScope(entry.scopeId)
        this.active.delete(key)
        changed.add(entry.threadId)
      }
    if (notify) for (const id of changed) this.host.changed?.(id, "site-presentations:*")
  }

  stats() {
    return { ...this.cache.stats(), guestPending: this.guestReads.size }
  }

  close(): void {
    this.lifetime.abort(new ModFunctionError("MODS_DISPLAY_SCOPE_CHANGED"))
    this.cache.clear()
    this.active.clear()
  }
}
