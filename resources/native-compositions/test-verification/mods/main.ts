import type { On } from "devclaw-mods"
import { adapterInvocation, parseAdapterResult } from "./runner"
type ProjectIdentity = { projectId: string; stageId: string; version: number; operationId: string }
type ProjectSummary = ProjectIdentity & { status: string; currentVersion: boolean }
type Counts = { total: number; passed: number; failed: number; skipped: number }
type Provider = { pluginId: string; plugin: string; digest: string; actionId: string }
type Source = { artifactId: string; path: string; maxBytes: number }
type ExecuteInput = { files: string[]; sources: Source[]; subjects?: string[]; timeoutMs: number }
type Artifact = Source & { bytes: number; sha256: string }
type Reference = {
  protocol: string
  projectId: string
  stageId: string
  version: number
  pluginDigest: string
  workspaceIdentity: string
  current: Artifact
  sources: Artifact[]
  configuration?: unknown
}
type TestEntry = { files: string[]; subjects: string[]; timeoutMs: number }
type Selection = { protocol: string; runId: string; executionId: string }
type Envelope = {
  version: number
  executionId: string
  input: unknown
  config?: { nativeCompositionProvider: Provider; allowLegacyInput?: boolean }
}
type ExecutionAdapterResult = {
  passed: boolean
  sourceFingerprint?: string
  testsFingerprint?: string
  subjectFingerprint?: string
  counts?: Counts
  errors?: { code: string }[]
}
type ReferenceAdapterResult = {
  selection: Selection
  sourceFingerprint: string
  testsFingerprint: string | null
  subjectFingerprint: string | null
}
type ExecutionReceipt = ProjectIdentity & {
  protocol: string
  passed: boolean
  runner: string
  executionId: string
  files: string[]
  subjects: string[]
  timeoutMs: number
  sourceFingerprint: string | null
  testsFingerprint: string | null
  subjectFingerprint: string | null
  counts: Counts
  exitCode: number
  errors: { code: string }[]
}
type ActionReceipt = {
  executionId: string
  provider: Provider
  status: string
  outputTruncated: boolean
  output: ExecutionReceipt | null
}
type RunEvidence = {
  runId: string
  status: string
  resultTruncated: boolean
  result: Selection
  deterministicActions: ActionReceipt[]
  actionCount: number
  nextActionOffset: number | null
}
type EvidenceOwner = {
  projectId: string
  operationId: string
  stageId: string
  pluginDigest: string
  inputFingerprint: string
}
type WorkflowRead = {
  status: string
  value?: { found: boolean; run: RunEvidence; evidence: EvidenceOwner }
}

const projectRef = { provider: "native.project-runtime", id: "project", version: "1.0.0" }
const protocol = "devclaw.test-execution-receipt/v1"

function currentProject(read: { value?: unknown }) {
  const value = read?.value as ProjectSummary | undefined
  if (
    value?.status !== "ready" ||
    value.currentVersion !== true ||
    ![value.projectId, value.stageId, value.operationId].every(
      (item) => typeof item === "string" && item
    ) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  )
    throw Error("TEST_PROJECT_SCOPE_UNAVAILABLE")
  return value
}

function sameProject(before: ProjectIdentity, after: ProjectIdentity) {
  return (["projectId", "version", "stageId", "operationId"] as const).every(
    (key) => before[key] === after[key]
  )
}

function validCounts(value: Counts | undefined) {
  return (
    value !== undefined &&
    (["total", "passed", "failed", "skipped"] as const).every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 0
    ) &&
    value.total > 0 &&
    value.passed === value.total &&
    value.failed === 0 &&
    value.skipped === 0
  )
}

function utf8Bytes(value: string) {
  let bytes = 0
  for (const char of value) {
    const code = char.codePointAt(0)!
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return bytes
}

/** Host-selected UI values only; this is independent of the executed receipt and workflow args. */
function expectedTestEntry(value: unknown): TestEntry {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !== "e2eSubjects|e2eTestFiles|e2eTimeoutMs"
  )
    throw Error("TEST_EXPECTED_CONFIGURATION_INVALID")
  const configuration = value as Record<string, unknown>
  const paths = (raw: unknown, maximum: number, tests: boolean): string[] => {
    if (typeof raw !== "string" || utf8Bytes(raw) > 4096)
      throw Error("TEST_EXPECTED_CONFIGURATION_INVALID")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw Error("TEST_EXPECTED_CONFIGURATION_INVALID")
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      parsed.length > maximum ||
      parsed.some(
        (path) =>
          typeof path !== "string" ||
          !path ||
          path.length > 160 ||
          path.includes("\\") ||
          path.includes(":") ||
          path
            .split("/")
            .some(
              (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                /[<>"|?*]|[. ]$/.test(part) ||
                [...part].some((char) => char.charCodeAt(0) < 32) ||
                /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
            ) ||
          (tests && !/\.(?:test|spec)\.(?:cjs|mjs|js)$/.test(path))
      ) ||
      new Set(parsed.map((path) => String(path).toLowerCase())).size !== parsed.length
    )
      throw Error("TEST_EXPECTED_CONFIGURATION_INVALID")
    return parsed as string[]
  }
  const timeoutMs = configuration.e2eTimeoutMs
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 300000
  )
    throw Error("TEST_EXPECTED_CONFIGURATION_INVALID")
  return {
    files: paths(configuration.e2eTestFiles, 4, true),
    subjects: paths(configuration.e2eSubjects, 8, false),
    timeoutMs
  }
}

/** SDK calls stay in the registered handler so authoring can verify their admission boundaries. */
export function register(on: On) {
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "test-verification",
      version: "2.0.0",
      title: "独立测试执行与原始回执校验",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "execute-e2e",
          title: "执行已配置 Node 测试",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: ["process.run", "platform.read"],
          cancellable: true,
          idempotency: "keyed"
        },
        {
          id: "e2e",
          title: "校验项目测试原始回执",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: ["process.run", "platform.read", "platform.act"],
          cancellable: true,
          idempotency: "keyed"
        }
      ]
    },
    {
      act: async ($, event) => {
        const envelope = event.input as unknown as Envelope
        const current = currentProject(
          await $.platform.read({ ref: projectRef, target: { kind: "current" } })
        )
        if (event.action === "execute-e2e") {
          if (
            envelope.version !== 1 ||
            typeof envelope.executionId !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(envelope.executionId)
          )
            throw Error("TEST_EXECUTION_ENVELOPE_INVALID")
          const input = envelope.input as ExecuteInput
          const request = adapterInvocation({
            mode: "execute",
            files: input.files,
            sources: input.sources,
            subjects: input.subjects ?? [],
            timeoutMs: input.timeoutMs
          })
          const checked = parseAdapterResult<ExecutionAdapterResult>(
            await $.process.run(request.argv, request.init)
          )
          const after = currentProject(
            await $.platform.read({ ref: projectRef, target: { kind: "current" } })
          )
          if (!sameProject(current, after)) throw Error("TEST_PROJECT_SCOPE_CHANGED")
          const value = checked.value
          const passed =
            checked.exitCode === 0 && value.passed === true && validCounts(value.counts)
          const output = {
            protocol,
            passed,
            runner: "node-test/v1",
            executionId: envelope.executionId,
            projectId: current.projectId,
            stageId: current.stageId,
            version: current.version,
            operationId: current.operationId,
            files: input.files,
            subjects: input.subjects ?? [],
            timeoutMs: input.timeoutMs,
            sourceFingerprint: value.sourceFingerprint ?? null,
            testsFingerprint: value.testsFingerprint ?? null,
            subjectFingerprint: value.subjectFingerprint ?? null,
            counts: value.counts ?? { total: 0, passed: 0, failed: 0, skipped: 0 },
            exitCode: checked.exitCode,
            errors: value.errors ?? []
          }
          if (utf8Bytes(JSON.stringify(output)) > 1900) throw Error("TEST_RECEIPT_LIMIT")
          return { status: passed ? "succeeded" : "failed", text: "真实 Node 测试执行回执", output }
        }
        if (event.action !== "e2e") throw Error("TEST_ACTION_UNSUPPORTED")
        const ref = envelope.input as Reference
        const expected = envelope.config?.nativeCompositionProvider
        if (
          envelope.version !== 1 ||
          ref?.protocol !== "devclaw.artifact-input/v1" ||
          expected?.plugin !== "test-verification" ||
          expected.actionId !== "e2e" ||
          !expected.pluginId ||
          !/^[a-f0-9]{64}$/.test(expected.digest)
        )
          throw Error("TEST_PROVIDER_BINDING_REQUIRED")
        if (
          current.projectId !== ref.projectId ||
          current.version !== ref.version ||
          current.stageId !== ref.stageId
        )
          throw Error("TEST_REPORT_SCOPE_CHANGED")
        const hasConfiguration = Object.hasOwn(ref, "configuration")
        if (!hasConfiguration && envelope.config?.allowLegacyInput !== true)
          throw Error("TEST_EXPECTED_CONFIGURATION_REQUIRED")
        const expectedEntry = hasConfiguration ? expectedTestEntry(ref.configuration) : undefined
        const loadRequest = adapterInvocation({
          mode: "reference",
          reference: ref,
          files: null,
          subjects: null
        })
        const loaded = parseAdapterResult<ReferenceAdapterResult>(
          await $.process.run(loadRequest.argv, loadRequest.init)
        )
        if (loaded.exitCode !== 0) throw Error("TEST_REPORT_REFERENCE_INVALID")
        const { selection, sourceFingerprint } = loaded.value
        let offset = 0,
          run: RunEvidence | undefined,
          evidence: EvidenceOwner | undefined
        const actions: ActionReceipt[] = []
        while (offset <= 256) {
          const read = (await $.platform.act({
            ref: projectRef,
            target: { kind: "current" },
            action: "inspect-workflow-evidence",
            input: {
              runId: selection.runId,
              stageId: ref.stageId,
              actionOffset: offset,
              limit: 32
            },
            requestKey: envelope.executionId + ":test-evidence:" + offset
          })) as unknown as WorkflowRead
          const observed = read.value?.run,
            owner = read.value?.evidence
          if (
            read.status !== "succeeded" ||
            read.value?.found !== true ||
            observed?.runId !== selection.runId ||
            observed.status !== "completed" ||
            observed.resultTruncated ||
            !Array.isArray(observed.deterministicActions) ||
            owner?.projectId !== ref.projectId ||
            owner.stageId !== ref.stageId ||
            owner.operationId !== current.operationId ||
            owner.pluginDigest !== ref.pluginDigest ||
            JSON.stringify(observed.result) !== JSON.stringify(selection)
          )
            throw Error("TEST_ORIGINAL_RUN_UNAVAILABLE")
          if (
            run &&
            (JSON.stringify(run.result) !== JSON.stringify(observed.result) ||
              JSON.stringify(evidence) !== JSON.stringify(owner))
          )
            throw Error("TEST_EVIDENCE_CHANGED")
          run = observed
          evidence = owner
          actions.push(...observed.deterministicActions)
          if (observed.nextActionOffset === null) break
          if (
            !Number.isSafeInteger(observed.nextActionOffset) ||
            observed.nextActionOffset <= offset ||
            observed.nextActionOffset > 256
          )
            throw Error("TEST_EVIDENCE_INCOMPLETE")
          offset = observed.nextActionOffset
        }
        if (
          !run ||
          actions.length !== run.actionCount ||
          new Set(actions.map((action) => action.executionId)).size !== actions.length
        )
          throw Error("TEST_EVIDENCE_INCOMPLETE")
        const candidates = actions.filter((action) => action.executionId === selection.executionId)
        if (candidates.length !== 1) throw Error("TEST_ORIGINAL_RECEIPT_REQUIRED")
        const action = candidates[0],
          output = action?.output
        if (
          !action ||
          action.status !== "succeeded" ||
          action.outputTruncated ||
          action.provider?.pluginId !== expected.pluginId ||
          action.provider.plugin !== expected.plugin ||
          action.provider.digest !== expected.digest ||
          action.provider.actionId !== "execute-e2e" ||
          output?.protocol !== protocol ||
          output.runner !== "node-test/v1" ||
          output.passed !== true ||
          output.executionId !== selection.executionId ||
          output.exitCode !== 0 ||
          !Array.isArray(output.subjects) ||
          output.subjects.length < 1 ||
          output.subjects.length > 8 ||
          !sameProject(current, output) ||
          output.sourceFingerprint !== sourceFingerprint ||
          !validCounts(output.counts) ||
          !Array.isArray(output.errors) ||
          output.errors.length
        )
          throw Error("TEST_ORIGINAL_RECEIPT_INVALID")
        if (
          expectedEntry &&
          (JSON.stringify(output.files) !== JSON.stringify(expectedEntry.files) ||
            JSON.stringify(output.subjects) !== JSON.stringify(expectedEntry.subjects) ||
            output.timeoutMs !== expectedEntry.timeoutMs)
        )
          throw Error("TEST_EXPECTED_ENTRY_MISMATCH")
        if (
          actions.filter(
            (row) =>
              row.provider?.pluginId === expected.pluginId &&
              row.provider.digest === expected.digest &&
              row.provider.actionId === "execute-e2e"
          ).length !== 1
        )
          throw Error("TEST_MULTIPLE_EXECUTIONS_REQUIRE_NEW_REPORT")
        const confirmRequest = adapterInvocation({
          mode: "reference",
          reference: ref,
          files: output.files,
          subjects: output.subjects
        })
        const confirmed = parseAdapterResult<ReferenceAdapterResult>(
          await $.process.run(confirmRequest.argv, confirmRequest.init)
        )
        if (
          confirmed.exitCode !== 0 ||
          confirmed.value.testsFingerprint !== output.testsFingerprint ||
          confirmed.value.subjectFingerprint !== output.subjectFingerprint ||
          confirmed.value.sourceFingerprint !== sourceFingerprint ||
          JSON.stringify(confirmed.value.selection) !== JSON.stringify(selection)
        )
          throw Error("TEST_REPORT_OR_INPUT_CHANGED")
        const after = currentProject(
          await $.platform.read({ ref: projectRef, target: { kind: "current" } })
        )
        if (!sameProject(current, after)) throw Error("TEST_PROJECT_SCOPE_CHANGED")
        return {
          status: "succeeded",
          text: "当前项目原始测试回执及产物字节校验通过",
          output: {
            passed: true,
            expectedEntryBound: expectedEntry !== undefined,
            errors: [],
            warnings: expectedEntry ? [] : [{ code: "TEST_LEGACY_ENTRY_UNBOUND" }],
            runId: selection.runId,
            executionId: selection.executionId,
            counts: output.counts
          }
        }
      }
    }
  )
}
