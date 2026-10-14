import type { ClawView } from "../../../shared/mods/claw"

type ChatClawBinding = Pick<ClawView, "enabled" | "applicable" | "active">

/** Keep configuration reads alive while a project is paused, but stop new execution. */
export function chatClawEnabled(enabled: boolean, binding?: ChatClawBinding): boolean {
  return enabled && binding?.enabled !== false && binding?.applicable !== false
}

/** A retained snapshot is not evidence that its model is currently applied. */
export function chatClawDefaultModel(
  enabled: boolean,
  binding?: ChatClawBinding
): string | undefined {
  return enabled && binding?.enabled === true && binding.applicable === true
    ? binding.active?.models?.default
    : undefined
}
