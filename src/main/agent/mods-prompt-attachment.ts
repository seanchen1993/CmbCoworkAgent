import type { ModRuntimeAuthority } from "../mods/runtime-instance"
import type { ModObject } from "../../shared/mods/types"
import type { FunctionPromptCore, FunctionPromptEvent } from "../../shared/mods/v2/prompt-composition"
import { validatePromptAttachmentResult } from "../../shared/mods/v2/prompt-attachment"
import { bindHostPromptOccurrence } from "../mods/v2/prompt-cache"
import { withFunctionTransportExecution } from "../mods/v2/host-call"

export type ModAttachmentTransform = (text: string, signal?: AbortSignal,
  occurrence?: object) => Promise<string | null>

/** Bind to the actual producer and current loop, before the native wrapper is added. */
export function createModAttachmentTransform(options: {
  type: string
  origin: ModObject
  authority(): ModRuntimeAuthority | undefined
  captureRuntime(authority: ModRuntimeAuthority): () => void
  enabled(): boolean
  dispatch(workspace: string, threadId: string, event: FunctionPromptEvent,
    input: ModObject, signal: AbortSignal, core: FunctionPromptCore): Promise<ModObject>
}): ModAttachmentTransform {
  return async (text, signal, occurrence) => {
    if (!options.enabled()) return text
    const authority = options.authority()
    if (!authority) return text
    authority.assertLive()
    const assertRuntime = options.captureRuntime(authority)
    assertRuntime()
    if (!signal) throw new Error("MODS_ATTACHMENT_SIGNAL_REQUIRED")
    signal.throwIfAborted()
    const input: ModObject = { type: options.type, text, origin: { ...options.origin },
      ...(authority.agentId === "main" ? {} : { agentId: authority.agentId }) }
    const core: FunctionPromptCore = async (received, active) => {
        assertRuntime()
        active.throwIfAborted()
        return { text: received.text }
    }
    if (occurrence) bindHostPromptOccurrence(core, "prompt.attachment", occurrence)
    const output = await withFunctionTransportExecution({
      workspace: authority.workspace, threadId: authority.threadId, turnId: authority.turnId,
      agentId: authority.agentId, runtimeAuthority: authority, userInitiated: false,
      leased: true, immediate: false
    }, () => options.dispatch(authority.workspace, authority.threadId,
      "prompt.attachment", input, signal, core))
    assertRuntime()
    signal.throwIfAborted()
    validatePromptAttachmentResult(output)
    return output.text as string | null
  }
}
