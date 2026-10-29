/** Live configured provider through a credential-isolated relay; no authored plugin fixtures. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  lstatSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { isAbsolute, relative } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { ServerResponse } from "node:http"
import type { DevelopmentStatus } from "../src/shared/mods/development"
import { enterModsCreatorChat } from "./support/mods-sidebar-navigation"
import { hasLiveCreatorCandidate } from "./support/creator-live-candidate"
import { rejectCreatorLiveRelay } from "./support/creator-live-transport"
import {
  assertGenericProjectReplacement,
  assertGenericProjectRepair,
  auditGenericProjectRuntime,
  genericProjectCreatorScenario,
  readGenericProjectCandidate,
  type GenericProjectCandidate
} from "./support/generic-project-creator-scenario"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert.equal(process.env.COMPOSITION_E2E_PACKAGED_DIR, undefined, "LIVE_NO_ASAR")
assert.equal(process.env.CREATOR_E2E_BUILT_PREVIEW, "1", "LIVE_BUILT_PREVIEW_REQUIRED")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.execution, "built-output")
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256, "LIVE_MAIN_SHA_CHANGED")
assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "2.0.0")
process.env.COMPOSITION_E2E_ARTIFACT_ROOT ??= join(
  root,
  "output/creator-journey-recheck-20261027/live"
)
const fixture = projectCompositionEnvironment(root)
fixture.env.CMB_MODS_E2E = "0"
const maxRequests = Number(process.env.CMB_CREATOR_LIVE_MAX_REQUESTS ?? "24")
assert([16, 24].includes(maxRequests) ||
  (maxRequests === 64 && (!!process.env.CREATOR_LIVE_SOURCE_SET ||
    process.env.GENERIC_PROJECT_CREATOR === "1")), "LIVE_REQUEST_LIMIT_INVALID")
const resumeRun = process.env.CMB_CREATOR_LIVE_RESUME_RUN
const resumeMode = process.env.CMB_CREATOR_LIVE_RESUME_MODE
const genericRepair = process.env.GENERIC_PROJECT_CREATOR === "1" &&
  process.env.GENERIC_PROJECT_CREATOR_REPAIR === "1"
const genericRepairRetry = genericRepair && process.env.GENERIC_PROJECT_CREATOR_REPAIR_RETRY === "1"
const genericDeliveryRecovery = genericRepair && resumeMode === "runtime" &&
  process.env.GENERIC_PROJECT_CREATOR_DELIVERY_RECOVERY === "1"
const resumeLabel = `continuation-${resumeMode}${genericRepair ?
  genericDeliveryRecovery ? "-repair-recovered" : genericRepairRetry ? "-repair-2" : "-repair" : ""}.json`
const installedProjectId = process.env.CMB_CREATOR_LIVE_INSTALLED_PROJECT_ID
if (installedProjectId)
  assert(
    resumeMode === "runtime" && /^[a-f0-9-]{36}$/.test(installedProjectId),
    "LIVE_INSTALLED_RESUME_OPT_IN_INVALID"
  )
// Acceptance guards only; native platform budgets and approvals remain authoritative.
const RUNTIME_HTTP_LIMIT = 16
const RUNTIME_STAGE_MS = 90_000
const COMMAND_REVIEW_LIMIT = 8
const genericProject = process.env.GENERIC_PROJECT_CREATOR === "1"
const projectKind = genericProject ? "three-stage-material-project" : "two-stage-document-project"
// Acceptance watchdog only; production model/tool budgets remain unchanged.
const totalMs = genericProject ? 900_000 :
  process.env.CREATOR_LIVE_DEPENDENCY_CONSENT === "1" ? 600_000 : 300_000
let priorEvidence:
  | { candidate: typeof candidate; observations: Observation[]; fatal?: string }
  | undefined
if (resumeRun) {
  assert(/^run-[A-Za-z0-9]+$/.test(resumeRun), "LIVE_RESUME_RUN_INVALID")
  assert(["diagnostic", "runtime"].includes(resumeMode ?? ""), "LIVE_RESUME_MODE_INVALID")
  const isolated = join(fixture.artifactRoot, resumeRun)
  priorEvidence = JSON.parse(readFileSync(join(isolated,
    genericDeliveryRecovery ? "continuation-runtime-repair.json" :
      genericRepair && resumeMode === "runtime" ? "continuation-diagnostic-repair-2.json" :
      genericRepair ? "continuation-diagnostic.json" : "evidence.json"), "utf8"))
  if (genericRepair) assert.equal(priorEvidence?.fatal, genericDeliveryRecovery ?
    "LIVE_PROJECT_RUNTIME_FAILED" : resumeMode === "runtime" ?
      "LIVE_PROJECT_INSTALLED_CANDIDATE_CHANGED" : "GENERIC_PROJECT_REPORT_OLD_REVIEW")
  if (genericRepairRetry) {
    const priorRepair = JSON.parse(readFileSync(
      join(isolated, "continuation-diagnostic-repair.json"), "utf8"))
    assert.equal(priorRepair.fatal, "GENERIC_PROJECT_RETAINED_SOURCE_CHANGED")
    assert.equal(priorRepair.observations[0].requests.length, 0)
  }
  assert(priorEvidence?.observations.length === 1, "LIVE_RESUME_SINGLE_CHAT_REQUIRED")
  if (
    resumeMode === "diagnostic" &&
    priorEvidence.fatal === "LIVE_DEPENDENCY_EXPLICIT_REVIEW_REQUIRED"
  ) {
    assert.equal(candidate.sha256, priorEvidence.candidate.sha256, "LIVE_DEPENDENCY_BUILD_CHANGED")
    assert.equal(
      process.env.CREATOR_LIVE_DEPENDENCY_CONSENT,
      "1",
      "LIVE_DEPENDENCY_REVIEW_OPT_IN_REQUIRED"
    )
  }
  const evidence = join(isolated, resumeLabel)
  assert(!existsSync(evidence), "LIVE_RESUME_ALREADY_ATTEMPTED")
  writeFileSync(evidence, "{}", { flag: "wx" })
  for (const [key, value] of Object.entries(fixture.env))
    if (value.startsWith(fixture.isolated))
      fixture.env[key] = join(isolated, relative(fixture.isolated, value))
  fixture.isolated = isolated
  fixture.workspace = join(isolated, "workspace")
  assert.equal(dirname(isolated), fixture.artifactRoot)
} else assert(!resumeMode, "LIVE_RESUME_RUN_REQUIRED")
const resumeDependencyReview =
  resumeMode === "diagnostic" && priorEvidence?.fatal === "LIVE_DEPENDENCY_EXPLICIT_REVIEW_REQUIRED"
const afterDependencyConsentPrompt =
  "已通过原生确认完成所需依赖的安装与授权。请继续刚才的插件改造，重新发现真实公开动作并核对契约，完成编译检查和新版本隔离试用候选准备。不要重复安装，不要删减原有业务检查，不要执行项目。"
const evidencePath = join(
  fixture.isolated,
  resumeRun ? resumeLabel : "evidence.json"
)

function realProvider() {
  const modelId = process.env.CMB_CREATOR_LIVE_MODEL_ID?.trim()
  assert(modelId, "LIVE_MODEL_ID_OPT_IN_REQUIRED")
  const home =
    process.env.CMB_CREATOR_LIVE_CONFIG_HOME?.trim() ?? join(homedir(), ".cmbcoworkagent")
  const stored: unknown = JSON.parse(readFileSync(join(home, "custom-models.json"), "utf8"))
  const rows = Array.isArray(stored) ? stored : Object.values(stored as object)
  const config = rows.find((row) => row && typeof row === "object" && row.id === modelId)
  assert(
    config && typeof config.model === "string" && config.model.trim(),
    "LIVE_PROVIDER_NOT_CONFIGURED"
  )
  const keyName =
    "CUSTOM_API_KEY__" + createHash("sha256").update(modelId).digest("hex").slice(0, 12)
  const line = readFileSync(join(home, ".env"), "utf8")
    .split("\n")
    .find((row) => row.slice(0, row.indexOf("=")).trim() === keyName)
  const key = line?.slice(line.indexOf("=") + 1).trim()
  assert(key, "LIVE_PROVIDER_KEY_UNAVAILABLE")
  const base = new URL(String(config.baseUrl))
  assert(["https:", "http:"].includes(base.protocol), "LIVE_PROVIDER_URL_INVALID")
  base.pathname = base.pathname.replace(/\/+$/, "")
  if (!base.pathname) base.pathname = "/v1"
  if (!base.pathname.endsWith("/chat/completions")) base.pathname += "/chat/completions"
  return {
    url: base.toString(),
    key,
    model: String(config.model),
    id: modelId,
    name: String(config.name ?? config.model)
  }
}

interface RequestMetric {
  number: number
  elapsedMs: number
  status?: number
  code?: string
  offeredTools?: string[]
  toolCalls?: Array<{ name: string; argumentKeys: string[] }>
}
interface StageMetric {
  label: string
  startedAt: number
  elapsedMs?: number
  requests: RequestMetric[]
}
interface Observation {
  kind: string
  threadId?: string
  startedAt?: number
  elapsedMs?: number
  outcome?: string
  requests: RequestMetric[]
  priorRequests?: number
  approvals?: Array<{ id: string; operation: string; decision: "reject" }>
  tools: Array<{ id: string; name: string; action?: string }>
  nativeTrace?: Array<{ id: string; request?: unknown; response?: unknown }>
  failures: Array<{ id: string; code: string }>
  repairs: number
  limitCode?: string
  candidateReadyMs?: number
  authoring?: unknown
  dependencyConsents?: unknown[]
  runtime?: {
    controlled: boolean
    requests: number
    phase?: string
    counterBefore?: number
    counterAfter?: number
    verified?: boolean
    error?: string
    stages?: StageMetric[]
    project?: unknown
  }
}
const observations: Observation[] = []
let active: Observation | undefined
let fatal: string | undefined
let app: ElectronApplication | undefined
let page: Page | undefined
let deadline = 0
let executionStage = "initializing"
let activeProjectId: string | undefined
let closing: Promise<boolean> | undefined
const provider = realProvider()
const artifactPrefix = basename(evidencePath, ".json")
const harnessRejections: Array<{
  code: string
  phase: string
  requests: number
  commandProposals?: number
  limit?: number
}> = []
const approvedCommands = new Map<
  string,
  { command: string; workspace: string; remaining: number; review: number }
>()
const commandReviews: Array<{
  command: string
  workspace: string
  digest: string
  review: number
  nativeApprovalRequested?: boolean
}> = []
let commandProposals = 0
async function reviewExecute(args: Record<string, unknown>, workspace: string) {
  assert(
    typeof args.command === "string" && args.command.length > 0 && args.command.length < 20000,
    "LIVE_COMMAND_INVALID"
  )
  assert(
    Object.keys(args).every((key) => ["command", "cwd"].includes(key)),
    "LIVE_COMMAND_ARGUMENT_SCOPE_REJECTED"
  )
  if (args.cwd !== undefined)
    assert(
      typeof args.cwd === "string" &&
        resolve(workspace, args.cwd).toLowerCase() === resolve(workspace).toLowerCase(),
      "LIVE_COMMAND_CWD_REJECTED"
    )
  commandProposals++
  const command = args.command
  const digest = createHash("sha256").update(JSON.stringify({ command, workspace })).digest("hex")
  const dir = join(fixture.isolated, `${artifactPrefix}-command-review`)
  mkdirSync(dir, { recursive: true })
  const proposal = join(dir, digest + `-${commandProposals}.proposal.json`),
    approval = join(dir, digest + `-${commandProposals}.approved.json`),
    rejection = join(dir, digest + `-${commandProposals}.rejected.json`)
  assert(!existsSync(approval), "LIVE_COMMAND_PREAPPROVAL_REJECTED")
  writeFileSync(proposal, JSON.stringify({ command, workspace, digest }, null, 2), { flag: "wx" })
  console.log(
    JSON.stringify({ event: "LIVE_COMMAND_REVIEW_REQUIRED", command, workspace, digest, proposal })
  )
  assert(
    commandProposals <= COMMAND_REVIEW_LIMIT,
    `LIVE_COMMAND_REVIEW_LIMIT requests=${commandProposals} limit=${COMMAND_REVIEW_LIMIT}`
  )
  const until = Math.min(
    deadline,
    runtime?.kind === "project" ? runtime.metric.startedAt + RUNTIME_STAGE_MS : deadline
  )
  while (Date.now() < until) {
    if (existsSync(rejection)) throw Error("LIVE_COMMAND_REVIEW_REJECTED")
    if (existsSync(approval)) {
      const value = JSON.parse(readFileSync(approval, "utf8"))
      assert(value.approved === true && value.digest === digest, "LIVE_COMMAND_APPROVAL_MISMATCH")
      commandReviews.push({ command, workspace, digest, review: commandProposals })
      approvedCommands.set(digest, { command, workspace, remaining: 1, review: commandProposals })
      return
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw Error("LIVE_COMMAND_REVIEW_TIME_LIMIT")
}

const toolSeen = new Set<string>()
const errorSeen = new Set<string>()
const priorToolIds = new Set<string>()
const aborts = new Set<AbortController>()
let runtime:
  | { kind: "counter"; workspace: string; requests: number }
  | { kind: "project"; metric: StageMetric; workspace: string }
  | undefined
const safeCode = (value: unknown) => {
  if (typeof value !== "string") return undefined
  return value.match(/\b[A-Z][A-Z0-9_]{3,100}\b/)?.[0]
}

function nativeFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 40).map(nativeFields)
  if (!value || typeof value !== "object")
    return typeof value === "string" ? value.slice(0, 1600) : value
  const object = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of [
    "ok",
    "error",
    "code",
    "message",
    "missingFields",
    "hint",
    "target",
    "doc",
    "document",
    "check",
    "revision",
    "currentRevision",
    "expectedRevision",
    "nextExpectedRevision",
    "latestRevision",
    "id",
    "name",
    "kind",
    "phase",
    "action",
    "catalogSection",
    "cursor",
    "nextCursor",
    "valid",
    "status",
    "diagnostics",
    "errors",
    "path",
    "file",
    "line",
    "column",
    "endLine",
    "endColumn",
    "severity",
    "nextStep",
    "repairHint",
    "repairHints"
  ])
    if (key in object) result[key] = nativeFields(object[key])
  const files = object.files ?? (object.source as { files?: unknown } | undefined)?.files
  if (Array.isArray(files)) result.files = files.map((file) => ({ path: file.path }))
  if (object.result) result.result = nativeFields(object.result)
  return result
}

function nativeRequest(args: Record<string, unknown>) {
  return {
    ...Object.fromEntries(
      ["action", "id", "revision", "name", "kind", "template", "catalogSection", "cursor"]
        .filter((key) => key in args)
        .map((key) => [key, args[key]])
    ),
    ...(typeof args.instruction === "string" ? { instructionLength: args.instruction.length } : {}),
    ...(Array.isArray(args.files) ? { files: args.files.map((file) => ({ path: file.path })) } : {})
  }
}

function controlledCounter(body: Record<string, unknown>, response: ServerResponse) {
  assert(runtime?.kind === "counter" && active)
  runtime.requests++
  active.runtime = { ...active.runtime, controlled: true, requests: runtime.requests }
  const messages = body.messages as Array<Record<string, unknown>>
  const last = messages.findLastIndex((message) => message.role === "user")
  const replied = messages.slice(last + 1).some((message) => message.role === "tool")
  const id = `controlled-counter-${runtime.requests}`
  const call = !replied
    ? {
        name: "read_file",
        arguments: JSON.stringify({
          file_path: join(runtime.workspace, "counter-trigger.txt")
        })
      }
    : undefined
  const delta = call
    ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: call }] }
    : { role: "assistant", content: "LIVE_COUNTER_TRIGGER_COMPLETED" }
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const packet of [
    { delta, finish_reason: null },
    { delta: {}, finish_reason: call ? "tool_calls" : "stop" }
  ])
    response.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, ...packet }]
      })}\n\n`
    )
  response.end("data: [DONE]\n\n")
}

const localRuntimeTools = new Set([
  "read_file",
  "grep",
  "glob",
  "ls",
  "list_files",
  "write_file",
  "edit_file",
  "mkdir",
  "create_directory",
  "structured_output"
])
function runtimeReplyCalls(raw: string, contentType: string) {
  const calls = new Map<string, { name: string; arguments: string }>()
  const packets = contentType.includes("text/event-stream")
    ? raw
        .split("\n")
        .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
        .map((line) => JSON.parse(line.slice(5).trim()))
    : [JSON.parse(raw)]
  for (const packet of packets)
    for (const choice of packet.choices ?? []) {
      for (const call of choice.delta?.tool_calls ?? choice.message?.tool_calls ?? []) {
        const key = String(call.index ?? call.id)
        const value = calls.get(key) ?? { name: "", arguments: "" }
        value.name += call.function?.name ?? ""
        value.arguments += call.function?.arguments ?? ""
        calls.set(key, value)
      }
    }
  return [...calls.values()].map((call) => {
    let args: Record<string, unknown>
    try {
      args = JSON.parse(call.arguments)
    } catch {
      throw Error("LIVE_RUNTIME_TOOL_ARGS_INVALID")
    }
    assert(
      args && typeof args === "object" && !Array.isArray(args),
      "LIVE_RUNTIME_TOOL_ARGS_INVALID"
    )
    return { name: call.name, args }
  })
}
async function verifyLocalRuntimeReply(
  raw: string,
  contentType: string,
  workspace: string,
  metric: RequestMetric
) {
  const calls = runtimeReplyCalls(raw, contentType)
  metric.toolCalls = calls.map((call) => ({
    name: /^[A-Za-z][A-Za-z0-9_.:-]{0,100}$/.test(call.name) ? call.name : "invalid",
    argumentKeys: Object.keys(call.args)
      .filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(key))
      .slice(0, 40)
  }))
  const within = (parent: string, target: string) => {
    const path = relative(resolve(parent), resolve(target))
    return !isAbsolute(path) && path !== ".." && !path.startsWith("..\\") && !path.startsWith("../")
  }
  for (const call of calls) {
    if (call.name === "execute") {
      await reviewExecute(call.args, workspace)
      continue
    }
    if (call.name === "structured_output") continue
    if (call.name === "grep" || call.name === "glob") {
      const args = call.args
      assert(
        Object.keys(args).every((key) =>
          (call.name === "grep" ? ["pattern", "path", "glob"] : ["pattern", "path"]).includes(key)
        ),
        "LIVE_RUNTIME_SEARCH_ARGUMENTS_INVALID"
      )
      assert(
        typeof args.pattern === "string" && args.pattern.length > 0,
        "LIVE_RUNTIME_SEARCH_PATTERN_INVALID"
      )
      const target = args.path ?? "/"
      assert(
        typeof target === "string" && target.trim() && !/^[a-z]+:\/\//i.test(target),
        "LIVE_RUNTIME_SEARCH_PATH_INVALID"
      )
      const actual =
        target === "/" ? workspace : isAbsolute(target) ? target : resolve(workspace, target)
      assert(within(workspace, actual), "LIVE_RUNTIME_SEARCH_SCOPE_REJECTED")
      assert(
        existsSync(actual) && within(realpathSync(workspace), realpathSync(actual)),
        "LIVE_RUNTIME_SEARCH_REALPATH_REJECTED"
      )
      const glob = call.name === "glob" ? args.pattern : args.glob
      if (glob !== undefined && glob !== null)
        assert(
          typeof glob === "string" &&
            !isAbsolute(glob) &&
            !glob.replaceAll(String.fromCharCode(92), "/").split("/").includes(".."),
          "LIVE_RUNTIME_SEARCH_GLOB_SCOPE_REJECTED"
        )
      const verifyTree = (path: string) => {
        const stat = lstatSync(path)
        assert(!stat.isSymbolicLink(), "LIVE_RUNTIME_SEARCH_SYMLINK_REJECTED")
        if (stat.isDirectory()) for (const item of readdirSync(path)) verifyTree(join(path, item))
      }
      verifyTree(actual)
      continue
    }
    const reading = ["read_file", "ls", "list_files"].includes(call.name)
    if (!reading && !["write_file", "edit_file", "mkdir", "create_directory"].includes(call.name))
      throw Error("LIVE_RUNTIME_NONLOCAL_TOOL_REJECTED")
    const args = call.args
    const target = args.file_path ?? args.path ?? args.directory_path ?? args.directory
    if (typeof target !== "string" || !target.trim())
      throw Error("LIVE_RUNTIME_FILE_TARGET_MISSING")
    const actual = isAbsolute(target) ? target : resolve(workspace, target)
    if (!within(reading ? fixture.isolated : workspace, actual))
      throw Error("LIVE_RUNTIME_FILE_SCOPE_REJECTED")
  }
}

function inspectToolMessages(messages: Array<Record<string, unknown>>) {
  if (!active) return
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call?.id) continue
        if (priorToolIds.has(String(call.id))) continue
        const name = String(call.function?.name ?? "unknown")
        let action: string | undefined
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.function?.arguments ?? "{}")
          const value =
            args.action ?? (name === "mod_authoring" && args.files ? "submit" : undefined)
          if (typeof value === "string" && /^[a-z_]{1,60}$/.test(value)) action = value
        } catch {
          /* Partial arguments are not an authoring result. */
        }
        if (name === "mod_authoring") {
          active.nativeTrace ??= []
          const trace = active.nativeTrace.find((row) => row.id === String(call.id))
          if (trace) trace.request = nativeRequest(args)
          else active.nativeTrace.push({ id: String(call.id), request: nativeRequest(args) })
        }
        if (toolSeen.has(String(call.id))) {
          const prior = active.tools.find((row) => row.id === String(call.id))
          if (prior && action) prior.action = action
          continue
        }
        toolSeen.add(String(call.id))
        active.tools.push({ id: String(call.id), name, ...(action ? { action } : {}) })
        if (
          active.failures.length &&
          name === "mod_authoring" &&
          ["submit", "scaffold", "project_scaffold", "project_save", "project_compile"].includes(
            action ?? ""
          )
        )
          active.repairs++
      }
    }
    if (message.role !== "tool" || typeof message.content !== "string") continue
    const id = String(message.tool_call_id ?? "unknown")
    if (priorToolIds.has(id)) continue
    if (errorSeen.has(id)) continue
    try {
      const value = JSON.parse(message.content)
      const trace = active.nativeTrace?.find((row) => row.id === id)
      if (trace) trace.response = nativeFields(value)
      const result = value.result ?? value
      const failed =
        value.ok === false ||
        value.error ||
        result.check?.valid === false ||
        result.valid === false ||
        result.status === "failed"
      if (failed) {
        const code =
          safeCode(value.error) ??
          safeCode(result.error) ??
          safeCode(result.check?.errors?.[0]?.code) ??
          "NATIVE_AUTHORING_CHECK_FAILED"
        active.failures.push({ id, code })
        errorSeen.add(id)
      }
    } catch {
      /* Ordinary tool prose is deliberately not persisted. */
    }
  }
}

const relay = createServer(async (request, response) => {
  const started = Date.now()
  const current = active
  const reject = (code: string, status = 400) => {
    if (!code.startsWith("UPSTREAM_"))
      harnessRejections.push({
        code,
        phase: executionStage,
        requests:
          runtime?.kind === "project"
            ? runtime.metric.requests.length
            : (current?.requests.length ?? 0),
        ...(code === "LIVE_STAGE_REQUEST_LIMIT" ? { limit: RUNTIME_HTTP_LIMIT } : {}),
        ...(code === "LIVE_COMMAND_REVIEW_LIMIT"
          ? { commandProposals, limit: COMMAND_REVIEW_LIMIT }
          : {})
      })
    rejectCreatorLiveRelay(response, code, status, (terminal) => { fatal = terminal })
  }
  if (request.url !== "/v1/chat/completions" || !current) return reject("LIVE_RELAY_SCOPE_INVALID")
  if (fatal || Date.now() >= deadline) return reject(fatal ?? "LIVE_TOTAL_TIME_LIMIT")
  if (!runtime && current.requests.length + (current.priorRequests ?? 0) >= maxRequests)
    return reject("LIVE_CHAT_REQUEST_LIMIT")
  if (runtime?.kind === "project" && runtime.metric.requests.length >= RUNTIME_HTTP_LIMIT)
    return reject("LIVE_STAGE_REQUEST_LIMIT")
  if (runtime?.kind === "project" && Date.now() - runtime.metric.startedAt >= RUNTIME_STAGE_MS)
    return reject("LIVE_STAGE_TIME_LIMIT")
  const capturedRuntime = runtime
  const metrics =
    capturedRuntime?.kind === "project" ? capturedRuntime.metric.requests : current.requests
  const metric = {
    number: metrics.length + 1 + (capturedRuntime ? 0 : (current.priorRequests ?? 0)),
    elapsedMs: 0
  } as RequestMetric
  if (capturedRuntime?.kind !== "counter") metrics.push(metric)
  const abort = new AbortController()
  aborts.add(abort)
  try {
    let raw = ""
    for await (const chunk of request) {
      raw += chunk
      if (raw.length > 5_000_000) return reject("LIVE_REQUEST_SIZE_LIMIT")
    }
    const body = JSON.parse(raw)
    inspectToolMessages(body.messages ?? [])
    if (capturedRuntime?.kind === "counter") {
      controlledCounter(body, response)
      return
    }
    if (capturedRuntime?.kind === "project") {
      localRuntimeTools.add("execute")
      assert(Array.isArray(body.tools), "LIVE_RUNTIME_TOOLS_MENU_MISSING")
      body.tools = body.tools.filter(
        (tool) => tool?.type === "function" && localRuntimeTools.has(tool.function?.name)
      )
      metric.offeredTools = body.tools.map((tool) => tool.function.name)
      assert(body.tools.length, "LIVE_RUNTIME_TOOLS_MENU_EMPTY")
    }
    body.model = provider.model
    body.max_tokens = Math.min(8192, Number(body.max_tokens ?? body.max_completion_tokens ?? 8192))
    delete body.max_completion_tokens
    const upstream = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(
          Math.min(
            90_000,
            deadline - Date.now(),
            capturedRuntime?.kind === "project"
              ? capturedRuntime.metric.startedAt + RUNTIME_STAGE_MS - Date.now()
              : 90_000
          )
        )
      ])
    })
    metric.status = upstream.status
    if (!upstream.ok) {
      metric.code = `UPSTREAM_HTTP_${upstream.status}`
      await upstream.body?.cancel()
      return reject(metric.code, upstream.status)
    }
    const contentType = upstream.headers.get("content-type") ?? "text/event-stream"
    if (capturedRuntime?.kind === "project") {
      const rawReply = await upstream.text()
      await verifyLocalRuntimeReply(rawReply, contentType, capturedRuntime.workspace, metric)
      response.writeHead(200, { "content-type": contentType })
      response.end(rawReply)
    } else {
      response.writeHead(200, { "content-type": contentType })
      const reader = upstream.body?.getReader()
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            response.write(value)
          }
        } finally {
          reader.releaseLock()
        }
      }
      response.end()
    }
  } catch (cause) {
    metric.code =
      safeCode(cause instanceof Error ? cause.message : undefined) ??
      (Date.now() >= deadline
        ? "LIVE_TOTAL_TIME_LIMIT"
        : capturedRuntime?.kind === "project" &&
            Date.now() >= capturedRuntime.metric.startedAt + RUNTIME_STAGE_MS
          ? "LIVE_STAGE_TIME_LIMIT"
          : "UPSTREAM_NETWORK_ERROR")
    reject(metric.code, 502)
  } finally {
    metric.elapsedMs = Date.now() - started
    if (capturedRuntime?.kind === "project" && current.runtime)
      current.runtime.requests = (current.runtime.stages ?? []).reduce(
        (sum, row) => sum + row.requests.length,
        0
      )
    aborts.delete(abort)
    save()
  }
})

const save = () =>
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        candidate,
        harnessRejections,
        commandReviews,
        acceptanceGuardsOnly: true,
        ...(priorEvidence ? { generationCandidate: priorEvidence.candidate, resumeMode } : {}),
        model: { id: provider.id, name: provider.name, model: provider.model, realProvider: true },
        transport: "in-memory credential relay; application stores localhost dummy key only",
        limits: {
          requestsPerChat: maxRequests,
          requestsPerRuntimeStage: RUNTIME_HTTP_LIMIT,
          runtimeStageMs: RUNTIME_STAGE_MS,
          reviewedCommandsPerRun: COMMAND_REVIEW_LIMIT,
          maxOutputTokens: 8192,
          totalMs
        },
        isolated: fixture.isolated,
        observations,
        fatal,
        executionStage
      },
      null,
      2
    )
  )

let diagnosticNumber = 0
async function recordFailure(cause: unknown) {
  const name = `live-failure-${Date.now()}-${++diagnosticNumber}`
  const redact = (value: string) => value.replaceAll(provider.key, "[REDACTED]")
  let state: unknown
  if (page && active?.threadId) {
    state = await page
      .evaluate(async (threadId) => {
        const status = await window.api.mods.development.status({ threadId })
        return {
          mode: status.mode,
          workspace: status.workspace,
          projectDelivery: status.projectDelivery
            ? {
                phase: status.projectDelivery.phase,
                pluginId: status.projectDelivery.pluginId,
                sourceDigest: status.projectDelivery.sourceDigest
              }
            : null,
          projectTrial: status.projectTrial
            ? { id: status.projectTrial.id, revision: status.projectTrial.revision }
            : null,
          pendingApprovals: (await window.api.sandbox.getPendingApprovals(threadId)).map(
            (value) => {
              const approval = value as { id?: string; operation?: string; filePath?: string }
              return { id: approval.id, operation: approval.operation, filePath: approval.filePath }
            }
          )
        }
      }, active.threadId)
      .catch(() => undefined)
  }
  writeFileSync(
    join(fixture.isolated, `${name}.json`),
    redact(
      JSON.stringify(
        {
          phase: executionStage,
          threadId: active?.threadId,
          message: cause instanceof Error ? cause.message : String(cause),
          stack: cause instanceof Error ? cause.stack : undefined,
          state
        },
        null,
        2
      )
    )
  )
  if (page) {
    await page
      .screenshot({ path: join(fixture.isolated, `${name}.png`), timeout: 5000 })
      .catch(() => {})
    const body = await page
      .locator("body")
      .innerText({ timeout: 3000 })
      .catch(() => "")
    writeFileSync(join(fixture.isolated, `${name}-body.txt`), redact(body))
  }
}

async function settleBeforeClose(): Promise<boolean> {
  if (closing) return closing
  closing = (async () => {
    if (!page) return true
    if (activeProjectId) {
      const projectId = activeProjectId
      const read = () =>
        page!.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
      let view = await read()
      const running = () =>
        view.operations.find((row) => ["started", "cancel_requested"].includes(row.status))
      let operation = running()
      if (!operation) return true
      const { openUnifiedHostProject } = await import("./support/project-unified-native-journey")
      await openUnifiedHostProject(page, view.project.name)
      if (operation.status === "started")
        await page
          .getByRole("button", { name: "停止本次步骤", exact: true })
          .click({ timeout: 5000 })
      const until = Date.now() + 20_000
      while (Date.now() < until) {
        view = await read()
        operation = running()
        if (!operation) return true
        await new Promise((done) => setTimeout(done, 100))
      }
      return false
    }
    // A creator modal can cover the composer while its physical stream still runs.
    // Stop the exact owned acceptance thread through the original native cancellation path.
    if (active?.threadId)
      await page.evaluate((id) => window.api.agent.cancel(id, { cancelWorkers: true }), active.threadId)
    const stop = page.getByRole("button", { name: /停止生成|停止响应|停止运行/ })
    if (await stop.count()) {
      await stop.first().click({ timeout: 5000 })
      await stop.first().waitFor({ state: "hidden", timeout: 20_000 })
    }
    return true
  })().catch(async (cause) => {
    await recordFailure(cause)
    return false
  })
  return closing
}

async function observe(threadId: string) {
  assert(page && active && threadId === active.threadId)
  const result = await page.evaluate(async (id) => {
    const status = await window.api.mods.development.status({ threadId: id })
    const messages = await window.api.threads.getMessages(id)
    return {
      metadata: {
        mode: status.mode,
        drafts: status.drafts.map((row) => ({ id: row.id, revision: row.revision })),
        trials: status.trials.map((row) => ({ phase: row.phase, error: row.error })),
        projectTrial: status.projectTrial
          ? { id: status.projectTrial.id, revision: status.projectTrial.revision, digest: status.projectTrial.digest }
          : null,
        projectDelivery: status.projectDelivery ? { phase: status.projectDelivery.phase } : null,
        reuse: status.reuse ? { phase: status.reuse.phase, planId: status.reuse.planId } : null,
        request:
          status.request && "operations" in status.request
            ? {
                operations: status.request.operations,
                candidates: status.request.candidates,
                attempts: status.request.model?.attempts,
                attemptLimit: status.request.model?.attemptLimit
              }
            : status.request
      },
      messages: messages
        .filter((row) => row.role === "tool" || row.tool_calls?.length)
        .map((row) => ({
          role: row.role,
          tool_call_id: row.tool_call_id,
          content: row.role === "tool" ? row.content : "",
          tool_calls: row.tool_calls?.map((call) => ({
            id: call.id,
            function: { name: call.name, arguments: JSON.stringify(call.args) }
          }))
        }))
    }
  }, threadId)
  inspectToolMessages(result.messages as Array<Record<string, unknown>>)
  active.authoring = result.metadata
  return result.metadata
}

/** Authoring is restricted to native authoring tools, never general command/file approvals. */
async function rejectUnexpectedAuthoringApprovals(threadId: string) {
  assert(page && active?.threadId === threadId)
  const pending = await page.evaluate((id) => window.api.sandbox.getPendingApprovals(id), threadId)
  if (!pending.length) return
  assert.equal(pending.length, 1, "LIVE_AUTHORING_APPROVAL_IDENTITY_AMBIGUOUS")
  const approval = pending[0] as {
    id?: string
    operation?: string
    command?: string
    filePath?: string
  }
  assert(approval.id, "LIVE_AUTHORING_APPROVAL_ID_REQUIRED")
  const panel = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  if (await panel.isVisible())
    await panel.getByRole("button", { name: "Close", exact: true }).click()
  const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
  const box = chat.locator("div.max-w-3xl.border-2").filter({
    has: page.getByRole("button", { name: "拒绝", exact: true })
  })
  await box.waitFor()
  assert.equal(await box.count(), 1, "LIVE_AUTHORING_APPROVAL_UI_AMBIGUOUS")
  if (approval.command) await box.getByText(approval.command, { exact: true }).waitFor()
  else if (approval.filePath)
    assert(
      (await box.innerText()).includes(approval.filePath),
      "LIVE_AUTHORING_APPROVAL_PATH_MISMATCH"
    )
  assert.deepEqual(
    await page.evaluate((id) => window.api.sandbox.getPendingApprovals(id), threadId),
    pending,
    "LIVE_AUTHORING_APPROVAL_IDENTITY_CHANGED"
  )
  await box.getByRole("button", { name: "拒绝", exact: true }).click()
  active.approvals ??= []
  active.approvals.push({
    id: approval.id,
    operation: approval.operation ?? "unknown",
    decision: "reject"
  })
  save()
}

async function exerciseCounter(threadId: string, workspace: string) {
  assert(page && active?.threadId === threadId)
  executionStage = "counter-native-approval"
  const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
  const panel = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  if (!(await panel.isVisible())) await chat.locator('[data-app-guide="workspace"]').click()
  const approve = panel.getByRole("button", { name: "确认并应用到这段聊天", exact: true })
  await approve.waitFor()
  await approve.click()
  let status: DevelopmentStatus | undefined
  while (Date.now() < deadline) {
    status = await page.evaluate(
      (id) => window.api.mods.development.status({ threadId: id }),
      threadId
    )
    if (status.trials.some((row) => row.phase === "active")) break
    const failed = status.trials.find((row) => row.phase === "failed")
    if (failed) throw Error(safeCode(failed.error) ?? "LIVE_COUNTER_ACTIVATION_FAILED")
    await new Promise((done) => setTimeout(done, 150))
  }
  assert(
    status?.trials.some((row) => row.phase === "active"),
    "LIVE_COUNTER_NOT_ACTIVE"
  )
  if (await panel.isVisible())
    await panel.getByRole("button", { name: "Close", exact: true }).click()
  await chat.getByRole("button", { name: "普通模式", exact: true }).click()
  const count = async () => {
    const text = await chat
      .locator('[data-function-site="AbovePrompt"]:visible')
      .first()
      .innerText()
    const result = /工具调用(?:次数)?[：:]\s*(\d+)/.exec(text)
    return result ? Number(result[1]) : undefined
  }
  executionStage = "counter-initial-display"
  let before: number | undefined
  const displayDeadline = Math.min(deadline, Date.now() + 20_000)
  while (Date.now() < displayDeadline) {
    before = await count().catch(() => undefined)
    if (before !== undefined) break
    await new Promise((done) => setTimeout(done, 150))
  }
  assert.equal(before, 0, "LIVE_COUNTER_INITIAL_VALUE")
  writeFileSync(join(workspace, "counter-trigger.txt"), "isolated real native read\n")
  runtime = { kind: "counter", workspace, requests: 0 }
  active.runtime = { controlled: true, requests: 0, counterBefore: before }
  executionStage = "counter-native-read-trigger"
  await page
    .locator("textarea.composer-textarea")
    .fill("LIVE_COUNTER_TRIGGER 请读取本项目counter-trigger.txt一次，完成后停止。")
  await page.getByRole("button", { name: "发送消息", exact: true }).click()
  await page.getByText("LIVE_COUNTER_TRIGGER_COMPLETED", { exact: true }).waitFor()
  let after: number | undefined
  const triggerDeadline = Math.min(deadline, Date.now() + 20_000)
  while (Date.now() < triggerDeadline) {
    after = await count().catch(() => undefined)
    if (after === 1) break
    await new Promise((done) => setTimeout(done, 150))
  }
  active.runtime = {
    controlled: true,
    requests: runtime.requests,
    counterBefore: before,
    counterAfter: after,
    verified: after === 1,
    phase: "native-tool-trigger-completed"
  }
  assert.equal(after, 1, "LIVE_COUNTER_NATIVE_TRIGGER_COUNT")
  await page.screenshot({ path: join(fixture.isolated, "live-counter-verified.png") })
  runtime = undefined
  executionStage = "counter-verified"
}

async function runChat(kind: string, prompt: string, workspace: string, modelUrl: string) {
  assert(page)
  executionStage = `${kind}-setup`
  runtime = undefined
  mkdirSync(workspace, { recursive: true })
  active = { kind, requests: [], tools: [], failures: [], repairs: 0 }
  observations.push(active)
  fatal = undefined
  toolSeen.clear()
  errorSeen.clear()
  priorToolIds.clear()
  const prior = priorEvidence?.observations[0]
  if (prior) {
    assert(prior.kind === kind || (genericRepair && prior.kind === "two-stage-document-project"),
      "LIVE_RESUME_SCENARIO_MISMATCH")
    assert(prior.threadId, "LIVE_RESUME_THREAD_REQUIRED")
    active.priorRequests = prior.requests.length + (prior.priorRequests ?? 0)
    if (resumeDependencyReview && prior.dependencyConsents)
      active.dependencyConsents = [...prior.dependencyConsents]
    for (const tool of prior.tools) priorToolIds.add(tool.id)
    if (resumeMode === "diagnostic")
      assert([24, 64].includes(maxRequests), "LIVE_DIAGNOSTIC_BOUNDED_OPT_IN_REQUIRED")
  }
  const title = `Live creator acceptance · ${kind}`
  executionStage = `${kind}-configure-model-and-thread`
  const threadId = await page.evaluate(
    async ({ workspace, title, modelUrl, model, existingThreadId }) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.models.setCustomConfig({
        id: "live-isolated-relay",
        name: "真实模型隔离转发",
        baseUrl: modelUrl,
        model,
        apiKey: "localhost-dummy-only",
        maxTokens: 128000,
        maxOutputTokens: 8192,
        enableThinking: false
      })
      await window.api.models.setDefault("custom:live-isolated-relay")
      if (existingThreadId) return existingThreadId
      const thread = await window.api.threads.create({
        title,
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
      return thread.thread_id
    },
    { workspace, title, modelUrl, model: provider.model, existingThreadId: prior?.threadId }
  )
  active.threadId = threadId
  executionStage = `${kind}-reload`
  await page.reload()
  await page.waitForFunction(() => Boolean(window.api?.mods))
  await page.evaluate("window.__name = value => value")
  executionStage = `${kind}-select-thread`
  const initialCreator = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  if (await initialCreator.isVisible())
    await initialCreator.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("tab", { name: "对话模式", exact: true }).click()
  const authorChat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
  if (!(await authorChat.isVisible())) {
    if (await initialCreator.isVisible())
      await initialCreator.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByText(title, { exact: true }).first().click()
  }
  assert(await authorChat.isVisible(), "LIVE_AUTHOR_NOT_DISPLAYED")
  executionStage = `${kind}-enter-creator`
  await enterModsCreatorChat(page, threadId, workspace)
  let importedDigest: string | undefined = resumeRun && process.env.CREATOR_LIVE_SOURCE_SET
    ? JSON.parse(readFileSync(join(fixture.isolated, "imported-source-set.json"), "utf8")).digest
    : undefined
  let firstGenericCandidate: GenericProjectCandidate | undefined
  if (genericProject && resumeRun) {
    assert(["diagnostic", "runtime"].includes(resumeMode ?? ""), "GENERIC_PROJECT_RESUME_MODE_INVALID")
    const saved: GenericProjectCandidate = genericRepair && resumeMode === "runtime" ?
      JSON.parse(readFileSync(join(fixture.isolated, "generic-project-repair.json"), "utf8")).after : genericRepair ?
      JSON.parse(readFileSync(join(fixture.isolated, "generic-project-replacement.json"), "utf8")).after :
      JSON.parse(readFileSync(join(fixture.isolated, "generic-project-first-candidate.json"), "utf8"))
    const status = await page.evaluate(
      (id) => window.api.mods.development.status({ threadId: id }), threadId
    )
    assert(status.projectTrial, "GENERIC_PROJECT_RETAINED_CANDIDATE_MISSING")
    const retained = readGenericProjectCandidate(fixture.isolated, status.projectTrial)
    assert.deepEqual(retained, {
      draftId: saved.draftId, revision: saved.revision, digest: saved.digest,
      directory: saved.directory, source: saved.source, skills: saved.skills
    }, "GENERIC_PROJECT_RETAINED_SOURCE_CHANGED")
    if (resumeMode === "diagnostic") firstGenericCandidate = retained
    importedDigest = resumeMode === "diagnostic" ? retained.digest : undefined
  }
  if (resumeRun && process.env.CREATOR_LIVE_SOURCE_SET)
    assert.match(importedDigest ?? "", /^[a-f0-9]{64}$/, "LIVE_IMPORTED_BASELINE_REQUIRED")
  if (process.env.CREATOR_LIVE_SOURCE_SET && !resumeRun) {
    executionStage = `${kind}-import-source-set`
    const { importLiveCreatorSourceSet } = await import("./support/creator-live-source-set")
    const imported = await importLiveCreatorSourceSet({
      app: app!, page, threadId, workspace, directory: process.env.CREATOR_LIVE_SOURCE_SET
    })
    importedDigest = imported.digest
    writeFileSync(join(fixture.isolated, "imported-source-set.json"), JSON.stringify(imported, null, 2))
  }
  const panel = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  if (await panel.isVisible())
    await panel.getByRole("button", { name: "Close", exact: true }).click()
  active.startedAt = Date.now()
  executionStage = `${kind}-real-model-authoring`
  if (resumeDependencyReview) {
    const original = (
      prior?.authoring as { reuse?: { phase?: string; planId?: string } } | undefined
    )?.reuse
    assert(
      original?.phase === "needs-approval" && original.planId,
      "LIVE_DEPENDENCY_ORIGINAL_PLAN_REQUIRED"
    )
    assert((active.dependencyConsents?.length ?? 0) < 2, "LIVE_DEPENDENCY_CONSENT_LIMIT")
    const { reviewLiveCreatorDependency } = await import("./support/creator-live-dependencies")
    executionStage = `${kind}-dependency-native-review-resume`
    const receipt = await reviewLiveCreatorDependency({
      page,
      threadId,
      workspace,
      artifacts: fixture.isolated,
      deadline,
      expectedPlanId: original.planId
    })
    active.dependencyConsents ??= []
    active.dependencyConsents.push(receipt)
    save()
    executionStage = `${kind}-real-model-authoring-after-dependency-consent`
  }
  if (resumeMode !== "runtime") {
    await page
      .locator("textarea.composer-textarea")
      .fill(
        resumeDependencyReview
          ? afterDependencyConsentPrompt
          : resumeMode === "diagnostic"
            ? genericProject ? genericRepair ? genericProjectCreatorScenario.repairPrompt :
              genericProjectCreatorScenario.followupPrompt : process.env.CREATOR_LIVE_PROMPT_FILE
              ? readFileSync(resolve(process.env.CREATOR_LIVE_PROMPT_FILE), "utf8")
              : kind === "two-stage-document-project"
                ? "请把刚才已生成检查通过的插件准备为本会话可确认的隔离试用候选，沿用现有草稿，不另建、不运行。"
                : "按真实检查修正当前草稿并试用，不要重读已经取得的完整目录。"
            : prompt
      )
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
  } else {
    const metadata = await observe(threadId)
    assert(
      installedProjectId ? metadata.projectDelivery?.phase === "installed" : metadata.projectTrial,
      "LIVE_RESUME_PROJECT_CANDIDATE_REQUIRED"
    )
    active.candidateReadyMs = 0
    active.outcome = installedProjectId ? "installed-project-ready" : "native-candidate-prepared"
  }
  let sawRunning = false
  let idleSince = 0
  while (!active.outcome && Date.now() < deadline) {
    await rejectUnexpectedAuthoringApprovals(threadId)
    const metadata = await observe(threadId)
    const running = await page.getByRole("button", { name: /停止生成|停止响应|停止运行/, includeHidden: true }).count()
    if (running || active.requests.length) sawRunning = true
    if (hasLiveCreatorCandidate(metadata, kind === "tool-counter" ? "function" : "project", importedDigest))
      active.candidateReadyMs ??= Date.now() - active.startedAt
    if (fatal) {
      active.limitCode = fatal
      active.outcome =
        active.candidateReadyMs === undefined ? fatal : "native-candidate-prepared-at-limit"
      break
    }
    if (sawRunning && !running && active.requests.length && aborts.size === 0) {
      idleSince ||= Date.now()
      if (Date.now() - idleSince > 3000) {
        if (genericProject && !firstGenericCandidate && active.candidateReadyMs !== undefined) {
          const status = await page.evaluate(
            (id) => window.api.mods.development.status({ threadId: id }), threadId
          )
          assert(status.projectTrial, "GENERIC_PROJECT_FIRST_CANDIDATE_MISSING")
          firstGenericCandidate = readGenericProjectCandidate(fixture.isolated, status.projectTrial)
          writeFileSync(join(fixture.isolated, "generic-project-first-candidate.json"),
            JSON.stringify(firstGenericCandidate, null, 2), { flag: "wx" })
          importedDigest = status.projectTrial.digest
          active.candidateReadyMs = undefined
          executionStage = "generic-project-replace-middle-through-conversation"
          const workspacePanel = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
          if (await workspacePanel.isVisible()) {
            await workspacePanel.getByRole("button", { name: "返回聊天修改", exact: true }).click()
            await workspacePanel.waitFor({ state: "hidden" })
          }
          await page.locator("textarea.composer-textarea")
            .fill(genericProjectCreatorScenario.followupPrompt)
          await page.getByRole("button", { name: "发送消息", exact: true }).click()
          idleSince = 0
          continue
        }
        if (process.env.CREATOR_LIVE_DEPENDENCY_CONSENT === "1" &&
          metadata.reuse?.phase === "needs-approval" &&
          active.candidateReadyMs === undefined) {
          assert((active.dependencyConsents?.length ?? 0) < 2, "LIVE_DEPENDENCY_CONSENT_LIMIT")
          const { reviewLiveCreatorDependency } = await import("./support/creator-live-dependencies")
          executionStage = `${kind}-dependency-native-review`
          const receipt = await reviewLiveCreatorDependency({
            page, threadId, workspace, artifacts: fixture.isolated, deadline
          })
          active.dependencyConsents ??= []
          active.dependencyConsents.push(receipt)
          save()
          executionStage = `${kind}-real-model-authoring-after-dependency-consent`
          await page.locator("textarea.composer-textarea").fill(afterDependencyConsentPrompt)
          await page.getByRole("button", { name: "发送消息", exact: true }).click()
          idleSince = 0
          continue
        }
        active.outcome =
          active.candidateReadyMs === undefined
            ? "authoring-turn-ended"
            : "native-candidate-prepared"
        break
      }
    } else idleSince = 0
    await new Promise((done) => setTimeout(done, 400))
  }
  active.elapsedMs = Date.now() - active.startedAt
  active.outcome ??= "LIVE_TOTAL_TIME_LIMIT"
  const finalStatus = await observe(threadId)
  if (genericProject && firstGenericCandidate &&
      hasLiveCreatorCandidate(finalStatus, "project", firstGenericCandidate.digest)) {
    const status = await page.evaluate(
      (id) => window.api.mods.development.status({ threadId: id }), threadId
    )
    assert(status.projectTrial, "GENERIC_PROJECT_UPDATED_CANDIDATE_MISSING")
    const after = readGenericProjectCandidate(fixture.isolated, status.projectTrial)
    const comparison = genericRepair ? assertGenericProjectRepair(firstGenericCandidate, after) :
      assertGenericProjectReplacement(firstGenericCandidate, after)
    writeFileSync(join(fixture.isolated, genericRepair ? "generic-project-repair.json" :
      "generic-project-replacement.json"),
      JSON.stringify({ comparison, after }, null, 2), { flag: "wx" })
  }
  if (!hasLiveCreatorCandidate(finalStatus, kind === "tool-counter" ? "function" : "project", importedDigest)) {
    active.candidateReadyMs = undefined
    if (active.outcome === "native-candidate-prepared") active.outcome = "authoring-turn-ended"
  }
  if (active.candidateReadyMs === undefined) {
    fatal ??= "LIVE_NATIVE_CANDIDATE_NOT_PREPARED"
    await recordFailure(new Error(fatal))
  }
  const firstFailure = active.tools.findIndex((row) =>
    active!.failures.some((failure) => failure.id === row.id)
  )
  active.repairs =
    firstFailure < 0
      ? 0
      : active.tools
          .slice(firstFailure + 1)
          .filter(
            (row) =>
              row.name === "mod_authoring" &&
              ["submit", "save", "scaffold", "project_save", "project_compile"].includes(
                row.action ?? ""
              )
          ).length
  if (
    kind === "tool-counter" &&
    active.outcome === "native-candidate-prepared" &&
    process.env.CMB_CREATOR_LIVE_NATIVE_TRIAL === "1"
  ) {
    try {
      await exerciseCounter(threadId, workspace)
    } catch (cause) {
      await recordFailure(cause)
      const code =
        safeCode(cause instanceof Error ? cause.message : undefined) ??
        "LIVE_COUNTER_RUNTIME_FAILED"
      active.runtime = {
        ...active.runtime,
        controlled: true,
        requests: active.runtime?.requests ?? 0,
        error: code
      }
      fatal = code
    }
  }
  if (
    kind === projectKind &&
    ["native-candidate-prepared", "installed-project-ready"].includes(active.outcome ?? "") &&
    process.env.CMB_CREATOR_LIVE_PROJECT_RUNTIME === "1"
  ) {
    assert(app && page)
    executionStage = "project-trial-save-installed-completion"
    active.runtime = { controlled: false, requests: 0, stages: [] }
    const { exerciseLiveGeneratedProject } = await import("./support/creator-live-project-runtime")
    try {
      const report = await exerciseLiveGeneratedProject({
        app,
        page,
        approvedCommand(command: string, workspace: string) {
          const digest = createHash("sha256")
            .update(JSON.stringify({ command, workspace }))
            .digest("hex")
          const value = approvedCommands.get(digest)
          if (
            !value ||
            value.command !== command ||
            value.workspace !== workspace ||
            !value.remaining
          )
            return false
          value.remaining--
          commandReviews.find((review) => review.review === value.review)!.nativeApprovalRequested =
            true
          return true
        },
        artifactPrefix,
        installedWorkspaceSuffix: genericProject ? finalStatus.projectTrial?.digest.slice(0, 12) : undefined,
        installedProjectId,
        authorThreadId: threadId,
        authorWorkspace: workspace,
        artifacts: fixture.isolated,
        deadline,
        goal: genericProject ? genericProjectCreatorScenario.runtimeGoal : "为团队制作一个完全本地离线的需求记录工具。用户可新建、编辑和查找需求，每条需求包含标题、目标、范围、验收标准和待确认问题；保存为工作目录内Markdown文档。验收标准：能创建与编辑一条需求，按标题查找，重启后能读回已保存文档；不联网、不访问工作目录外文件。仅为本地验收允许经实际逐条审查的只读JSON/Markdown校验命令，禁止任何写文件命令，业务文件须通过原生文件写入审批。无须额外取时间戳或哈希；按阶段Skill与已给需求直接完成产物与检查。第一阶段写需求草稿，第二阶段独立复核并保留原稿。",
        beginStage(label: string, stageWorkspace: string, projectId?: string) {
          assert(!fatal, "LIVE_PROVIDER_ALREADY_STOPPED")
          activeProjectId = projectId
          const metric: StageMetric = { label, startedAt: Date.now(), requests: [] }
          active!.runtime!.stages!.push(metric)
          runtime = { kind: "project", metric, workspace: stageWorkspace }
          executionStage = `project/${label}`
          save()
        },
        endStage() {
          if (runtime?.kind === "project")
            runtime.metric.elapsedMs = Date.now() - runtime.metric.startedAt
          runtime = undefined
          save()
        }
      })
      for (const reviewed of report.reviewedCommands)
        assert(
          reviewed.uiApproved && approvedCommands.has(reviewed.digest),
          "LIVE_COMMAND_NATIVE_DIGEST_CHANGED"
        )
      if (genericProject) {
        assert("trial" in report && report.trial, "GENERIC_PROJECT_TRIAL_REQUIRED")
        const runtimeAudit = {
          trial: await auditGenericProjectRuntime(page, report.trial.projectId),
          ordinary: await auditGenericProjectRuntime(page, report.ordinary.projectId)
        }
        writeFileSync(join(fixture.isolated, "generic-project-business-runtime.json"),
          JSON.stringify(runtimeAudit, null, 2), { flag: "wx" })
      }
      active.runtime.project = report
      active.runtime.verified = true
    } catch (cause) {
      await recordFailure(cause)
      const code =
        safeCode(cause instanceof Error ? cause.message : undefined) ??
        "LIVE_PROJECT_RUNTIME_FAILED"
      active.runtime.error = code
      fatal ??= code
    }
  }
  save()
  console.log(
    JSON.stringify({
      kind,
      outcome: active.outcome,
      requests: active.requests.length,
      elapsedMs: active.elapsedMs,
      tools: active.tools.map((row) => `${row.name}:${row.action ?? ""}`),
      failures: active.failures,
      repairs: active.repairs
    })
  )
  return active.outcome === "native-candidate-prepared" || active.outcome === "authoring-turn-ended"
}

async function main() {
  deadline = Date.now() + totalMs
  const watchdog = setTimeout(() => {
    fatal = "LIVE_TOTAL_TIME_LIMIT"
    void settleBeforeClose().then(async (settled) => {
      aborts.forEach((row) => row.abort())
      if (settled) await app?.close()
    })
  }, totalMs)
  try {
    await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done))
    const address = relay.address()
    assert(address && typeof address !== "string")
    const modelUrl = `http://127.0.0.1:${address.port}/v1`
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app.process().stderr?.on("data", (chunk: Buffer) =>
      appendFileSync(join(fixture.isolated, "electron-stderr.log"), chunk.toString("utf8").replaceAll(provider.key, "[REDACTED]")))
    page = await app.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(20_000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
    const scenario = process.env.CREATOR_LIVE_SCENARIO ?? "both"
    assert(["both", "counter", "project"].includes(scenario), "LIVE_SCENARIO_INVALID")
    if (resumeRun) assert.notEqual(scenario, "both", "LIVE_RESUME_EXACT_SCENARIO_REQUIRED")
    const first =
      scenario !== "project"
        ? await runChat(
            "tool-counter",
            "请做一个简单的工具次数计数 Mod：在当前聊天里，每个工具执行完成后累计一次，在输入框上方显示‘工具调用次数：N’，初始为0，界面只显示这个数字。请自行使用原生创作工具生成并检查候选，准备给我确认试用。不要安装、不要代我授权。",
            join(fixture.workspace, "counter"),
            modelUrl
          )
        : true
    if (scenario !== "counter" && first && Date.now() < deadline)
      await runChat(
        projectKind,
        genericProject ? genericProjectCreatorScenario.firstPrompt : process.env.CREATOR_LIVE_PROMPT_FILE
          ? readFileSync(resolve(process.env.CREATOR_LIVE_PROMPT_FILE), "utf8")
          : "请从零制作一个两阶段需求文档项目插件，不依赖已有插件：第一阶段根据本项目内用户需求生成 requirements.md，第二阶段独立复核需求是否有目标、范围、验收标准，输出 review.md 和机器可检查的 review.json。保留第一阶段原稿，成果通过实际文件检查后再交给人确认。请用原生项目创作工具生成、检查和准备隔离试用候选。不要安装、不要启动执行、不要代我批准。",
        join(fixture.workspace, "document"),
        modelUrl
      )
  } catch (cause) {
    await recordFailure(cause)
    fatal ??=
      safeCode(cause instanceof Error ? cause.message : undefined) ??
      (cause instanceof Error && /Timeout/i.test(cause.message)
        ? "LIVE_UI_TIMEOUT"
        : "LIVE_RUNNER_ERROR")
  } finally {
    clearTimeout(watchdog)
    const settled = await settleBeforeClose()
    if (!settled) fatal ??= "LIVE_CLEANUP_EXECUTION_UNSETTLED"
    aborts.forEach((row) => row.abort())
    save()
    if (settled) await app?.close().catch(() => {})
    relay.closeAllConnections()
    await new Promise<void>((done) => relay.close(() => done()))
    console.log(
      JSON.stringify({
        evidence: evidencePath,
        fatal,
        chats: observations.length,
        realProvider: true,
        mainSha256: candidate.sha256
      })
    )
    if (fatal) process.exitCode = 1
  }
}

void main()
