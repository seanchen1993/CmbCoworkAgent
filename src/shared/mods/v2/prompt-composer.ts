export type PromptFillMode = "replace" | "append" | "insert"
export interface PromptComposerSnapshot {
  text: string
  cursor: number
  revision: number
}
export interface PromptComposerRequest {
  requestId: string
  threadId: string
  owner: string
  kind: "read" | "fill" | "suggest"
  expectedRevision?: number
  text?: string
  mode?: PromptFillMode
  decorations?: import("./prompt-edit").FunctionPromptDecoration[]
}
export interface PromptComposerResponse extends PromptComposerSnapshot {
  requestId: string
  threadId: string
  owner: string
  status: "ok" | "no_composer" | "dialog" | "conflict"
  isShown?: boolean
}
export interface PromptFillResult {
  isFilled: boolean
  refusal?: "no_composer" | "dialog"
  text: string
  cursor: number
}
export interface PromptComposerApi {
  promptAttach(threadId: string, owner: string): Promise<void>
  promptDetach(threadId: string, owner: string): Promise<void>
  promptAuthorize(threadId: string, owner: string, requestId: string): Promise<boolean>
  promptRespond(response: PromptComposerResponse): Promise<void>
  onPromptRequest(callback: (request: PromptComposerRequest) => void): () => void
  promptEditSupport(threadId: string, owner: string): Promise<boolean>
  promptEdit(request: PromptEditRequest): Promise<import("./prompt-edit").FunctionPromptEditResult>
  promptEditCancel(threadId: string, owner: string, sequence: number): Promise<void>
}
export interface PromptEditRequest {
  threadId: string
  owner: string
  sequence: number
  nativeCursor?: number
  input: import("./prompt-edit").FunctionPromptEditInput
}
export const PROMPT_COMPOSER_MAX_BYTES = 64_000
export function validPromptSnapshot(value: PromptComposerSnapshot): boolean {
  return (
    typeof value?.text === "string" &&
    new TextEncoder().encode(value.text).length <= PROMPT_COMPOSER_MAX_BYTES &&
    Number.isSafeInteger(value.cursor) &&
    value.cursor >= 0 &&
    value.cursor <= value.text.length &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  )
}
export function fillPromptSnapshot(
  before: PromptComposerSnapshot,
  text: string,
  mode: PromptFillMode
): { text: string; cursor: number } {
  const next =
    mode === "replace"
      ? text
      : mode === "append"
        ? before.text + text
        : before.text.slice(0, before.cursor) + text + before.text.slice(before.cursor)
  if (new TextEncoder().encode(next).length > PROMPT_COMPOSER_MAX_BYTES)
    throw Error("MODS_PROMPT_TOO_LARGE")
  return { text: next, cursor: mode === "insert" ? before.cursor + text.length : next.length }
}
