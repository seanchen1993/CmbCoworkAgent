import { randomUUID } from "node:crypto"
import type { FunctionPromptScope } from "./prompt-broker"
import { FunctionPresentationPublisher, type NativePresentationBinding } from "./presentation-broker"
import type { FunctionPresentationReport, FunctionPresentationSnapshot } from "../../../shared/mods/v2/presentation"
import { validatePresentationReport } from "../../../shared/mods/v2/presentation"
import {
  validateCopyInput,
  validateSelection,
  validatePaneDrawings,
  type DesktopRequest,
  type DesktopResponse,
  type FunctionCopyResult,
  type FunctionSelection,
  type FunctionPaneDrawing
} from "../../../shared/mods/v2/desktop-actions"

type Owner = { id: string; senderId: number; send(request: DesktopRequest): void; presentation: FunctionPresentationPublisher; visible?: () => boolean }
type Pending = {
  owner: Owner
  scope: FunctionPromptScope
  kind: DesktopRequest["kind"]
  text?: string
  settle(value: DesktopResponse | FunctionCopyResult): void
  reject(error: unknown): void
}
export interface FunctionDesktopAccess {
  assertLive(): void
  copy(input: { text: string; surface?: string }, signal: AbortSignal): Promise<FunctionCopyResult>
  selection(signal: AbortSignal): Promise<FunctionSelection | undefined>
  clearSelection(signal: AbortSignal): Promise<void>
  drawings(signal: AbortSignal): Promise<FunctionPaneDrawing[]>
}

/** Native write permission is private, one-shot, and bound to the original mounted chat. */
export class FunctionDesktopBroker {
  private owners = new Map<string, Owner>()
  private pending = new Map<string, Pending>()
  constructor(private readonly writeClipboard: (text: string) => void) {}
  attach(threadId: string, owner: string, senderId: number, send: Owner["send"], visible?: () => boolean): void {
    if (!threadId || threadId.length > 200 || !owner || owner.length > 100)
      throw Error("MODS_DESKTOP_OWNER")
    this.closeThread(threadId)
    this.owners.set(threadId, { id: owner, senderId, send, visible, presentation: new FunctionPresentationPublisher() })
  }
  async feedback(senderId: number, threadId: string, id: string,
    read: () => Promise<NativePresentationBinding | undefined>): Promise<FunctionPresentationSnapshot> {
    this.assertOwner(senderId, threadId, id)
    const owner = this.owners.get(threadId)!
    const result = await owner.presentation.publish(read)
    if (this.owners.get(threadId) !== owner) throw Error("MODS_DESKTOP_OWNER")
    return result
  }
  present(senderId: number, report: FunctionPresentationReport): void {
    validatePresentationReport(report)
    this.assertOwner(senderId, report?.threadId, report?.owner)
    const owner = this.owners.get(report.threadId)!
    owner.presentation.report({ ...report, present: report.present && owner.visible?.() !== false })
  }
  assertOwner(senderId: number, threadId: string, id: string): void {
    const owner = this.owners.get(threadId)
    if (!owner || owner.id !== id || owner.senderId !== senderId) throw Error("MODS_DESKTOP_OWNER")
  }
  detach(threadId: string, id: string, senderId: number): void {
    const owner = this.owners.get(threadId)
    if (owner?.id === id && owner.senderId === senderId) this.closeThread(threadId)
  }
  private assertPending(item: Pending): void {
    item.scope.signal.throwIfAborted()
    item.scope.assertLive()
    if (this.owners.get(item.scope.threadId) !== item.owner) throw Error("MODS_DESKTOP_OWNER")
  }
  respond(senderId: number, response: DesktopResponse): void {
    const item = this.pending.get(response?.requestId)
    if (
      !item ||
      item.kind === "copy" ||
      item.owner.senderId !== senderId ||
      item.owner.id !== response.owner ||
      item.scope.threadId !== response.threadId
    )
      return
    try {
      this.assertPending(item)
      if (
        typeof response.present !== "boolean" ||
        !Number.isSafeInteger(response.revision) ||
        response.revision < 0 ||
        Object.keys(response).some(
          (key) =>
            ![
              "threadId",
              "owner",
              "requestId",
              "present",
              "revision",
              "selection",
              "drawings"
            ].includes(key)
        )
      )
        throw Error("MODS_DESKTOP_RESPONSE")
      validateSelection(response.selection === null ? undefined : response.selection)
      if (response.drawings !== undefined) validatePaneDrawings(response.drawings)
      item.settle(response)
    } catch (error) {
      item.reject(error)
    }
  }
  commitCopy(
    senderId: number,
    threadId: string,
    owner: string,
    requestId: string,
    present: boolean
  ): void {
    const item = this.pending.get(requestId)
    if (
      !item ||
      item.kind !== "copy" ||
      item.owner.senderId !== senderId ||
      item.owner.id !== owner ||
      item.scope.threadId !== threadId
    )
      throw Error("MODS_DESKTOP_COPY_OWNER")
    // Consume before the synchronous native write. A replay can never write twice.
    this.pending.delete(requestId)
    try {
      this.assertPending(item)
      if (present !== true) {
        item.settle({ isCopied: false, reason: "no-surface" })
        return
      }
      try {
        this.writeClipboard(item.text!)
        item.settle({ isCopied: true })
      } catch {
        item.settle({ isCopied: false, reason: "no-clipboard" })
      }
    } catch (error) {
      item.reject(error)
    }
  }
  private request(
    owner: Owner,
    scope: FunctionPromptScope,
    kind: DesktopRequest["kind"],
    text?: string,
    revision?: number
  ): Promise<DesktopResponse | FunctionCopyResult> {
    scope.assertLive()
    scope.signal.throwIfAborted()
    if (this.owners.get(scope.threadId) !== owner) throw Error("MODS_DESKTOP_OWNER")
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const finish = (run: () => void) => {
        clearTimeout(timer)
        scope.signal.removeEventListener("abort", abort)
        this.pending.delete(requestId)
        run()
      }
      const abort = () => finish(() => reject(Error("MODS_CANCELLED")))
      const timer = setTimeout(() => finish(() => reject(Error("MODS_DESKTOP_TIMEOUT"))), 5000)
      const pending: Pending = {
        owner,
        scope,
        kind,
        text,
        settle: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error))
      }
      this.pending.set(requestId, pending)
      scope.signal.addEventListener("abort", abort, { once: true })
      try {
        owner.send({
          threadId: scope.threadId,
          owner: owner.id,
          requestId,
          kind,
          ...(revision === undefined ? {} : { revision })
        })
      } catch (error) {
        pending.reject(error)
      }
    })
  }
  async capture(scope: FunctionPromptScope): Promise<FunctionDesktopAccess> {
    const owner = this.owners.get(scope.threadId)
    const before = owner
      ? ((await this.request(owner, scope, "presence")) as DesktopResponse)
      : undefined
    const live = (signal: AbortSignal) => {
      scope.assertLive()
      scope.signal.throwIfAborted()
      signal.throwIfAborted()
    }
    const requestScope = (signal: AbortSignal): FunctionPromptScope => ({
      ...scope,
      signal: AbortSignal.any([scope.signal, signal]),
      assertLive: () => live(signal)
    })
    return {
      assertLive: () => {
        live(scope.signal)
        if (owner && this.owners.get(scope.threadId) !== owner) throw Error("MODS_DESKTOP_OWNER")
      },
      copy: async (input, signal) => {
        live(signal)
        validateCopyInput(input)
        if (!owner || !before?.present || input.surface !== "desktop")
          return { isCopied: false, reason: "no-surface" }
        const result = (await this.request(
          owner,
          requestScope(signal),
          "copy",
          input.text
        )) as FunctionCopyResult
        live(signal)
        return result
      },
      selection: async (signal) => {
        live(signal)
        if (!owner || !before?.present) return undefined
        const result = (await this.request(
          owner,
          requestScope(signal),
          "selection"
        )) as DesktopResponse
        live(signal)
        return result.present && result.selection ? result.selection : undefined
      },
      clearSelection: async () => {
        // Cleanup only forgets the privately captured selection revision. It reads no
        // content and grants no SDK operation, so it also runs after command cancellation.
        if (owner && before?.present)
          await this.request(
            owner,
            {
              ...scope,
              signal: new AbortController().signal,
              assertLive: () => {
                if (this.owners.get(scope.threadId) !== owner) throw Error("MODS_DESKTOP_OWNER")
              }
            },
            "clear-selection",
            undefined,
            before.revision
          )
      },
      drawings: async (signal) => {
        live(signal)
        if (!owner || !before?.present) return []
        const result = (await this.request(owner, requestScope(signal), "panes")) as DesktopResponse
        live(signal)
        return result.present ? (result.drawings ?? []) : []
      }
    }
  }
  closeThread(threadId: string): void {
    this.owners.get(threadId)?.presentation.close()
    this.owners.delete(threadId)
    for (const item of [...this.pending.values()])
      if (item.scope.threadId === threadId) item.reject(Error("MODS_DESKTOP_OWNER"))
  }
  closeSender(senderId: number): void {
    for (const [thread, owner] of this.owners)
      if (owner.senderId === senderId) this.closeThread(thread)
  }
  pauseSender(senderId: number): void {
    for (const owner of this.owners.values())
      if (owner.senderId === senderId) owner.presentation.pause()
  }
  close(): void {
    for (const thread of this.owners.keys()) this.closeThread(thread)
  }
}
