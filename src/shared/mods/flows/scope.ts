import { resolveAgentModeFromMetadata } from "../../agent-mode-metadata"

export function isOrdinaryFlowMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const metadata = value as Record<string, unknown>
  const object = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === "object" && !Array.isArray(input)
  const text = (input: unknown) => typeof input === "string" && !!input.trim()
  const feature = metadata.harnessFeature
  const project = metadata.harnessProjectSession
  if (
    feature !== undefined &&
    (!object(feature) || !text(feature.projectId) || !text(feature.slug))
  )
    return false
  if (object(feature) && (feature.runId || feature.nodeId)) return false
  if (
    project !== undefined &&
    (!object(project) || !text(project.projectId) || !text(project.kind))
  )
    return false
  if (object(feature) && object(project) && feature.projectId !== project.projectId) return false
  const projectId = object(feature)
    ? feature.projectId
    : object(project)
      ? project.projectId
      : undefined
  if (metadata.harnessProjectId && metadata.harnessProjectId !== projectId) return false
  if (metadata.featureId && (!object(feature) || metadata.featureId !== feature.slug)) return false
  // Legacy flat attribution is not sufficient authority to bind a Harness project.
  if (
    ["harnessProjectId", "featureId", "isHarnessProjectSession"].some((key) => metadata[key]) &&
    !feature &&
    !project
  )
    return false
  return (
    resolveAgentModeFromMetadata(metadata) === "normal" &&
    ![
      "workflowRunId",
      "parentThreadId",
      "remoteThread",
      "remoteState",
      "remoteReadOnly",
      "targetKind",
      "imDeliveryContext",
      "isHeartbeat",
      "scheduledTaskId",
      "hostProjectRuntime"
    ].some((field) => Boolean(metadata[field]))
  )
}
