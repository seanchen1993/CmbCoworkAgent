import { serialize } from "node:v8"
import type {
  HarnessEnterpriseProjectDetailItem,
  HarnessEnterpriseProjectDetailResult,
  HarnessProjectReviewItem,
  HarnessProjectReviewResult
} from "../../shared/harness-board-types"
import {
  HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES,
  HARNESS_ENTERPRISE_REVIEW_SUMMARY_MAX_RESPONSE_BYTES,
  HARNESS_ENTERPRISE_REVIEW_TYPES_MAX_RESPONSE_BYTES,
  type HarnessEnterpriseProjectionStats
} from "./enterprise-projection-protocol"

const MAX_SHORT_TEXT_LENGTH = 512
const MAX_REVIEW_TITLE_LENGTH = 1024
const MAX_REVIEW_MEMBERS_LENGTH = 4096
const ERROR_PREVIEW_LENGTH = 1024
const SUCCESS_CODE = "SUC0000"

export class HarnessEnterpriseProjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly preview?: string
  ) {
    super(message)
    this.name = "HarnessEnterpriseProjectionError"
  }
}

interface ProjectionOptions {
  maxOutputBytes: number
  cancelFlag: Int32Array
}

interface DetailProjectionOptions extends ProjectionOptions {
  maxProjects: number
}

interface ReviewProjectionOptions extends ProjectionOptions {
  maxReviews: number
  maxTypeNodes: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown, maxLength = MAX_SHORT_TEXT_LENGTH): string {
  const normalized =
    typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim()
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength)
}

function checkCancelled(cancelFlag: Int32Array): void {
  if (Atomics.load(cancelFlag, 0) !== 0) {
    throw new HarnessEnterpriseProjectionError(
      "HARNESS_ENTERPRISE_PROJECTION_CANCELLED",
      "Harness enterprise projection was superseded"
    )
  }
}

function parseJson(buffer: Buffer, maxBytes: number, source: string): unknown {
  if (buffer.byteLength > maxBytes) {
    throw new HarnessEnterpriseProjectionError(
      "HARNESS_ENTERPRISE_RESPONSE_TOO_LARGE",
      `${source} response exceeded ${maxBytes} bytes`
    )
  }
  const sourceText = buffer.toString("utf8")
  try {
    return JSON.parse(sourceText) as unknown
  } catch {
    throw new HarnessEnterpriseProjectionError(
      "HARNESS_ENTERPRISE_INVALID_JSON",
      `${source} returned invalid JSON`,
      sourceText.slice(0, ERROR_PREVIEW_LENGTH)
    )
  }
}

function ensureOutputBudget(value: unknown, maxOutputBytes: number): number {
  const outputBytes = serialize(value).byteLength
  if (outputBytes > maxOutputBytes) {
    throw new HarnessEnterpriseProjectionError(
      "HARNESS_ENTERPRISE_RESULT_TOO_LARGE",
      `normalized result exceeded IPC limit (${maxOutputBytes} bytes)`
    )
  }
  return outputBytes
}

function normalizeDetailItem(value: unknown): HarnessEnterpriseProjectDetailItem | null {
  if (!isObject(value)) return null
  const projectCode = text(value.prjCode)
  const projectName = text(value.prjName)
  if (!projectCode && !projectName) return null
  const mainProduct = text(value.mainProduct)
  const systemId = mainProduct.length >= 7 ? mainProduct.slice(0, 7) : ""
  const systemName = mainProduct.length >= 7 ? mainProduct.slice(7).trim() : ""
  return {
    projectCode,
    projectName,
    pm: text(value.pm),
    systemId,
    systemName,
    status: text(value.status),
    phaseStatus: text(value.phaseStatus),
    baselineEndDate: text(value.baselineEndDate)
  }
}

export function projectEnterpriseProjectDetails(
  buffer: Buffer,
  options: DetailProjectionOptions
): { result: HarnessEnterpriseProjectDetailResult; stats: HarnessEnterpriseProjectionStats } {
  const startedAt = performance.now()
  checkCancelled(options.cancelFlag)
  const parsed = parseJson(buffer, HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES, "Project detail")
  checkCancelled(options.cancelFlag)
  if (!isObject(parsed)) {
    throw new HarnessEnterpriseProjectionError(
      "HARNESS_ENTERPRISE_INVALID_RESPONSE",
      "Project detail returned an invalid response"
    )
  }
  if (parsed.returnCode !== SUCCESS_CODE) {
    throw new HarnessEnterpriseProjectionError(
      "HARNESS_ENTERPRISE_REQUEST_FAILED",
      text(parsed.errorMsg) || "找不到项目"
    )
  }
  const source = Array.isArray(parsed.body) ? parsed.body : []
  const projects: HarnessEnterpriseProjectDetailItem[] = []
  for (let index = 0; index < source.length && projects.length < options.maxProjects; index += 1) {
    if ((index & 31) === 0) checkCancelled(options.cancelFlag)
    const project = normalizeDetailItem(source[index])
    if (project) projects.push(project)
  }
  checkCancelled(options.cancelFlag)
  const result = { projects }
  const outputBytes = ensureOutputBudget(result, options.maxOutputBytes)
  return {
    result,
    stats: {
      durationMs: performance.now() - startedAt,
      inputBytes: buffer.byteLength,
      outputBytes,
      itemCount: projects.length
    }
  }
}

function buildReviewTypeMap(
  reviewTypes: unknown[],
  maxTypeNodes: number,
  cancelFlag: Int32Array
): Map<string, string> {
  const typeMap = new Map<string, string>()
  const stack = reviewTypes
    .slice(0, maxTypeNodes)
    .reverse()
    .map((value) => ({ value, parentDescription: "" }))
  let visited = 0
  while (stack.length > 0 && visited < maxTypeNodes) {
    if ((visited & 31) === 0) checkCancelled(cancelFlag)
    const entry = stack.pop()
    if (!entry || !isObject(entry.value)) continue
    visited += 1
    const typeCode = text(entry.value.type)
    const description = text(entry.value.description)
    if (typeCode) {
      typeMap.set(
        typeCode,
        entry.parentDescription ? `${entry.parentDescription} - ${description}` : description
      )
    }
    const subTypes = Array.isArray(entry.value.subTypes) ? entry.value.subTypes : []
    const remaining = Math.max(0, maxTypeNodes - visited - stack.length)
    for (let index = Math.min(subTypes.length, remaining) - 1; index >= 0; index -= 1) {
      stack.push({ value: subTypes[index], parentDescription: description })
    }
  }
  return typeMap
}

function normalizeReviewItem(
  value: unknown,
  typeMap: Map<string, string>
): HarnessProjectReviewItem | null {
  if (!isObject(value)) return null
  const creator = text(value.creator)
  const creatorName = text(value.creatorName)
  const members = Array.isArray(value.reviewMembers)
    ? value.reviewMembers
        .slice(0, 128)
        .map((member) => isObject(member) ? text(member.name) : "")
        .filter(Boolean)
        .join(", ")
        .slice(0, MAX_REVIEW_MEMBERS_LENGTH)
    : ""
  return {
    title: text(value.title, MAX_REVIEW_TITLE_LENGTH),
    type: typeMap.get(text(value.type)) || "其他",
    start_time: text(value.startTime),
    end_time: text(value.endTime),
    creator: `${creator} (${creatorName})`,
    members
  }
}

export function projectEnterpriseProjectReviews(
  summaryBuffer: Buffer,
  typeBuffer: Buffer,
  options: ReviewProjectionOptions
): { result: HarnessProjectReviewResult; stats: HarnessEnterpriseProjectionStats } {
  const startedAt = performance.now()
  checkCancelled(options.cancelFlag)
  const summary = parseJson(
    summaryBuffer,
    HARNESS_ENTERPRISE_REVIEW_SUMMARY_MAX_RESPONSE_BYTES,
    "Review summary"
  )
  checkCancelled(options.cancelFlag)
  const types = parseJson(
    typeBuffer,
    HARNESS_ENTERPRISE_REVIEW_TYPES_MAX_RESPONSE_BYTES,
    "Review types"
  )
  checkCancelled(options.cancelFlag)
  const rawReviews = isObject(summary) && Array.isArray(summary.reviewSummaries)
    ? summary.reviewSummaries
    : []
  const rawTypes = isObject(types) && Array.isArray(types.data) ? types.data : []
  const typeMap = buildReviewTypeMap(rawTypes, options.maxTypeNodes, options.cancelFlag)
  const reviews: HarnessProjectReviewItem[] = []
  for (
    let index = 0;
    index < rawReviews.length && reviews.length < options.maxReviews;
    index += 1
  ) {
    if ((index & 15) === 0) checkCancelled(options.cancelFlag)
    const review = normalizeReviewItem(rawReviews[index], typeMap)
    if (review) reviews.push(review)
  }
  checkCancelled(options.cancelFlag)
  const result = { tokenConfigured: true, reviews }
  const outputBytes = ensureOutputBudget(result, options.maxOutputBytes)
  return {
    result,
    stats: {
      durationMs: performance.now() - startedAt,
      inputBytes: summaryBuffer.byteLength + typeBuffer.byteLength,
      outputBytes,
      itemCount: reviews.length
    }
  }
}
