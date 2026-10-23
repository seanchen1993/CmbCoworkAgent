import { expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModError } from "../../mods/errors"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { HookProcessCleanupError } from "../../hooks/owned-process-error"
import type { HookScopeController } from "../../hooks/scope"
import { createSkillUseTracker } from "./tracker"
import { runPostSkillUseHooksForActivatedSkills } from "./completion-hooks"
import { throwIfSkillHookHostFailure } from "./host-failure"
import { RetainedPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import type { PluginMetadata } from "../../types"

vi.mock("../../hooks/required-skill", () => ({ runHooksEnriched: vi.fn() }))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))

function fixture() {
  const controller = new AbortController()
  const tracker = createSkillUseTracker()
  tracker.recordSkillUse(
    { name: "review", path: "/plugin/review/SKILL.md", rootDir: "/plugin/review" },
    { trigger: "explicit", triggerToolName: "explicit_skill" }
  )
  return {
    controller,
    tracker,
    input: {
      threadId: "thread",
      workspacePath: "/workspace",
      signal: controller.signal,
      getStopContext: () => ({}),
      hookScope: {} as HookScopeController,
      skillUseTracker: tracker,
      resolveHooks: () => []
    }
  }
}

it.each([
  new ModFunctionError("MODS_CALL_SCOPE_CHANGED"),
  new ModError("MODS_DISABLED"),
  new Error("HOOK_SESSION_CHANGED"),
  new HookProcessCleanupError()
])("does not swallow a native PostSkillUse boundary failure: %s", async (error) => {
  const f = fixture()
  await expect(
    runPostSkillUseHooksForActivatedSkills({
      ...f.input,
      executeHooks: async () => {
        throw error
      }
    })
  ).rejects.toBe(error)
  expect(f.tracker.getPendingPostSkillUses()).toHaveLength(1)
})

it("keeps an aborted PostSkillUse pending and never treats it as an optional guest failure", async () => {
  const f = fixture()
  const reason = new Error("native turn cancelled")
  await expect(
    runPostSkillUseHooksForActivatedSkills({
      ...f.input,
      executeHooks: async () => {
        f.controller.abort(reason)
        throw new Error("late result")
      }
    })
  ).rejects.toBe(reason)
  expect(f.tracker.getPendingPostSkillUses()).toHaveLength(1)
})

it("rejects a late successful observation after cancellation without consuming the pending Skill", async () => {
  const f = fixture()
  const reason = new Error("cancelled while native hook completed")
  await expect(
    runPostSkillUseHooksForActivatedSkills({
      ...f.input,
      executeHooks: async () => {
        f.controller.abort(reason)
        return null
      }
    })
  ).rejects.toBe(reason)
  expect(f.tracker.getPendingPostSkillUses()).toHaveLength(1)
})

it("retains ordinary optional PostSkillUse recovery and marks that observation exactly once", async () => {
  const f = fixture()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    expect(
      await runPostSkillUseHooksForActivatedSkills({
        ...f.input,
        executeHooks: async () => {
          throw new Error("optional observer failed")
        }
      })
    ).toBeNull()
    expect(f.tracker.getPendingPostSkillUses()).toHaveLength(0)
    expect(warn).toHaveBeenCalledOnce()
  } finally {
    warn.mockRestore()
  }
})

it("recognizes owned cleanup failures inside native cause chains without classifying plain guest text", () => {
  const owned = new HookProcessCleanupError()
  expect(() => throwIfSkillHookHostFailure(new Error("wrapper", { cause: owned }))).toThrow(owned)
  expect(() => throwIfSkillHookHostFailure(new Error("MODS_CALL_SCOPE_CHANGED"))).not.toThrow()
})

it("rechecks the real retained source guard before recovering an ordinary PostSkillUse error", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-hook-source-"))
  try {
    const installed = join(root, "installed")
    mkdirSync(installed)
    writeFileSync(join(installed, "plugin.json"), '{"name":"review","version":"1.0.0"}')
    writeFileSync(join(installed, "SKILL.md"), "original business instructions")
    const snapshots = new RetainedPackageSnapshots(join(root, "snapshots"))
    const snapshot = snapshots.capture(installed)
    const token = issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        threadId: "thread",
        incarnationKey: "incarnation",
        projectId: "project",
        operationId: "operation",
        workspace: root,
        packageDigest: snapshot.digest,
        stageId: "review",
        plugin: {
          id: "installed-review",
          name: "review",
          path: snapshot.root,
          enabled: true
        } as PluginMetadata
      },
      snapshots.captureGuard(snapshot.digest)
    )
    const f = fixture()
    await expect(
      withRuntimePluginSource(token, () =>
        runPostSkillUseHooksForActivatedSkills({
          ...f.input,
          workspacePath: root,
          executeHooks: async () => {
            writeFileSync(join(snapshot.root, "SKILL.md"), "replaced after activation")
            throw new Error("optional callback failed after source changed")
          }
        })
      )
    ).rejects.toThrow(/PROJECT_.*CHANGED/)
    expect(f.tracker.getPendingPostSkillUses()).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
