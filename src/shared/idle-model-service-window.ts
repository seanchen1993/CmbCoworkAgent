const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

export type IdleModelEnvironment = "production" | "uat"

export interface IdleModelServiceHoursConfig {
  transport?: string
  idleModelEnvironment?: IdleModelEnvironment
}

export const IDLE_MODEL_OUTSIDE_HOURS_MESSAGE =
  "闲时模型仅在北京时间 22:00–次日 07:00 开放，当前为非服务时段，请在开放时间重试或手动选择其他模型。"
export const IDLE_MODEL_OUTSIDE_HOURS_CODE = "idle_model_outside_service_hours"

/** Admission only: an already submitted request may finish after the window closes. */
export function getIdleModelServiceWindow(now = Date.now()): {
  available: boolean
  nextChangeAt: number
} {
  // UTC arithmetic keeps the rule independent of the computer's configured time zone.
  const beijing = new Date(now + BEIJING_OFFSET_MS)
  const hour = beijing.getUTCHours()
  const available = hour >= 22 || hour < 7
  const nextChangeAt =
    Date.UTC(
      beijing.getUTCFullYear(),
      beijing.getUTCMonth(),
      beijing.getUTCDate() + (hour >= 22 ? 1 : 0),
      hour < 7 || hour >= 22 ? 7 : 22
    ) - BEIJING_OFFSET_MS
  return { available, nextChangeAt }
}

export class IdleModelServiceHoursError extends Error {
  readonly status = 400
  readonly code = IDLE_MODEL_OUTSIDE_HOURS_CODE

  constructor() {
    super(IDLE_MODEL_OUTSIDE_HOURS_MESSAGE)
    this.name = "IdleModelServiceHoursError"
  }
}

export function isIdleModelOutsideServiceHours(
  config: IdleModelServiceHoursConfig | null | undefined
): boolean {
  // Only an explicitly selected UAT connection is exempt; legacy configs stay restricted.
  return (
    config?.transport === "idle-gateway" &&
    config.idleModelEnvironment !== "uat" &&
    !getIdleModelServiceWindow().available
  )
}

export function assertIdleModelServiceHours(config: IdleModelServiceHoursConfig | null): void {
  if (isIdleModelOutsideServiceHours(config)) {
    throw new IdleModelServiceHoursError()
  }
}
