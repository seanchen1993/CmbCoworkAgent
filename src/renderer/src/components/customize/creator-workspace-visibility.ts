import type { DevelopmentStatus } from "../../../../shared/mods/development"

/** Native authoring records establish creation intent; selecting a mode or planner does not. */
export function hasNativeCreatorWork(status: DevelopmentStatus | null): boolean {
  return (
    !!status &&
    !!(
      status.drafts.length ||
      status.trials.length ||
      status.configuration ||
      status.projectTrial ||
      status.projectDelivery ||
      (status.sourceSet && status.sourceSet.phase !== "cancelled") ||
      status.composition ||
      status.reuse ||
      status.save ||
      status.undo ||
      status.business?.drafts?.length ||
      status.business?.review ||
      status.business?.modularization ||
      status.business?.trial
    )
  )
}
