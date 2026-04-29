import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const modelsSource = readFileSync(new URL("../src/main/ipc/models.ts", import.meta.url), "utf8")
const localSandboxSource = readFileSync(new URL("../src/main/agent/local-sandbox.ts", import.meta.url), "utf8")
const sandboxSource = readFileSync(new URL("../src/main/ipc/sandbox.ts", import.meta.url), "utf8")

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start) : -1
  return source.slice(start, end === -1 ? undefined : end)
}

test("workspace:set validates elevated sandbox before committing global workspace", () => {
  const section = sectionBetween(modelsSource, '"workspace:set"', 'ipcMain.handle("workspace:select"')
  const awaitIndex = section.indexOf('const ready = await prepareWorkspaceSelectionSandbox(newPath, parentWindow)')
  const commitIndex = section.indexOf('store.set("workspacePath", newPath)')

  assert.ok(awaitIndex !== -1, "workspace:set should await sandbox preparation for global path changes")
  assert.ok(commitIndex !== -1, "workspace:set should still persist the workspace on success")
  assert.ok(awaitIndex < commitIndex, "global workspace should only be persisted after sandbox validation succeeds")
})

test("workspace:set validates elevated sandbox before updating thread metadata", () => {
  const section = sectionBetween(modelsSource, '"workspace:set"', 'ipcMain.handle("workspace:select"')
  const awaitIndex = section.indexOf('const ready = await prepareWorkspaceSelectionSandbox(newPath, parentWindow)')
  const metadataIndex = section.indexOf('metadata.workspacePath = newPath')

  assert.ok(awaitIndex !== -1, "workspace:set should await sandbox preparation before thread update")
  assert.ok(metadataIndex !== -1, "workspace:set should still update thread metadata on success")
  assert.ok(awaitIndex < metadataIndex, "thread metadata should only change after sandbox validation succeeds")
})

test("workspace:select validates elevated sandbox before committing selected workspace", () => {
  const section = sectionBetween(modelsSource, 'ipcMain.handle("workspace:select"', 'ipcMain.handle("workspace:loadFromDisk"')
  const awaitIndex = section.indexOf('const ready = await prepareWorkspaceSelectionSandbox(selectedPath, parentWindow)')
  const metadataIndex = section.indexOf('metadata.workspacePath = selectedPath')
  const storeIndex = section.indexOf('store.set("workspacePath", selectedPath)')

  assert.ok(awaitIndex !== -1, "workspace:select should await sandbox preparation")
  assert.ok(metadataIndex !== -1, "workspace:select should still update thread metadata on success")
  assert.ok(storeIndex !== -1, "workspace:select should still persist the recent workspace on success")
  assert.ok(awaitIndex < metadataIndex, "selected workspace must be validated before thread metadata changes")
  assert.ok(awaitIndex < storeIndex, "selected workspace must be validated before recent-workspace persistence")
})

test("workspace switch preparation still supports explicit setup/UAC for hard failures", () => {
  const section = sectionBetween(
    localSandboxSource,
    "static async prepareWorkspaceForSelection(",
    "private static buildElevatedSandboxEnvPreamble("
  )

  assert.match(
    section,
    /const preflight = await LocalSandbox\.ensureElevatedWorkspaceSetup\([\s\S]*?false[\s\S]*?const promptedSetup = await LocalSandbox\.ensureElevatedWorkspaceSetup\([\s\S]*?true/,
    "workspace switch preparation should first try no-UAC preflight, then escalate via explicit setup for hard failures"
  )
  assert.match(
    localSandboxSource,
    /private static shouldPromptForWorkspaceSwitchSetup\(error\?: string\): boolean/,
    "hard-failure prompting policy should stay explicit and reviewable"
  )
})

test("elevated workspace root validation is shared before ACL/setup work", () => {
  const prewarmSection = sectionBetween(
    localSandboxSource,
    "static prewarmForWorkspace(",
    "static prewarmForWorkspaces("
  )
  const selectionSection = sectionBetween(
    localSandboxSource,
    "static async prepareWorkspaceForSelection(",
    "private static buildElevatedSandboxEnvPreamble("
  )
  const setupSection = sectionBetween(
    sandboxSource,
    "export async function runElevatedSetupForPaths(",
    "export function isElevatedRootPrepared("
  )
  const ensureSection = sectionBetween(
    localSandboxSource,
    "private static async ensureElevatedWorkspaceSetup(",
    "private static createAbortError()"
  )

  assert.match(
    sandboxSource,
    /export function validateElevatedWorkspaceRoot\(workspacePath: string\)/,
    "sandbox IPC should expose one shared elevated workspace validator"
  )
  assert.match(
    prewarmSection,
    /validateElevatedWorkspaceRoot\(workspacePath\)/,
    "elevated prewarm should skip invalid workspace roots before ACL work"
  )
  assert.ok(
    prewarmSection.indexOf("LocalSandbox.resolveWindowsSandboxShell()") <
      prewarmSection.indexOf("validateElevatedWorkspaceRoot(workspacePath)"),
    "workspace-independent shell prewarm should still run before elevated workspace validation can return"
  )
  assert.ok(
    prewarmSection.indexOf("LocalSandbox.resolvePythonDir()") <
      prewarmSection.indexOf("validateElevatedWorkspaceRoot(workspacePath)"),
    "workspace-independent Python prewarm should still run before elevated workspace validation can return"
  )
  assert.match(
    selectionSection,
    /const workspaceValidation = validateElevatedWorkspaceRoot\(workspacePath\)/,
    "workspace selection should validate before preflight ACL work"
  )
  assert.match(
    setupSection,
    /const validation = validateElevatedWorkspaceRoot\(p\)/,
    "elevated setup should use the same workspace validation path"
  )
  assert.match(
    ensureSection,
    /setupResult\.success[\s\S]*areElevatedWorkspaceRootsPrepared\(workingDir, cacheRoots\)/,
    "workspace setup success should be rechecked against the requested workspace root"
  )
})
