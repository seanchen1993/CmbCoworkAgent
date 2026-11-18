import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"
import { isSameWorkspacePath } from "../../shared/workspace-path"
import { LEGACY_PROJECT_SESSION_SCOPE } from "../harness-board/project-runtime/legacy-entry-gate"
import type { LegacyRuntimeDependencies } from "../harness-board/project-runtime/legacy-runtime-service"

type CaptureWorkspace = NonNullable<LegacyRuntimeDependencies["captureExecutionWorkspace"]>
type ManagedLookup = {
  corrupt?: boolean
  snapshot?: { workspacePath: string; currentSession?: { threadId: string } }
}

const source = ts.createSourceFile(
  "project-runtime-legacy.ts",
  readFileSync(new URL("./project-runtime-legacy.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ES2022,
  true
)
const callbacks: ts.Expression[] = []
function visit(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === "captureExecutionWorkspace")
    callbacks.push(node.initializer)
  ts.forEachChild(node, visit)
}
visit(source)
if (callbacks.length !== 1) throw Error("Expected one production legacy workspace callback")
const code = ts.transpileModule(`(${callbacks[0].getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

const scope = { projectId: "project", featureId: "feature", runId: "mr_workspace_fixture" }
const featureWorkspace = "C:/feature-repository"
const managedWorkspace = "C:/managed-repository"
const rejected = "LEGACY_EXECUTION_WORKSPACE_NOT_REGISTERED"

function fixture(run: ManagedLookup = {}) {
  const getRun = vi.fn<() => ManagedLookup>(() => run)
  const readFeature = vi.fn(() => featureWorkspace)
  const assertKnowledge = vi.fn()
  const captureKnowledge = vi.fn(async () => assertKnowledge)
  const capture = runInNewContext(code, {
    isSameWorkspacePath,
    LEGACY_PROJECT_SESSION_SCOPE,
    managedRunStore: { getRun },
    requireHarnessFeatureWorkspace: async () => featureWorkspace,
    getHarnessCapabilityFeatureWorkspace: readFeature,
    captureHarnessKnowledgeDepositionWorkspace: captureKnowledge
  }) as CaptureWorkspace
  return { capture, getRun, readFeature, captureKnowledge, assertKnowledge }
}

it.each([
  ["missing", {}],
  ["corrupt", { corrupt: true, snapshot: { workspacePath: featureWorkspace } }],
  ["different workspace", { snapshot: { workspacePath: managedWorkspace } }]
] satisfies Array<[string, ManagedLookup]>)(
  "rejects an independent managed Skill preflight with %s run evidence even at the Feature path",
  async (_reason, run) => {
    const f = fixture(run)
    await expect(f.capture(undefined, scope, featureWorkspace, undefined)).rejects.toThrow(rejected)
    expect(f.getRun).toHaveBeenCalledExactlyOnceWith(scope)
  }
)

it("admits the durable managed workspace before session creation and rechecks it after preparation", async () => {
  const f = fixture({ snapshot: { workspacePath: featureWorkspace } })
  const assertCurrent = await f.capture(undefined, scope, featureWorkspace, undefined)
  expect(f.getRun).toHaveBeenCalledExactlyOnceWith(scope)
  f.getRun.mockReturnValue({ snapshot: { workspacePath: managedWorkspace } })
  expect(assertCurrent).toThrow(rejected)
})

it("checks an existing session or the exact main-process proof for a new managed session", async () => {
  const f = fixture({ snapshot: { workspacePath: managedWorkspace, currentSession: { threadId: "old" } } })
  const previous = await f.capture("old", scope, managedWorkspace, undefined)
  expect(previous).not.toThrow()
  await expect(f.capture("new", scope, managedWorkspace, undefined)).rejects.toThrow(rejected)
  const proof = { ...scope, threadId: "new", workspace: managedWorkspace }
  for (const changedProof of [
    { ...proof, threadId: "foreign" },
    { ...proof, projectId: "foreign" },
    { ...proof, featureId: "foreign" },
    { ...proof, runId: "mr_foreign" },
    { ...proof, workspace: featureWorkspace }
  ]) {
    await expect(f.capture("new", scope, managedWorkspace, changedProof)).rejects.toThrow(rejected)
  }
  const fresh = await f.capture("new", scope, managedWorkspace, proof)
  expect(fresh).not.toThrow()
  f.getRun.mockReturnValue({ snapshot: { workspacePath: featureWorkspace } })
  expect(fresh).toThrow(rejected)
})

it("preserves the Feature workspace without a managed scope and rechecks its original configuration", async () => {
  const f = fixture()
  const feature = { projectId: scope.projectId, featureId: scope.featureId }
  const assertCurrent = await f.capture(undefined, feature, featureWorkspace, undefined)
  expect(assertCurrent).not.toThrow()
  expect(f.getRun).not.toHaveBeenCalled()
  f.readFeature.mockReturnValue(managedWorkspace)
  expect(assertCurrent).toThrow(rejected)
})

it("uses the original knowledge authority for a knowledge deposition session only", async () => {
  const f = fixture()
  const projectSession = { projectId: scope.projectId, featureId: LEGACY_PROJECT_SESSION_SCOPE }
  await expect(f.capture("knowledge", projectSession, managedWorkspace, undefined))
    .rejects.toThrow(rejected)
  expect(f.captureKnowledge).not.toHaveBeenCalled()
  const assertCurrent = await f.capture("knowledge", {
    ...projectSession,
    projectSessionKind: "system-constraints-update"
  }, managedWorkspace, undefined)
  expect(f.captureKnowledge).toHaveBeenCalledExactlyOnceWith(scope.projectId, managedWorkspace)
  expect(assertCurrent).toBe(f.assertKnowledge)
  expect(f.getRun).not.toHaveBeenCalled()
})
