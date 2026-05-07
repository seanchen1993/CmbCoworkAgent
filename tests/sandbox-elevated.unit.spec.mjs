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
const toolOrchestratorSource = readFileSync(new URL("../src/main/agent/tool-orchestrator.ts", import.meta.url), "utf8")

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
    "    const isReadonly = effectiveMode === \"readonly\""
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

test("LocalSandbox exposes a single sandbox-denial detector modelled on Codex", () => {
  // Codex's design (codex-rs/core/src/exec.rs::is_likely_sandbox_denied):
  //   one keyword set, one function, one bypass prompt — keep it simple.
  assert.match(
    localSandboxSource,
    /static isLikelySandboxDenied\(exitCode: number \| null, output: string\): boolean/,
    "LocalSandbox should expose a single Codex-style sandbox denial detector"
  )
  assert.match(
    localSandboxSource,
    /static readonly SANDBOX_DENIED_KEYWORDS: readonly string\[\]/,
    "the keyword list should be a single readonly array, not scattered regexes per tool"
  )
  // Codex's original 7 keywords from is_likely_sandbox_denied:
  for (const codexKw of [
    "operation not permitted",
    "permission denied",
    "read-only file system",
    "seccomp",
    "sandbox",
    "landlock",
    "failed to write file"
  ]) {
    assert.match(
      localSandboxSource,
      new RegExp(`"${codexKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `Codex's "${codexKw}" keyword should appear in SANDBOX_DENIED_KEYWORDS`
    )
  }
  // Windows-specific additions Codex doesn't ship:
  for (const winKw of [
    "access is denied",
    "拒绝访问",
    "winerror 5",
    "winerror 1314",
    "dubious ownership",
    "spawn eperm",
    "createprocesswithlogonw failed"  // domain-policy-blocked elevated sandbox (error 1385)
  ]) {
    assert.match(
      localSandboxSource,
      new RegExp(`"${winKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `Windows-specific "${winKw}" keyword should appear in SANDBOX_DENIED_KEYWORDS`
    )
  }
})

test("error 1385 from CreateProcessWithLogonW gets a specific 'switch to unelevated' guidance prompt", () => {
  // Real failure output we observed on a domain-managed machine
  const sample =
    '[stderr] windows sandbox failed: CreateProcessWithLogonW failed: 1385\n[Command failed with exit code 1]'

  // Replicate the source helper to verify behaviour:
  function getSandboxBypassGuidance(output) {
    if (!output) return null
    const lower = output.toLowerCase()
    if (
      lower.includes("createprocesswithlogonw failed: 1385")
      || (lower.includes("windows sandbox failed") && lower.includes("1385"))
    ) {
      return "elevated-1385"  // sentinel for the test
    }
    return null
  }

  assert.equal(getSandboxBypassGuidance(sample), "elevated-1385", "1385 from CreateProcessWithLogonW should match")
  assert.equal(getSandboxBypassGuidance(""), null, "empty output should not match")
  assert.equal(getSandboxBypassGuidance("Error: spawn EPERM"), null, "unrelated EPERM should not match")

  // Verify the source carries the specific guidance message and the orchestrator wires it in:
  assert.match(
    localSandboxSource,
    /static getSandboxBypassGuidance\(output: string\): string \| null/,
    "LocalSandbox should expose getSandboxBypassGuidance for the orchestrator to consume"
  )
  assert.match(
    localSandboxSource,
    /CodexSandboxOnline[\s\S]*1385[\s\S]*SeInteractiveLogonRight/,
    "the 1385 guidance text should name the sandbox user, the error code, and the underlying logon-right"
  )
  assert.match(
    localSandboxSource,
    /设置 → 沙箱模式[\s\S]*Unelevated/,
    "the 1385 guidance should point users at the sandbox-mode setting"
  )
  assert.match(
    toolOrchestratorSource,
    /LocalSandbox\.getSandboxBypassGuidance\([^)]+\)\s*\?\?\s*SANDBOX_BYPASS_PROMPT_REASON/,
    "the orchestrator should prefer LocalSandbox.getSandboxBypassGuidance and fall back to the generic prompt"
  )
})

test("sandbox preemptive routing has been removed in favour of the prompt-then-retry flow", () => {
  const rawExecutionSection = sectionBetween(
    localSandboxSource,
    "private async executeRawUnserialized(",
    "    const isWindows = process.platform === \"win32\""
  )
  assert.doesNotMatch(
    rawExecutionSection,
    /executeRawUnserialized\(command, "none"/,
    "executeRawUnserialized must not preemptively re-route to host token — the orchestrator owns that decision after asking the user"
  )
  assert.doesNotMatch(
    rawExecutionSection,
    /hostBroker/,
    "host-broker preemptive routing has been replaced with a fail → prompt → retry flow"
  )
  // Detection helpers we previously exposed have been collapsed into isLikelySandboxDenied:
  for (const dead of [
    "isSandboxedPipeSpawnFailure",
    "isGitMetadataPermissionFailure",
    "isSandboxedSshAuthFailure",
    "isGenericSandboxAccessFailure",
    "shouldRunGitMetadataOutsideWindowsSandbox"
  ]) {
    assert.doesNotMatch(
      localSandboxSource,
      new RegExp(`static\\s+${dead}\\b`),
      `${dead} should be removed — replaced by isLikelySandboxDenied`
    )
  }
})

test("Windows sandbox execution no longer installs native-helper workarounds", () => {
  const plannerSection = sectionBetween(
    localSandboxSource,
    "private static buildWindowsSandboxExecutionPlan(",
    "  private static buildSerializedExecutionKey("
  )
  const executeWindowsSection = sectionBetween(
    localSandboxSource,
    "private async executeInWindowsSandbox(",
    "    const isReadonly = effectiveMode === \"readonly\""
  )

  for (const dead of [
    "NATIVE_HELPER_SPAWN_HOOK",
    "CMB_SANDBOX_NATIVE_HELPER_MAP",
    "prepareNativeHelpersForPlan",
    "prepareNativeHelperSpawnHook",
    "prepareNativeHelperReadAccess",
    "materializeNativeHelper",
    "getNativeHelperReadAccessPaths",
    "grantSandboxReadExecuteAcl",
    "SandboxNativeHelpers"
  ]) {
    assert.doesNotMatch(
      localSandboxSource,
      new RegExp(dead),
      `${dead} should not remain — npm/build failures should surface to the prompt-then-retry flow`
    )
  }
  assert.doesNotMatch(
    plannerSection,
    /nativeHelper|materializedHelper|NODE_OPTIONS|CMB_SANDBOX_NATIVE_HELPER/,
    "execution planning should not add native-helper redirects or NODE_OPTIONS hooks"
  )
  assert.doesNotMatch(
    executeWindowsSection,
    /prepareNativeHelper|materializeNativeHelper|NODE_OPTIONS|CMB_SANDBOX_NATIVE_HELPER/,
    "Windows sandbox execution should not patch native helper spawning before running the command"
  )
})

test("orchestrator wraps every sandbox failure in Codex's single retry-without-sandbox prompt", () => {
  const orchestratorSection = sectionBetween(
    toolOrchestratorSource,
    "async execute(command: string, cwd: string, sandboxMode: string)",
    "private async approveFileOp("
  )
  const bypassSection = sectionBetween(
    toolOrchestratorSource,
    "private async maybeRequestSandboxBypass(",
    "  private mapDecisionToReview("
  )

  assert.match(
    orchestratorSection,
    /maybeRetryOutsideSandbox/,
    "execute() should hand the result to maybeRetryOutsideSandbox"
  )
  assert.match(
    orchestratorSection,
    /safety\.level === "safe"[\s\S]*rawExecute\(command, sandboxMode\)[\s\S]*maybeRetryOutsideSandbox\(command, cwd, sandboxMode, result\)/,
    "safe commands should also be eligible for Codex-style sandbox bypass prompts after sandbox failure"
  )
  assert.match(
    orchestratorSection,
    /this\.yoloMode[\s\S]*rawExecute\(command, sandboxMode\)[\s\S]*maybeRetryOutsideSandbox\(command, cwd, sandboxMode, result\)/,
    "YOLO mode should skip only the initial command approval; sandbox escape must still require the retry approval prompt"
  )
  assert.match(
    toolOrchestratorSource,
    /isLikelySandboxDenied\(sandboxResult\.exitCode,\s*output\)/,
    "the orchestrator should call LocalSandbox.isLikelySandboxDenied (output + exit code) instead of multiple ad-hoc detectors"
  )
  assert.match(
    bypassSection,
    /retry_reason: promptReason/,
    "the bypass prompt should populate retry_reason from a resolved promptReason (specific guidance or generic fallback)"
  )
  assert.match(
    bypassSection,
    /LocalSandbox\.getSandboxBypassGuidance\(output\)\s*\?\?\s*SANDBOX_BYPASS_PROMPT_REASON/,
    "the orchestrator should prefer LocalSandbox.getSandboxBypassGuidance, falling back to the Codex-style generic prompt"
  )
  assert.match(
    bypassSection,
    /allowed_approval_types: \["approve", "reject"\]/,
    "sandbox bypass should only offer one-shot approve/reject — not session/permanent grants"
  )
  assert.match(
    bypassSection,
    /rawExecute\(command, "none"\)/,
    "approval should hand the command to rawExecute with mode=none (host token)"
  )
  assert.match(
    bypassSection,
    /return sandboxResult/,
    "rejection should surface the original sandbox failure so the agent can adjust its plan"
  )
  assert.match(
    toolOrchestratorSource,
    /SANDBOX_BYPASS_PROMPT_REASON\s*=\s*"[^"]+沙箱外重试[^"]+"/,
    "the prompt message constant should be a single shared string (mirrors Codex's 'command failed; retry without sandbox?' UX)"
  )
})

test("isLikelySandboxDenied keyword check matches real failure outputs and rejects unrelated errors", () => {
  // Recreate the detector locally — keep this in sync with the source.
  const SANDBOX_DENIED_KEYWORDS = [
    "operation not permitted",
    "permission denied",
    "read-only file system",
    "seccomp",
    "sandbox",
    "landlock",
    "failed to write file",
    "access is denied",
    "拒绝访问",
    "winerror 5",
    "winerror 1314",
    "dubious ownership",
    "spawn eperm",
    "eacces: permission",
    "eperm: operation",
    "permissionerror: [errno 13"
  ]
  function isLikelySandboxDenied(exit, output) {
    if (exit === 0 || !output) return false
    const lower = output.toLowerCase()
    return SANDBOX_DENIED_KEYWORDS.some((kw) => lower.includes(kw))
  }

  const samples = [
    // Sandbox-induced failures — should match
    { output: "Error: spawn EPERM\n    at ChildProcess.spawn (...)", expect: true },
    { output: "fatal: detected dubious ownership in repository at 'C:/ai/repo'", expect: true },
    { output: "error: cannot lock ref 'refs/remotes/origin/main': Permission denied", expect: true },
    { output: "Permission denied (publickey).\r\nfatal: Could not read from remote repository.", expect: true },
    { output: "EACCES: permission denied, open 'C:\\Users\\host\\.npmrc'", expect: true },
    { output: "OSError: [WinError 5] Access is denied: 'C:\\Windows\\Temp\\foo'", expect: true },
    { output: "[WinError 1314] A required privilege is not held by the client", expect: true },
    { output: "icacls: Access is denied.", expect: true },
    { output: "拒绝访问", expect: true },
    { output: "[Sandbox] command was blocked", expect: true },  // Codex's "sandbox" keyword
    // Non-sandbox failures — should NOT match
    { output: "TypeScript error TS2304: Cannot find name 'foo'", expect: false },
    { output: "Test failed: expected 1 to equal 2", expect: false },
    { output: "ECONNREFUSED 127.0.0.1:5432", expect: false },
    { output: "syntax error near unexpected token", expect: false },
    { output: "", expect: false }
  ]

  for (const s of samples) {
    assert.equal(
      isLikelySandboxDenied(1, s.output),
      s.expect,
      `keyword match mismatch on: ${s.output.slice(0, 60)}`
    )
  }
  // Exit 0 always returns false even with denial keywords (success branch never prompts)
  assert.equal(isLikelySandboxDenied(0, "EACCES: permission denied"), false)
})

test("background execute() routes results through the orchestrator's bypass check", () => {
  const backgroundSection = sectionBetween(
    localSandboxSource,
    "async executeBackground(command: string)",
    "  /**\r\n   * Retrieve a background task's"
  )

  assert.match(
    backgroundSection,
    /this\.orchestrator[\s\S]*maybeRetryOutsideSandbox\(command, this\.workingDir, this\.windowsSandbox, rawResult\)/,
    "executeBackground must hand the raw result to the orchestrator's bypass check before marking the task complete — otherwise backgrounded `npm run build` skips the approval prompt"
  )
  assert.match(
    backgroundSection,
    /if \(task\.completed\) return[\s\S]*if \(task\.completed\) return/,
    "executeBackground should re-check task.completed before AND after the bypass call so cancelled tasks aren't overwritten"
  )
  assert.match(
    toolOrchestratorSource,
    /async maybeRetryOutsideSandbox\(/,
    "ToolOrchestrator should expose maybeRetryOutsideSandbox so background tasks can reuse the bypass logic"
  )
})

test("runtime mounts the orchestrator even in YOLO mode so sandbox escape can still prompt", () => {
  const runtimeApprovalSection = sectionBetween(
    runtimeSource,
    "  // ── Wire up the approval orchestrator ──",
    "  let systemPrompt = getSystemPrompt"
  )

  assert.doesNotMatch(
    runtimeApprovalSection,
    /if \(!yoloMode\) \{[\s\S]*setOrchestrator/,
    "YOLO mode must not skip mounting ToolOrchestrator, otherwise sandbox failures return directly without a retry approval prompt"
  )
  assert.match(
    runtimeApprovalSection,
    /new ToolOrchestrator\(approvalStore, rawExecute, requestApproval, yoloMode\)[\s\S]*backend\.setOrchestrator\(orchestrator\)/,
    "runtime should always mount ToolOrchestrator and pass yoloMode into it"
  )
})

test("elevated sandbox preamble injects git safe.directory and openssl backend", () => {
  const elevatedPreambleSection = sectionBetween(
    localSandboxSource,
    "private static buildElevatedSandboxEnvPreamble(",
    "  /**\r\n   * Build JVM + Python environment preamble for unelevated sandbox mode."
  )
  const unelevatedClearProxySection = sectionBetween(
    localSandboxSource,
    "    const clearProxyPreamble = !isElevatedSandbox && effectiveMode !== \"none\"",
    "    // Unelevated sandbox: set shared tool env vars"
  )

  for (const section of [elevatedPreambleSection, unelevatedClearProxySection]) {
    assert.match(
      section,
      /GIT_CONFIG_COUNT=2/,
      "GIT_CONFIG_COUNT must be bumped to 2 so both http.sslBackend and safe.directory survive"
    )
    assert.match(
      section,
      /GIT_CONFIG_KEY_1=safe\.directory[\s\S]*GIT_CONFIG_VALUE_1=\*/,
      "git safe.directory=* must be injected so the sandbox user can operate on the host-owned workspace without 'dubious ownership' errors"
    )
  }
})

test("sandbox ACL grants only cover writable sandbox roots", () => {
  const unelevatedAclSection = sectionBetween(
    localSandboxSource,
    "private static async grantSandboxWriteAcl(",
    "  /** Remove the Everyone ACE"
  )
  const elevatedAclSection = sectionBetween(
    localSandboxSource,
    "private static async grantElevatedWorkspaceAcl(",
    "  private static getElevatedPrepareRoots("
  )
  const elevatedPrepareSection = sectionBetween(
    localSandboxSource,
    "  private static getElevatedPrepareRoots(",
    "  private static async ensureElevatedWorkspaceSetup("
  )
  const executeWindowsAclSection = sectionBetween(
    localSandboxSource,
    "      // Pre-create app-owned persistent cache subdirectories from the main process",
    "      const aclGrantStart = Date.now()"
  )
  assert.match(
    unelevatedAclSection,
    /fs\.stat\(dir\)[\s\S]*isDirectory\(\)[\s\S]*EVERYONE_SID\}:\(OI\)\(CI\)\(M\)[\s\S]*EVERYONE_SID\}:RX/,
    "unelevated ACL grants should still use inherited modify for directories and RX for file roots"
  )
  assert.match(
    elevatedAclSection,
    /fs\.stat\(dir\)[\s\S]*isDirectory\(\)[\s\S]*grantSuffix = isDirectory \? "\(OI\)\(CI\)\(M\)" : "RX"/,
    "elevated ACL grants should not apply directory inheritance flags to helper files"
  )
  assert.doesNotMatch(
    executeWindowsAclSection,
    /nativeHelperAccess/,
    "native helper directories must not be mixed into writable cache ACL preparation"
  )
  assert.match(
    elevatedPrepareSection,
    /isCacheableElevatedPreparedRoot[\s\S]*fs\.stat\(root\)[\s\S]*isDirectory\(\)/,
    "only directory roots should be eligible for persisted elevated prepared-root state"
  )
  assert.match(
    elevatedPrepareSection,
    /if \(cachePreparedRoot\) \{[\s\S]*markElevatedRootsPrepared\(\[root\]\)/,
    "file-level elevated helper grants should not be marked as permanently prepared"
  )
  assert.match(
    elevatedPrepareSection,
    /areCacheableElevatedRootsPrepared/,
    "elevated prewarm should verify persisted state only for cacheable directory roots"
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
    "private static async grantSandboxWriteAcl(",
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
