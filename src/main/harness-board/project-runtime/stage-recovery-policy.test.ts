import { afterEach, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { HookConfig } from "../../hooks/types"
import { assertStageRecoveryHookSupported, readStageRecoveryPolicy } from "./stage-recovery-policy"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stage-recovery-policy-"))
  roots.push(root)
  mkdirSync(join(root, "hooks"))
  const hook: HookConfig = {
    id: "required",
    event: "PostSkillUse",
    enabled: true,
    type: "prompt",
    prompt: "Verify the actual stage result",
    fallback: "block",
    hookSourceType: "plugin",
    hookSourceRoot: root,
    hookSourcePath: join(root, "hooks/hooks.json"),
    createdAt: "",
    updatedAt: "",
    ...{ pluginRoot: root }
  }
  const put = (value: unknown) =>
    writeFileSync(
      join(root, "devclaw.stage-recovery.json"),
      typeof value === "string" ? value : JSON.stringify(value)
    )
  return { root, hook, put }
}

it("negotiates exact requested profiles without granting execution", () => {
  const f = fixture()
  expect(readStageRecoveryPolicy(f.root)).toBeUndefined()
  for (const [hookExecution, externalEffects] of [
    ["prompt-only", "deny"],
    ["windows-sandbox", "network-requires-confirmation"]
  ]) {
    const value = { apiVersion: "devclaw.stage-recovery/v1", hookExecution, externalEffects }
    f.put(value)
    expect(readStageRecoveryPolicy(f.root)).toEqual(value)
  }
})

it("accepts only the pinned text context protocol and bounded known argv placeholders", () => {
  const f = fixture()
  const policy = {
    apiVersion: "devclaw.stage-recovery/v1",
    hookExecution: "windows-sandbox",
    externalEffects: "network-requires-confirmation",
    contextProvider: {
      protocol: "devclaw.context-text/v1",
      args: ["--workspace", "${workspace}", "${stageId}", "${goal}"]
    }
  }
  f.put(policy)
  expect(readStageRecoveryPolicy(f.root)).toEqual(policy)
  for (const contextProvider of [
    { protocol: "unknown", args: [] },
    { protocol: "devclaw.context-text/v1", args: ["${secret}"] },
    { protocol: "devclaw.context-text/v1", args: [], executable: "unreviewed.exe" }
  ]) {
    f.put({ ...policy, contextProvider })
    expect(() => readStageRecoveryPolicy(f.root)).toThrow("RECOVERY_DECLARATION_INVALID")
  }
  f.put({ ...policy, hookExecution: "prompt-only", externalEffects: "deny" })
  expect(() => readStageRecoveryPolicy(f.root)).toThrow("RECOVERY_DECLARATION_INVALID")
})

it.each([
  {
    apiVersion: "devclaw.stage-recovery/v1",
    hookExecution: "windows-sandbox",
    externalEffects: "deny"
  },
  {
    apiVersion: "devclaw.stage-recovery/v1",
    hookExecution: "prompt-only",
    externalEffects: "deny",
    grant: true
  },
  '{"credential":"PRIVATE_INPUT"'
])("rejects an unsupported or malformed profile without exposing values", (value) => {
  const f = fixture()
  f.put(value)
  expect(() => readStageRecoveryPolicy(f.root)).toThrow(
    "PROJECT_STAGE_DEBUG_RECOVERY_DECLARATION_INVALID"
  )
  try {
    readStageRecoveryPolicy(f.root)
  } catch (error) {
    expect(String(error)).not.toContain("PRIVATE_INPUT")
  }
})

it("requires a native profile and exact retained Hook scope", () => {
  const f = fixture(),
    policy = { snapshotRoot: f.root, allowPromptHooks: true }
  expect(() => assertStageRecoveryHookSupported(policy, f.hook)).not.toThrow()
  expect(() => assertStageRecoveryHookSupported({ snapshotRoot: f.root }, f.hook)).toThrow(
    "HOOK_UNSUPPORTED"
  )
  for (const replacement of [
    { hookSourceType: "global" },
    { hookSourceType: "workspace" },
    { hookSourcePath: join(f.root, "../outside.json") },
    { pluginRoot: join(f.root, "another") }
  ])
    expect(() =>
      assertStageRecoveryHookSupported(policy, { ...f.hook, ...replacement } as HookConfig)
    ).toThrow("HOOK_SOURCE_UNSUPPORTED")
})

it.each([
  { async: true },
  { fallback: "allow" },
  { injectUserContext: true },
  { type: "http", url: "https://invalid.example" },
  { command: "arbitrary command" }
])("refuses behavior outside the original synchronous model gate: %j", (replacement) => {
  const f = fixture()
  expect(() =>
    assertStageRecoveryHookSupported({ snapshotRoot: f.root, allowPromptHooks: true }, {
      ...f.hook,
      ...replacement
    } as HookConfig)
  ).toThrow(/PROJECT_STAGE_DEBUG_HOOK_(?:PROFILE_)?UNSUPPORTED/)
})

it("requires a separate native network consent for restricted command Hooks", () => {
  const f = fixture(),
    hook = {
      ...f.hook,
      type: "command",
      prompt: undefined,
      command: "python validator.py"
    } as HookConfig
  expect(() =>
    assertStageRecoveryHookSupported({ snapshotRoot: f.root, allowPromptHooks: true }, hook)
  ).toThrow("HOOK_UNSUPPORTED")
  const policy = {
    snapshotRoot: f.root,
    commandHooks: {
      readOnlyRoots: [f.root],
      networkAccess: "explicitly-approved" as const
    }
  }
  expect(() => assertStageRecoveryHookSupported(policy, hook)).not.toThrow()
  expect(() => assertStageRecoveryHookSupported(policy, { ...hook, shell: "bash" })).toThrow(
    "HOOK_PROFILE_UNSUPPORTED"
  )
  expect(() => assertStageRecoveryHookSupported(policy, { ...hook, async: true })).toThrow(
    "HOOK_PROFILE_UNSUPPORTED"
  )
})
