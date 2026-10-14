import type {
  FunctionMarkdownLinkAddress,
  FunctionMarkdownProtectedPreview
} from "../../../shared/mods/v2/markdown-links"
import { functionMarkdownLinkAddressKey } from "../../../shared/mods/v2/markdown-links"

export interface ProtectedFunctionPreviewRequest {
  threadId: string
  preview: FunctionMarkdownProtectedPreview
  address: FunctionMarkdownLinkAddress
  intentId: number
}

const OPEN = "mods:protected-preview-open"
const CLOSED = "mods:protected-preview-owner-closed"
let intent = 0

export function emitProtectedFunctionPreview(
  request: Omit<ProtectedFunctionPreviewRequest, "intentId">
): void {
  window.dispatchEvent(new CustomEvent<ProtectedFunctionPreviewRequest>(OPEN, {
    detail: { ...request, intentId: ++intent }
  }))
}

export function onProtectedFunctionPreview(
  receive: (request: ProtectedFunctionPreviewRequest) => void
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<ProtectedFunctionPreviewRequest>).detail
    if (typeof detail?.threadId !== "string" || typeof detail.preview?.receipt !== "string" ||
      !Number.isSafeInteger(detail.intentId) || !detail.address) return
    receive(detail)
  }
  window.addEventListener(OPEN, listener)
  return () => window.removeEventListener(OPEN, listener)
}

export function closeProtectedFunctionPreviewOwner(
  threadId: string,
  address: FunctionMarkdownLinkAddress
): void {
  window.dispatchEvent(new CustomEvent(CLOSED, {
    detail: { threadId, owner: functionMarkdownLinkAddressKey(address) }
  }))
}

export function onProtectedFunctionPreviewOwnerClosed(
  receive: (threadId: string, owner: string) => void
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ threadId: string; owner: string }>).detail
    if (typeof detail?.threadId === "string" && typeof detail.owner === "string")
      receive(detail.threadId, detail.owner)
  }
  window.addEventListener(CLOSED, listener)
  return () => window.removeEventListener(CLOSED, listener)
}
