import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const modelsSource = readFileSync(new URL("../src/main/ipc/models.ts", import.meta.url), "utf8")
const localSandboxSource = readFileSync(new URL("../src/main/agent/local-sandbox.ts", import.meta.url), "utf8")
const sandboxSource = readFileSync(new URL("../src/main/ipc/sandbox.ts", import.meta.url), "utf8")
const execPolicySource = readFileSync(new URL("../src/main/agent/exec-policy.ts", import.meta.url), "utf8")
const windowsSafeCommandsSource = readFileSync(new URL("../src/main/agent/windows-safe-commands.ts", import.meta.url), "utf8")
const runtimeSource = readFileSync(new URL("../src/main/agent/runtime.ts", import.meta.url), "utf8")
const codeExecRunnerSource = readFileSync(new URL("../src/main/code-exec/runner.ts", import.meta.url), "utf8")

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
    /export async function validateElevatedWorkspaceRoot\(workspacePath: string\)/,
    "sandbox IPC should expose one shared async elevated workspace validator"
  )
  assert.match(
    prewarmSection,
    /await validateElevatedWorkspaceRoot\(workspacePath\)/,
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
    /const workspaceValidation = await validateElevatedWorkspaceRoot\(workspacePath\)/,
    "workspace selection should validate before preflight ACL work"
  )
  assert.match(
    setupSection,
    /validation: await validateElevatedWorkspaceRoot\(p\)/,
    "elevated setup should use the same workspace validation path"
  )
  assert.match(
    ensureSection,
    /setupResult\.success[\s\S]*areElevatedWorkspaceRootsPrepared\(workingDir, cacheRoots\)/,
    "workspace setup success should be rechecked against the requested workspace root"
  )
})

test("sandbox setup hot paths avoid synchronous filesystem calls", () => {
  const forbiddenSyncFs = /\b(?:statSync|readdirSync|readFileSync|writeFileSync|mkdirSync|unlinkSync)\b/
  const importSection = sectionBetween(
    sandboxSource,
    'import { app, BrowserWindow, IpcMain } from "electron"',
    'import { execFile } from "child_process"'
  )
  const validationSection = sectionBetween(
    sandboxSource,
    "export async function validateElevatedWorkspaceRoot(",
    "function isPotentiallySafeElevatedPreparedRoot("
  )
  const rootsPersistenceSection = sectionBetween(
    sandboxSource,
    "async function loadElevatedPreparedRoots(",
    "function notifyChanged()"
  )
  const setupSection = sectionBetween(
    sandboxSource,
    "export async function runElevatedSetupForPaths(",
    "export function isElevatedRootPrepared("
  )
  const nuxSection = sectionBetween(
    sandboxSource,
    'ipcMain.handle("sandbox:checkElevatedSetup"',
    "  // ── Approval rules management ──"
  )
  const elevatedPrepareSection = sectionBetween(
    localSandboxSource,
    "private static async prepareElevatedRoot(",
    "private static createAbortError()"
  )

  assert.doesNotMatch(
    importSection,
    /from "fs"/,
    "sandbox IPC should not import sync fs APIs on the main-process setup path"
  )
  assert.doesNotMatch(
    validationSection,
    forbiddenSyncFs,
    "workspace validation should not block the main process with synchronous stat calls"
  )
  assert.doesNotMatch(
    rootsPersistenceSection,
    forbiddenSyncFs,
    "prepared-root load/save and profile enumeration should be asynchronous"
  )
  assert.doesNotMatch(
    setupSection,
    forbiddenSyncFs,
    "elevated setup should not synchronously read/write marker, temp script, or profile directories"
  )
  assert.match(
    nuxSection,
    /await isElevatedSetupComplete\(\)/,
    "IPC handlers should await async setup checks instead of reading marker files synchronously"
  )
  assert.match(
    elevatedPrepareSection,
    /await isElevatedSetupComplete\(\)/,
    "execute-time elevated preparation should use the async setup marker check"
  )
})

test("prepared elevated roots are persisted after async startup load", () => {
  const saveSection = sectionBetween(
    sandboxSource,
    "function saveElevatedPreparedRoots(",
    "// Load persisted roots immediately so they survive app restarts"
  )
  const loadSection = sectionBetween(
    sandboxSource,
    "async function loadElevatedPreparedRoots(",
    "let elevatedPreparedRootsSavePromise = Promise.resolve()"
  )
  const awaitLoadIndex = saveSection.indexOf("await elevatedPreparedRootsLoadPromise")
  const snapshotIndex = saveSection.indexOf("const snapshot = JSON.stringify")

  assert.notEqual(awaitLoadIndex, -1, "prepared-root saves should wait for the startup load promise")
  assert.notEqual(snapshotIndex, -1, "prepared-root saves should snapshot after load")
  assert.ok(
    awaitLoadIndex < snapshotIndex,
    "prepared-root saves must not snapshot an incomplete in-memory set before startup load finishes"
  )
  assert.match(
    loadSection,
    /\(err as NodeJS\.ErrnoException\)\?\.code !== "ENOENT"[\s\S]*console\.warn/,
    "missing prepared-root files should stay quiet, but corrupt/unreadable files should be observable"
  )
})

test("sandbox cache roots canonicalize workspace symlinks without sync fs calls", () => {
  const buildCacheRootSection = sectionBetween(
    localSandboxSource,
    "private static async buildSandboxCacheRoot(",
    "private static getSandboxToolCacheDirs("
  )
  const constructorSection = sectionBetween(
    localSandboxSource,
    "constructor(options: LocalSandboxOptions = {})",
    "    // Redirect deepagents' virtual eviction paths"
  )
  const executeWindowsSection = sectionBetween(
    localSandboxSource,
    "private async executeInWindowsSandbox(",
    "    const sandboxCacheRoots = Array.from(new Set(["
  )
  const selectionSection = sectionBetween(
    localSandboxSource,
    "static async prepareWorkspaceForSelection(",
    "private static async ensureElevatedWorkspaceSetup("
  )

  assert.match(
    buildCacheRootSection,
    /await fs\.realpath\(workingDir\)/,
    "sandbox cache root hashing should canonicalize symlinked workspaces asynchronously"
  )
  assert.doesNotMatch(
    localSandboxSource,
    /\brealpathSync\b/,
    "sandbox cache root canonicalization should not reintroduce synchronous realpath calls"
  )
  assert.match(
    constructorSection,
    /this\._sandboxCacheRoot = LocalSandbox\.buildSandboxCacheRootFromCanonical[\s\S]*this\._sandboxCacheRootPromise = LocalSandbox\.buildSandboxCacheRoot/,
    "constructor should keep a synchronous fallback while precomputing the canonical cache root"
  )
  assert.match(
    executeWindowsSection,
    /raceWithAbort\(this\._sandboxCacheRootPromise[\s\S]*return this\._sandboxCacheRoot/,
    "Windows sandbox execution should await canonical cache root resolution with a fallback"
  )
  assert.match(
    selectionSection,
    /await LocalSandbox\.buildElevatedWorkspaceCacheRoots/,
    "workspace switch preparation should use canonical cache roots before ACL checks"
  )
})

test("sandbox ACL helpers avoid unbounded parallel process fan-out", () => {
  const revokeSection = sectionBetween(
    localSandboxSource,
    "static async revokeGrantedAclsForRun(",
    "  /** Sandbox user names used by elevated mode. */"
  )
  const elevatedPrewarmSection = sectionBetween(
    localSandboxSource,
    "private static async prewarmElevatedWorkspaceRoots(",
    "private static async waitForElevatedRootsPrepared("
  )
  const elevatedSetupSection = sectionBetween(
    localSandboxSource,
    "private static async ensureElevatedWorkspaceSetup(",
    "private static createAbortError()"
  )
  const executeWindowsSection = sectionBetween(
    localSandboxSource,
    "private async executeInWindowsSandbox(",
    "    const execStartMs = Date.now()"
  )

  assert.match(
    localSandboxSource,
    /private static readonly ACL_OPERATION_CONCURRENCY = 2/,
    "ACL subprocess fan-out should stay deliberately bounded"
  )
  assert.match(
    revokeSection,
    /mapLimit\([\s\S]*ACL_OPERATION_CONCURRENCY[\s\S]*revokeSandboxWriteAcl/,
    "ACL revoke should not spawn one icacls process per directory at once"
  )
  assert.match(
    elevatedPrewarmSection,
    /mapLimit\([\s\S]*ACL_OPERATION_CONCURRENCY[\s\S]*prepareElevatedRoot/,
    "elevated prewarm should not fan out all root ACL grants at once"
  )
  assert.match(
    elevatedSetupSection,
    /mapLimit\([\s\S]*ACL_OPERATION_CONCURRENCY[\s\S]*grantElevatedWorkspaceAcl/,
    "explicit elevated setup preflight should bound cache-root ACL grants"
  )
  assert.match(
    executeWindowsSection,
    /mapLimit\([\s\S]*ACL_OPERATION_CONCURRENCY[\s\S]*grantSandboxWriteAcl/,
    "per-command unelevated ACL grants should be queued instead of unbounded Promise.all"
  )
})

test("elevated command routing avoids unconditional Python lookup waits", () => {
  const executeWindowsSection = sectionBetween(
    localSandboxSource,
    "private async executeInWindowsSandbox(",
    "    const isElevatedSandbox = effectiveMode === \"elevated\""
  )
  const sandboxEnvSection = sectionBetween(
    localSandboxSource,
    "private static async buildSandboxEnv(",
    "private static async resolveShell("
  )
  const preferUnelevatedSection = sectionBetween(
    localSandboxSource,
    "private static async shouldPreferUnelevated(",
    "  constructor(options: LocalSandboxOptions = {})"
  )
  const barePythonIndex = preferUnelevatedSection.indexOf("const isBarePythonCommand")
  const resolvePythonIndex = preferUnelevatedSection.indexOf("await LocalSandbox.resolvePythonDir()")

  assert.doesNotMatch(
    executeWindowsSection,
    /await LocalSandbox\.resolvePythonDir/,
    "ordinary elevated commands should not wait on py/where python before starting sandbox setup"
  )
  assert.doesNotMatch(
    sandboxEnvSection,
    /await LocalSandbox\.resolvePythonDir/,
    "sandbox env construction should use the prewarmed Python cache without waiting on probe processes"
  )
  assert.match(
    sandboxEnvSection,
    /const pythonDir = LocalSandbox\._pythonDir \?\? null/,
    "sandbox env construction should still inject Python when the background cache is already populated"
  )
  assert.notEqual(
    barePythonIndex,
    -1,
    "shouldPreferUnelevated should still detect direct python/py invocations"
  )
  assert.ok(
    barePythonIndex < resolvePythonIndex,
    "Python path lookup should be gated behind a direct python/py command check"
  )
})

test("sandbox execute helpers do not create visible console windows", () => {
  const windowsSandboxSpawnSection = sectionBetween(
    localSandboxSource,
    "const proc = spawn(this.codexExePath, sandboxArgs, {",
    "console.log(`[LocalSandbox] spawned pid="
  )
  const executeOnceSection = sectionBetween(
    localSandboxSource,
    "private executeOnce(",
    "  private formatOutput"
  )
  const aclSection = sectionBetween(
    localSandboxSource,
    "private static grantSandboxWriteAcl(",
    "  /** Sandbox user names used by elevated mode. */"
  )
  const killTreeSection = sectionBetween(
    localSandboxSource,
    "private static async killTree(",
    "  /**\r\n   * Execute a shell command in the workspace directory."
  )
  const elevatedSetupPowerShellSection = sectionBetween(
    sandboxSource,
    'await execFileWithAbort("powershell"',
    "} finally {"
  )
  const codeExecSpawnSection = sectionBetween(
    codeExecRunnerSource,
    "const child = spawn(process.execPath",
    "      child.stdin.end"
  )

  assert.match(
    windowsSandboxSpawnSection,
    /windowsHide: true/,
    "codex windows sandbox wrapper should be spawned without a visible console window"
  )
  assert.match(
    executeOnceSection,
    /spawn\(shell, \[\], \{[\s\S]*windowsHide: true[\s\S]*spawn\(command, \{[\s\S]*windowsHide: true/,
    "raw shell execution should hide both bash-like and shell=true child windows"
  )
  assert.match(
    aclSection,
    /spawn\("icacls"[\s\S]*windowsHide: true[\s\S]*spawn\("icacls"[\s\S]*windowsHide: true/,
    "grant/revoke ACL helpers should not flash console windows"
  )
  assert.match(
    localSandboxSource,
    /spawn\("icacls", args, \{[\s\S]*windowsHide: true/,
    "elevated ACL helper should not flash console windows"
  )
  assert.match(
    killTreeSection,
    /spawn\("taskkill"[\s\S]*windowsHide: true/,
    "process cleanup helpers should not flash console windows"
  )
  assert.match(
    elevatedSetupPowerShellSection,
    /windowsHide: true/,
    "UAC setup should hide its parent PowerShell wrapper while keeping the UAC prompt available"
  )
  assert.doesNotMatch(
    sandboxSource,
    /windowsHide: false/,
    "sandbox setup code should not intentionally show wrapper PowerShell consoles"
  )
  assert.match(
    codeExecSpawnSection,
    /windowsHide: true/,
    "code_exec helper should also hide its wrapper process on Windows"
  )
})

test("PowerShell safe-command parsing stays conservative without helper processes", () => {
  const parserSection = sectionBetween(
    windowsSafeCommandsSource,
    "function parsePowerShellScriptConservatively(",
    "function pushPowerShellSegment("
  )
  const variableSection = sectionBetween(
    windowsSafeCommandsSource,
    "const SAFE_POWERSHELL_VARIABLES = new Set([",
    "])"
  )

  assert.match(
    parserSection,
    /stripPowerShellDiscardRedirects\(\s*normalizePowerShellLineContinuations\(script\)\s*\)/,
    "PowerShell discard redirects should be stripped before the redirection-rejecting splitter runs"
  )
  assert.match(
    parserSection,
    /replace\(\/`\\r\?\\n\/g, " "\)/,
    "PowerShell backtick line continuations should be normalized before conservative parsing"
  )
  assert.match(
    parserSection,
    /\(\?:\\d\+\|\\\*\)\?>\\s\*\\\$null\\b/,
    "discard redirects to $null should cover > $null, 2> $null, and *> $null"
  )
  assert.match(
    parserSection,
    /prev === "\*"[\s\S]*N>&M \/ \*>&M/,
    "stream merge parsing should keep supporting both N>&M and *>&M"
  )
  for (const variable of ["$null", "$true", "$false", "$_", "$psitem", "$pwd", "$home", "$psscriptroot", "$lastexitcode"]) {
    assert.ok(
      variableSection.toLowerCase().includes(`"${variable}"`),
      `safe PowerShell automatic variable missing from whitelist: ${variable}`
    )
  }
})

test("sandbox execute safety checks do not synchronously spawn helper processes", () => {
  const executeSection = sectionBetween(
    localSandboxSource,
    "  async execute(command: string): Promise<ExecuteResponse> {",
    "  /**\r\n   * Raw command execution"
  )
  const policySection = sectionBetween(
    execPolicySource,
    "export function assessCommandSafety(",
    "export function classifyCommandConcurrency("
  )

  assert.match(
    executeSection,
    /assessCommandSafety\(command/,
    "execute should keep using the central safety policy"
  )
  assert.match(
    policySection,
    /isKnownSafeWindowsCommand\(trimmed/,
    "the policy should keep Windows safe-command handling centralized"
  )
  assert.doesNotMatch(
    windowsSafeCommandsSource,
    /\b(?:spawnSync|execSync|execFileSync)\b/,
    "Windows safe-command checks must not block the Electron main process with synchronous child processes"
  )
  assert.doesNotMatch(
    windowsSafeCommandsSource,
    /\b(?:existsSync|statSync|readFileSync|writeFileSync|readdirSync|mkdirSync|unlinkSync|accessSync)\b/,
    "Windows safe-command checks must remain pure string parsing, without synchronous filesystem probes"
  )
})

test("sandbox-adjacent runtime startup avoids synchronous filesystem probes", () => {
  const runtimeResourceSection = sectionBetween(
    runtimeSource,
    "async function ensureCodexExe(",
    "  const enabledHooks = getEnabledHooks(workspacePath)"
  )
  const codeExecHelperSection = sectionBetween(
    codeExecRunnerSource,
    "async function resolveHelperEntryPath(",
    "export class LocalProcessRunner"
  )
  const forbiddenSyncFs = /\b(?:existsSync|statSync|readFileSync|writeFileSync|readdirSync|mkdirSync|unlinkSync|accessSync)\b/

  assert.doesNotMatch(
    runtimeSource,
    /import \{[^}]*\b(?:existsSync|statSync|unlinkSync)\b[^}]*\} from "fs"/,
    "agent runtime should not import sync fs helpers on sandbox startup path"
  )
  assert.doesNotMatch(
    runtimeResourceSection,
    forbiddenSyncFs,
    "sandbox runtime resource/codex.exe checks should use async fs APIs"
  )
  assert.doesNotMatch(
    codeExecRunnerSource,
    /\bexistsSync\b/,
    "code_exec helper lookup should not synchronously probe candidate paths"
  )
  assert.match(
    codeExecHelperSection,
    /await Promise\.all\(candidates\.map/,
    "code_exec helper lookup should check candidates asynchronously"
  )
})
