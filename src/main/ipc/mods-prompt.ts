import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { FunctionPromptBroker } from "../mods/v2/prompt-broker"
import type { PromptComposerResponse } from "../../shared/mods/v2/prompt-composer"
import type { PromptEditRequest } from "../../shared/mods/v2/prompt-composer"
import type {
  FunctionPromptEditInput,
  FunctionPromptEditResult
} from "../../shared/mods/v2/prompt-edit"
import { compositionRecoveryError } from "../mods/errors"

export function registerPromptComposerHandlers(
  ipc: IpcMain,
  broker: FunctionPromptBroker,
  scope: (event: IpcMainInvokeEvent, threadId: string) => string,
  editing?: {
    support(workspace: string, threadId: string): Promise<boolean>
    run(
      workspace: string,
      threadId: string,
      input: FunctionPromptEditInput,
      signal: AbortSignal,
      assertOwner: () => void,
      nativeCursor?: number
    ): Promise<FunctionPromptEditResult>
  }
): void {
  const observedSenders = new WeakSet<IpcMainInvokeEvent["sender"]>()
  ipc.handle(
    "mods:prompt-edit-support",
    async (event, input: { threadId: string; owner: string }) => {
      const workspace = scope(event, input?.threadId)
      broker.assertEditor(event.sender.id, input.threadId, input.owner)
      let result: boolean
      try {
        result = editing ? await editing.support(workspace, input.threadId) : false
      } catch (error) {
        throw compositionRecoveryError(error)
      }
      scope(event, input.threadId)
      broker.assertEditor(event.sender.id, input.threadId, input.owner)
      return result
    }
  )
  ipc.handle("mods:prompt-edit", (event, request: PromptEditRequest) => {
    const workspace = scope(event, request?.threadId)
    if (!editing) throw Error("MODS_PROMPT_EDIT_UNAVAILABLE")
    return broker.edit(
      event.sender.id,
      request,
      async (input, signal, assertOwner, nativeCursor) => {
        try {
          return await editing.run(
            workspace,
            request.threadId,
            input,
            signal,
            () => {
              scope(event, request.threadId)
              assertOwner()
            },
            nativeCursor
          )
        } catch (error) {
          throw compositionRecoveryError(error)
        }
      }
    )
  })
  ipc.handle(
    "mods:prompt-edit-cancel",
    (event, input: { threadId: string; owner: string; sequence: number }) => {
      scope(event, input?.threadId)
      broker.cancelEdit(event.sender.id, input.threadId, input.owner, input.sequence)
    }
  )
  ipc.handle("mods:prompt-attach", (event, input: { threadId: string; owner: string }) => {
    scope(event, input?.threadId)
    if (event.sender.isDestroyed()) throw Error("MODS_PROMPT_NO_COMPOSER")
    broker.attach(input.threadId, input.owner, event.sender.id, (request) => {
      if (event.sender.isDestroyed()) throw Error("MODS_PROMPT_NO_COMPOSER")
      event.sender.send("mods:prompt-request", request)
    })
    if (!observedSenders.has(event.sender)) {
      observedSenders.add(event.sender)
      const senderId = event.sender.id
      event.sender.once("destroyed", () => broker.closeSender(senderId))
    }
  })
  ipc.handle("mods:prompt-detach", (event, input: { threadId: string; owner: string }) => {
    // Releasing an existing owner must work even after its thread is deleted or made read-only.
    // The broker matches the originating sender as well as the opaque owner and thread.
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof input.threadId !== "string" ||
      !input.threadId ||
      input.threadId.length > 200 ||
      typeof input.owner !== "string" ||
      !input.owner ||
      input.owner.length > 100
    )
      throw Error("MODS_PROMPT_OWNER_INVALID")
    broker.detach(input.threadId, input.owner, event.sender.id)
  })
  ipc.handle("mods:prompt-response", (event, response: PromptComposerResponse) => {
    scope(event, response?.threadId)
    broker.respond(event.sender.id, response)
  })
  ipc.handle(
    "mods:prompt-authorize",
    (event, input: { threadId: string; owner: string; requestId: string }) => {
      scope(event, input?.threadId)
      return broker.authorize(event.sender.id, input.requestId, input.threadId, input.owner)
    }
  )
}
