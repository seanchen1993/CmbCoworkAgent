import { compositionDigest, compositionRelativePath, compositionText } from "./composition"

export const STAGE_CHECK_RECEIPT_PREFIX = "DEVCLAW_STAGE_CHECK_V1 "
export interface StageCheckReceipt {
  apiVersion: "devclaw.stage-check/v1"
  nodeId: string
  checkId: string
  contractDigest: string
  outcome: "passed"
  artifacts: Array<{ id: string; path: string; digest: string }>
}
export interface StageCheckContract {
  checkOnly?: true
  nodeId: string
  checkId: string
  contractDigest: string
  artifacts: Array<{ id: string; path: string; pattern?: boolean }>
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw Error("STAGE_CHECK_RECEIPT_INVALID")
  return value as Record<string, unknown>
}
export function parseStageCheckReceipt(value: unknown): StageCheckReceipt {
  const entry = object(value, [
    "apiVersion",
    "nodeId",
    "checkId",
    "contractDigest",
    "outcome",
    "artifacts"
  ])
  if (
    entry.apiVersion !== "devclaw.stage-check/v1" ||
    entry.outcome !== "passed" ||
    !Array.isArray(entry.artifacts) ||
    entry.artifacts.length > 128
  )
    throw Error("STAGE_CHECK_RECEIPT_INVALID")
  const artifacts = entry.artifacts.map((value) => {
    const item = object(value, ["id", "path", "digest"])
    return {
      id: compositionText(item.id),
      path: compositionRelativePath(item.path),
      digest: compositionDigest(item.digest)
    }
  })
  if (
    new Set(artifacts.map((item) => JSON.stringify([item.id, item.path]))).size !== artifacts.length
  )
    throw Error("STAGE_CHECK_RECEIPT_DUPLICATE")
  return {
    apiVersion: "devclaw.stage-check/v1",
    nodeId: compositionText(entry.nodeId),
    checkId: compositionText(entry.checkId),
    contractDigest: compositionDigest(entry.contractDigest),
    outcome: "passed",
    artifacts
  }
}
/** Cross-language canonical JSON: sorted object keys, preserved array order, UTF-8. */
export function canonicalStageCheckJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStageCheckJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalStageCheckJson((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`
  throw Error("STAGE_CHECK_CONTRACT_INVALID")
}

export function stageCheckArtifactAllowed(
  contract: StageCheckContract,
  artifact: { id: string; path: string }
): boolean {
  return contract.artifacts.some((rule) => {
    if (rule.id !== artifact.id) return false
    if (!rule.pattern) return rule.path === artifact.path
    let escaped = ""
    for (let index = 0; index < rule.path.length; index++) {
      if (rule.path.slice(index, index + 3) === "**/") {
        escaped += "(?:[^/]+/)*"
        index += 2
      } else if (rule.path.slice(index, index + 2) === "**") {
        escaped += ".*"
        index++
      } else if (rule.path[index] === "*") escaped += "[^/]*"
      else escaped += rule.path[index].replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
    return new RegExp(`^${escaped}$`).test(artifact.path)
  })
}
export function parseStageCheckContracts(value: unknown): StageCheckContract[] {
  if (!Array.isArray(value) || !value.length || value.length > 128)
    throw Error("STAGE_CHECK_CONTRACT_INVALID")
  const contracts = value.map((value) => {
    const item = object(value, ["nodeId", "checkId", "contractDigest", "artifacts", "checkOnly"])
    if (
      !Array.isArray(item.artifacts) ||
      item.artifacts.length > 128 ||
      (item.checkOnly !== undefined && item.checkOnly !== true) ||
      (item.artifacts.length === 0) !== (item.checkOnly === true)
    )
      throw Error("STAGE_CHECK_CONTRACT_INVALID")
    const artifacts = item.artifacts.map((value) => {
      const artifact = object(value, ["id", "path", "pattern"])
      if (artifact.pattern !== undefined && typeof artifact.pattern !== "boolean")
        throw Error("STAGE_CHECK_CONTRACT_INVALID")
      if (typeof artifact.path !== "string") throw Error("STAGE_CHECK_CONTRACT_INVALID")
      compositionRelativePath(artifact.pattern ? artifact.path.replace(/\*/g, "x") : artifact.path)
      return {
        id: compositionText(artifact.id),
        path: artifact.path,
        ...(artifact.pattern === true ? { pattern: true } : {})
      }
    })
    return {
      nodeId: compositionText(item.nodeId),
      checkId: compositionText(item.checkId),
      contractDigest: compositionDigest(item.contractDigest),
      ...(item.checkOnly === true ? { checkOnly: true as const } : {}),
      artifacts
    }
  })
  if (
    new Set(contracts.map((item) => JSON.stringify([item.nodeId, item.checkId]))).size !==
    contracts.length
  )
    throw Error("STAGE_CHECK_CONTRACT_DUPLICATE")
  return contracts
}
