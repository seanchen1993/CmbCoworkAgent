import { randomUUID } from "node:crypto"
import {
  validPromptSnapshot,
  PROMPT_COMPOSER_MAX_BYTES,
  type PromptComposerRequest,
  type PromptComposerResponse,
  type PromptComposerSnapshot,
  type PromptFillMode,
  type PromptFillResult
} from "../../../shared/mods/v2/prompt-composer"
import type { PromptEditRequest } from "../../../shared/mods/v2/prompt-composer"
import {
  validatePromptEditInput, validatePromptEditResult, validatePromptDecorations,
  type FunctionPromptEditInput, type FunctionPromptEditResult
} from "../../../shared/mods/v2/prompt-edit"
import { isModObject } from "../../../shared/mods/v2/contracts"

export interface FunctionPromptScope {
  threadId: string
  pluginId: string
  sessionId: string
  signal: AbortSignal
  assertLive(): void
}
type Owner = { id: string; senderId: number; editSequence: number; send(request: PromptComposerRequest): void }
type Lease = PromptComposerSnapshot & { threadId: string; owner: string }
type Pending = {
  scope: FunctionPromptScope
  owner: Owner
  kind: "read" | "fill" | "suggest"
  authorized?: boolean
  resolve(response: PromptComposerResponse): void
  reject(error: Error): void
  cleanup(): void
}

/** Private renderer leases never enter guest state or hook-mutable prompt payloads. */
export class FunctionPromptBroker {
  private owners = new Map<string, Owner>()
  private reads = new Map<string, Lease>()
  private pending = new Map<string, Pending>()
  private edits = new Map<string, { owner: Owner; sequence: number; controller: AbortController }>()
  attach(threadId: string, id: string, senderId: number, send: Owner["send"]): void {
    if (!id || id.length > 100) throw Error("MODS_PROMPT_OWNER_INVALID")
    this.closeThread(threadId)
    this.owners.set(threadId, { id, senderId, send, editSequence: 0 })
  }
  assertEditor(senderId: number, threadId: string, id: string): void {
    const owner = this.owners.get(threadId)
    if (!owner || owner.id !== id || owner.senderId !== senderId) throw Error("MODS_PROMPT_EDITOR_OWNER")
  }
  cancelEdit(senderId: number, threadId: string, id: string, sequence: number): void {
    this.assertEditor(senderId, threadId, id)
    const edit = this.edits.get(threadId)
    if (edit?.sequence === sequence) edit.controller.abort(Error("MODS_PROMPT_EDIT_CANCELLED"))
  }
  async edit(senderId: number, request: PromptEditRequest, run: (
    input: FunctionPromptEditInput, signal: AbortSignal, assertOwner: () => void,
    nativeCursor?: number
  ) => Promise<FunctionPromptEditResult>): Promise<FunctionPromptEditResult> {
    if (!request || typeof request.threadId !== "string" || typeof request.owner !== "string" ||
      !Number.isSafeInteger(request.sequence) || request.sequence < 1 || !isModObject(request.input) ||
      Object.keys(request).some(key => !["threadId", "owner", "sequence", "input", "nativeCursor"].includes(key)))
      throw Error("MODS_PROMPT_EDIT_REQUEST")
    this.assertEditor(senderId, request.threadId, request.owner)
    const owner = this.owners.get(request.threadId)!
    if (request.sequence <= owner.editSequence) throw Error("MODS_PROMPT_EDIT_STALE")
    validatePromptEditInput(request.input)
    const nativeLength = request.input.text.length - (request.input.end - request.input.start) + request.input.inputText.length
    if (request.nativeCursor !== undefined && (!Number.isSafeInteger(request.nativeCursor) ||
      request.nativeCursor < 0 || request.nativeCursor > nativeLength)) throw Error("MODS_PROMPT_EDIT_REQUEST")
    owner.editSequence = request.sequence
    this.edits.get(request.threadId)?.controller.abort(Error("MODS_PROMPT_EDIT_SUPERSEDED"))
    const current = { owner, sequence: request.sequence, controller: new AbortController() }
    this.edits.set(request.threadId, current)
    const assertOwner = () => {
      current.controller.signal.throwIfAborted()
      if (this.owners.get(request.threadId) !== owner || this.edits.get(request.threadId) !== current)
        throw Error("MODS_PROMPT_EDITOR_OWNER")
    }
    try {
      assertOwner()
      const result = await run(structuredClone(request.input), current.controller.signal, assertOwner,
        request.nativeCursor)
      assertOwner()
      validatePromptEditResult(result)
      return structuredClone(result)
    } finally {
      if (this.edits.get(request.threadId) === current) this.edits.delete(request.threadId)
    }
  }
  detach(threadId: string, owner: string, senderId: number): void {
    const current = this.owners.get(threadId)
    if (current?.id === owner && current.senderId === senderId) this.closeThread(threadId)
  }
  authorize(senderId: number, requestId: string, threadId: string, owner: string): boolean {
    const pending = this.pending.get(requestId)
    if (
      !pending ||
      pending.kind === "read" ||
      pending.authorized ||
      pending.owner.senderId !== senderId ||
      pending.owner.id !== owner ||
      pending.scope.threadId !== threadId
    )
      return false
    try {
      pending.scope.assertLive()
      if (pending.scope.signal.aborted) throw Error("MODS_CANCELLED")
      pending.authorized = true
      return true
    } catch {
      return false
    }
  }
  respond(senderId: number, response: PromptComposerResponse): void {
    const pending = this.pending.get(response?.requestId)
    if (
      !pending ||
      pending.owner.senderId !== senderId ||
      pending.owner.id !== response.owner ||
      pending.scope.threadId !== response.threadId
    )
      return
    if (
      !validPromptSnapshot(response) ||
      !["ok", "no_composer", "dialog", "conflict"].includes(response.status) ||
      (pending.kind !== "read" && response.status === "ok" && !pending.authorized) ||
      (pending.kind === "suggest" && (typeof response.isShown !== "boolean" ||
        (response.isShown && response.status !== "ok")))
    ) {
      pending.reject(Error("MODS_PROMPT_RESPONSE_INVALID"))
      pending.cleanup()
      return
    }
    pending.cleanup()
    try {
      pending.scope.assertLive()
      if (pending.scope.signal.aborted) throw Error("MODS_CANCELLED")
      pending.resolve(response)
    } catch (error) {
      pending.reject(error instanceof Error ? error : Error(String(error)))
    }
  }
  private request(
    scope: FunctionPromptScope,
    kind: "read" | "fill" | "suggest",
    input: Partial<PromptComposerRequest> = {}
  ): Promise<PromptComposerResponse | undefined> {
    scope.assertLive()
    if (scope.signal.aborted) throw Error("MODS_CANCELLED")
    const owner = this.owners.get(scope.threadId)
    if (!owner) return Promise.resolve(undefined)
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const cleanup = () => {
        clearTimeout(timer)
        scope.signal.removeEventListener("abort", abort)
        this.pending.delete(requestId)
      }
      const abort = () => {
        cleanup()
        reject(Error("MODS_CANCELLED"))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(Error("MODS_PROMPT_TIMEOUT"))
      }, 5000)
      this.pending.set(requestId, { scope, owner, kind, resolve, reject, cleanup })
      scope.signal.addEventListener("abort", abort, { once: true })
      try {
        owner.send({ ...input, requestId, threadId: scope.threadId, owner: owner.id, kind })
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }
  async read(scope: FunctionPromptScope): Promise<{ text: string; cursor: number }> {
    return this.snapshot(scope, true)
  }
  /** SDK readback must never refresh the lease captured before a fill hook awaited. */
  async peek(scope: FunctionPromptScope): Promise<{ text: string; cursor: number }> {
    return this.snapshot(scope, false)
  }
  async prepareFill(scope: FunctionPromptScope): Promise<void> {
    scope.assertLive()
    if (scope.signal.aborted) throw Error("MODS_CANCELLED")
    if (!this.reads.has(scope.sessionId)) await this.read(scope)
  }
  /** A per-call private capture; nested hooks cannot replace another suggestion's owner. */
  async prepareSuggestion(scope: FunctionPromptScope): Promise<(
    input: { text: string }, signal: AbortSignal
  ) => Promise<{ isShown: boolean }>> {
    const owner = this.owners.get(scope.threadId)
    const before = await this.request(scope, "read")
    scope.assertLive()
    scope.signal.throwIfAborted()
    return async (input, signal) => {
      scope.assertLive()
      signal.throwIfAborted()
      if (typeof input.text !== "string" || Buffer.byteLength(input.text) > PROMPT_COMPOSER_MAX_BYTES)
        throw Error("MODS_PROMPT_INPUT_INVALID")
      if (!owner || !before || !["ok", "dialog"].includes(before.status) ||
        this.owners.get(scope.threadId) !== owner) return { isShown: false }
      const answer = await this.request({ ...scope, signal }, "suggest", {
        text: input.text, expectedRevision: before.revision })
      return { isShown: answer?.status === "ok" && answer.isShown === true }
    }
  }
  private async snapshot(
    scope: FunctionPromptScope,
    capture: boolean
  ): Promise<{ text: string; cursor: number }> {
    let response: PromptComposerResponse | undefined
    try {
      response = await this.request(scope, "read")
    } catch (error) {
      scope.assertLive()
      if (scope.signal.aborted) throw Error("MODS_CANCELLED")
      if (!(error instanceof Error) || error.message !== "MODS_PROMPT_NO_COMPOSER") throw error
    }
    if (!response || response.status !== "ok") {
      // An empty read must not authorize a later newly mounted or unlocked composer.
      if (capture)
        this.reads.set(scope.sessionId, {
          text: "",
          cursor: 0,
          revision: -1,
          threadId: scope.threadId,
          owner: response?.owner ?? "no-composer"
        })
      return { text: "", cursor: 0 }
    }
    if (capture)
      this.reads.set(scope.sessionId, {
        text: response.text,
        cursor: response.cursor,
        revision: response.revision,
        threadId: response.threadId,
        owner: response.owner
      })
    return { text: response.text, cursor: response.cursor }
  }
  async fill(
    scope: FunctionPromptScope,
    input: { text: string; mode?: PromptFillMode; decorations?: import("../../../shared/mods/v2/prompt-edit").FunctionPromptDecoration[] }
  ): Promise<PromptFillResult> {
    scope.assertLive()
    if (scope.signal.aborted) throw Error("MODS_CANCELLED")
    if (
      typeof input?.text !== "string" ||
      new TextEncoder().encode(input.text).length > PROMPT_COMPOSER_MAX_BYTES ||
      !["replace", "append", "insert"].includes(input.mode ?? "replace")
    )
      throw Error("MODS_PROMPT_INPUT_INVALID")
    if (input.decorations !== undefined) validatePromptDecorations(input.decorations, input.text)
    let lease = this.reads.get(scope.sessionId)
    if (
      lease &&
      (lease.threadId !== scope.threadId || lease.owner !== this.owners.get(scope.threadId)?.id)
    )
      return { isFilled: false, refusal: "no_composer", text: "", cursor: 0 }
    if (!lease) {
      const snapshot = await this.request(scope, "read")
      if (!snapshot || snapshot.status !== "ok")
        return {
          isFilled: false,
          refusal: snapshot?.status === "dialog" ? "dialog" : "no_composer",
          text: "",
          cursor: 0
        }
      lease = { ...snapshot }
    }
    if (this.owners.get(scope.threadId)?.id !== lease.owner)
      return { isFilled: false, refusal: "no_composer", text: "", cursor: 0 }
    const response = await this.request(scope, "fill", {
      expectedRevision: lease.revision,
      text: input.text,
      mode: input.mode ?? "replace",
      ...(input.decorations === undefined ? {} : { decorations: input.decorations })
    })
    if (!response) return { isFilled: false, refusal: "no_composer", text: "", cursor: 0 }
    if (response.status === "ok") this.reads.set(scope.sessionId, { ...response })
    return {
      isFilled: response.status === "ok",
      ...(response.status === "no_composer" || response.status === "dialog"
        ? { refusal: response.status }
        : {}),
      text: response.text,
      cursor: response.cursor
    }
  }
  closeSession(sessionId: string): void {
    this.reads.delete(sessionId)
    for (const item of this.pending.values())
      if (item.scope.sessionId === sessionId) {
        item.cleanup()
        item.reject(Error("MODS_CANCELLED"))
      }
  }
  closeThread(threadId: string): void {
    this.edits.get(threadId)?.controller.abort(Error("MODS_PROMPT_NO_COMPOSER"))
    this.edits.delete(threadId)
    this.owners.delete(threadId)
    for (const item of this.pending.values())
      if (item.scope.threadId === threadId) {
        item.cleanup()
        item.reject(Error("MODS_PROMPT_NO_COMPOSER"))
      }
  }
  closeSender(senderId: number): void {
    for (const [threadId, owner] of this.owners)
      if (owner.senderId === senderId) this.closeThread(threadId)
    // Keep captured read leases as tombstones: a new renderer is not the old composer.
    for (const item of this.pending.values())
      if (item.owner.senderId === senderId) {
        item.cleanup()
        item.reject(Error("MODS_PROMPT_NO_COMPOSER"))
      }
  }
  close(): void {
    for (const threadId of this.owners.keys()) this.closeThread(threadId)
    this.reads.clear()
  }
}
