export function resolveGoalControlSubmitRoute(params: {
  isGoalControlCommand: boolean
  isLoading: boolean
  historyLoading?: boolean
  hasActiveGoal?: boolean
  goalControlAllowedWhileLoading?: boolean
}): {
  isSideChannelGoalControl: boolean
  shouldUseGoalControlPlane: boolean
  shouldUseSubmitLock: boolean
} {
  const goalControlAllowedWhileLoading =
    params.goalControlAllowedWhileLoading ?? Boolean(params.hasActiveGoal)
  const canUseGoalControlPlane =
    params.isGoalControlCommand &&
    !params.historyLoading &&
    (!params.isLoading || goalControlAllowedWhileLoading)
  const isSideChannelGoalControl = params.isLoading && canUseGoalControlPlane
  return {
    isSideChannelGoalControl,
    shouldUseGoalControlPlane: canUseGoalControlPlane,
    shouldUseSubmitLock: !isSideChannelGoalControl
  }
}

export function shouldClearPendingApprovalAfterGoalControl(params: {
  hasPendingApproval: boolean
  isTerminatingControlCommand: boolean
  terminatedCurrentRun: boolean
}): boolean {
  return (
    params.hasPendingApproval &&
    params.isTerminatingControlCommand &&
    params.terminatedCurrentRun
  )
}
