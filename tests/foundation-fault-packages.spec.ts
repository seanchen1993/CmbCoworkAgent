/** Fixture preflight only; the companion packaged test supplies actual native execution proof. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import ts from "typescript"
import { RequiredPromptContextError } from "../src/main/agent/required-prompt-context"
import { registerModsDevelopmentHandlers } from "../src/main/ipc/mods-development"
import { formatSkillUseBlock } from "../src/shared/skill-use-block"
import {
  parseProjectRuntimeManifest,
  projectRuntimeExtensionContract,
  CONTEXT_HANDOFF_PROTOCOL
} from "../src/shared/project-runtime"
import { parsePluginCapabilities } from "../src/shared/plugin-capabilities"
import { parseHostReceipt } from "../src/main/harness-board/project-runtime/host-state-protocol"
import {
  foundationContextProvider,
  foundationFaultProject,
  foundationFailedOperationOnly,
  foundationFunctionPackage,
  foundationInvalidContract,
  foundationNativeHookNotices,
  foundationRequiredContextRejection,
  foundationEarlyPromptHookPackage,
  foundationPromptHookPayload,
  FAULT_PROMPT_HOOK_POLICY,
  FAULT_PROMPT_HOOK_SKILL
} from "./support/foundation-fault-packages"

const action = {
  pluginId: "owned-fixture-context",
  plugin: "foundation-fault-context",
  digest: "a".repeat(64),
  actionId: "context",
  name: "Actual fixture context",
  command: "foundation-context",
  inputSchema: { type: "object", additionalProperties: false }
}
const checks: string[] = []
const earlyHookZip = foundationEarlyPromptHookPackage()
const earlyHookConfig = JSON.parse(earlyHookZip.readAsText("hooks/hooks.json"))[0]
assert.equal(earlyHookConfig.type, "prompt")
assert.equal(earlyHookConfig.event, "UserPromptSubmit")
assert.equal(earlyHookConfig.prompt, FAULT_PROMPT_HOOK_POLICY)
assert(earlyHookZip.getEntry(`skills/${FAULT_PROMPT_HOOK_SKILL}/SKILL.md`))
assert(!earlyHookZip.getEntry("mods/manifest.json"))
const earlyPrompt = `unique original human input\n\n${formatSkillUseBlock({
  name: FAULT_PROMPT_HOOK_SKILL,
  path: "/owned-installed-plugin/skills/foundation-prompt-probe/SKILL.md"
})}`
const earlyPayload = {
  hook_event_name: "UserPromptSubmit",
  policy: FAULT_PROMPT_HOOK_POLICY,
  prompt: earlyPrompt,
  tool_args: { message: earlyPrompt, rawMessage: earlyPrompt }
}
const earlyRequest = (payload: unknown) => ({
  messages: [
    { role: "system", content: "Original native Hook policy system" },
    { role: "user", content: JSON.stringify(payload) }
  ]
})
assert.deepEqual(foundationPromptHookPayload(earlyRequest(earlyPayload), earlyPrompt), earlyPayload)
for (const change of [
  { hook_event_name: "PreToolUse" },
  { policy: "other policy" },
  { prompt: "foreign input" },
  { tool_args: { message: earlyPrompt, rawMessage: "foreign" } }
])
  assert.equal(
    foundationPromptHookPayload(earlyRequest({ ...earlyPayload, ...change }), earlyPrompt),
    undefined
  )
assert.equal(
  foundationPromptHookPayload({ messages: [{ role: "user", content: earlyPrompt }] }, earlyPrompt),
  undefined
)
checks.push(
  "Private normal Skill activates only its plugin prompt Hook; exact native JSON event/policy/original input identifies Hook HTTP"
)
type DevelopmentIpc = Parameters<typeof registerModsDevelopmentHandlers>[0]
type DevelopmentListener = Parameters<DevelopmentIpc["handle"]>[1]
const developmentHandlers = new Map<string, DevelopmentListener>()
registerModsDevelopmentHandlers(
  {
    handle: (channel: string, listener: DevelopmentListener) => {
      developmentHandlers.set(channel, listener)
    }
  } as unknown as DevelopmentIpc,
  { refreshReuse: (threadId: string) => ({ threadId }) } as unknown as Parameters<
    typeof registerModsDevelopmentHandlers
  >[1],
  () => {
    /* This isolated IPC schema preflight has no renderer or side effects. */
  }
)
const statusHandler = developmentHandlers.get("mods:development:status")!
const schemaEvent = {} as Parameters<DevelopmentListener>[0]
assert.deepEqual(statusHandler(schemaEvent, { threadId: "fixture-thread" }), {
  threadId: "fixture-thread"
})
assert.throws(
  () =>
    statusHandler(schemaEvent, {
      threadId: "fixture-thread",
      expectedWorkspace: "C:/owned-fixture-workspace"
    }),
  /DEVELOPMENT_INPUT/
)
assert.throws(() => statusHandler(schemaEvent, {}), /DEVELOPMENT_INPUT/)
checks.push(
  "Original strict native status IPC accepts only threadId and rejects AuthoringScope extra fields"
)
const requiredError = new RequiredPromptContextError()
assert.equal(requiredError.code, "MODS_REQUIRED_CONTEXT_CHANGED")
const nativeErrorBlock = `[Agent] Error: {\n  name: '${requiredError.name}',\n  message: '${requiredError.message}',\n  stack: 'Original middleware error'\n}\n`
assert(foundationRequiredContextRejection(nativeErrorBlock))
assert(
  !foundationRequiredContextRejection(
    nativeErrorBlock.replace(requiredError.name, "UnrelatedError")
  )
)
assert(
  !foundationRequiredContextRejection(
    nativeErrorBlock.replace(requiredError.message, "context unavailable")
  )
)
assert(
  !foundationRequiredContextRejection(
    nativeErrorBlock.replace(requiredError.message, requiredError.message + " unrelated")
  )
)
assert(
  !foundationRequiredContextRejection(nativeErrorBlock.replace("[Agent] Error", "Assistant text"))
)
checks.push(
  "Original guarded rejection requires one native Agent error's exact name and dedicated complete message"
)
const receipt = {
  schemaVersion: 1,
  operationId: "operation",
  projectId: "project",
  stageId: "draft",
  pluginDigest: "a".repeat(64),
  inputFingerprint: "b".repeat(64),
  checkId: "required-check",
  artifactFingerprint: "c".repeat(64),
  validatorVersion: "host-file-exists/v1",
  checkedAt: 1000
}
for (const result of ["passed", "failed", "blocked", "unknown"] as const) {
  const actual = parseHostReceipt({ ...receipt, result })
  assert.equal(
    foundationFailedOperationOnly({ status: "failed", receipts: [actual] }),
    result !== "passed"
  )
  assert.equal(foundationFailedOperationOnly({ status: "succeeded", receipts: [actual] }), false)
}
assert.equal(foundationFailedOperationOnly({ status: "started", receipts: [] }), false)
checks.push(
  "Original receipt parser distinguishes passed credentials from retained failed/blocked/unknown evidence"
)
for (const mode of ["remove-context", "check-error", "check-cancel"] as const) {
  const zip = foundationFaultProject("C:/owned-fixture-workspace", action, mode)
  const envelope = JSON.parse(zip.readAsText("devclaw.project-runtime.json"))
  const runtime = parseProjectRuntimeManifest(envelope)
  const contract = projectRuntimeExtensionContract(envelope)
  assert(contract)
  assert(contract.requires.includes(CONTEXT_HANDOFF_PROTOCOL))
  assert.equal(contract.context?.knowledge.required, true)
  assert(runtime.stages.every((stage) => zip.getEntry(stage.skill)))
  assert(
    runtime.stages.every((stage) => /\ndescription: [^\n]+\n/.test(zip.readAsText(stage.skill)))
  )
  const registered = ts.transpileModule(zip.readAsText("mods/register.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true
  })
  assert.equal(registered.diagnostics?.length, 0)
  if (mode === "remove-context") assert(zip.readAsText("mods/register.ts").includes("sections:[]"))
  else {
    const declared = parsePluginCapabilities(
      JSON.parse(zip.readAsText("devclaw.capabilities.json"))
    )
    assert.deepEqual(declared?.capabilities[0].requiredHooks, ["native-check"])
    const hook = JSON.parse(zip.readAsText("hooks/hooks.json"))[0]
    assert.equal(hook.id, "native-check")
    assert.equal(hook.matcher, "read_file")
    assert.equal(hook.shell, "bash")
    assert(hook.command.startsWith("exec python -I -B -X utf8"))
    const source = zip.readAsText("checks/check.py")
    const parsed = spawnSync(
      "python",
      ["-I", "-B", "-X", "utf8", "-c", "import ast,sys;ast.parse(sys.stdin.read())"],
      {
        input: source,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000
      }
    )
    assert.equal(parsed.status, 0, String(parsed.error ?? parsed.stderr))
    if (mode === "check-cancel") {
      assert(source.includes('workspace=payload["workspace"]'))
      assert(!source.includes('os.path.join(payload["cwd"]'))
      assert(source.includes('"naturalExitAfterMs":30000'))
      assert(source.includes('"native-check-natural-exit.json"'))
      assert(source.indexOf("time.sleep(30)") < source.indexOf('"native-check-natural-exit.json"'))
    }
  }
  checks.push(`Valid original context/action contract and syntax: ${mode}`)
}
for (const kind of ["missing", "unsupported"] as const) {
  const { zip } = foundationInvalidContract("C:/owned-fixture-workspace", kind)
  assert.throws(() =>
    parseProjectRuntimeManifest(JSON.parse(zip.readAsText("devclaw.project-runtime.json")))
  )
  checks.push(`Negative installer candidate deliberately rejected by original parser: ${kind}`)
}
assert.equal(foundationContextProvider().getEntry("mods/register.ts")?.isDirectory, false)
assert.equal(
  foundationFunctionPackage("planning", "export function register() {}").getEntries().length,
  3
)
const nativeNotice = { type: "hook_executed", systemMessage: "Original conflict /file_path" }
assert.deepEqual(
  foundationNativeHookNotices([
    { type: "custom", data: nativeNotice },
    nativeNotice,
    { type: "text", data: nativeNotice },
    { type: "custom", data: null }
  ]),
  [nativeNotice]
)
checks.push(
  "Original custom Hook envelope is unwrapped; assistant text and unrelated events are excluded"
)
console.log(
  JSON.stringify({ passed: true, layer: "fixture-preflight-not-packaged-acceptance", checks })
)
