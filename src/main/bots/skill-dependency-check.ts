import { z } from "zod"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import {
  BOT_SKILL_DEPENDENCY_FRESH_MS,
  botSkillDependencyEnvironment,
  botSkillDependencyReport,
  botSkillDependencyCheckResult,
  type BotSkillDependencyCheckResult,
  type BotSkillDependencyEnvironment,
  type BotSkillDependencyReport
} from "../../shared/bot-skill-dependencies"
import type { SkillDependencyCheck } from "../../shared/skill-dependencies"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import { BotProjectFiles } from "./project-files"
import { botExecutionAuthorityFingerprint } from "./execution-authority"
import { readBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { BOT_BUILD_ID } from "./host-build"
import { canonicalJson } from "./validation"
import {
  botExecutionConfigSchema,
  botShellEnvironment,
  botShellSandboxName,
  botShellReadOnly,
  botShellResultSandboxName
} from "./shell-contract"
import { BotShellPreparationError, type BotShellProcess } from "./shell-process"
import { botShellDefinition, assertBotShellDefinition } from "./shell-definition"
import { withBotProjectMutation } from "./project-lock"
import { assessCommandSafety } from "../agent/exec-policy"
import type { BotStore } from "./store"

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
/** A Host/runtime restart invalidates this ephemeral environment identity. No
 * environment values or dependency result are persisted by this identity. */
export const createBotSkillDependencyEnvironmentId = () => randomUUID()
export async function readBotSkillDependencyEnvironment(
  store: BotStore,
  botId: string,
  modelFile: string,
  instance: string,
  snapshot?: BotModelSnapshot
): Promise<BotSkillDependencyEnvironment> {
  const bot = store.getBot(botId),
    policy = store.localTools.read()
  if (policy.target.platform !== process.platform)
    throw new BotDomainError("skill_dependency_environment", "当前本机执行环境身份不可用")
  const current = snapshot ?? (await readBotModelSnapshot(modelFile))
  const project = bot.workspacePath
    ? await BotProjectFiles.open(bot.workspacePath, [dirname(modelFile)])
    : undefined
  return botSkillDependencyEnvironment.parse({
    target: policy.target,
    dataEpoch: store.dataEpoch(),
    policyRevision: policy.revision,
    botRevision: bot.revision,
    buildId: BOT_BUILD_ID,
    commandRulesRevision: store.approvalRules.read(botId).revision,
    reviewRevision: store.autoReview.read(botId).revision,
    authoritySha256: botExecutionAuthorityFingerprint(current),
    workspaceSha256: hash({
      instance,
      platform: process.platform,
      identity: project?.identity ?? null
    })
  })
}

function versionResult(name: string, output: string): string | undefined {
  if (output.length > 4096 || output.includes("\0")) return
  const normalized = output.replace(/\r\n/g, "\n").trim()
  const patterns: Record<string, RegExp> = {
    node: /^v(\d+\.\d+\.\d+)$/,
    npm: /^(\d+\.\d+\.\d+)$/,
    pnpm: /^(\d+\.\d+\.\d+)$/,
    python: /^Python (\d+\.\d+\.\d+)$/,
    python3: /^Python (\d+\.\d+\.\d+)$/,
    git: /^git version (\d+\.\d+\.\d+)(?:\.windows\.\d+)?$/,
    cargo: /^cargo (\d+\.\d+\.\d+) \([a-f0-9]+ \d{4}-\d{2}-\d{2}\)$/,
    rustc: /^rustc (\d+\.\d+\.\d+) \([a-f0-9]+ \d{4}-\d{2}-\d{2}\)$/,
    dotnet: /^(\d+\.\d+\.\d+)$/,
    go: /^go version go(\d+\.\d+\.\d+) (?:darwin|linux|windows)\/[a-z0-9]+$/
  }
  const version = patterns[name]?.exec(normalized)?.[1]
  return version &&
    /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/.test(version)
    ? version
    : undefined
}
const versionNames = new Set([
  "node",
  "npm",
  "pnpm",
  "python",
  "python3",
  "git",
  "cargo",
  "rustc",
  "dotnet",
  "go"
])
const quoted = (value: string) => `'${value}'` // Schema excludes quotes, metacharacters and paths.
function presenceCommand(kind: "executable" | "environment", name: string): string {
  if (process.platform === "win32") {
    const predicate =
      kind === "environment"
        ? `Test-Path -LiteralPath 'Env:${name}'`
        : `Get-Command -Name ${quoted(name)} -CommandType Application -ErrorAction SilentlyContinue`
    return `if (${predicate}) { Write-Output 'present' } else { Write-Output 'absent' }`
  }
  const predicate =
    kind === "executable"
      ? `command -v ${quoted(name)} >/dev/null 2>&1`
      : `[ "${"${" + name + "+x}"}" = x ]`
  return `if ${predicate}; then printf 'present\\n'; else printf 'absent\\n'; fi`
}
export interface BotSkillDependencyExecution {
  request: BotRuntimeRequest
  modelFile: string
  snapshot: BotModelSnapshot
  environmentId: string
  runner: BotShellProcess
  check(allowWaiting?: boolean): void
  approve(
    id: string,
    action: unknown,
    operation: () => Promise<string>,
    beforeStart?: () => Promise<void | string>
  ): Promise<string>
}
/** Only known results are published. Raw command output lives solely in the
 * bounded runner return, never an artifact, progress callback, log or receipt. */
export async function executeBotSkillDependencyCheck(
  input: BotSkillDependencyExecution
): Promise<string> {
  const { request, snapshot, modelFile, runner, check, approve } = input
  runner.assertAvailable()
  const { store, lease, run, bot, signal } = request
  const pin = store.skillDependencies.pinned(run.id)
  if (!pin) throw new BotDomainError("skill_dependency_scope", "缺少已授权的技能依赖检查任务")
  const environment = await readBotSkillDependencyEnvironment(
    store,
    bot.id,
    modelFile,
    input.environmentId,
    snapshot
  )
  // The original approval collector validates each exact action and its current
  // rule. Saving that approval as a rule is a normal human decision, not a change
  // to the physical executable environment; record its final revision below.
  const executionIdentity = (value: BotSkillDependencyEnvironment) => ({
    ...value,
    commandRulesRevision: 0
  })
  const assertCurrent = async () => {
    check()
    store.skillDependencies.assertCurrent(lease)
    if (
      canonicalJson(
        executionIdentity(
          await readBotSkillDependencyEnvironment(store, bot.id, modelFile, input.environmentId)
        )
      ) !== canonicalJson(executionIdentity(environment))
    )
      throw new BotDomainError(
        "skill_dependency_environment",
        "执行环境或许可已变化，请重新发起依赖检查"
      )
    check()
  }
  await assertCurrent()
  // Recovered evidence must belong to the original execution environment.
  const savedEnvironment = store.toolOnce(
    lease,
    "skill-dependencies:environment",
    { skill: pin.skill },
    () => environment
  )
  if (canonicalJson(savedEnvironment) !== canonicalJson(environment))
    throw new BotDomainError(
      "skill_dependency_environment",
      "原检查的执行环境已失效，请核对原结果后发起新检查"
    )
  const result = (
    entry: SkillDependencyCheck,
    status: BotSkillDependencyCheckResult["status"],
    reason: BotSkillDependencyCheckResult["reason"],
    extra = {}
  ) =>
    botSkillDependencyCheckResult.parse({
      id: entry.id,
      status,
      reason,
      ...extra
    })
  const observationSchema = z
    .object({ check: botSkillDependencyCheckResult, scopeClosed: z.boolean() })
    .strict()
  const projectObservation = (
    entry: SkillDependencyCheck,
    observation: z.infer<typeof observationSchema>
  ): BotSkillDependencyCheckResult =>
    entry.kind !== "environment" &&
    !observation.scopeClosed &&
    observation.check.status !== "unverified"
      ? { ...observation.check, status: "unverified", reason: "command_exit_unconfirmed" }
      : observation.check
  const observe = async (
    entry: SkillDependencyCheck,
    command: string,
    parse: (output: string) => BotSkillDependencyCheckResult,
    suffix = ""
  ) => {
    if (!bot.workspacePath || !snapshot.execution)
      return { check: result(entry, "unverified", "environment_unavailable"), scopeClosed: false }
    const execution = botExecutionConfigSchema.parse(snapshot.execution)
    const project = await BotProjectFiles.open(bot.workspacePath, [dirname(modelFile)])
    const effectId = `skill-dependency:${run.id}:${entry.id}${suffix}`
    await assertCurrent()
    const safety = assessCommandSafety(command, project.root, {
      enforceGitWorkflowCommitOnly: true,
      windowsShell: process.platform === "win32" ? "powershell" : "unknown"
    })
    if (safety.level === "forbidden")
      return { check: result(entry, "unverified", "unsupported"), scopeClosed: false }
    const definition = await botShellDefinition(project, command)
    const action = {
      shell: {
        command,
        cwd: project.root,
        timeoutSeconds: 5,
        sandbox: botShellSandboxName(execution),
        ...(definition ? { definition } : {})
      }
    }
    const value = await approve(
      effectId,
      action,
      () =>
        withBotProjectMutation(
          project.root,
          async () => {
            await assertCurrent()
            await assertBotShellDefinition(project, definition)
            const timeout = AbortSignal.timeout(5000)
            const probeSignal = AbortSignal.any([signal, timeout])
            let output
            try {
              output = await runner.execute(
                {
                  command,
                  cwd: project.root,
                  timeoutMs: 5000,
                  runId: run.id,
                  protectedRoots: [dirname(modelFile)],
                  execution,
                  readOnly: botShellReadOnly({ execution })
                },
                probeSignal,
                undefined,
                async () => {
                  store.localTools.assertStartedEffect(lease, effectId)
                  await assertCurrent()
                  await assertBotShellDefinition(project, definition)
                  probeSignal.throwIfAborted()
                }
              )
            } catch (error) {
              // Preparation never admitted a command. Keep the trusted subclass so
              // the existing approval collector can settle `failed`, not `unknown`.
              if (error instanceof BotShellPreparationError) {
                error.message = "依赖探测尚未开始；本机执行环境未就绪"
                throw error
              }
              throw new BotDomainError(
                "skill_dependency_interrupted",
                "依赖探测结果未确认，请核对原操作；不自动重复"
              )
            }
            await assertCurrent()
            if (output.exitCode === 124 || output.exitCode === 130 || output.exitCode === null)
              throw new BotDomainError(
                "skill_dependency_interrupted",
                "依赖探测中断，不能确认结果；不自动重复"
              )
            const checked =
              output.exitCode === 0 && !output.truncated
                ? parse(output.output)
                : result(entry, "unverified", "probe_failed")
            return JSON.stringify({
              check: { ...checked, effectId },
              // Only the Host WeakMap brand is accepted. Serializable request/
              // output flags cannot turn a weak or uncertain resource into proof.
              scopeClosed: botShellResultSandboxName(output) !== undefined
            })
          },
          signal
        ),
      assertCurrent
    )
    const parsed = (() => {
      try {
        return observationSchema.safeParse(JSON.parse(value))
      } catch {
        return null
      }
    })()
    // An original human denial is text, not a successful probe or missing binary.
    return parsed?.success
      ? parsed.data
      : { check: result(entry, "unverified", "permission_denied"), scopeClosed: false }
  }
  const probe = async (
    ...args: Parameters<typeof observe>
  ): Promise<BotSkillDependencyCheckResult> => projectObservation(args[0], await observe(...args))
  const checks: BotSkillDependencyCheckResult[] = []
  for (const entry of pin.declaration.checks) {
    await assertCurrent()
    const callId = `skill-dependencies:check:${entry.id}`
    const previous = store.hasToolResult(lease, callId)
    if (previous) {
      checks.push(
        botSkillDependencyCheckResult.parse(store.toolOnce(lease, callId, { entry }, () => null))
      )
      continue
    }
    let checked: BotSkillDependencyCheckResult
    try {
      if (entry.kind === "unsupported") checked = result(entry, "unverified", "unsupported")
      else if (entry.kind === "platform")
        checked = result(
          entry,
          entry.platforms.includes(process.platform as "darwin" | "win32" | "linux")
            ? "satisfied"
            : "missing",
          entry.platforms.includes(process.platform as "darwin" | "win32" | "linux")
            ? "observed"
            : "platform_mismatch"
        )
      else if (entry.kind === "file") {
        if (!bot.workspacePath) checked = result(entry, "unverified", "environment_unavailable")
        else {
          const project = await BotProjectFiles.open(bot.workspacePath, [dirname(modelFile)])
          const effectId = `skill-dependency:${run.id}:${entry.id}:file`
          const raw = await approve(
            effectId,
            { skillDependencyFile: { path: entry.path, type: entry.type } },
            async () => {
              await assertCurrent()
              const fileSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)])
              const observed = await project.probe(entry.path, entry.type, fileSignal)
              await assertCurrent()
              return JSON.stringify(
                result(
                  entry,
                  observed ? "satisfied" : "missing",
                  observed ? "observed" : "not_found",
                  { effectId }
                )
              )
            },
            assertCurrent
          )
          try {
            checked = botSkillDependencyCheckResult.parse(JSON.parse(raw))
          } catch {
            checked = result(entry, "unverified", "permission_denied")
          }
        }
      } else if (entry.kind === "environment") {
        if (!Object.hasOwn(botShellEnvironment({ [entry.name]: "presence-only" }), entry.name))
          checked = result(entry, "unverified", "unsupported")
        else
          checked = await probe(entry, presenceCommand("environment", entry.name), (output) =>
            output.trim() === "present"
              ? result(entry, "satisfied", "observed")
              : output.trim() === "absent"
                ? result(entry, "missing", "not_found")
                : result(entry, "unverified", "probe_output_invalid")
          )
      } else if (entry.kind === "any-executable") {
        const predicate =
          process.platform === "win32"
            ? entry.names
                .map(
                  (name) =>
                    `(Get-Command -Name ${quoted(name)} -CommandType Application -ErrorAction SilentlyContinue)`
                )
                .join(" -or ")
            : entry.names.map((name) => `command -v ${quoted(name)} >/dev/null 2>&1`).join(" || ")
        const command =
          process.platform === "win32"
            ? `if (${predicate}) { Write-Output 'present' } else { Write-Output 'absent' }`
            : `if ${predicate}; then printf 'present\\n'; else printf 'absent\\n'; fi`
        checked = await probe(entry, command, (output) =>
          output.trim() === "present"
            ? result(entry, "satisfied", "observed")
            : output.trim() === "absent"
              ? result(entry, "missing", "not_found")
              : result(entry, "unverified", "probe_output_invalid")
        )
      } else {
        const presence = await observe(
          entry,
          presenceCommand("executable", entry.name),
          (output) =>
            output.trim() === "present"
              ? result(entry, "satisfied", "observed")
              : output.trim() === "absent"
                ? result(entry, "missing", "not_found")
                : result(entry, "unverified", "probe_output_invalid")
        )
        checked = projectObservation(entry, presence)
        if (presence.check.status === "satisfied" && entry.minimumVersion) {
          if (!versionNames.has(entry.name)) checked = result(entry, "unverified", "unsupported")
          else {
            const version = await observe(
              entry,
              `${process.platform === "win32" ? "& " : ""}${quoted(entry.name)} ${entry.name === "go" ? "version" : "--version"}`,
              (output) => {
                const observed = versionResult(entry.name, output)
                if (!observed) return result(entry, "unverified", "probe_output_invalid")
                const a = observed.split(".").map(Number),
                  b = entry.minimumVersion!.split(".").map(Number)
                const difference = a.findIndex((value, index) => value !== b[index]),
                  ok = difference < 0 || a[difference] >= b[difference]
                return result(
                  entry,
                  ok ? "satisfied" : "missing",
                  ok ? "observed" : "version_too_old",
                  { observedVersion: observed }
                )
              },
              ":version"
            )
            checked = projectObservation(entry, {
              check: version.check,
              scopeClosed: presence.scopeClosed && version.scopeClosed
            })
          }
        }
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof BotShellPreparationError)
        checked = result(entry, "unverified", "environment_unavailable")
      else if (
        error instanceof BotDomainError &&
        ["local_permission_denied", "local_permission_retired"].includes(error.code)
      )
        checked = result(entry, "unverified", "permission_denied")
      else throw error
    }
    await assertCurrent()
    checks.push(store.toolOnce(lease, callId, { entry }, () => checked))
  }
  await assertCurrent()
  const checkedEnvironment = await readBotSkillDependencyEnvironment(
    store,
    bot.id,
    modelFile,
    input.environmentId
  )
  await assertCurrent()
  const checkedAt = store.now()
  const status: BotSkillDependencyReport["status"] = checks.some(
    (item) => item.status === "missing"
  )
    ? "missing"
    : !checks.length ||
        pin.declaration.state !== "structured" ||
        checks.some((item) => item.status === "unverified")
      ? "unverified"
      : "satisfied"
  const report = botSkillDependencyReport.parse({
    format: 1,
    skill: pin.skill,
    environment: checkedEnvironment,
    runId: run.id,
    checkedAt,
    expiresAt: checkedAt + BOT_SKILL_DEPENDENCY_FRESH_MS,
    status,
    checks
  })
  store.toolOnce(
    lease,
    "skill-dependencies:report",
    { skill: pin.skill, environment: checkedEnvironment },
    () => report
  )
  const satisfied = checks.filter((item) => item.status === "satisfied").length
  const missing = checks.filter((item) => item.status === "missing").length
  const unverified = checks.filter((item) => item.status === "unverified").length
  const label = { satisfied: "已满足", missing: "有缺失", unverified: "未核验" }[report.status]
  return `技能「${pin.skill.name}」版本 ${pin.skill.version} 依赖检查：${label}。${checks.length ? `已确认 ${satisfied} 项，缺失 ${missing} 项，未核验 ${unverified} 项。` : "没有可核验的结构化依赖声明。"}本次结果可在技能卡查看，不代表技能已通过试跑。`
}
