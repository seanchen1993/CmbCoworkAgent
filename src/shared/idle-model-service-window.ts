import type { IdleModelEnvironment, ModelTransport } from "./model-catalog"

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const OPEN_HOUR = 22
const CLOSE_HOUR = 7

export const IDLE_MODEL_SERVICE_HOURS = `北京时间 ${OPEN_HOUR}:00 至次日 ${String(CLOSE_HOUR).padStart(2, "0")}:00`
export const IDLE_MODEL_OUTSIDE_HOURS_MESSAGE = `当前为非服务时段，请在${IDLE_MODEL_SERVICE_HOURS}重试或选择其他模型。`
export const IDLE_MODEL_OUTSIDE_HOURS_CODE = "idle_model_outside_service_hours"

export interface IdleModelServiceHoursConfig {
  transport?: ModelTransport
  model?: string
  idleModelEnvironment?: IdleModelEnvironment
}

export function getIdleModelServiceWindow(now = Date.now()): {
  available: boolean
  nextChangeAt: number
} {
  // Calculate both boundaries in UTC+8 regardless of the local time zone.
  const beijing = new Date(now + BEIJING_OFFSET_MS)
  const hour = beijing.getUTCHours()
  const available = hour >= OPEN_HOUR || hour < CLOSE_HOUR
  const nextChangeAt =
    Date.UTC(
      beijing.getUTCFullYear(),
      beijing.getUTCMonth(),
      beijing.getUTCDate() + (hour >= OPEN_HOUR ? 1 : 0),
      available ? CLOSE_HOUR : OPEN_HOUR
    ) - BEIJING_OFFSET_MS
  return { available, nextChangeAt }
}

export function isIdleModelOutsideServiceHours(
  config: IdleModelServiceHoursConfig | null | undefined
): boolean {
  // Ultra connections without an explicit environment use the production window.
  return (
    config?.transport === "idle-gateway" &&
    config.model === "ultra" &&
    config.idleModelEnvironment !== "uat" &&
    !getIdleModelServiceWindow().available
  )
}

export class IdleModelServiceHoursError extends Error {
  readonly status = 400
  readonly code = IDLE_MODEL_OUTSIDE_HOURS_CODE

  constructor() {
    super(IDLE_MODEL_OUTSIDE_HOURS_MESSAGE)
    this.name = "IdleModelServiceHoursError"
  }
}

export function assertIdleModelServiceHours(config: IdleModelServiceHoursConfig | null): void {
  if (isIdleModelOutsideServiceHours(config)) {
    throw new IdleModelServiceHoursError()
  }
}
