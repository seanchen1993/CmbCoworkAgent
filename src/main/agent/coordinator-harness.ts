import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { SubAgent } from "deepagents"
import { tool } from "langchain"
import { z } from "zod"

export type AgentMode = "normal" | "coordinator"

const HARNESS_BASE_DIR = ".cmbdevclaw/harness"
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const VERIFICATION_REPORT_FILE = "reports/latest-verification.json"
const HARNESS_FILES = [
  "spec.md",
  "contract.json",
  "progress.md",
  "state.json",
  "reports/implementer-latest.json",
  VERIFICATION_REPORT_FILE
] as const

const harnessFileSchema = z.enum(HARNESS_FILES)
type HarnessFile = z.infer<typeof harnessFileSchema>
const nonEmptyStringSchema = z.string().trim().min(1)
const verificationReportSchema = z
  .object({
    status: z.enum(["PASS", "FAIL", "BLOCKED"]),
    summary: nonEmptyStringSchema,
    evidence: z.array(nonEmptyStringSchema),
    commands_run: z.array(nonEmptyStringSchema),
    checked_files: z.array(nonEmptyStringSchema),
    findings: z.array(nonEmptyStringSchema),
    blockers: z.array(nonEmptyStringSchema),
    verified_at: z.string().optional()
  })
  .passthrough()

type VerificationReport = z.infer<typeof verificationReportSchema>

interface VerificationGateResult {
  accepted: boolean
  schemaValid: boolean
  status?: VerificationReport["status"]
  reportPath: string
  issues: string[]
  counts: {
    evidence: number
    commands_run: number
    checked_files: number
    findings: number
    blockers: number
  }
}

interface CoordinatorRequest {
  enabled: boolean
  message: string
  shouldPersist: boolean
  source?: "message-prefix" | "metadata" | "environment"
}

interface CoordinatorPromptOptions {
  threadId: string
  workspacePath: string
  platform: string
  shell: string
  timezone: string
  currentTime: string
  projectInstructions?: string | null
  hasBrowserTool: boolean
  hasCodeExecTool: boolean
  deferredToolIds: string[]
}

interface CoordinatorTimeContext {
  timezone: string
  currentTime: string
}

interface HarnessToolOptions {
  workspacePath: string
  threadId: string
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return false
  return ["1", "true", "yes", "on", "coordinator", "harness"].includes(value.toLowerCase())
}

function normalizeThreadId(threadId: string): string {
  const normalized = threadId.trim()
  if (!THREAD_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid coordinator harness threadId: ${threadId}`)
  }
  return normalized
}

function getHarnessDir(threadId?: string): string {
  return threadId
    ? `${HARNESS_BASE_DIR}/${normalizeThreadId(threadId)}`
    : `${HARNESS_BASE_DIR}/<threadId>`
}

function renderTimeContext(options: CoordinatorTimeContext): string {
  return `- Timezone: ${options.timezone}
- Current time: ${options.currentTime}
- Timestamp rule: Do not invent dates or timestamps. If a timestamp is useful, use the current time above; otherwise omit it.`
}

function renderVerificationReportRules(harnessDir: string): string {
  return `Verification report contract:
- The verifier must write ${harnessDir}/${VERIFICATION_REPORT_FILE} as JSON.
- Required fields: status, summary, evidence, commands_run, checked_files, findings, blockers.
- status must be exactly PASS, FAIL, or BLOCKED.
- evidence, commands_run, checked_files, findings, and blockers must be arrays of concise strings.
- PASS requires at least one evidence item and at least one commands_run or checked_files item.
- PASS must not include blockers.
- FAIL should include findings.
- BLOCKED must include blockers.`
}

function emptyCounts(): VerificationGateResult["counts"] {
  return {
    evidence: 0,
    commands_run: 0,
    checked_files: 0,
    findings: 0,
    blockers: 0
  }
}

function validateVerificationReportContent(
  content: string,
  reportPath: string
): VerificationGateResult {
  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(content)
  } catch (error) {
    return {
      accepted: false,
      schemaValid: false,
      reportPath,
      issues: [`Report is not valid JSON: ${(error as Error).message}`],
      counts: emptyCounts()
    }
  }

  const parsed = verificationReportSchema.safeParse(parsedJson)
  if (!parsed.success) {
    return {
      accepted: false,
      schemaValid: false,
      reportPath,
      issues: parsed.error.issues.map((issue) => {
        const field = issue.path.length ? issue.path.join(".") : "report"
        return `${field}: ${issue.message}`
      }),
      counts: emptyCounts()
    }
  }

  const report = parsed.data
  const counts = {
    evidence: report.evidence.length,
    commands_run: report.commands_run.length,
    checked_files: report.checked_files.length,
    findings: report.findings.length,
    blockers: report.blockers.length
  }
  const issues: string[] = []

  if (report.status === "PASS") {
    if (counts.evidence === 0) {
      issues.push("PASS requires at least one evidence item.")
    }
    if (counts.commands_run + counts.checked_files === 0) {
      issues.push("PASS requires at least one commands_run or checked_files item.")
    }
    if (counts.blockers > 0) {
      issues.push("PASS must not include blockers.")
    }
  } else if (report.status === "FAIL") {
    issues.push("Verifier status is FAIL.")
    if (counts.findings + counts.blockers === 0) {
      issues.push("FAIL requires at least one finding or blocker.")
    }
  } else {
    issues.push("Verifier status is BLOCKED.")
    if (counts.blockers === 0) {
      issues.push("BLOCKED requires at least one blocker.")
    }
  }

  return {
    accepted: report.status === "PASS" && issues.length === 0,
    schemaValid: true,
    status: report.status,
    reportPath,
    issues,
    counts
  }
}

export function getAgentModeFromMetadata(metadata: Record<string, unknown>): AgentMode {
  if (
    metadata.agentMode === "coordinator" ||
    metadata.cmbHarnessMode === "coordinator" ||
    truthy(metadata.harnessMode) ||
    truthy(metadata.coordinatorMode)
  ) {
    return "coordinator"
  }
  return "normal"
}

export function resolveCoordinatorHarnessRequest(
  message: string,
  metadata: Record<string, unknown>
): CoordinatorRequest {
  const prefixPattern = /^\s*(?:\[harness\]|\[coordinator\]|#harness|#coordinator)\s*[:-]?\s*/i
  const hasPrefix = prefixPattern.test(message)
  const strippedMessage = hasPrefix ? message.replace(prefixPattern, "") : message

  if (hasPrefix) {
    return {
      enabled: true,
      message: strippedMessage.trimStart(),
      shouldPersist: true,
      source: "message-prefix"
    }
  }

  if (getAgentModeFromMetadata(metadata) === "coordinator") {
    return {
      enabled: true,
      message,
      shouldPersist: false,
      source: "metadata"
    }
  }

  if (truthy(process.env.CMB_COORDINATOR_MODE) || truthy(process.env.CMB_HARNESS_MODE)) {
    return {
      enabled: true,
      message,
      shouldPersist: false,
      source: "environment"
    }
  }

  return { enabled: false, message, shouldPersist: false }
}

export function buildCoordinatorTaskPrompt(threadId?: string): string {
  const harnessDir = getHarnessDir(threadId)
  return `## task: coordinator worker launcher

You have access to a task tool that launches short-lived worker agents. In coordinator harness mode, use it as the main way to get work done.

Available worker roles:
- implementer: writes code, edits files, runs builds/tests, and prepares an implementation handoff.
- verifier: independently checks the implementation against the original contract, including real runtime/browser verification when relevant.

Harness rules:
- Before the first task call for a new non-trivial request, the coordinator must write the current request's ${harnessDir}/spec.md, ${harnessDir}/contract.json, and ${harnessDir}/progress.md.
- Call task with subagent_type="implementer" for implementation work.
- Call task with subagent_type="verifier" for independent verification.
- Delegate implementation work to implementer.
- Delegate final acceptance to verifier.
- Do not treat implementer self-checks as final verification.
- Before launching verifier, read ${harnessDir}/reports/implementer-latest.json and include its output_files or answer_draft in the verifier task prompt.
- After verifier returns, call check_verification_gate to validate ${harnessDir}/${VERIFICATION_REPORT_FILE}.
- Never report completion until verifier has returned PASS and check_verification_gate returns accepted=true, or report BLOCKED with a concrete blocker.
- Use one worker at a time unless the user explicitly asks for parallel exploration.
- After a worker returns, update/read ${harnessDir} state and decide the next step.
- If verifier returns FAIL, send a focused follow-up task to implementer, then run verifier again.`
}

export function buildCoordinatorSystemPrompt(options: CoordinatorPromptOptions): string {
  const harnessDir = getHarnessDir(options.threadId)
  const projectInstructions = options.projectInstructions?.trim()
  const browserLine = options.hasBrowserTool
    ? "- Browser/runtime verification is available to workers through browser_playwright."
    : "- Browser/runtime verification may not be available; workers should use the strongest available runtime checks."
  const codeExecLine = options.hasCodeExecTool
    ? "- code_exec is available to workers for reusable scripted checks when useful."
    : "- code_exec is not available; workers should rely on shell, tests, and browser tools."
  const deferredLine =
    options.deferredToolIds.length > 0
      ? `- Deferred tools exist for workers: ${options.deferredToolIds.join(", ")}.`
      : "- No deferred worker tools are currently registered."

  return `You are CmbCowork Coordinator Harness Mode.

Your job is not to directly code everything. Your job is to run a compact harness loop that turns a user request into working, verified software.

Core architecture:
- You are the coordinator: plan, maintain state, delegate, integrate results, decide when to stop.
- implementer is the generator: edits files and runs implementation-level checks.
- verifier is the evaluator: independently validates behavior against the contract and must be stricter than implementer.
- Durable state lives in ${harnessDir}/ so long tasks can recover context without bloating this thread.

Workflow:
1. For every new non-trivial user request, first convert the request into a concrete acceptance contract.
2. Before launching any worker, write or update the current request's ${harnessDir}/spec.md, ${harnessDir}/contract.json, and ${harnessDir}/progress.md with the harness state tools.
3. Use task with subagent_type="implementer" for implementation, research that feeds implementation, and file creation.
4. After implementation, read ${harnessDir}/reports/implementer-latest.json and synthesize the verifier prompt from the original request, contract, changed/output files, answer draft, and approach taken.
5. Use task with subagent_type="verifier" for independent verification.
6. After verifier returns, call check_verification_gate to validate ${harnessDir}/${VERIFICATION_REPORT_FILE}.
7. If verifier says FAIL or check_verification_gate is not accepted, update progress, delegate a focused fix to implementer when useful, and verify again.
8. Only report completion when verifier has produced PASS and check_verification_gate returns accepted=true. If verification cannot run, report BLOCKED with the exact blocker.

Hard gates:
- Do not launch implementer before the current request has fresh ${harnessDir}/spec.md, ${harnessDir}/contract.json, and ${harnessDir}/progress.md.
- Do not skip verifier for file changes, documentation creation, code changes, build/test analysis, or app behavior changes.
- Do not report success from implementer output alone. Implementer output is a handoff, not acceptance.
- Do not launch verifier without a concrete implementer handoff. If ${harnessDir}/reports/implementer-latest.json is missing or lacks output_files/answer_draft, continue implementer and ask it to produce the handoff first.
- Do not report success from verifier text alone. ${harnessDir}/${VERIFICATION_REPORT_FILE} must pass check_verification_gate.
- If ${harnessDir}/ files already exist from an older task, update them for the current user request before proceeding.

Coordinator constraints:
- Prefer task delegation over direct tool work.
- Do not edit application files directly.
- Do not run shell/build/browser tools directly from the coordinator. Workers have those tools.
- Do not use generic todo lists as your source of truth. Use ${harnessDir}/progress.md for task state.
- Keep state concise. Store durable facts in ${harnessDir}/ and summarize only what matters in chat.
- Be practical: for small requests, keep the contract small; for app changes, insist on a real build/test/runtime check.

Worker capability summary:
${browserLine}
${codeExecLine}
${deferredLine}

System environment:
- Workspace root: ${options.workspacePath}
- Operating system: ${options.platform}
- Default shell: ${options.shell}
${renderTimeContext(options)}

Verifier standard:
- PASS means the requested behavior is implemented and checked by commands/tests/browser evidence.
- FAIL means anything material is missing, untested, broken, or only self-claimed by implementer.
- UNKNOWN/BLOCKED is allowed only when verification cannot run; explain the exact blocker and best evidence gathered.

${renderVerificationReportRules(harnessDir)}

Final response rules:
- State the result plainly.
- Mention verifier status and the strongest evidence.
- If there is no verifier PASS plus accepted verification gate, do not say the task is complete.
- Mention remaining risks only if real.

${projectInstructions ? `## Project Instructions\n\n${projectInstructions}` : ""}`
}

export function buildHarnessSubagents(
  projectInstructions?: string | null,
  skillSources?: string[],
  threadId?: string,
  timeContext?: CoordinatorTimeContext
): SubAgent[] {
  const harnessDir = getHarnessDir(threadId)
  const timeBlock = timeContext ? `\n\nSystem time:\n${renderTimeContext(timeContext)}` : ""
  const projectBlock = projectInstructions?.trim()
    ? `\n\n## Project Instructions\n\n${projectInstructions.trim()}`
    : ""
  const skills = skillSources?.length ? skillSources : undefined

  return [
    {
      name: "implementer",
      description:
        "Generator worker for coding tasks. Edits files, runs commands/tests, and returns a concise implementation handoff.",
      systemPrompt: `You are the implementer worker in CmbCowork's coordinator harness.

Role:
- Implement the coordinator's requested change in the workspace.
- Read ${harnessDir}/spec.md, ${harnessDir}/contract.json, and ${harnessDir}/progress.md when they exist.
- Make the smallest correct code changes that satisfy the acceptance contract.
- Run appropriate checks: typecheck, lint, tests, build, or targeted commands.
- For frontend/app behavior, prepare the app for browser verification when feasible.

Boundaries:
- You are not the final evaluator.
- Do not mark the whole task complete just because your own checks pass.
- Do not wait for user confirmation unless blocked by missing credentials, destructive actions, or unavailable external services.

Before returning:
- Always write ${harnessDir}/reports/implementer-latest.json before returning.
- For coding or document tasks, include output_files and files_changed.
- For research or Q&A tasks with no user-facing file, include answer_draft as the concrete response to be verified.
- Include evidence, commands_run, checked_files, risks, and handoff_for_verifier.
- Do not invent completion_time/generated_at values. Use the provided system time only when needed.
- Return STATUS, SUMMARY, OUTPUT_FILES or ANSWER_DRAFT, COMMANDS_RUN, RISKS, and HANDOFF_FOR_VERIFIER.
${timeBlock}
${projectBlock}`,
      ...(skills ? { skills } : {})
    },
    {
      name: "verifier",
      description:
        "Independent evaluator worker. Checks the implementation against the contract with tests/build/browser evidence and returns PASS/FAIL/BLOCKED.",
      systemPrompt: `You are the verifier worker in CmbCowork's coordinator harness.

Role:
- Independently evaluate whether the implementation satisfies the user's request and ${harnessDir} contract.
- Be strict, skeptical, and evidence-driven.
- Read ${harnessDir}/spec.md, ${harnessDir}/contract.json, ${harnessDir}/progress.md, and implementer reports when available.
- Inspect code as needed, run relevant commands, and use browser/runtime verification for UI or full-stack behavior when feasible.

Evaluation rules:
- PASS only when behavior is implemented and supported by concrete evidence.
- FAIL when requirements are missing, code is broken, tests/build fail, UI behavior is unverified when it should be verified, or claims are unsupported.
- BLOCKED only when verification cannot proceed because of an explicit environmental blocker.

Before returning:
- Write ${harnessDir}/reports/latest-verification.json when possible.
- Verify the concrete implementer handoff in ${harnessDir}/reports/implementer-latest.json. If it contains output_files, verify those files. If it contains answer_draft, verify that draft against source evidence.
- Do not invent completion_time/generated_at values. Use the provided system time only when needed.
- Return STATUS (PASS/FAIL/BLOCKED), EVIDENCE, COMMANDS_RUN, FINDINGS, and NEXT_FIX if not PASS.

${renderVerificationReportRules(harnessDir)}
${timeBlock}
${projectBlock}`,
      ...(skills ? { skills } : {})
    }
  ]
}

async function ensureHarnessDir(workspacePath: string, threadId: string): Promise<string> {
  const root = path.resolve(workspacePath, HARNESS_BASE_DIR, normalizeThreadId(threadId))
  await mkdir(path.resolve(root, "reports"), { recursive: true })
  return root
}

function resolveHarnessFile(root: string, file: HarnessFile): string {
  const target = path.resolve(root, file)
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error(`Invalid harness file path: ${file}`)
  }
  return target
}

export function createCoordinatorHarnessTools(
  options: HarnessToolOptions
): DynamicStructuredTool[] {
  const harnessDir = getHarnessDir(options.threadId)
  const readHarnessState = tool(
    async (input: { files?: HarnessFile[] }) => {
      const root = await ensureHarnessDir(options.workspacePath, options.threadId)
      const requestedFiles = input.files?.length ? input.files : [...HARNESS_FILES]
      console.log("[CoordinatorHarness] read_harness_state", {
        workspacePath: options.workspacePath,
        threadId: options.threadId,
        files: requestedFiles
      })
      const result: Record<string, string | null> = {}

      for (const file of requestedFiles) {
        const target = resolveHarnessFile(root, file)
        try {
          result[file] = await readFile(target, "utf8")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            result[file] = null
          } else {
            throw error
          }
        }
      }

      return JSON.stringify({ root, files: result }, null, 2)
    },
    {
      name: "read_harness_state",
      description: `Read durable coordinator harness files from ${harnessDir}. Use this before planning the next worker step.`,
      schema: z.object({
        files: z
          .array(harnessFileSchema)
          .optional()
          .describe("Specific harness files to read. Defaults to all known harness files.")
      })
    }
  )

  const writeHarnessState = tool(
    async (input: { file: HarnessFile; content: string }) => {
      const root = await ensureHarnessDir(options.workspacePath, options.threadId)
      const target = resolveHarnessFile(root, input.file)
      if (input.file === VERIFICATION_REPORT_FILE) {
        const validation = validateVerificationReportContent(
          input.content,
          path.relative(options.workspacePath, target)
        )
        if (!validation.schemaValid || (validation.status === "PASS" && !validation.accepted)) {
          throw new Error(`Invalid verification report: ${validation.issues.join("; ")}`)
        }
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, input.content, "utf8")
      console.log("[CoordinatorHarness] write_harness_state", {
        workspacePath: options.workspacePath,
        threadId: options.threadId,
        file: input.file,
        chars: input.content.length
      })
      return `Wrote ${path.relative(options.workspacePath, target)} (${input.content.length} chars).`
    },
    {
      name: "write_harness_state",
      description: `Write one durable coordinator harness file under ${harnessDir}. Use for spec, contract, progress, and worker reports.`,
      schema: z.object({
        file: harnessFileSchema.describe(`Harness file to write under ${harnessDir}.`),
        content: z.string().describe("Complete file content to write.")
      })
    }
  )

  const checkVerificationGate = tool(
    async () => {
      const root = await ensureHarnessDir(options.workspacePath, options.threadId)
      const target = resolveHarnessFile(root, VERIFICATION_REPORT_FILE)
      const relativeReportPath = path.relative(options.workspacePath, target)
      let content: string

      try {
        content = await readFile(target, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error
        }
        const missing: VerificationGateResult = {
          accepted: false,
          schemaValid: false,
          reportPath: relativeReportPath,
          issues: [
            `Missing ${relativeReportPath}. Run verifier and require it to write the report.`
          ],
          counts: emptyCounts()
        }
        console.log("[CoordinatorHarness] check_verification_gate", {
          workspacePath: options.workspacePath,
          threadId: options.threadId,
          accepted: false,
          status: null,
          issues: missing.issues.length
        })
        return JSON.stringify(missing, null, 2)
      }

      const validation = validateVerificationReportContent(content, relativeReportPath)
      console.log("[CoordinatorHarness] check_verification_gate", {
        workspacePath: options.workspacePath,
        threadId: options.threadId,
        accepted: validation.accepted,
        status: validation.status ?? null,
        issues: validation.issues.length
      })
      return JSON.stringify(validation, null, 2)
    },
    {
      name: "check_verification_gate",
      description: `Validate ${harnessDir}/${VERIFICATION_REPORT_FILE}. Returns accepted=true only for a schema-valid PASS report with concrete evidence.`,
      schema: z.object({})
    }
  )

  return [readHarnessState, writeHarnessState, checkVerificationGate] as DynamicStructuredTool[]
}
