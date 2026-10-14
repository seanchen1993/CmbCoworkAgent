/** Reject changes to the state captured before asynchronous submission preparation. */
export function hasComposerSubmissionStateChanged<T extends { approvalQueue: readonly unknown[] }>(
  admitted: T,
  current: T
): boolean {
  return (Object.keys(admitted) as Array<keyof T>).some((key) => {
    // Thread hydration rebuilds the tail array even when no approval changed.
    // Keep object identity and order so replacement requests still invalidate admission.
    if (key === "approvalQueue") {
      return (
        admitted.approvalQueue.length !== current.approvalQueue.length ||
        admitted.approvalQueue.some((approval, index) => approval !== current.approvalQueue[index])
      )
    }
    return admitted[key] !== current[key]
  })
}

/** Capture all non-text admission facts before prompt hooks can await. */
export function captureComposerSubmissionState<T extends { approvalQueue: readonly unknown[] }>(
  read: () => T,
  isModelIntentCurrent: () => boolean = () => true
): () => void {
  const admitted = read()
  return () => {
    if (hasComposerSubmissionStateChanged(admitted, read()) || !isModelIntentCurrent())
      throw Error("准备发送期间会话、附件、技能或任务状态已变化，请重新发送；当前输入已保留。")
  }
}
