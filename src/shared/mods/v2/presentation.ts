import { isModObject, ModFunctionError } from "./contracts"
import { validatePaneDrawings, type FunctionPaneDrawing } from "./desktop-actions"
import type { FunctionFeedbackEntry } from "./ui-feedback"

/** Native renderer-only publication receipt, never a mod SDK method or operation authority. */
export interface FunctionPresentationSnapshot {
  receipt?: string
  entries: FunctionFeedbackEntry[]
}
export interface FunctionPresentationReport {
  threadId: string
  owner: string
  receipt: string
  sequence: number
  present: boolean
  panes: FunctionPaneDrawing[]
  shown: string[]
  hovered: string[]
  dismissed: string[]
}
export interface FunctionPresentationApi {
  desktopFeedback(threadId: string, owner: string): Promise<FunctionPresentationSnapshot>
  desktopPresent(report: FunctionPresentationReport): Promise<void>
}
export function validatePresentationReport(
  value: unknown
): asserts value is FunctionPresentationReport {
  const ids = (list: unknown) =>
    Array.isArray(list) &&
    list.length <= 40 &&
    list.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100) &&
    new Set(list).size === list.length
  if (
    !isModObject(value) ||
    typeof value.threadId !== "string" ||
    !value.threadId ||
    value.threadId.length > 200 ||
    typeof value.owner !== "string" ||
    !value.owner ||
    value.owner.length > 100 ||
    typeof value.receipt !== "string" ||
    !/^[\w-]{16,100}$/.test(value.receipt) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.present !== "boolean" ||
    !ids(value.shown) ||
    !ids(value.hovered) ||
    !ids(value.dismissed) ||
    Object.keys(value).some(
      (key) =>
        ![
          "threadId",
          "owner",
          "receipt",
          "sequence",
          "present",
          "panes",
          "shown",
          "hovered",
          "dismissed"
        ].includes(key)
    )
  )
    throw new ModFunctionError("MODS_UI_PRESENTATION")
  validatePaneDrawings(value.panes)
}
