import { runHooksEnriched } from "../../hooks/required-skill"
import { activateSkillLifecycleCore, type SkillActivationOptions } from "./activation-core"
export { getSkillActivationKey, formatSkillHookContext } from "./activation-core"
export type { SkillActivationOptions, SkillActivationResult } from "./activation-core"

export function activateSkillLifecycle(options: SkillActivationOptions) {
  return activateSkillLifecycleCore(options, runHooksEnriched)
}
