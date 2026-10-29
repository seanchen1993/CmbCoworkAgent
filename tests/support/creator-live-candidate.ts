interface CandidateObservation {
  projectTrial?: { digest: string } | null
  trials: ReadonlyArray<{ phase: string }>
}

/** A retained/source-import trial is not evidence that the requested edit was prepared. */
export function hasLiveCreatorCandidate(
  status: CandidateObservation,
  target: "project" | "function",
  importedDigest?: string
) {
  return target === "project"
    ? !!status.projectTrial && status.projectTrial.digest !== importedDigest
    : status.trials.some((trial) => trial.phase === "needs-approval")
}
