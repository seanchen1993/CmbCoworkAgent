import { currentRuntimePluginSource } from "../../plugins/runtime-source-scope"
import type { HostWorkflowExecution } from "./types"

const keys = [
  "projectId",
  "operationId",
  "stageId",
  "packageDigest",
  "inputFingerprint",
  "threadId",
  "incarnationKey"
] as const

/** Metadata is not a grant. Consumers still verify the original Host operation and inputs. */
export function isHostWorkflowExecution(value: unknown): value is HostWorkflowExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === keys.length &&
    keys.every((key) => {
      const text = record[key]
      return (
        typeof text === "string" &&
        text.length > 0 &&
        text.length <= (key === "incarnationKey" ? 1024 : 256) &&
        (!["packageDigest", "inputFingerprint"].includes(key) || /^[a-f0-9]{64}$/.test(text))
      )
    })
  )
}

/** Reads only the original opaque main source at the synchronous launch boundary. */
export function captureHostWorkflowExecution(threadId: string): HostWorkflowExecution | undefined {
  const source = currentRuntimePluginSource()
  // Pre-protocol/ordinary workflows retain their old behavior but cannot gain historical proof.
  if (source?.mode !== "host" || source.inputFingerprint === undefined) return undefined
  const value = {
    projectId: source.projectId,
    operationId: source.operationId,
    stageId: source.stageId,
    packageDigest: source.packageDigest,
    inputFingerprint: source.inputFingerprint,
    threadId: source.threadId,
    incarnationKey: source.incarnationKey
  }
  if (source.threadId !== threadId || !isHostWorkflowExecution(value))
    throw Error("HOST_WORKFLOW_EXECUTION_CHANGED")
  return value
}
