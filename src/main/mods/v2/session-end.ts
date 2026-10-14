/** Native host receipt only: renderer/SDK callers cannot create or replay an ending phase. */
export interface FunctionSessionEndReceipt {
  readonly count: number
  classic<T>(run: () => Promise<T>): Promise<T>
  notify(): Promise<void>
  /** Before notification this releases admission; afterwards it retires the exact instance. */
  finish(): void
}

export type FunctionSessionEndReason = "clear" | "logout"
