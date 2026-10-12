import type { BotErrorTrayNotice } from "./error-trays"

export type BotBackgroundFailureNotice = Omit<BotErrorTrayNotice, "detail" | "diagnostic"> & {
  /** Captured before work starts. A restore retires any delayed old producer. */
  dataEpoch: string
}
export type BotBackgroundFailureReporter = (
  notice: BotBackgroundFailureNotice,
  error: unknown
) => void

export function reportBotBackgroundFailure(
  report: BotBackgroundFailureReporter | undefined,
  notice: BotBackgroundFailureNotice,
  error: unknown
): void {
  try {
    report?.(notice, error)
  } catch {
    // A notification cannot roll back a committed failure or replay its work.
  }
}
