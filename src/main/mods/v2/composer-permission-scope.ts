import { LocalSandbox } from "../../agent/local-sandbox"
import { captureWindowsSandboxModeData, getWindowsSandboxMode } from "../../storage"
import { types } from "node:util"
import { ModError } from "../errors"
import type { FunctionFileScope } from "./file-access"
import { createClawSkillPolicy } from "../claw-skills"
import { SkillLifecycleRegistry } from "../../agent/skill-lifecycle/registry"

const permissionScopeData = new WeakMap<object, () => void>()
const permissionWeakGet = WeakMap.prototype.get, permissionWeakSet = WeakMap.prototype.set
const permissionSignalThrow = AbortSignal.prototype.throwIfAborted
const permissionCaptureMode = captureWindowsSandboxModeData

/** Only the real returned permission probe owns this data tail; structural copies cannot mint it. */
export function readComposerPermissionScopeData(scope: unknown): (() => void) | undefined {
  if (!scope || typeof scope !== "object" || types.isProxy(scope)) return undefined
  const reader: (() => void) | undefined = Reflect.apply(permissionWeakGet, permissionScopeData, [scope])
  if (reader) reader()
  return reader
}

/** Inert permission context for admission; it creates no sandbox tools or writable backend. */
export async function createComposerPermissionScope(
  workspace: string,
  threadId: string,
  assertOwner: () => void,
  signal: AbortSignal,
  skills?: Parameters<typeof createClawSkillPolicy>[0]
): Promise<FunctionFileScope> {
  const windowsSandbox = process.platform === "win32" ? getWindowsSandboxMode() : "none"
  const modeData = process.platform === "win32" ? permissionCaptureMode() : undefined
  if (modeData && modeData.mode !== windowsSandbox) throw new ModError("MODS_CALL_SCOPE_CHANGED")
  const assertLive = () => {
    signal.throwIfAborted()
    assertOwner()
    if (process.platform === "win32" && getWindowsSandboxMode() !== windowsSandbox)
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
  }
  assertLive()
  const policy = await createClawSkillPolicy(skills)
  assertLive()
  const query = LocalSandbox.createPermissionProbe({
    rootDir: workspace,
    runId: threadId,
    virtualMode: false,
    windowsSandbox,
    abortSignal: signal,
    clawSkillPolicy: policy,
    skillLifecycleRegistry: policy ? new SkillLifecycleRegistry(policy.lifecycleSources) : undefined
  })
  const scope: FunctionFileScope = {
    workspace,
    assertLive,
    queryTool: async (id, input) => {
      assertLive()
      const tool = id.replace(/^host:/, "")
      if (!["read_file", "ls", "glob", "grep"].includes(tool))
        return { decision: "deny", reason: "MODS_RUNTIME_TOOL_DENIED" }
      const result = await query(tool, input)
      assertLive()
      return result
    }
  }
  const prototype = Object.getPrototypeOf(scope)
  const fields = Object.getOwnPropertyDescriptors(scope)
  const keys = ["workspace", "assertLive", "queryTool"] as const
  let failed = false
  const assertDataCurrent = () => {
    if (failed) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    try {
      if (types.isProxy(scope) || Object.getPrototypeOf(scope) !== prototype ||
        Reflect.ownKeys(scope).length !== keys.length) throw new ModError("MODS_CALL_SCOPE_CHANGED")
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index], expected = fields[key], current = Object.getOwnPropertyDescriptor(scope, key)
        if (!current || !("value" in current) || current.value !== expected.value ||
          current.enumerable !== expected.enumerable || current.writable !== expected.writable ||
          current.configurable !== expected.configurable) throw new ModError("MODS_CALL_SCOPE_CHANGED")
      }
      Reflect.apply(permissionSignalThrow, signal, [])
      modeData?.assertDataCurrent()
    } catch (error) { failed = true; throw error }
  }
  Reflect.apply(permissionWeakSet, permissionScopeData, [scope, assertDataCurrent])
  assertDataCurrent()
  return scope
}
