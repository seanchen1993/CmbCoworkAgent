import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AuthoringSourceBundle } from "./authoring-bundle"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"
import type { HostExecutionTicket, HostProjectState } from "../../../shared/project-runtime/host-types"
import { assertHostRuntimeSupported, validateHostStage } from "../../harness-board/project-runtime/host-validators"

interface ContractCase {
  id: string
  stageId: string
  files: Array<{ path: string; text: string }>
  expected: "passed" | "failed"
}

function parseCases(bundle: AuthoringSourceBundle, manifest: ProjectRuntimeManifest): ContractCase[] {
  const raw: unknown = JSON.parse(bundle.files.find(file => file.path === "tests/project-contract.json")?.text ?? "null")
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
    Object.keys(raw).some(key => !["apiVersion", "cases"].includes(key)) ||
    !("apiVersion" in raw) || raw.apiVersion !== "devclaw.project-contract/v1" ||
    !("cases" in raw) || !Array.isArray(raw.cases) || !raw.cases.length || raw.cases.length > 32) {
    throw Error("PROJECT_CONTRACT_INVALID")
  }
  const ids = new Set<string>()
  return raw.cases.map((item: unknown): ContractCase => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some(key => !["id", "stageId", "files", "expected"].includes(key))) throw Error("PROJECT_CONTRACT_INVALID")
    const value = item as Record<string, unknown>
    if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) || ids.has(value.id) ||
      !manifest.stages.some(stage => stage.id === value.stageId) || !Array.isArray(value.files) || value.files.length > 16 ||
      !["passed", "failed"].includes(String(value.expected))) throw Error("PROJECT_CONTRACT_INVALID")
    ids.add(value.id)
    const paths = new Set<string>()
    const files = value.files.map((file: unknown) => {
      if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).length !== 2 ||
        !("path" in file) || typeof file.path !== "string" || !manifest.artifacts.some(artifact => artifact.path === file.path) ||
        paths.has(file.path.toLowerCase()) || !("text" in file) || typeof file.text !== "string" ||
        Buffer.byteLength(file.text) > 65536) throw Error("PROJECT_CONTRACT_FILE_INVALID")
      paths.add(file.path.toLowerCase())
      return { path: file.path, text: file.text }
    })
    return { id: value.id, stageId: String(value.stageId), files, expected: value.expected as "passed" | "failed" }
  })
}

export interface ProjectContractReport {
  valid: boolean
  digest: string
  scope: "isolated-host-artifact-checks"
  cases: Array<{ id: string; stageId: string; expected: "passed" | "failed"; actual: "passed" | "failed"; matched: boolean }>
  limitations: string[]
}

/** Writes only generated fixtures in a fresh temporary directory; executes no plugin/Skill code. */
export async function testProjectSource(bundle: AuthoringSourceBundle, manifest: ProjectRuntimeManifest): Promise<ProjectContractReport> {
  assertHostRuntimeSupported(manifest)
  const cases = parseCases(bundle, manifest)
  const root = await realpath(await mkdtemp(join(tmpdir(), "devclaw-project-contract-")))
  const results: ProjectContractReport["cases"] = []
  try {
    for (const item of cases) {
      const workspace = join(root, item.id)
      await mkdir(workspace)
      for (const file of item.files) {
        const path = resolve(workspace, file.path)
        if (!path.startsWith(`${workspace}${process.platform === "win32" ? "\\" : "/"}`)) throw Error("PROJECT_CONTRACT_FILE_INVALID")
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, file.text, { encoding: "utf8", flag: "wx" })
      }
      const state: HostProjectState = {
        schemaVersion: 1, stateOwner: "host", version: 1, stageIndex: manifest.stages.findIndex(stage => stage.id === item.stageId),
        status: "active", createdAt: 1, updatedAt: 1, projectId: `contract-${item.id}`, name: item.id,
        workspace, goal: "隔离产物校验样例，不执行模型或业务", installedPluginId: "isolated-contract-installation", packageId: manifest.plugin.id,
        packageVersion: manifest.plugin.version, pluginDigest: bundle.digest, manifest
      }
      const ticket: HostExecutionTicket = { operationId: `contract-${item.id}`, projectId: state.projectId,
        stageId: item.stageId, expectedVersion: 1, inputFingerprint: bundle.digest, pluginDigest: bundle.digest }
      const receipts = validateHostStage(state, ticket)
      const actual = receipts.length && receipts.every(receipt => receipt.result === "passed") ? "passed" : "failed"
      results.push({ id: item.id, stageId: item.stageId, expected: item.expected, actual, matched: actual === item.expected })
    }
    return { valid: results.every(result => result.matched), digest: bundle.digest,
      scope: "isolated-host-artifact-checks", cases: results,
      limitations: ["真实读取隔离产物并执行宿主校验器；未执行 Skill、模型或业务脚本。",
        ...(manifest.checks.some((check) => check.kind === "action")
          ? ["公开动作业务检查未执行，其回执保持 unknown；仅负例通过不代表业务验证成功，须在授权试用中执行真实检查器。"] : []),
        "人工审批、阶段事务、失败重试、正式安装和业务内容质量仍需生产场景验收。"] }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
