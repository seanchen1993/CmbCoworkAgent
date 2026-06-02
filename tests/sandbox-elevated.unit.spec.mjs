import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const modelsSource = readFileSync(new URL("../src/main/ipc/models.ts", import.meta.url), "utf8")
const localSandboxSource = readFileSync(new URL("../src/main/agent/local-sandbox.ts", import.meta.url), "utf8")
const sandboxSource = readFileSync(new URL("../src/main/ipc/sandbox.ts", import.meta.url), "utf8")
const execPolicySource = readFileSync(new URL("../src/main/agent/exec-policy.ts", import.meta.url), "utf8")
const windowsSafeCommandsSource = readFileSync(new URL("../src/main/agent/windows-safe-commands.ts", import.meta.url), "utf8")
const runtimeSource = readFileSync(new URL("../src/main/agent/runtime.ts", import.meta.url), "utf8")
const preloadSource = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8")
const threadContextSource = readFileSync(new URL("../src/renderer/src/lib/thread-context.tsx", import.meta.url), "utf8")
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

test("sandbox mode defaults to disabled and first-run elevated NUX stays opt-in", () => {
  const readSettingsSection = sectionBetween(
    readFileSync(new URL("../src/main/storage.ts", import.meta.url), "utf8"),
    "function readSandboxSettings()",
    "function updateSandboxSettings("
  )
  const nuxNeededSection = sectionBetween(
    sandboxSource,
    'ipcMain.handle("sandbox:isNuxNeeded"',
    'ipcMain.handle(\n    "sandbox:completeNux"'
  )

  assert.match(
    readSettingsSection,
    /return \{ mode: "none", yolo: false, nuxCompleted: true \}/,
    "missing or unreadable sandbox settings should default to disabled"
  )
  assert.match(
    readSettingsSection,
    /SANDBOX_MODES\.has\(parsed\.mode\) \? parsed\.mode : "none"/,
    "invalid persisted sandbox modes should fall back to disabled"
  )
  assert.match(
    nuxNeededSection,
    /ENABLE_SANDBOX_NUX[\s\S]*isSandboxNuxCompleted\(\)/,
    "first-run elevated sandbox setup should stay behind an explicit feature flag"
  )
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

test("python temp ACL sitecustomize uses a callable wrapper so pathlib.mkdir stays compatible", () => {
  const siteCustomizeSection = sectionBetween(
    localSandboxSource,
    "const PYTHON_TEMP_ACL_SITE_CUSTOMIZE = `",
    "/*"
  )

  assert.match(
    siteCustomizeSection,
    /class _MkdirInheritAcl:/,
    "sitecustomize should use a callable wrapper object instead of rebinding os.mkdir to a plain Python function"
  )
  assert.match(
    siteCustomizeSection,
    /def __call__\(self, path, mode=0o777, \*args, \*\*kwargs\):/,
    "the wrapper should implement __call__ so pathlib's accessor binding does not inject an extra self argument"
  )
  assert.match(
    siteCustomizeSection,
    /os\.mkdir = _MkdirInheritAcl\(_orig_mkdir\)/,
    "sitecustomize should install the callable wrapper instance"
  )
  assert.doesNotMatch(
    siteCustomizeSection,
    /def _mkdir_inherit_acl\(/,
    "the old plain-function wrapper should not come back"
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

test("sandbox cache roots canonicalize workspace symlinks asynchronously", () => {
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
    buildCacheRootSection,
    /\brealpathSync\b/,
    "async sandbox cache root canonicalization should not use synchronous realpath calls"
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
  assert.doesNotMatch(
    preferUnelevatedSection,
    /git\s*(?:\\s\+)?\([^)]*pull|git[\s\S]*pull\|fetch|git[\s\S]*clone/,
    "Git network commands should not be silently rerouted from elevated to unelevated sandbox"
  )
})

test("LocalSandbox exposes a single sandbox-denial detector modelled on Codex", () => {
  // Codex's design (codex-rs/core/src/exec.rs::is_likely_sandbox_denied):
  //   one keyword set, one function, one bypass prompt — keep it simple.
  assert.match(
    localSandboxSource,
    /static isLikelySandboxDenied\(exitCode: number \| null, output: string, command\?: string\): boolean/,
    "LocalSandbox should expose a single command-aware sandbox denial detector"
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

test("output collection caps encoding detection to a small head sample", () => {
  // Encoding detection runs on every shell command's main-thread cleanup. chardet is
  // pure JS and linear in the input size — feeding it the full 100KB buffer adds
  // 5-15ms of blocking per cap-hit command. Sample the head (8KB) instead.
  assert.match(
    localSandboxSource,
    /private static readonly ENCODING_DETECT_HEAD_BYTES = 8 \* 1024/,
    "ENCODING_DETECT_HEAD_BYTES should cap the sample chardet sees"
  )
  assert.match(
    localSandboxSource,
    /buf\.length > LocalSandbox\.ENCODING_DETECT_HEAD_BYTES[\s\S]*buf\.subarray\(0, LocalSandbox\.ENCODING_DETECT_HEAD_BYTES\)/,
    "detectCmdEncoding should slice via subarray (no allocation), not pass the full buffer to chardet"
  )
  assert.match(
    localSandboxSource,
    /private static encodingDetectionBuffer\(stdoutBuf: Buffer, stderrBuf: Buffer\): Buffer/,
    "should expose a helper that picks the encoding-detection buffer without an extra Buffer.concat"
  )
  // Both collectAndResolve sites should use the helper instead of Buffer.concat([stdoutBuf, stderrBuf])
  assert.doesNotMatch(
    localSandboxSource,
    /Buffer\.concat\(\[stdoutBuf, stderrBuf\]\)/,
    "neither executeOnce path should allocate a third Buffer.concat just to feed chardet"
  )
  // Both sites should now use the helper:
  const helperUseCount = (localSandboxSource.match(/encodingDetectionBuffer\(stdoutBuf, stderrBuf\)/g) || []).length
  assert.ok(helperUseCount >= 2, `encodingDetectionBuffer should be used by both collectAndResolve paths (got ${helperUseCount})`)
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
    /isLikelySandboxDenied\(sandboxResult\.exitCode,\s*output,\s*command\)/,
    "the orchestrator should pass the command so Git auth timeouts can be classified without treating every timeout as sandbox-denied"
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

test("command-specific timeout retry detection shares timeout metadata constants", () => {
  const detectorSection = sectionBetween(
    localSandboxSource,
    "static isLikelySandboxDenied(",
    "  /**\r\n   * Keywords whose presence"
  )
  const timeoutMetadataSection = sectionBetween(
    localSandboxSource,
    "private static createTimeoutMetadata(",
    "  /**\r\n   * Kill a process tree"
  )

  assert.match(
    localSandboxSource,
    /TIMEOUT_METADATA_SENTINEL\s*=\s*"execute tool killed"/,
    "timeout sentinel should be a named constant"
  )
  assert.match(
    localSandboxSource,
    /TIMEOUT_METADATA_REASON\s*=\s*"exceeding timeout"/,
    "timeout reason should be a named constant"
  )
  assert.match(
    localSandboxSource,
    /SPARSE_TIMEOUT_OUTPUT_MAX_CHARS\s*=\s*40/,
    "sparse timeout threshold should be named and documented"
  )
  assert.match(
    timeoutMetadataSection,
    /TIMEOUT_METADATA_SENTINEL[\s\S]*TIMEOUT_METADATA_REASON/,
    "timeout metadata generation should use the same constants as detection"
  )
  assert.match(
    detectorSection,
    /includes\(LocalSandbox\.TIMEOUT_METADATA_SENTINEL\)[\s\S]*includes\(LocalSandbox\.TIMEOUT_METADATA_REASON\)/,
    "sparse timeout detection should not depend on duplicated literal metadata text"
  )
  assert.match(
    detectorSection,
    /isLikelyInteractiveNetworkCommand\(command\)/,
    "timeout retry should remain command-aware, not a blanket timeout escalation"
  )
  assert.match(
    detectorSection,
    /isGitInteractiveAuthCommand\(command\)[\s\S]*shouldFallbackToUnelevatedForNetworkAuth\(lowerOutput\)/,
    "Git credential and certificate failures should be routed to the no-sandbox prompt path"
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

test("approval requests do not auto-timeout and are cleaned up on run abort", () => {
  const runtimeApprovalSection = sectionBetween(
    runtimeSource,
    "  // ── Wire up the approval orchestrator ──",
    "  let systemPrompt = getSystemPrompt"
  )

  assert.match(
    runtimeApprovalSection,
    /const APPROVAL_TIMEOUT_MS: number \| null = null/,
    "command approval should default to no automatic timeout"
  )
  assert.doesNotMatch(
    runtimeApprovalSection,
    /5 \* 60 \* 1000|approval request timed out after/,
    "approval requests should not auto-reject after a fixed timeout"
  )
  assert.match(
    runtimeApprovalSection,
    /options\.abortSignal\?\.addEventListener\("abort", onAbort, \{ once: true \}\)/,
    "approval requests should subscribe to the run abort signal"
  )
  // On run abort: onAbort → rejectPending("abort") notifies the renderer on the
  // cancel channel, then resolveOnce removes the pending approval and resolves a
  // reject decision to unblock the orchestrator. (Coordinator V2 renamed the
  // thread id to approvalThreadId and factored the reject into rejectDecision.)
  assert.match(
    runtimeApprovalSection,
    /const onAbort = \(\): void => \{\s*rejectPending\("abort"\)/,
    "run abort should funnel through rejectPending(\"abort\")"
  )
  assert.match(
    runtimeApprovalSection,
    /`approval:cancel:\$\{approvalThreadId\}`/,
    "aborted runs should notify the renderer on the approval:cancel channel"
  )
  assert.match(
    runtimeApprovalSection,
    /const rejectDecision = \(\): ApprovalDecision => \(\{\s*type: "reject"/,
    "aborted runs should resolve a reject decision to unblock the orchestrator"
  )
  assert.match(
    runtimeApprovalSection,
    /pendingApprovals\.delete\(req\.id\)[\s\S]*resolve\(decision\)/,
    "resolving an approval should remove the pending entry before resolving the decision"
  )
})

test("pending command approvals can be restored after renderer reload", () => {
  const approvalListenerSection = sectionBetween(
    threadContextSource,
    "      const cancelledApprovalRequestIds = new Set<string>()",
    "      const cleanupUserInput = window.api.userInput.onRequest"
  )
  const cancelListenerIndex = approvalListenerSection.indexOf("const cleanupCancel = window.api.sandbox.onApprovalCancel")
  const restoreSnapshotIndex = approvalListenerSection.indexOf("getPendingApprovals(threadId)")

  assert.match(
    runtimeSource,
    /pendingApprovals = new Map<[\s\S]*threadId: string[\s\S]*targetWebContentsIds/,
    "pending approvals should retain their owning thread id"
  )
  assert.match(
    sandboxSource,
    /"sandbox:getPendingApprovals"[\s\S]*filter\(\(pending\) => pending\.threadId === threadId\)[\s\S]*map\(\(pending\) => pending\.request\)/,
    "sandbox IPC should expose current pending approvals scoped to the thread"
  )
  assert.match(
    preloadSource,
    /getPendingApprovals: \(threadId: string\)[\s\S]*"sandbox:getPendingApprovals"/,
    "preload should expose pending approval restoration to the renderer"
  )
  assert.match(
    threadContextSource,
    /getPendingApprovals\(threadId\)[\s\S]*normalizeApprovalPayload\(request\)[\s\S]*enqueuePendingApproval/,
    "thread context should restore pending approval cards when listeners are registered"
  )
  assert.match(
    threadContextSource,
    /onApprovalCancel\(threadId[\s\S]*removePendingApproval\(state\.pendingApprovals, data\.requestId\)[\s\S]*status: "interrupted"/,
    "thread context should clear approval cards when the backend cancels them"
  )
  assert.ok(
    cancelListenerIndex !== -1 && restoreSnapshotIndex !== -1 && cancelListenerIndex < restoreSnapshotIndex,
    "cancel listeners should be registered before pending approval snapshot restoration"
  )
  assert.match(
    approvalListenerSection,
    /cancelledApprovalRequestIds\.add\(data\.requestId\)[\s\S]*getPendingApprovals\(threadId\)[\s\S]*filter\(\(request\) => !cancelledApprovalRequestIds\.has\(getPendingApprovalId\(request\)\)\)/,
    "snapshot restoration should filter approvals cancelled while the snapshot request was in flight"
  )
  assert.match(
    approvalListenerSection,
    /getPendingApprovals\(threadId\)[\s\S]*if \(!initializedThreadsRef\.current\.has\(threadId\)\) return/,
    "late pending approval snapshots should not recreate cleaned-up thread state"
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
    /spawn\(shell, \[\], \{[\s\S]*windowsHide: !allowInteractiveGitAuth[\s\S]*spawn\(command, \{[\s\S]*windowsHide: !allowInteractiveGitAuth/,
    "raw shell execution should hide child windows except for interactive Git auth commands"
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

test("unsandboxed git network commands allow Git Credential Manager UI prompts", () => {
  const executeOnceSection = sectionBetween(
    localSandboxSource,
    "private executeOnce(",
    "  private formatOutput"
  )

  assert.match(
    localSandboxSource,
    /private static isGitInteractiveAuthCommand\(command: string\): boolean \{[\s\S]*git[\s\S]*pull\|fetch\|push\|clone\|submodule\|lfs/,
    "Git network commands should be recognized as credential-interactive commands"
  )
  assert.match(
    localSandboxSource,
    /private static buildInteractiveGitEnv\(env: NodeJS\.ProcessEnv\): NodeJS\.ProcessEnv \{[\s\S]*GCM_INTERACTIVE: "auto"[\s\S]*GCM_GUI_PROMPT: "1"[\s\S]*GIT_TERMINAL_PROMPT: "1"/,
    "unsandboxed Git auth should explicitly permit GCM GUI/interactive prompts"
  )
  assert.match(
    executeOnceSection,
    /const allowInteractiveGitAuth =[\s\S]*isWindows && LocalSandbox\.isGitInteractiveAuthCommand\(command\)[\s\S]*const spawnEnv = allowInteractiveGitAuth[\s\S]*LocalSandbox\.buildInteractiveGitEnv\(this\.env\)/,
    "executeOnce should opt Git network commands into the interactive credential environment"
  )
  assert.match(
    executeOnceSection,
    /windowsHide: !allowInteractiveGitAuth/,
    "Windows should not hide the shell process when Git Credential Manager may need to show UI"
  )
})

test("Windows command execution uses shell-compatible sandbox arguments and UTF-8 preambles", () => {
  const executeRawSection = sectionBetween(
    localSandboxSource,
    "private async executeRawUnserialized(",
    "  async executeRaw("
  )
  const sandboxArgsSection = sectionBetween(
    localSandboxSource,
    "    let sandboxArgs: string[]",
    "    // Elevated sandbox manages its own ACLs internally"
  )

  assert.match(
    executeRawSection,
    /LocalSandbox\.withWindowsShellUtf8Preamble\(command, shellBase\)/,
    "raw Windows execution should share the shell-compatible UTF-8 preamble helper"
  )
  assert.match(
    localSandboxSource,
    /private static withWindowsShellUtf8Preamble\(command: string, shellBase: string\): string \{[\s\S]*shellBase === "cmd"[\s\S]*chcp 65001 >nul & \$\{command\}/,
    "raw cmd.exe execution should keep using cmd-compatible UTF-8 setup"
  )
  assert.match(
    localSandboxSource,
    /private static windowsPowerShellUtf8Preamble\(\): string \{[\s\S]*chcp 65001 >\$null[\s\S]*\$ErrorActionPreference='Continue'[\s\S]*\$global:LASTEXITCODE=0/,
    "PowerShell UTF-8 setup should preserve native stderr without masking native exit codes"
  )
  assert.match(
    localSandboxSource,
    /private static windowsPowerShellExitCodePostamble\(\): string \{[\s\S]*\$__cmbLastSuccess=\$\?[\s\S]*\$__cmbLastExitCode=\$LASTEXITCODE[\s\S]*exit \$__cmbLastExitCode/,
    "PowerShell execution should propagate the native command's exit code when the final command fails"
  )
  assert.match(
    localSandboxSource,
    /shellBase === "pwsh" \|\| shellBase === "powershell"[\s\S]*LocalSandbox\.windowsPowerShellUtf8Preamble\(\)[\s\S]*LocalSandbox\.windowsPowerShellExitCodePostamble\(\)/,
    "raw PowerShell execution must use PowerShell-compatible UTF-8 setup"
  )
  assert.doesNotMatch(
    executeRawSection,
    /isWindows && !isBashLikeShell \? `chcp 65001 >nul &/,
    "raw PowerShell execution must not reuse cmd.exe's >nul & syntax"
  )
  assert.doesNotMatch(
    sandboxArgsSection,
    /"--full-auto"/,
    "Node-spawned packaged codex.exe rejects --full-auto in this argument layout; explicit sandbox config should be used instead"
  )
  assert.match(
    sandboxArgsSection,
    /windows\.sandbox="elevated"[\s\S]*sandbox_workspace_write\.network_access=true[\s\S]*windows\.sandbox="unelevated"/,
    "Windows sandbox args should still configure elevated/unelevated sandbox modes explicitly"
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
    /assessCommandSafety\(effectiveCommand/,
    "execute should keep using the central safety policy after PreToolUse command rewrites"
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
