import AdmZip from "adm-zip"
import { RequiredPromptContextError } from "../../src/main/agent/required-prompt-context"
import type { HostProjectOperation } from "../../src/shared/project-runtime/host-types"
import type { ClawActionDescriptor } from "../../src/shared/mods/claw-actions"
import { hostProjectFixture } from "../../src/main/harness-board/project-runtime/host-fixtures.test-helper"
import { createProjectActionBinding } from "../../src/main/harness-board/project-runtime/action-input"
import {
  CONTEXT_HANDOFF_PROTOCOL,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL,
  wrapProjectRuntimeManifest
} from "../../src/shared/project-runtime"

export const FAULT_CONTEXT =
  "FOUNDATION_REQUIRED_KNOWLEDGE: preserve invoice approval and source ownership."
export const FAULT_PROMPT_HOOK_POLICY =
  "FOUNDATION_EARLY_CREATOR_POLICY_V1: allow this original native prompt unchanged."
export const FAULT_PROMPT_HOOK_SKILL = "foundation-prompt-probe"

/** Only the original prompt-Hook JSON payload can select the fixture's Hook response. */
export function foundationPromptHookPayload(body: Record<string, unknown>, prompt: string) {
  if (!Array.isArray(body.messages) || body.messages.length !== 2) return undefined
  const [system, user] = body.messages as Array<Record<string, unknown>>
  if (system?.role !== "system" || user?.role !== "user" || typeof user.content !== "string")
    return undefined
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(user.content)
  } catch {
    return undefined
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.hook_event_name !== "UserPromptSubmit" ||
    payload.policy !== FAULT_PROMPT_HOOK_POLICY ||
    payload.prompt !== prompt ||
    !payload.tool_args ||
    typeof payload.tool_args !== "object" ||
    Array.isArray(payload.tool_args)
  )
    return undefined
  const args = payload.tool_args as Record<string, unknown>
  return args.message === prompt && args.rawMessage === prompt ? payload : undefined
}

/** Minimal normal Skill supplies the original plugin Hook activation scope, no Function/runtime. */
export function foundationEarlyPromptHookPackage() {
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(
      JSON.stringify({
        name: "foundation-early-prompt-hook",
        version: "1.0.0",
        skills: "skills",
        hooks: "hooks/hooks.json"
      })
    )
  )
  zip.addFile(
    `skills/${FAULT_PROMPT_HOOK_SKILL}/SKILL.md`,
    Buffer.from(
      `---\nname: ${FAULT_PROMPT_HOOK_SKILL}\ndescription: Answer this original user request without tools\n---\nAnswer the user's original request directly. Do not call tools.\n`
    )
  )
  zip.addFile(
    "hooks/hooks.json",
    Buffer.from(
      JSON.stringify([
        {
          id: "early-creator-prompt",
          enabled: true,
          event: "UserPromptSubmit",
          type: "prompt",
          prompt: FAULT_PROMPT_HOOK_POLICY,
          model: "custom:foundation-b"
        }
      ])
    )
  )
  return zip
}
export type FaultProjectMode = "remove-context" | "check-error" | "check-cancel"

/** Original Agent logger serializes name/message/stack, not the inner MiddlewareError cause code. */
export function foundationRequiredContextRejection(stderr: string) {
  const expected = new RequiredPromptContextError()
  const blocks = stderr.match(/\[Agent\] Error: \{[\s\S]*?\r?\n\}/g) ?? []
  return blocks.some((block) => {
    const name = /^\s*name: '([^']*)',?\s*$/m.exec(block)?.[1]
    const message = /^\s*message: '([^']*)',?\s*$/m.exec(block)?.[1]
    return name === expected.name && message === expected.message
  })
}

/** Failed/blocked/unknown receipts preserve evidence; only `passed` is a success credential. */
export function foundationFailedOperationOnly(
  operation: Pick<HostProjectOperation, "status" | "receipts">
) {
  return (
    ["failed", "cancelled", "unknown"].includes(operation.status) &&
    operation.receipts.every((receipt) => receipt.result !== "passed")
  )
}

/** Original result-callback emits a custom stream event; invoke does not unwrap it. */
export function foundationNativeHookNotices(events: unknown[]) {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return []
    const wrapper = event as Record<string, unknown>
    if (
      wrapper.type !== "custom" ||
      !wrapper.data ||
      typeof wrapper.data !== "object" ||
      Array.isArray(wrapper.data)
    )
      return []
    const data = wrapper.data as Record<string, unknown>
    return data.type === "hook_executed" ? [data] : []
  })
}

export function foundationFunctionPackage(name: string, source: string) {
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name, version: "1.0.0", mods: "mods/manifest.json" }))
  )
  zip.addFile(
    "mods/manifest.json",
    Buffer.from(JSON.stringify({ apiVersion: "cmb.mods/v2", id: name, entry: "register.ts" }))
  )
  zip.addFile("mods/register.ts", Buffer.from(source))
  return zip
}

export function foundationContextProvider() {
  const zip = foundationFunctionPackage(
    "foundation-fault-context",
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"foundation-context",description:"Read actual fixture knowledge",immediate:true});return next(e)});
    on("command.run",{command:"foundation-context"},async($)=>({text:await $.fs.read("knowledge.txt")}))
  }`
  )
  const metadata = JSON.parse(zip.readAsText("plugin.json"))
  metadata.claw = {
    actions: [
      {
        id: "context",
        name: "Actual fixture knowledge",
        command: "foundation-context",
        inputSchema: { type: "object", additionalProperties: false }
      }
    ]
  }
  zip.updateFile("plugin.json", Buffer.from(JSON.stringify(metadata)))
  return zip
}

export function foundationFaultProject(
  workspace: string,
  context: ClawActionDescriptor,
  mode: FaultProjectMode
) {
  const name = `foundation-${mode}`
  const zip = foundationFunctionPackage(
    name,
    mode === "remove-context"
      ? 'export function register(on){on("prompt.compose",async()=>({sections:[]}))}'
      : "export function register() { /* Native required command owns the check. */ }"
  )
  const metadata = JSON.parse(zip.readAsText("plugin.json"))
  metadata.skills = "skills"
  zip.updateFile("plugin.json", Buffer.from(JSON.stringify(metadata)))
  const manifest = hostProjectFixture(workspace).manifest
  manifest.plugin = { id: name, version: "1.0.0" }
  manifest.stages = [{ ...manifest.stages[0], approval: "none" }]
  const binding = createProjectActionBinding("required-vocabulary", context, {})
  manifest.actions = [{ id: binding.id, ref: binding.ref }]
  zip.addFile(
    "devclaw.project-actions.lock.json",
    Buffer.from(
      JSON.stringify({
        apiVersion: "devclaw.project-actions-lock/v1",
        bindings: [binding]
      })
    )
  )
  zip.addFile(
    "devclaw.project-runtime.json",
    Buffer.from(
      JSON.stringify(
        wrapProjectRuntimeManifest(manifest, {
          apiVersion: "devclaw.extension-contract/v1",
          requires: [CONTEXT_HANDOFF_PROTOCOL, REQUIRED_BUSINESS_CHECKS_PROTOCOL],
          context: {
            sourceAccess: "read-only",
            mutableData: "host",
            configuration: "host-resolved",
            knowledge: { required: true },
            provider: { actionId: binding.id, operations: ["session-context"] }
          }
        })
      )
    )
  )
  zip.addFile(
    "skills/draft/SKILL.md",
    Buffer.from(
      "---\nname: foundation-fault-skill\ndescription: Exercise original native fault gates with actual knowledge.\n---\nRead this original Skill with read_file. Do not write an artifact or claim a check passed.\n"
    )
  )
  if (mode !== "remove-context") {
    zip.addFile(
      "devclaw.capabilities.json",
      Buffer.from(
        JSON.stringify({
          apiVersion: "devclaw.capabilities/v1",
          capabilities: [
            {
              id: "project",
              title: "Required native fault check",
              kind: "flow",
              usage: "project",
              entry: "devclaw.project-runtime.json",
              requiredHooks: ["native-check"]
            }
          ]
        })
      )
    )
    zip.addFile(
      "hooks/hooks.json",
      Buffer.from(
        JSON.stringify([
          {
            id: "native-check",
            event: "PreToolUse",
            matcher: "read_file",
            type: "command",
            shell: "bash",
            timeout: mode === "check-cancel" ? 3000 : 5000,
            command: 'exec python -I -B -X utf8 "${PLUGIN_ROOT}/checks/check.py"',
            onBlock: { reason: "Required original check did not pass" }
          }
        ])
      )
    )
    zip.addFile(
      "checks/check.py",
      Buffer.from(
        mode === "check-error"
          ? 'raise RuntimeError("FOUNDATION_REQUIRED_CHECK_EXCEPTION")\n'
          : 'import json, os, sys, time\npayload=json.load(sys.stdin)\nworkspace=payload["workspace"]\nstarted_at_ms=int(time.time()*1000)\nwith open(os.path.join(workspace,"native-check-pid.json"),"w",encoding="utf-8") as stream:\n json.dump({"pid":os.getpid(),"cwd":os.getcwd(),"workspace":workspace,"startedAt":started_at_ms,"naturalExitAfterMs":30000},stream)\n stream.flush()\ntime.sleep(30)\nwith open(os.path.join(workspace,"native-check-natural-exit.json"),"w",encoding="utf-8") as stream:\n json.dump({"pid":os.getpid(),"startedAt":started_at_ms,"naturalExitAt":int(time.time()*1000)},stream)\nraise RuntimeError("CANCELLED_CHECK_MUST_NOT_FINISH_NORMALLY")\n'
      )
    )
  }
  return zip
}

/** Deliberately unvalidated candidates: only the real installer may reject them. */
export function foundationInvalidContract(workspace: string, kind: "missing" | "unsupported") {
  const name = `foundation-contract-${kind}`
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name, version: "1.0.0", skills: "skills" }))
  )
  const runtime = hostProjectFixture(workspace).manifest
  runtime.plugin = { id: name, version: "1.0.0" }
  zip.addFile(
    "devclaw.project-runtime.json",
    Buffer.from(
      JSON.stringify({
        apiVersion: "devclaw.project-runtime/v2",
        runtime,
        ...(kind === "unsupported"
          ? {
              extensionContract: {
                apiVersion: "devclaw.extension-contract/v1",
                requires: ["devclaw.not-implemented/v99"]
              }
            }
          : {})
      })
    )
  )
  for (const stage of runtime.stages)
    zip.addFile(
      stage.skill,
      Buffer.from(
        "---\nname: invalid-contract\ndescription: A valid Skill in an intentionally incompatible package.\n---\nMust never execute.\n"
      )
    )
  return { name, zip }
}
