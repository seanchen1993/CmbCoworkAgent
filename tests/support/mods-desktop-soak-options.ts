export interface DesktopSoakOptions {
  smoke: boolean
  durationMs: number
  events: number
  reloadEvery: number
}

export function desktopSoakOptions(input: { smoke?: string }): DesktopSoakOptions {
  if (input.smoke !== undefined && input.smoke !== "1")
    throw Error("Invalid desktop soak smoke flag")
  return input.smoke === "1"
    ? { smoke: true, durationMs: 10000, events: 24, reloadEvery: 8 }
    : { smoke: false, durationMs: 7200000, events: 10000, reloadEvery: 250 }
}

export function qualifiesDesktopSoak(
  options: DesktopSoakOptions,
  elapsedMs: number,
  events: number
): boolean {
  return (
    !options.smoke &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 7200000 &&
    Number.isSafeInteger(events) &&
    events >= 10000
  )
}
