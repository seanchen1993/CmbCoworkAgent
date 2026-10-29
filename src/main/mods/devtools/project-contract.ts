import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AuthoringSourceBundle } from "./authoring-bundle"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"
import type {
  HostExecutionTicket,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import {
  assertHostRuntimeSupported,
  validateHostStage
} from "../../harness-board/project-runtime/host-validators"

interface ContractCase {
  id: string
  stageId: string
  files: Array<{ path: string; text: string }>
  expected: "passed" | "failed"
}

export interface ProjectContractDiagnostic {
  code: string
  file: "tests/project-contract.json"
  /** JSON Pointer into the author source, not an absolute workspace path. */
  path: string
  message: string
  allowedPaths?: string[]
  allowedStageIds?: string[]
  caseId?: string
  stageId?: string
  expected?: "passed" | "failed"
  actual?: "passed" | "failed"
  checks?: Array<{ checkId: string; result: string }>
}

/** Host-created reasons only; fixture bodies and parser excerpts never leave this boundary. */
export class ProjectContractError extends Error {
  constructor(
    readonly diagnostics: ProjectContractDiagnostic[],
    code = "PROJECT_CONTRACT_INVALID"
  ) {
    super(code)
    this.name = "ProjectContractError"
  }
}

function invalid(
  code: string,
  reason: string,
  path: string,
  message: string,
  details: Partial<Pick<ProjectContractDiagnostic, "allowedPaths" | "allowedStageIds">> = {}
): never {
  throw new ProjectContractError(
    [{ code: reason, file: "tests/project-contract.json", path, message, ...details }],
    code
  )
}

function parseCases(
  bundle: AuthoringSourceBundle,
  manifest: ProjectRuntimeManifest
): ContractCase[] {
  const code = "PROJECT_CONTRACT_INVALID"
  let raw: unknown
  try {
    raw = JSON.parse(
      bundle.files.find((file) => file.path === "tests/project-contract.json")?.text ?? "null"
    )
  } catch {
    invalid(
      code,
      "PROJECT_CONTRACT_JSON_SYNTAX",
      "",
      "Contract file must contain valid JSON; no fixture text was executed."
    )
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    invalid(code, "PROJECT_CONTRACT_OBJECT_REQUIRED", "", "Contract root must be an object.")
  if (Object.keys(raw).some((key) => !["apiVersion", "cases"].includes(key)))
    invalid(
      code,
      "PROJECT_CONTRACT_UNKNOWN_FIELD",
      "",
      "Contract root permits only apiVersion and cases."
    )
  if (!("apiVersion" in raw) || raw.apiVersion !== "devclaw.project-contract/v1")
    invalid(
      code,
      "PROJECT_CONTRACT_API_VERSION",
      "/apiVersion",
      "apiVersion must be devclaw.project-contract/v1."
    )
  if (!("cases" in raw) || !Array.isArray(raw.cases) || !raw.cases.length || raw.cases.length > 32)
    invalid(
      code,
      "PROJECT_CONTRACT_CASES_LIMIT",
      "/cases",
      "cases must be an array with 1 to 32 cases."
    )
  const ids = new Set<string>()
  return raw.cases.map((item: unknown, caseIndex): ContractCase => {
    const location = `/cases/${caseIndex}`
    if (!item || typeof item !== "object" || Array.isArray(item))
      invalid(code, "PROJECT_CONTRACT_CASE_OBJECT", location, "Each case must be an object.")
    if (Object.keys(item).some((key) => !["id", "stageId", "files", "expected"].includes(key)))
      invalid(
        code,
        "PROJECT_CONTRACT_CASE_UNKNOWN_FIELD",
        location,
        "Case permits only id, stageId, files and expected."
      )
    const value = item as Record<string, unknown>
    if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id))
      invalid(
        code,
        "PROJECT_CONTRACT_CASE_ID",
        `${location}/id`,
        "Case id must match ^[a-z][a-z0-9-]{0,63}$."
      )
    if (ids.has(value.id))
      invalid(code, "PROJECT_CONTRACT_CASE_DUPLICATE", `${location}/id`, "Case id must be unique.")
    if (!manifest.stages.some((stage) => stage.id === value.stageId))
      invalid(
        code,
        "PROJECT_CONTRACT_STAGE_UNDECLARED",
        `${location}/stageId`,
        "stageId must reference a stage in the current compiled source.",
        { allowedStageIds: manifest.stages.map((stage) => stage.id).slice(0, 32) }
      )
    if (!Array.isArray(value.files) || value.files.length > 16)
      invalid(
        code,
        "PROJECT_CONTRACT_FILES_LIMIT",
        `${location}/files`,
        "files must be an array with at most 16 fixture files."
      )
    if (!["passed", "failed"].includes(String(value.expected)))
      invalid(
        code,
        "PROJECT_CONTRACT_EXPECTED",
        `${location}/expected`,
        "expected must be passed or failed."
      )
    ids.add(value.id)
    const paths = new Set<string>()
    const files = value.files.map((file: unknown, fileIndex) => {
      const field = `${location}/files/${fileIndex}`
      const fileCode = "PROJECT_CONTRACT_FILE_INVALID"
      if (!file || typeof file !== "object" || Array.isArray(file))
        invalid(
          fileCode,
          "PROJECT_CONTRACT_FILE_OBJECT",
          field,
          "Each fixture file must be an object containing path and text."
        )
      if (
        Object.keys(file).length !== 2 ||
        Object.keys(file).some((key) => !["path", "text"].includes(key))
      )
        invalid(
          fileCode,
          "PROJECT_CONTRACT_FILE_FIELDS",
          field,
          "Fixture file permits exactly path and text; content is not a supported field."
        )
      if (!("path" in file) || typeof file.path !== "string")
        invalid(
          fileCode,
          "PROJECT_CONTRACT_FILE_PATH",
          `${field}/path`,
          "Fixture path must be a string."
        )
      if (!manifest.artifacts.some((artifact) => artifact.path === file.path))
        invalid(
          fileCode,
          "PROJECT_CONTRACT_ARTIFACT_UNDECLARED",
          `${field}/path`,
          "Fixture path must exactly match a declared artifact path, including case. Update fixture references when replacing artifacts; do not remove checks.",
          { allowedPaths: manifest.artifacts.map((artifact) => artifact.path).slice(0, 32) }
        )
      if (paths.has(file.path.toLowerCase()))
        invalid(
          fileCode,
          "PROJECT_CONTRACT_FILE_DUPLICATE",
          `${field}/path`,
          "Fixture paths must be unique ignoring case."
        )
      if (!("text" in file) || typeof file.text !== "string")
        invalid(
          fileCode,
          "PROJECT_CONTRACT_FILE_TEXT",
          `${field}/text`,
          "Fixture text must be a string, including when it represents JSON."
        )
      if (Buffer.byteLength(file.text) > 65536)
        invalid(
          fileCode,
          "PROJECT_CONTRACT_FILE_TEXT_LIMIT",
          `${field}/text`,
          "Fixture text exceeds the 65536-byte limit."
        )
      paths.add(file.path.toLowerCase())
      return { path: file.path, text: file.text }
    })
    return {
      id: value.id,
      stageId: String(value.stageId),
      files,
      expected: value.expected as "passed" | "failed"
    }
  })
}

export interface ProjectContractReport {
  valid: boolean
  digest: string
  scope: "isolated-host-artifact-checks"
  cases: Array<{
    id: string
    stageId: string
    expected: "passed" | "failed"
    actual: "passed" | "failed"
    matched: boolean
  }>
  limitations: string[]
  diagnostics?: ProjectContractDiagnostic[]
}

export function assertProjectContractPassed(report: ProjectContractReport): void {
  if (!report.valid)
    throw new ProjectContractError(
      report.diagnostics ?? [
        {
          code: "PROJECT_CONTRACT_EXPECTATION_MISMATCH",
          file: "tests/project-contract.json",
          path: "/cases",
          message:
            "Contract cases did not match the unchanged Host artifact validators. Repair fixtures/contracts; do not weaken checks or change expectations solely to mark a test passed."
        }
      ],
      "PROJECT_HARNESS_CONTRACT_FAILED"
    )
}

/** Writes only generated fixtures in a fresh temporary directory; executes no plugin/Skill code. */
export async function testProjectSource(
  bundle: AuthoringSourceBundle,
  manifest: ProjectRuntimeManifest
): Promise<ProjectContractReport> {
  assertHostRuntimeSupported(manifest)
  const cases = parseCases(bundle, manifest)
  const root = await realpath(await mkdtemp(join(tmpdir(), "devclaw-project-contract-")))
  const results: ProjectContractReport["cases"] = []
  const diagnostics: ProjectContractDiagnostic[] = []
  try {
    for (const [caseIndex, item] of cases.entries()) {
      const workspace = join(root, item.id)
      await mkdir(workspace)
      for (const [fileIndex, file] of item.files.entries()) {
        const path = resolve(workspace, file.path)
        if (!path.startsWith(`${workspace}${process.platform === "win32" ? "\\" : "/"}`))
          invalid(
            "PROJECT_CONTRACT_FILE_INVALID",
            "PROJECT_CONTRACT_FILE_OUTSIDE_FIXTURE",
            `/cases/${caseIndex}/files/${fileIndex}/path`,
            "Fixture path must stay inside its isolated case directory."
          )
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, file.text, { encoding: "utf8", flag: "wx" })
      }
      const state: HostProjectState = {
        schemaVersion: 1,
        stateOwner: "host",
        version: 1,
        stageIndex: manifest.stages.findIndex((stage) => stage.id === item.stageId),
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        projectId: `contract-${item.id}`,
        name: item.id,
        workspace,
        goal: "隔离产物校验样例，不执行模型或业务",
        installedPluginId: "isolated-contract-installation",
        packageId: manifest.plugin.id,
        packageVersion: manifest.plugin.version,
        pluginDigest: bundle.digest,
        manifest
      }
      const ticket: HostExecutionTicket = {
        operationId: `contract-${item.id}`,
        projectId: state.projectId,
        stageId: item.stageId,
        expectedVersion: 1,
        inputFingerprint: bundle.digest,
        pluginDigest: bundle.digest
      }
      const receipts = validateHostStage(state, ticket)
      const actual =
        receipts.length && receipts.every((receipt) => receipt.result === "passed")
          ? "passed"
          : "failed"
      results.push({
        id: item.id,
        stageId: item.stageId,
        expected: item.expected,
        actual,
        matched: actual === item.expected
      })
      if (actual !== item.expected)
        diagnostics.push({
          code: "PROJECT_CONTRACT_EXPECTATION_MISMATCH",
          file: "tests/project-contract.json",
          path: `/cases/${caseIndex}/expected`,
          caseId: item.id,
          stageId: item.stageId,
          expected: item.expected,
          actual,
          checks: receipts.map(({ checkId, result }) => ({ checkId, result })),
          message:
            "Expected result differs from unchanged Host artifact validators. Repair the fixture or declared artifact/check contract; do not weaken checks or change expectations solely to mark a test passed. Action checks remain unknown here and require an authorized native trial."
        })
    }
    return {
      valid: results.every((result) => result.matched),
      digest: bundle.digest,
      scope: "isolated-host-artifact-checks",
      cases: results,
      ...(diagnostics.length ? { diagnostics } : {}),
      limitations: [
        "真实读取隔离产物并执行宿主校验器；未执行 Skill、模型或业务脚本。",
        ...(manifest.checks.some((check) => check.kind === "action")
          ? [
              "公开动作业务检查未执行，其回执保持 unknown；仅负例通过不代表业务验证成功，须在授权试用中执行真实检查器。"
            ]
          : []),
        "人工审批、阶段事务、失败重试、正式安装和业务内容质量仍需生产场景验收。"
      ]
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
