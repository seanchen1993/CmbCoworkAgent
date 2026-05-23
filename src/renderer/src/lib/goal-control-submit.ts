export function resolveGoalControlSubmitRoute(params: {
  isGoalControlCommand: boolean
  isLoading: boolean
}): {
  isSideChannelGoalControl: boolean
  shouldUseGoalControlPlane: boolean
  shouldUseSubmitLock: boolean
} {
  const isSideChannelGoalControl = params.isLoading && params.isGoalControlCommand
  return {
    isSideChannelGoalControl,
    shouldUseGoalControlPlane: params.isGoalControlCommand,
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
