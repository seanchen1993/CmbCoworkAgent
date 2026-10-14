import { isModObject, ModFunctionError } from "./contracts"

export type FunctionCopyResult =
  | { isCopied: true }
  | {
      isCopied: false
      reason: "no-surface" | "no-clipboard" | "refused"
    }
export interface FunctionSelection {
  text: string
  requestId?: string
}
export interface FunctionPaneInfo {
  id: string
  title: string
  isShown: boolean
  isFocused: boolean
  isPlaced: boolean
}
export interface FunctionPaneDrawing {
  key: string
  generation: string
  isShown: boolean
  isFocused: boolean
  isPlaced: boolean
}
export interface DesktopRequest {
  threadId: string
  owner: string
  requestId: string
  kind: "presence" | "selection" | "copy" | "clear-selection" | "panes"
  revision?: number
}
export interface DesktopResponse {
  threadId: string
  owner: string
  requestId: string
  present: boolean
  revision: number
  selection?: FunctionSelection | null
  drawings?: FunctionPaneDrawing[]
}
export interface DesktopApi {
  desktopAttach(threadId: string, owner: string): Promise<void>
  desktopDetach(threadId: string, owner: string): Promise<void>
  desktopRespond(response: DesktopResponse): Promise<void>
  desktopCopy(input: {
    threadId: string
    owner: string
    requestId: string
    present: boolean
  }): Promise<void>
  onDesktopRequest(callback: (request: DesktopRequest) => void): () => void
}
const bytes = (text: string) => new TextEncoder().encode(text).length
export function validateCopyInput(
  value: unknown
): asserts value is { text: string; surface?: string } {
  if (
    !isModObject(value) ||
    typeof value.text !== "string" ||
    bytes(value.text) > 64 * 1024 ||
    Object.keys(value).some((key) => !["text", "surface"].includes(key)) ||
    (value.surface !== undefined &&
      (typeof value.surface !== "string" ||
        !["terminal", "desktop", "mobile", "vscode"].includes(value.surface)))
  )
    throw new ModFunctionError("MODS_UI_COPY_ARGUMENTS")
}
export function validateCopyResult(value: unknown): asserts value is FunctionCopyResult {
  if (
    !isModObject(value) ||
    typeof value.isCopied !== "boolean" ||
    Object.keys(value).some((key) => !["isCopied", "reason"].includes(key)) ||
    (value.isCopied
      ? value.reason !== undefined
      : typeof value.reason !== "string" ||
        !["no-surface", "no-clipboard", "refused"].includes(value.reason))
  )
    throw new ModFunctionError("MODS_UI_COPY_RESULT")
}
export function validateSelection(value: unknown): asserts value is FunctionSelection | undefined {
  if (value === undefined) return
  if (
    !isModObject(value) ||
    typeof value.text !== "string" ||
    bytes(value.text) > 64 * 1024 ||
    Object.keys(value).some((key) => !["text", "requestId"].includes(key)) ||
    (value.requestId !== undefined &&
      (typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 256))
  )
    throw new ModFunctionError("MODS_UI_SELECTION_RESULT")
}
export function validatePaneInfo(value: unknown): asserts value is FunctionPaneInfo[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some(
      (row) =>
        !isModObject(row) ||
        typeof row.id !== "string" ||
        !row.id ||
        row.id.length > 256 ||
        typeof row.title !== "string" ||
        row.title.length > 1000 ||
        ![row.isShown, row.isFocused, row.isPlaced].every((flag) => typeof flag === "boolean") ||
        (row.isFocused && !row.isShown) ||
        (row.isShown && !row.isPlaced) ||
        Object.keys(row).some(
          (key) => !["id", "title", "isShown", "isFocused", "isPlaced"].includes(key)
        )
    )
  )
    throw new ModFunctionError("MODS_UI_PANES_RESULT")
}
export function validatePaneDrawings(value: unknown): asserts value is FunctionPaneDrawing[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some(
      (row) =>
        !isModObject(row) ||
        typeof row.key !== "string" ||
        !row.key ||
        row.key.length > 512 ||
        typeof row.generation !== "string" ||
        row.generation.length > 100 ||
        ![row.isShown, row.isFocused, row.isPlaced].every((flag) => typeof flag === "boolean") ||
        (row.isFocused && !row.isShown) ||
        (row.isShown && !row.isPlaced) ||
        Object.keys(row).some(
          (key) => !["key", "generation", "isShown", "isFocused", "isPlaced"].includes(key)
        )
    )
  )
    throw new ModFunctionError("MODS_UI_PANES_DRAWING")
}
