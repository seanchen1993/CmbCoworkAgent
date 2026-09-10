import { getUserInfo } from "../storage"
import { deriveUpperOrgLv1FromPath } from "../org-levels"
import type {
  HarnessDeployUnitSearchInput,
  HarnessDeployUnitSearchItem,
  HarnessDeployUnitSearchResult,
  HarnessEnterpriseProjectDetailInput,
  HarnessEnterpriseProjectDetailItem,
  HarnessEnterpriseProjectDetailResult,
  HarnessEnterpriseProjectSearchInput,
  HarnessEnterpriseProjectSearchItem,
  HarnessEnterpriseProjectSearchResult,
  HarnessPipelineLabelItem,
  HarnessPipelineLabelQueryInput,
  HarnessPipelineLabelQueryResult,
  HarnessPipelineQueryInput,
  HarnessPipelineQueryItem,
  HarnessPipelineQueryResult,
  HarnessProjectReviewInput,
  HarnessProjectReviewResult
} from "../../shared/harness-board-types"
import { readBoundedResponseBody } from "./bounded-response-reader"
import {
  cancelHarnessCatalogScope,
  readHarnessLeanTokenInWorker
} from "./catalog-client"
import {
  cancelHarnessEnterpriseProjectionScope,
  projectHarnessEnterpriseDetailsInWorker,
  projectHarnessEnterpriseReviewsInWorker
} from "./enterprise-projection-client"
import {
  HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS,
  HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES,
  HARNESS_ENTERPRISE_REVIEW_PAGE_SIZE,
  HARNESS_ENTERPRISE_REVIEW_SUMMARY_MAX_RESPONSE_BYTES,
  HARNESS_ENTERPRISE_REVIEW_TYPES_MAX_RESPONSE_BYTES
} from "./enterprise-projection-protocol"

const ENTERPRISE_PROJECT_SEARCH_PAGE_SIZE = 15
const DEPLOY_UNIT_SEARCH_PAGE_SIZE = 20
const DEPLOY_UNIT_FALLBACK_ORG_ID = "991175"
const ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS = 10000
const ENTERPRISE_PROJECT_SUCCESS_CODE = "SUC0000"
const LEANSTAR_REVIEW_REQUEST_TIMEOUT_MS = 10000
const ENTERPRISE_PROJECT_CODE_MAX_LENGTH = 128

export interface HarnessEnterpriseRequestOptions {
  scope?: string
  signal?: AbortSignal
}

export class HarnessEnterpriseRequestCancelledError extends Error {
  readonly code = "HARNESS_ENTERPRISE_REQUEST_CANCELLED"

  constructor(message = "Harness enterprise request was superseded", options?: ErrorOptions) {
    super(message, options)
    this.name = "HarnessEnterpriseRequestCancelledError"
  }
}

class HarnessEnterpriseRequestTimeoutError extends Error {
  constructor() {
    super("Harness enterprise request timed out")
    this.name = "HarnessEnterpriseRequestTimeoutError"
  }
}

interface EnterpriseRequestLifecycle {
  signal: AbortSignal
  workerScope: string
  abort: (reason: Error) => void
  finish: () => void
}

const activeEnterpriseRequestControllers = new Map<string, AbortController>()
let nextUnscopedRequestId = 1

function normalizedRequestScope(scope: string | undefined): string {
  return typeof scope === "string" ? scope.slice(0, 256).trim() : ""
}

function beginEnterpriseRequest(
  options: HarnessEnterpriseRequestOptions,
  timeoutMs: number
): EnterpriseRequestLifecycle {
  const scope = normalizedRequestScope(options.scope)
  const workerScope = scope || `enterprise-unscoped:${nextUnscopedRequestId++}`
  const controller = new AbortController()

  if (scope) {
    const previous = activeEnterpriseRequestControllers.get(scope)
    previous?.abort(new HarnessEnterpriseRequestCancelledError())
    cancelHarnessEnterpriseProjectionScope(scope)
    activeEnterpriseRequestControllers.set(scope, controller)
  }

  const abortFromCaller = (): void => {
    controller.abort(
      new HarnessEnterpriseRequestCancelledError("Harness enterprise request was cancelled", {
        cause: options.signal?.reason
      })
    )
  }
  if (options.signal?.aborted) {
    abortFromCaller()
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  }
  const timeout = setTimeout(() => {
    controller.abort(new HarnessEnterpriseRequestTimeoutError())
  }, timeoutMs)
  timeout.unref()

  return {
    signal: controller.signal,
    workerScope,
    abort: (reason) => controller.abort(reason),
    finish: () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abortFromCaller)
      if (scope && activeEnterpriseRequestControllers.get(scope) === controller) {
        activeEnterpriseRequestControllers.delete(scope)
      }
    }
  }
}

function mapEnterpriseRequestError(
  error: unknown,
  signal: AbortSignal,
  timeoutMessage: string
): Error {
  if (signal.aborted) {
    if (signal.reason instanceof HarnessEnterpriseRequestTimeoutError) {
      return new Error(timeoutMessage)
    }
    if (signal.reason instanceof Error) return signal.reason
    return new HarnessEnterpriseRequestCancelledError()
  }
  return error instanceof Error ? error : new Error(String(error))
}

export function cancelHarnessEnterpriseRequestScope(scope: string): void {
  const normalizedScope = normalizedRequestScope(scope)
  if (!normalizedScope) return
  const controller = activeEnterpriseRequestControllers.get(normalizedScope)
  activeEnterpriseRequestControllers.delete(normalizedScope)
  controller?.abort(new HarnessEnterpriseRequestCancelledError())
  cancelHarnessEnterpriseProjectionScope(normalizedScope)
  cancelHarnessCatalogScope(`${normalizedScope}:lean-token`)
}

export function cancelAllHarnessEnterpriseRequestScopes(): void {
  for (const scope of Array.from(activeEnterpriseRequestControllers.keys())) {
    cancelHarnessEnterpriseRequestScope(scope)
  }
}

function normalizeEnterpriseProjectCodes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("项目详情查询参数无效")
  }
  if (value.length > HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS) {
    throw new Error(`项目详情单次最多查询 ${HARNESS_ENTERPRISE_DETAIL_MAX_PROJECTS} 个项目`)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") continue
    const code = value[index].slice(0, ENTERPRISE_PROJECT_CODE_MAX_LENGTH).trim()
    if (!code || seen.has(code)) continue
    seen.add(code)
    result.push(code)
  }
  return result
}

interface EnterpriseProjectQueryResponse {
  returnCode?: string
  errorMsg?: string | null
  body?:
    | {
        pageNum?: number
        pageSize?: number
        pages?: number
        total?: number
        data?: unknown[]
      }
    | unknown[]
}

interface DeployUnitQueryResponse {
  returnCode?: string
  errorMsg?: string | null
  body?: {
    records?: unknown[]
    total?: number
    pages?: number
    current?: number
  }
}

interface PipelineQueryResponse {
  returnCode?: string
  errorMsg?: string | null
  body?: {
    records?: unknown[]
    total?: number
    size?: number
    current?: number
    pages?: number
  }
}

interface PipelineLabelQueryResponse {
  returnCode?: string
  errorMsg?: string | null
  body?: unknown[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim()
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function getThreeMonthsAgoDate(): string {
  const date = new Date()
  date.setMonth(date.getMonth() - 3)
  return formatDate(date)
}

function getEnterpriseProjectQueryUrl(): string {
  return (import.meta.env.VITE_ENTERPRISE_PROJECT_QUERY_URL as string | undefined)?.trim() || ""
}

function getEnterpriseProjectListUrl(): string {
  return (import.meta.env.VITE_ENTERPRISE_PROJECT_LIST as string | undefined)?.trim() || ""
}

function getDeployUnitQueryUrl(): string {
  return (import.meta.env.VITE_DEPLOY_UNIT_QUERY_URL as string | undefined)?.trim() || ""
}

function getPipelineQueryUrl(): string {
  return (import.meta.env.VITE_PIPELINE_QUERY_URL as string | undefined)?.trim() || ""
}

function getPipelineLabelQueryUrl(): string {
  return (import.meta.env.VITE_PIPELINE_LABEL_QUERY_URL as string | undefined)?.trim() || ""
}

function getLeanstarReviewGatewayUrl(): string {
  return (import.meta.env.VITE_LEANSTAR_REVIEW_GATEWAY_URL as string | undefined)?.trim() || ""
}

function resolveDeployUnitOrgId(originPathId?: string): string {
  try {
    const parts =
      typeof originPathId === "string"
        ? originPathId
            .split("/")
            .map((part) => part.trim())
            .filter(Boolean)
        : []
    const orgId =
      parts.length === 6 || parts.length === 7
        ? parts[4]
        : parts.length <= 5
          ? parts[parts.length - 1]
          : ""
    return normalizeText(orgId) || DEPLOY_UNIT_FALLBACK_ORG_ID
  } catch {
    return DEPLOY_UNIT_FALLBACK_ORG_ID
  }
}

function logHarnessHttpRequest(configKey: string, method: string, url: string, detail?: string): void {
  console.log(`[HarnessBoard] [${configKey}] Running${detail ? ` (${detail})` : ""}: ${method} ${url}`)
}

function isEnterpriseProjectQueryMockEnabled(): boolean {
  const value = (import.meta.env.VITE_ENTERPRISE_PROJECT_QUERY_MOCK as string | undefined)
    ?.trim()
    .toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function isKnowledgeMockEnabled(): boolean {
  const value = (import.meta.env.VITE_KNOWLEDGE_MOCK as string | undefined)
    ?.trim()
    .toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function isProjectReviewEmptyMockEnabled(): boolean {
  const value = (import.meta.env.VITE_ENTERPRISE_PROJECT_REVIEW_MOCK_EMPTY as string | undefined)
    ?.trim()
    .toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function splitMainProduct(mainProduct: string): Pick<
  HarnessEnterpriseProjectSearchItem,
  "systemId" | "systemName"
> {
  if (mainProduct.length < 7) {
    return { systemId: "", systemName: "" }
  }
  return {
    systemId: mainProduct.slice(0, 7),
    systemName: mainProduct.slice(7).trim()
  }
}

function normalizeEnterpriseProjectItem(value: unknown): HarnessEnterpriseProjectSearchItem | null {
  if (!isObject(value)) return null

  const projectCode = normalizeText(value.prjCode)
  const projectName = normalizeText(value.prjName)
  if (!projectCode && !projectName) return null

  const mainProduct = normalizeText(value.mainProduct)
  return {
    projectCode,
    projectName,
    pm: normalizeText(value.pm),
    ...splitMainProduct(mainProduct)
  }
}

function normalizeDeployUnitSearchItem(value: unknown): HarnessDeployUnitSearchItem | null {
  if (!isObject(value)) return null

  const deployUnit = normalizeText(value.deployUnit)
  if (!deployUnit) return null

  return {
    deployUnit,
    deployUnitName: normalizeText(value.deployUnitName),
    ownerId: normalizeText(value.ownerId),
    ownerName: normalizeText(value.ownerName)
  }
}

function normalizePipelineQueryItem(value: unknown): HarnessPipelineQueryItem | null {
  if (!isObject(value)) return null

  const pipeline = normalizeText(value.pipeline)
  if (!pipeline) return null

  return {
    pipeline,
    pipelineAlias: normalizeText(value.pipelineAlias),
    env: normalizeText(value.env),
    branch: normalizeText(value.branch),
    latestBuildStatus: normalizeText(value.latestBuildStatus),
    latestCompletedTime: normalizeText(value.latestCompletedTime)
  }
}

function normalizePipelineLabelItem(value: unknown): HarnessPipelineLabelItem | null {
  if (!isObject(value)) return null

  const pipelineName = normalizeText(value.pipelineName)
  if (!pipelineName) return null

  return {
    pipelineName,
    pipelineNumber: numberValue(value.pipelineNumber),
    status: normalizeText(value.status),
    startDate: normalizeText(value.startDate),
    label: normalizeText(value.label),
    triggerUser: normalizeText(value.triggerUser)
  }
}

function normalizeSearchResponse(
  response: EnterpriseProjectQueryResponse
): HarnessEnterpriseProjectSearchResult {
  if (response.returnCode !== ENTERPRISE_PROJECT_SUCCESS_CODE) {
    throw new Error(response.errorMsg || "找不到项目")
  }

  const body = isObject(response.body) ? response.body : undefined
  const rawData = Array.isArray(body?.data) ? body.data : []
  const projects = rawData
    .map((item) => normalizeEnterpriseProjectItem(item))
    .filter((item): item is HarnessEnterpriseProjectSearchItem => item !== null)
  const total = numberValue(body?.total)
  const pageNum = numberValue(body?.pageNum) || 1
  const pages = numberValue(body?.pages)

  return {
    projects,
    total,
    hasMore: total > projects.length || pages > pageNum
  }
}

function normalizeDeployUnitSearchResponse(
  response: DeployUnitQueryResponse
): HarnessDeployUnitSearchResult {
  if (response.returnCode !== ENTERPRISE_PROJECT_SUCCESS_CODE) {
    throw new Error(response.errorMsg || "发布单元查询失败")
  }

  const records = Array.isArray(response.body?.records) ? response.body.records : []
  const deployUnits = records
    .map((item) => normalizeDeployUnitSearchItem(item))
    .filter((item): item is HarnessDeployUnitSearchItem => item !== null)
  const total = numberValue(response.body?.total)
  const current = numberValue(response.body?.current) || 1
  const pages = numberValue(response.body?.pages)

  return {
    deployUnits,
    total,
    hasMore: total > deployUnits.length || pages > current
  }
}

function normalizePipelineQueryResponse(
  response: PipelineQueryResponse
): HarnessPipelineQueryResult {
  if (response.returnCode !== ENTERPRISE_PROJECT_SUCCESS_CODE) {
    throw new Error(response.errorMsg || "流水线查询失败")
  }

  const records = Array.isArray(response.body?.records) ? response.body.records : []
  const pipelines = records
    .map((item) => normalizePipelineQueryItem(item))
    .filter((item): item is HarnessPipelineQueryItem => item !== null)
  const total = numberValue(response.body?.total)
  const size = numberValue(response.body?.size)
  const current = numberValue(response.body?.current)
  const pages = numberValue(response.body?.pages)

  return {
    pipelines,
    total,
    size,
    current,
    pages,
    hasMore: pages > current
  }
}

function normalizePipelineLabelQueryResponse(
  response: PipelineLabelQueryResponse
): HarnessPipelineLabelQueryResult {
  if (response.returnCode !== ENTERPRISE_PROJECT_SUCCESS_CODE) {
    throw new Error(response.errorMsg || "流水线标签查询失败")
  }

  const records = Array.isArray(response.body) ? response.body : []
  const labels = records
    .map((item) => normalizePipelineLabelItem(item))
    .filter((item): item is HarnessPipelineLabelItem => item !== null)

  return { labels }
}

function makeMockEnterpriseProjectSearchResult(): HarnessEnterpriseProjectSearchResult {
  return {
    total: 3,
    hasMore: false,
    projects: [
      {
        projectCode: "T26GIW81",
        projectName: "企业客户经营平台优化",
        pm: "张明",
        systemId: "LF39.18",
        systemName: "（C）WE运营管理平台"
      },
      {
        projectCode: "T26HXK02",
        projectName: "企业项目协同流程改造",
        pm: "李娜",
        systemId: "AB12.34",
        systemName: "（A）项目协同管理系统"
      },
      {
        projectCode: "T26KQ730",
        projectName: "企业服务中台能力建设",
        pm: "王磊",
        systemId: "CD56.78",
        systemName: "（B）企业服务中台"
      }
    ]
  }
}

function makeMockEnterpriseProjectDetailResult(
  prjCodeList: string[]
): HarnessEnterpriseProjectDetailResult {
  const details: HarnessEnterpriseProjectDetailItem[] = [
    {
      projectCode: "T26GIW81",
      projectName: "企业客户经营平台优化",
      pm: "张明",
      systemId: "LF39.18",
      systemName: "（C）WE运营管理平台",
      status: "任务_实施中",
      phaseStatus: "开发中",
      baselineEndDate: "2026-07-17"
    },
    {
      projectCode: "T26HXK02",
      projectName: "企业项目协同流程改造",
      pm: "李娜",
      systemId: "AB12.34",
      systemName: "（A）项目协同管理系统",
      status: "任务_实施中",
      phaseStatus: "联调中",
      baselineEndDate: "2026-08-05"
    }
  ]
  const requestedCodes = new Set(prjCodeList)
  return {
    projects: details.filter((project) => requestedCodes.has(project.projectCode))
  }
}

function makeMockDeployUnitSearchResult(): HarnessDeployUnitSearchResult {
  return {
    total: 3,
    hasMore: false,
    deployUnits: [
      {
        deployUnit: "LF39.18_WealthBoxApi",
        deployUnitName: "财富管理服务接口",
        ownerId: "80280631",
        ownerName: "陈强"
      },
      {
        deployUnit: "LF39.18_WealthBoxWeb",
        deployUnitName: "财富管理服务前端",
        ownerId: "80280631",
        ownerName: "陈强"
      },
      {
        deployUnit: "LF39.18_WealthBoxJob",
        deployUnitName: "财富管理服务批处理",
        ownerId: "80280632",
        ownerName: "李敏"
      }
    ]
  }
}

function makeMockPipelineQueryResult(): HarnessPipelineQueryResult {
  return {
    total: 3,
    size: 20,
    current: 1,
    pages: 1,
    hasMore: false,
    pipelines: [
      {
        pipeline: "p-wealth-box-api-build",
        pipelineAlias: "财富盒子API构建流水线",
        env: "UAT",
        branch: "master",
        latestBuildStatus: "SUCCESS",
        latestCompletedTime: "2026-07-20 16:30:00"
      },
      {
        pipeline: "p-wealth-box-web-build",
        pipelineAlias: "财富盒子前端构建流水线",
        env: "UAT",
        branch: "release/1.0",
        latestBuildStatus: "SUCCESS",
        latestCompletedTime: "2026-07-20 15:00:00"
      },
      {
        pipeline: "p-wealth-box-job-build",
        pipelineAlias: "财富盒子批处理构建流水线",
        env: "UAT",
        branch: "develop",
        latestBuildStatus: "FAILED",
        latestCompletedTime: "2026-07-19 10:00:00"
      }
    ]
  }
}

function makeMockPipelineLabelQueryResult(): HarnessPipelineLabelQueryResult {
  return {
    labels: [
      {
        pipelineName: "mock-pipeline",
        pipelineNumber: 1001,
        status: "SUCCESS",
        startDate: "2026-07-20 10:00:00",
        label: "v1.2.0",
        triggerUser: "zhangsan"
      },
      {
        pipelineName: "mock-pipeline",
        pipelineNumber: 1000,
        status: "SUCCESS",
        startDate: "2026-07-19 10:00:00",
        label: "v1.1.0",
        triggerUser: "lisi"
      },
      {
        pipelineName: "mock-pipeline",
        pipelineNumber: 999,
        status: "FAILED",
        startDate: "2026-07-18 10:00:00",
        label: "v1.0.0",
        triggerUser: "wangwu"
      }
    ]
  }
}

function makeMockProjectReviewResult(projectCode: string): HarnessProjectReviewResult {
  if (!projectCode) {
    return { tokenConfigured: true, reviews: [] }
  }

  return {
    tokenConfigured: true,
    reviews: [
      {
        title: `${projectCode} 需求方案评审`,
        type: "需求评审 - 方案评审",
        start_time: "2026-07-06 09:30:00",
        end_time: "2026-07-06 10:30:00",
        creator: "zhangming (张明)",
        members: "李娜, 王磊, 陈晨"
      },
      {
        title: `${projectCode} 技术设计评审`,
        type: "技术评审 - 详细设计评审",
        start_time: "2026-07-07 14:00:00",
        end_time: "2026-07-07 15:30:00",
        creator: "lina (李娜)",
        members: "张明, 王磊"
      },
      {
        title: `${projectCode} 投产准备评审`,
        type: "上线评审 - 投产准备评审",
        start_time: "2026-07-08 16:00:00",
        end_time: "2026-07-08 17:00:00",
        creator: "wanglei (王磊)",
        members: "张明, 李娜, 陈晨"
      }
    ]
  }
}

export async function searchEnterpriseProjects(
  input: HarnessEnterpriseProjectSearchInput
): Promise<HarnessEnterpriseProjectSearchResult> {
  const keyword = normalizeText(input.keyword)
  const keywordField = input.field === "code" ? "prjCode" : "prjName"
  if (!keyword) {
    return { projects: [], total: 0, hasMore: false }
  }

  if (isEnterpriseProjectQueryMockEnabled()) {
    return makeMockEnterpriseProjectSearchResult()
  }

  const userInfo = getUserInfo()
  const roomName = deriveUpperOrgLv1FromPath(userInfo?.pathName)

  const queryUrl = getEnterpriseProjectQueryUrl()
  if (!queryUrl) {
    throw new Error("未配置项目查询地址")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS)

  try {
    logHarnessHttpRequest(
      "enterprise_project_search",
      "POST",
      queryUrl,
      `${keywordField}=${keyword}, pageNum=1, pageSize=${ENTERPRISE_PROJECT_SEARCH_PAGE_SIZE}`
    )
    const response = await fetch(queryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        createDate: getThreeMonthsAgoDate(),
        [keywordField]: keyword,
        ...(roomName ? { roomName } : {}),
        pageNum: 1,
        pageSize: ENTERPRISE_PROJECT_SEARCH_PAGE_SIZE
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`项目查询失败`)
    }

    const json = (await response.json()) as EnterpriseProjectQueryResponse
    return normalizeSearchResponse(json)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("项目查询超时")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function searchDeployUnits(
  input: HarnessDeployUnitSearchInput
): Promise<HarnessDeployUnitSearchResult> {
  const deployUnit = normalizeText(input.keyword)
  if (!deployUnit) {
    return { deployUnits: [], total: 0, hasMore: false }
  }

  if (isKnowledgeMockEnabled()) {
    return makeMockDeployUnitSearchResult()
  }

  const userInfo = getUserInfo()
  const orgId = resolveDeployUnitOrgId(userInfo?.originPathId)
  const queryUrl = getDeployUnitQueryUrl()
  if (!queryUrl) {
    throw new Error("未配置发布单元查询地址")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS)
  const requestPayload = {
    deployUnit,
    orgId,
    pageNumber: 1,
    pageSize: DEPLOY_UNIT_SEARCH_PAGE_SIZE
  }
  let requestSucceeded = false

  try {
    logHarnessHttpRequest(
      "deploy_unit_search",
      "POST",
      queryUrl,
      `input=${JSON.stringify(requestPayload)}`
    )
    const response = await fetch(queryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error("发布单元查询失败")
    }

    const json = (await response.json()) as DeployUnitQueryResponse
    const result = normalizeDeployUnitSearchResponse(json)
    requestSucceeded = true
    console.log(`[HarnessBoard] [deploy_unit_search] response: ${JSON.stringify(result)}`)
    return result
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("发布单元查询超时")
    }
    throw error
  } finally {
    clearTimeout(timeout)
    console.log(`[HarnessBoard] [deploy_unit_search] ${requestSucceeded ? "success" : "failed"}`)
  }
}

export async function queryPipelines(
  input: HarnessPipelineQueryInput
): Promise<HarnessPipelineQueryResult> {
  if (isKnowledgeMockEnabled()) {
    console.log(`[HarnessBoard] [pipeline_query] mock input=${JSON.stringify(input)}`)
    return makeMockPipelineQueryResult()
  }

  const queryUrl = getPipelineQueryUrl()
  if (!queryUrl) {
    throw new Error("未配置流水线查询地址")
  }

  const userInfo = getUserInfo()
  const orgId = resolveDeployUnitOrgId(userInfo?.originPathId)

  const requestPayload: HarnessPipelineQueryInput = {
    deployUnit: normalizeText(input.deployUnit),
    env: normalizeText(input.env),
    orgId,
    pageNumber: 1,
    pageSize: DEPLOY_UNIT_SEARCH_PAGE_SIZE,
    pipelineTerm: "",
    productTerm: ""
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS)

  try {
    logHarnessHttpRequest(
      "pipeline_query",
      "POST",
      queryUrl,
      `input=${JSON.stringify(requestPayload)}`
    )
    const response = await fetch(queryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error("流水线查询失败")
    }

    const json = (await response.json()) as PipelineQueryResponse
    const result = normalizePipelineQueryResponse(json)
    console.log(`[HarnessBoard] [pipeline_query] response: ${JSON.stringify(result)}`)
    return result
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("流水线查询超时")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function queryPipelineLabels(
  input: HarnessPipelineLabelQueryInput
): Promise<HarnessPipelineLabelQueryResult> {
  if (isKnowledgeMockEnabled()) {
    console.log(`[HarnessBoard] [pipeline_label_query] mock input=${JSON.stringify(input)}`)
    return makeMockPipelineLabelQueryResult()
  }

  const pipelineName = normalizeText(input.pipelineName)
  if (!pipelineName) {
    return { labels: [] }
  }

  const queryUrl = getPipelineLabelQueryUrl()
  if (!queryUrl) {
    throw new Error("未配置流水线标签查询地址")
  }

  const requestUrl = new URL(queryUrl)
  requestUrl.searchParams.set("pipelineName", pipelineName)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS)

  try {
    logHarnessHttpRequest(
      "pipeline_label_query",
      "GET",
      requestUrl.toString(),
      `pipelineName=${pipelineName}`
    )
    const response = await fetch(requestUrl, {
      method: "GET",
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error("流水线标签查询失败")
    }

    const json = (await response.json()) as PipelineLabelQueryResponse
    const result = normalizePipelineLabelQueryResponse(json)
    console.log(`[HarnessBoard] [pipeline_label_query] response: ${JSON.stringify(result)}`)
    return result
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("流水线标签查询超时")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function getEnterpriseProjectDetails(
  input: HarnessEnterpriseProjectDetailInput,
  options: HarnessEnterpriseRequestOptions = {}
): Promise<HarnessEnterpriseProjectDetailResult> {
  const prjCodeList = normalizeEnterpriseProjectCodes(input.prjCodeList)
  if (prjCodeList.length === 0) {
    return { projects: [] }
  }

  if (isEnterpriseProjectQueryMockEnabled()) {
    return makeMockEnterpriseProjectDetailResult(prjCodeList)
  }

  const queryUrl = getEnterpriseProjectListUrl()
  if (!queryUrl) {
    throw new Error("未配置项目详情查询地址")
  }

  const request = beginEnterpriseRequest(options, ENTERPRISE_PROJECT_SEARCH_TIMEOUT_MS)

  try {
    logHarnessHttpRequest(
      "enterprise_project_detail",
      "POST",
      queryUrl,
      `prjCodeList=${prjCodeList.join(",")}`
    )
    const response = await fetch(queryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ prjCodeList }),
      signal: request.signal
    })

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error("项目查询失败")
    }

    const bytes = await readBoundedResponseBody(
      response,
      HARNESS_ENTERPRISE_DETAIL_MAX_RESPONSE_BYTES,
      "Project detail",
      request.signal
    )
    const result = await projectHarnessEnterpriseDetailsInWorker(
      bytes,
      request.workerScope
    )
    if (request.signal.aborted) throw request.signal.reason
    return result
  } catch (error) {
    request.abort(error instanceof Error ? error : new Error(String(error)))
    throw mapEnterpriseRequestError(error, request.signal, "项目查询超时")
  } finally {
    request.finish()
  }
}

export async function getProjectReviews(
  input: HarnessProjectReviewInput,
  options: HarnessEnterpriseRequestOptions = {}
): Promise<HarnessProjectReviewResult> {
  const projectCode =
    typeof input.projectCode === "string"
      ? input.projectCode.slice(0, ENTERPRISE_PROJECT_CODE_MAX_LENGTH).trim()
      : ""
  if (!projectCode) {
    return { tokenConfigured: true, reviews: [] }
  }

  if (isEnterpriseProjectQueryMockEnabled()) {
    if (isProjectReviewEmptyMockEnabled()) {
      return { tokenConfigured: true, reviews: [] }
    }
    return makeMockProjectReviewResult(projectCode)
  }

  const tokenScope = `${normalizedRequestScope(options.scope) || `enterprise-unscoped:${nextUnscopedRequestId++}`}:lean-token`
  const token = (await readHarnessLeanTokenInWorker(tokenScope)).leanToken.trim()
  if (!token) {
    return { tokenConfigured: false, reviews: [] }
  }

  const headers = {
    "Ls-Access-Token": token,
    "Content-Type": "application/json"
  }
  const reviewGatewayUrl = getLeanstarReviewGatewayUrl()
  if (!reviewGatewayUrl) {
    throw new Error("未配置精益平台评审查询地址")
  }
  const summaryUrl = `${reviewGatewayUrl}/api/review/summary/${encodeURIComponent(projectCode)}`
  const reviewTypesUrl = `${reviewGatewayUrl}/api/review/review-types`
  const request = beginEnterpriseRequest(options, LEANSTAR_REVIEW_REQUEST_TIMEOUT_MS)

  try {
    const summarySearchParams = new URLSearchParams({
      size: String(HARNESS_ENTERPRISE_REVIEW_PAGE_SIZE),
      page: "0"
    })
    logHarnessHttpRequest(
      "review_summary",
      "GET",
      `${summaryUrl}?${summarySearchParams.toString()}`,
      `projectCode=${projectCode}`
    )
    const summaryResponsePromise = fetch(`${summaryUrl}?${summarySearchParams.toString()}`, {
      method: "GET",
      headers,
      signal: request.signal
    })
    logHarnessHttpRequest("review_types", "GET", reviewTypesUrl)
    const reviewTypesResponsePromise = fetch(reviewTypesUrl, {
      method: "GET",
      headers,
      signal: request.signal
    })
    const [summaryResponse, reviewTypesResponse] = await Promise.all([
      summaryResponsePromise,
      reviewTypesResponsePromise
    ])
    if (summaryResponse.status === 401) {
      void summaryResponse.body?.cancel().catch(() => undefined)
      void reviewTypesResponse.body?.cancel().catch(() => undefined)
      throw new Error("精益平台 token 认证失败")
    }
    if (!summaryResponse.ok) {
      void summaryResponse.body?.cancel().catch(() => undefined)
      void reviewTypesResponse.body?.cancel().catch(() => undefined)
      throw new Error("项目评审查询失败")
    }

    if (reviewTypesResponse.status === 401) {
      void summaryResponse.body?.cancel().catch(() => undefined)
      void reviewTypesResponse.body?.cancel().catch(() => undefined)
      throw new Error("精益平台 token 认证失败")
    }
    if (!reviewTypesResponse.ok) {
      void summaryResponse.body?.cancel().catch(() => undefined)
      void reviewTypesResponse.body?.cancel().catch(() => undefined)
      throw new Error("评审类型查询失败")
    }

    const [summaryBytes, reviewTypesBytes] = await Promise.all([
      readBoundedResponseBody(
        summaryResponse,
        HARNESS_ENTERPRISE_REVIEW_SUMMARY_MAX_RESPONSE_BYTES,
        "Review summary",
        request.signal
      ),
      readBoundedResponseBody(
        reviewTypesResponse,
        HARNESS_ENTERPRISE_REVIEW_TYPES_MAX_RESPONSE_BYTES,
        "Review types",
        request.signal
      )
    ])
    const result = await projectHarnessEnterpriseReviewsInWorker(
      summaryBytes,
      reviewTypesBytes,
      request.workerScope
    )
    if (request.signal.aborted) throw request.signal.reason
    return result
  } catch (error) {
    request.abort(error instanceof Error ? error : new Error(String(error)))
    throw mapEnterpriseRequestError(error, request.signal, "项目评审查询超时")
  } finally {
    request.finish()
  }
}
