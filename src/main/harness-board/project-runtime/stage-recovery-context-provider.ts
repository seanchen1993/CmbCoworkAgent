import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { HostSkillExecutionContext } from "./host-service"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { readStageRecoveryPolicy } from "./stage-recovery-policy"
import { runtimeDigest, readRuntimeScopedFile, runtimeDirectory } from "./safe-files"
import { prepareExtensionContext } from "../extension-context"
import { prepareStageRecoveryCommand } from "../../hooks/stage-recovery-command"
import { startOwnedHookCommand } from "../../hooks/owned-command"

function fail(code: string): never {
  throw Error(`PROJECT_STAGE_DEBUG_${code}`)
}

/** Main-only text provider execution. The package requests argv, while the native branch
 * owns its process, frozen knowledge, writable scratch, fresh consent and exact result intent.
 */
export async function executeStageRecoveryContextProvider(
  context: HostSkillExecutionContext,
  threadId: string,
  assertThread: () => void
): Promise<string> {
  const project = context.project
  const { getProjectStageDebugSessions } = await import("../../mods/devtools/project-stage-debug")
  const stages = getProjectStageDebugSessions()
  const execution = await stages.contextProviderExecution(context, threadId)
  const { commandPolicy, bound } = execution
  const declaration = readStageRecoveryPolicy(context.snapshotRoot)?.contextProvider
  const contract = readPackageExtensionContract(context.snapshotRoot)?.context
  if (!commandPolicy || !declaration || !contract?.provider?.entry)
    fail("CONTEXT_PROVIDER_RECOVERY_REQUIRED")
  const guard = () => {
    context.signal.throwIfAborted()
    context.assertAuthorityCurrent?.()
    assertThread()
    execution.guard()
  }
  guard()
  const parent = join(project.workspace, ".dcp")
  await mkdir(parent).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  })
  runtimeDirectory(parent)
  const scratch = await mkdtemp(join(parent, "r-"))
  guard()
  runtimeDirectory(scratch)
  const argumentsByName = {
    workspace: project.workspace,
    stageId: context.operation.stageId,
    goal: context.goal
  }
  let args = [
    "-I",
    "-B",
    "-X",
    "utf8",
    join(context.snapshotRoot, contract.provider.entry),
    ...declaration.args.map((arg) =>
      arg.replace(
        /\$\{(workspace|stageId|goal)\}/g,
        (_match, key: keyof typeof argumentsByName) => argumentsByName[key]
      )
    )
  ]
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
  let prepared: Awaited<ReturnType<typeof prepareExtensionContext>>
  try {
    // Existing board-resource adapters keep their exact original argv/environment behavior.
    // Their frozen cache is copied into per-run branch scratch before any plugin code runs.
    const originalBoard = readRuntimeScopedFile(
      context.snapshotRoot,
      "board_core/board_config.json",
      262144
    )
    if (originalBoard.bytes) {
      const board = readRuntimeScopedFile(bound.directory, "board_config.json", 262144)
      if (!board.bytes) fail("CONTEXT_PROVIDER_INPUTS_UNBOUND")
      await writeFile(join(scratch, "board_config.json"), board.bytes, { flag: "wx" })
      prepared = await prepareExtensionContext({
        sourceRoot: context.snapshotRoot,
        workspace: project.workspace,
        dataRoot: bound.directory,
        operation: "session-context",
        invocation: { executable: "python", args },
        recoveryContext: { ...bound, directory: scratch }
      })
      if (!prepared) fail("CONTEXT_PROVIDER_INPUTS_UNBOUND")
      args = prepared.invocation.args
      Object.assign(env, prepared.env)
      env.DEVCLAW_RUNTIME_CONFIG_PATH = join(scratch, "board_config.json")
    } else
      args = [...args.slice(0, 5), "--devclaw-operation", "session-context", "--", ...args.slice(5)]
    Object.assign(env, {
      DEVCLAW_PLUGIN_DATA_ROOT: scratch,
      ...(bound.knowledgeRoot ? { DEVCLAW_KNOWLEDGE_ROOT: bound.knowledgeRoot } : {}),
      DEVCLAW_KNOWLEDGE_READONLY: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
    })
    guard()
    const plan = await prepareStageRecoveryCommand({
      workspace: project.workspace,
      snapshotRoot: context.snapshotRoot,
      commandCwd: context.snapshotRoot,
      policy: {
        ...commandPolicy,
        readOnlyRoots: [...commandPolicy.readOnlyRoots, bound.directory]
      },
      env,
      shell: "python",
      args,
      stdin: JSON.stringify({
        schemaVersion: 1,
        projectId: project.projectId,
        operationId: context.operation.operationId,
        configuration: bound.configuration ?? {},
        stageId: context.operation.stageId,
        workspace: project.workspace,
        goal: context.goal
      }),
      guard,
      signal: context.signal
    })
    let settlement: ReturnType<typeof stages.beginHookExecution> | undefined
    const out: Buffer[] = [],
      err: Buffer[] = []
    let bytes = 0,
      exceeded = false,
      timedOut = false
    let owned: ReturnType<typeof startOwnedHookCommand> | undefined
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (exceeded) return
      if ((bytes += chunk.length) > 512 * 1024) {
        exceeded = true
        owned?.stop()
      } else target.push(chunk)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      settlement = execution.begin({
        id: "native-retained-context-provider",
        event: "SessionStart",
        type: "command",
        command: JSON.stringify(["python", ...args]),
        enabled: true,
        fallback: "block",
        createdAt: "",
        updatedAt: ""
      })
      // Bracket actual plugin execution with the full immutable source/config/knowledge fence.
      // ACL preparation uses the native authority and retained metadata guards above.
      context.assertInputsCurrent?.()
      owned = startOwnedHookCommand({
        ...plan,
        stdin: "",
        signal: context.signal,
        stdout: (chunk) => collect(out, chunk),
        stderr: (chunk) => collect(err, chunk)
      })
      timer = setTimeout(() => {
        timedOut = true
        owned!.stop()
      }, 15000)
      const result = await owned.completion
      const uncertain = timedOut || exceeded || !!result.error || context.signal.aborted
      const fact = settlement
      settlement = undefined
      fact.settle(
        result.code,
        uncertain,
        runtimeDigest(Buffer.concat([...out, Buffer.from([0]), ...err]))
      )
      context.signal.throwIfAborted()
      if (uncertain || result.code !== 0) fail("CONTEXT_PROVIDER_FAILED")
      guard()
      context.assertInputsCurrent?.()
      bound.assertCurrent()
      prepared?.assertCurrent?.()
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(out)).trim()
      if (!text || Buffer.byteLength(text) > 28000 || text.includes("\0"))
        fail("CONTEXT_PROVIDER_TEXT_INVALID")
      return text
    } finally {
      if (timer) clearTimeout(timer)
      settlement?.settle(null, true)
      await plan.cleanup()
    }
  } finally {
    prepared?.release()
  }
}
