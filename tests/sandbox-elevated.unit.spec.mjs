import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const localSandboxSource = readFileSync(
  new URL("../src/main/agent/local-sandbox.ts", import.meta.url),
  "utf8"
)
const sandboxSource = readFileSync(new URL("../src/main/ipc/sandbox.ts", import.meta.url), "utf8")
const execPolicySource = readFileSync(
  new URL("../src/main/agent/exec-policy.ts", import.meta.url),
  "utf8"
)
const windowsSafeCommandsSource = readFileSync(
  new URL("../src/main/agent/windows-safe-commands.ts", import.meta.url),
  "utf8"
)
const runtimeSource = readFileSync(new URL("../src/main/agent/runtime.ts", import.meta.url), "utf8")
const workflowEngineSource = readFileSync(
  new URL("../src/main/agent/workflow/engine.ts", import.meta.url),
  "utf8"
)
const workflowSubagentSource = readFileSync(
  new URL("../src/main/agent/workflow/subagent.ts", import.meta.url),
  "utf8"
)
const workflowRunStoreSource = readFileSync(
  new URL("../src/main/agent/workflow/run-store.ts", import.meta.url),
  "utf8"
)
const preloadSource = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8")
const threadContextSource = readFileSync(
  new URL("../src/renderer/src/lib/thread-context.tsx", import.meta.url),
  "utf8"
)
const codeExecRunnerSource = readFileSync(
  new URL("../src/main/code-exec/runner.ts", import.meta.url),
  "utf8"
)
const toolOrchestratorSource = readFileSync(
  new URL("../src/main/agent/tool-orchestrator.ts", import.meta.url),
  "utf8"
)
const workflowRunManagerSource = readFileSync(
  new URL("../src/main/agent/workflow/run-manager.ts", import.meta.url),
  "utf8"
)
const gitWorktreeSource = readFileSync(
  new URL("../src/main/services/git-worktree.ts", import.meta.url),
  "utf8"
)
const threadsSource = readFileSync(new URL("../src/main/ipc/threads.ts", import.meta.url), "utf8")
const modelsSource = readFileSync(new URL("../src/main/ipc/models.ts", import.meta.url), "utf8")
const storageSource = readFileSync(new URL("../src/main/storage.ts", import.meta.url), "utf8")
const agentIpcSource = readFileSync(new URL("../src/main/ipc/agent.ts", import.meta.url), "utf8")
const checkpointTranscriptSource = readFileSync(
  new URL("../src/shared/checkpoint-transcript.ts", import.meta.url),
  "utf8"
)
const workflowToolSource = readFileSync(
  new URL("../src/main/agent/workflow/tool.ts", import.meta.url),
  "utf8"
)
const workflowsIpcSource = readFileSync(
  new URL("../src/main/ipc/workflows.ts", import.meta.url),
  "utf8"
)
const workflowRunsDialogSource = readFileSync(
  new URL("../src/renderer/src/components/chat/WorkflowRunsDialog.tsx", import.meta.url),
  "utf8"
)
const workflowAgentStreamPanelSource = readFileSync(
  new URL("../src/renderer/src/components/chat/WorkflowAgentStreamPanel.tsx", import.meta.url),
  "utf8"
)

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start) : -1
  return source.slice(start, end === -1 ? undefined : end)
}

test("workspace:set validates elevated sandbox before committing global workspace", () => {
  const section = sectionBetween(
    modelsSource,
    '"workspace:set"',
    'ipcMain.handle("workspace:select"'
  )
  const awaitIndex = section.indexOf(
    "const ready = await prepareWorkspaceSelectionSandbox(newPath, parentWindow)"
  )
  const commitIndex = section.indexOf('store.set("workspacePath", newPath)')

  assert.ok(
    awaitIndex !== -1,
    "workspace:set should await sandbox preparation for global path changes"
  )
  assert.ok(commitIndex !== -1, "workspace:set should still persist the workspace on success")
  assert.ok(
    awaitIndex < commitIndex,
    "global workspace should only be persisted after sandbox validation succeeds"
  )
})

test("workspace:set validates elevated sandbox before updating thread metadata", () => {
  const section = sectionBetween(
    modelsSource,
    '"workspace:set"',
    'ipcMain.handle("workspace:select"'
  )
  const awaitIndex = section.indexOf(
    "const ready = await prepareWorkspaceSelectionSandbox(newPath, parentWindow)"
  )
  const metadataIndex = section.indexOf("metadata.workspacePath = newPath")

  assert.ok(
    awaitIndex !== -1,
    "workspace:set should await sandbox preparation before thread update"
  )
  assert.ok(metadataIndex !== -1, "workspace:set should still update thread metadata on success")
  assert.ok(
    awaitIndex < metadataIndex,
    "thread metadata should only change after sandbox validation succeeds"
  )
})

test("workspace:select validates elevated sandbox before committing selected workspace", () => {
  const section = sectionBetween(
    modelsSource,
    'ipcMain.handle("workspace:select"',
    'ipcMain.handle("workspace:loadFromDisk"'
  )
  const awaitIndex = section.indexOf(
    "const ready = await prepareWorkspaceSelectionSandbox(selectedPath, parentWindow)"
  )
  const metadataIndex = section.indexOf("metadata.workspacePath = selectedPath")
  const storeIndex = section.indexOf('store.set("workspacePath", selectedPath)')

  assert.ok(awaitIndex !== -1, "workspace:select should await sandbox preparation")
  assert.ok(metadataIndex !== -1, "workspace:select should still update thread metadata on success")
  assert.ok(
    storeIndex !== -1,
    "workspace:select should still persist the recent workspace on success"
  )
  assert.ok(
    awaitIndex < metadataIndex,
    "selected workspace must be validated before thread metadata changes"
  )
  assert.ok(
    awaitIndex < storeIndex,
    "selected workspace must be validated before recent-workspace persistence"
  )
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
  const forbiddenSyncFs =
    /\b(?:statSync|readdirSync|readFileSync|writeFileSync|mkdirSync|unlinkSync)\b/
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

  assert.notEqual(
    awaitLoadIndex,
    -1,
    "prepared-root saves should wait for the startup load promise"
  )
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
    /raceWithAbort\(\s*this\._sandboxCacheRootPromise[\s\S]*return this\._sandboxCacheRoot/,
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
    '    const isReadonly = effectiveMode === "readonly"'
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
  const resolvePythonIndex = preferUnelevatedSection.indexOf(
    "await LocalSandbox.resolvePythonDir()"
  )

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
    "createprocesswithlogonw failed" // domain-policy-blocked elevated sandbox (error 1385)
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
  const helperUseCount = (
    localSandboxSource.match(/encodingDetectionBuffer\(stdoutBuf, stderrBuf\)/g) || []
  ).length
  assert.ok(
    helperUseCount >= 2,
    `encodingDetectionBuffer should be used by both collectAndResolve paths (got ${helperUseCount})`
  )
})

test("error 1385 from CreateProcessWithLogonW gets a specific 'switch to unelevated' guidance prompt", () => {
  // Real failure output we observed on a domain-managed machine
  const sample =
    "[stderr] windows sandbox failed: CreateProcessWithLogonW failed: 1385\n[Command failed with exit code 1]"

  // Replicate the source helper to verify behaviour:
  function getSandboxBypassGuidance(output) {
    if (!output) return null
    const lower = output.toLowerCase()
    if (
      lower.includes("createprocesswithlogonw failed: 1385") ||
      (lower.includes("windows sandbox failed") && lower.includes("1385"))
    ) {
      return "elevated-1385" // sentinel for the test
    }
    return null
  }

  assert.equal(
    getSandboxBypassGuidance(sample),
    "elevated-1385",
    "1385 from CreateProcessWithLogonW should match"
  )
  assert.equal(getSandboxBypassGuidance(""), null, "empty output should not match")
  assert.equal(
    getSandboxBypassGuidance("Error: spawn EPERM"),
    null,
    "unrelated EPERM should not match"
  )

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
    '    const isWindows = process.platform === "win32"'
  )
  assert.doesNotMatch(
    rawExecutionSection,
    /executeRawUnserialized\(command, "none", timeoutMs, overrideAbortSignal\)/,
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
    '    const isReadonly = effectiveMode === "readonly"'
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
    "  async execute(",
    "  async approveFileOp("
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
    /safety\.level === "safe"[\s\S]*rawExecute\(command, sandboxMode, cwd\)[\s\S]*maybeRetryOutsideSandbox\(\s*command,\s*cwd,\s*sandboxMode,\s*result,\s*outsideShellSyntax\s*\)/,
    "safe commands should also be eligible for Codex-style sandbox bypass prompts after sandbox failure"
  )
  assert.match(
    orchestratorSection,
    /this\.yoloMode[\s\S]*rawExecute\(command, sandboxMode, cwd\)[\s\S]*maybeRetryOutsideSandbox\(\s*command,\s*cwd,\s*sandboxMode,\s*result,\s*outsideShellSyntax\s*\)/,
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
    /rawExecute\(command, "none", cwd\)/,
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
    {
      output: "error: cannot lock ref 'refs/remotes/origin/main': Permission denied",
      expect: true
    },
    {
      output: "Permission denied (publickey).\r\nfatal: Could not read from remote repository.",
      expect: true
    },
    { output: "EACCES: permission denied, open 'C:\\Users\\host\\.npmrc'", expect: true },
    { output: "OSError: [WinError 5] Access is denied: 'C:\\Windows\\Temp\\foo'", expect: true },
    { output: "[WinError 1314] A required privilege is not held by the client", expect: true },
    { output: "icacls: Access is denied.", expect: true },
    { output: "拒绝访问", expect: true },
    { output: "[Sandbox] command was blocked", expect: true }, // Codex's "sandbox" keyword
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
    "async executeBackground(command: string, cwd?: string)",
    "  /**\r\n   * Retrieve a background task's"
  )

  assert.match(
    backgroundSection,
    /this\.orchestrator[\s\S]*maybeRetryOutsideSandbox\(\s*effectiveCommand,\s*effectiveCwd,\s*this\.windowsSandbox,\s*rawResult,\s*outsideShellSyntax\s*\)/,
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
    /new ToolOrchestrator\(\s*approvalStore,\s*rawExecute,\s*requestApproval,\s*yoloMode[\s\S]*?\)[\s\S]*backend\.setOrchestrator\(orchestrator\)/,
    "runtime should always mount ToolOrchestrator and pass yoloMode into it"
  )
})

test("autoApproveFileEdits waives ONLY file-edit approval, never shell execute", () => {
  // Dynamic-workflow subagents set autoApproveFileEdits so background batch edits
  // don't re-prompt per file (the user already approved the whole workflow at
  // launch). The boundary must hold: file edits skip approval, but `execute`
  // (shell) stays gated. Lock it at the source so it can't be loosened later.

  // 1) File edits auto-approve when the flag is set.
  assert.match(
    toolOrchestratorSource,
    /if \(this\.yoloMode \|\| this\.autoApproveFileEdits\) return true/,
    "approveFileOp must skip approval when autoApproveFileEdits is set"
  )

  // 2) The execute() path must NOT consult autoApproveFileEdits — shell commands
  // are gated on yoloMode alone, so a workflow subagent still gets a shell prompt.
  const executeSection = sectionBetween(
    toolOrchestratorSource,
    "  async execute(",
    "  async approveFileOp("
  )
  assert.ok(
    !executeSection.includes("autoApproveFileEdits"),
    "execute() must not reference autoApproveFileEdits — shell must stay gated"
  )
  assert.match(
    executeSection,
    /if \(this\.yoloMode\) \{/,
    "execute() skips approval only in YOLO mode (not via autoApproveFileEdits)"
  )

  // 3) Only workflow subagents enable the flag (it defaults off everywhere else).
  assert.match(
    runtimeSource,
    /autoApproveFileEdits: true/,
    "the flag is enabled for workflow subagents"
  )
  assert.match(
    toolOrchestratorSource,
    /private autoApproveFileEdits: boolean = false/,
    "autoApproveFileEdits defaults to false (opt-in only)"
  )
})

test("thread delete settles the active workflow (bounded) BEFORE removing its run dir", () => {
  // cancelAndWait must not hang the threads:delete IPC if a subagent is slow to
  // honor abort — the wait is bounded by a timeout race.
  const cancelAndWaitSection = sectionBetween(
    workflowRunManagerSource,
    "async cancelAndWait(",
    "findPendingNotification("
  )
  assert.match(
    cancelAndWaitSection,
    /Promise\.race\(\[[\s\S]*entry\.settled[\s\S]*setTimeout\(resolve, timeoutMs\)[\s\S]*\]\)/,
    "cancelAndWait must bound the settle wait with a timeout race so delete can't hang"
  )

  // threads:delete must settle the active run (so its final flush completes)
  // BEFORE removing the run directory, or a late flush recreates it as an orphan.
  const cancelIdx = threadsSource.indexOf("await workflowRunManager.cancelAndWait(threadId)")
  const deleteIdx = threadsSource.indexOf("deleteWorkflowRunsForThread(workspacePath, threadId)")
  assert.ok(cancelIdx !== -1, "threads:delete must await cancelAndWait")
  assert.ok(deleteIdx !== -1, "threads:delete must remove the workflow run dir")
  assert.ok(
    cancelIdx < deleteIdx,
    "cancelAndWait (settle) must run BEFORE deleteWorkflowRunsForThread (rm)"
  )
})

test("cleanupThread tears down the workflow_progress RAF buffer (#2 ghost/leak)", () => {
  // A workflow_progress burst coalesces into a per-frame RAF flush. Deleting the
  // thread while a frame is still queued would fire flush → updateThreadState,
  // which resurrects the deleted thread as a ghost (prev[threadId] ||
  // createDefaultThreadState()). cleanupThread must cancel the queued RAF AND drop
  // the buffer entry.
  assert.match(
    threadContextSource,
    /const cleanupThread = useCallback\([\s\S]*?workflowProgressBufferRef\.current\.get\(threadId\)[\s\S]*?cancelAnimationFrame\([\s\S]*?workflowProgressBufferRef\.current\.delete\(threadId\)/,
    "cleanupThread cancels the queued workflow_progress RAF and deletes the buffer entry"
  )
  // And a drained buffer (events emptied, no frame pending) is removed inside flush
  // so finished/idle workflow threads don't retain an empty entry forever.
  assert.match(
    threadContextSource,
    /e\.rafId === null && e\.events\.length === 0\) buffer\.delete\(threadId\)/,
    "flush drops a drained workflow_progress buffer entry (no per-thread empty-entry leak)"
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
    'run abort should funnel through rejectPending("abort")'
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
  assert.match(
    runtimeApprovalSection,
    /const resolveOnce[\s\S]*if \(attentionRaised\)[\s\S]*action: "resolve"[\s\S]*key: `approval:\$\{req\.id\}`/,
    "approval attention should resolve from the shared resolveOnce lifecycle"
  )
  assert.doesNotMatch(
    sandboxSource,
    /pendingApprovals\.delete\(decision\.requestId\)/,
    "approval decision IPC should delegate cleanup to the shared approval resolver"
  )
})

test("pending command approvals can be restored after renderer reload", () => {
  const approvalListenerSection = sectionBetween(
    threadContextSource,
    "      const cancelledApprovalRequestIds = new Set<string>()",
    "      const cleanupUserInput = window.api.userInput.onRequest"
  )
  const cancelListenerIndex = approvalListenerSection.indexOf(
    "const cleanupCancel = window.api.sandbox.onApprovalCancel"
  )
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
    cancelListenerIndex !== -1 &&
      restoreSnapshotIndex !== -1 &&
      cancelListenerIndex < restoreSnapshotIndex,
    "cancel listeners should be registered before pending approval snapshot restoration"
  )
  assert.match(
    approvalListenerSection,
    /cancelledApprovalRequestIds\.add\(data\.requestId\)[\s\S]*getPendingApprovals\(threadId\)[\s\S]*filter\(\(request\) => !cancelledApprovalRequestIds\.has\(getPendingApprovalId\(request\)\)\)/,
    "snapshot restoration should filter approvals cancelled while the snapshot request was in flight"
  )
  assert.match(
    approvalListenerSection,
    /getPendingApprovals\(threadId\)[\s\S]*if \(!isCurrentListenerEpoch\(\)\) return/,
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
    "    const clearProxyPreamble =",
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

test("Windows sandbox keeps workspace root separate from command cwd", () => {
  const executionCwdPreambleSection = sectionBetween(
    localSandboxSource,
    "private static withWindowsExecutionCwdPreamble(",
    "  private isProjectPluginHookCommand("
  )
  const executeWindowsSection = sectionBetween(
    localSandboxSource,
    "private async executeInWindowsSandbox(",
    "  private executeOnce("
  )

  assert.match(
    executionCwdPreambleSection,
    /Set-Location -LiteralPath \$\{powershellSingleQuote\(executionCwd\)\} -ErrorAction Stop; \$\{command\}/,
    "PowerShell cwd preamble should fail fast when the requested execution cwd is missing"
  )
  assert.match(
    executeWindowsSection,
    /const executionCwd = this\.resolveExecutionCwd\(cwd\)[\s\S]*const sandboxWorkspaceRoot = path\.resolve\(this\.workingDir\)/,
    "Windows sandbox should track command cwd separately from the sandbox workspace root"
  )
  assert.match(
    executeWindowsSection,
    /new Set\(\s*\[\.\.\.executionPlan\.writableRoots,\s*executionCwd\]/,
    "skill cwd should be passed as an additional writable root instead of replacing the workspace"
  )
  assert.match(
    executeWindowsSection,
    /prewarmElevatedWorkspaceRoots\(\s*sandboxWorkspaceRoot,\s*sandboxWritableRoots\s*\)/,
    "elevated prewarm should prepare the real workspace plus extra writable roots"
  )
  assert.match(
    executeWindowsSection,
    /aclDirs\.push\(sandboxWorkspaceRoot, executionCwd\)/,
    "unelevated ACL grants should cover both workspace root and command cwd"
  )
  assert.match(
    executeWindowsSection,
    /withWindowsExecutionCwdPreamble\([\s\S]*executionCwd,[\s\S]*sandboxWorkspaceRoot/,
    "the shell command should cd into the requested command cwd inside the sandbox"
  )
  assert.match(
    executeWindowsSection,
    /spawn\(this\.codexExePath, sandboxArgs, \{[\s\S]*cwd: sandboxWorkspaceRoot/,
    "codex sandbox process should still be launched from the real workspace root"
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
  for (const variable of [
    "$null",
    "$true",
    "$false",
    "$_",
    "$psitem",
    "$pwd",
    "$home",
    "$psscriptroot",
    "$lastexitcode"
  ]) {
    assert.ok(
      variableSection.toLowerCase().includes(`"${variable}"`),
      `safe PowerShell automatic variable missing from whitelist: ${variable}`
    )
  }
})

test("sandbox execute safety checks do not synchronously spawn helper processes", () => {
  const executeSection = sectionBetween(
    localSandboxSource,
    "  async execute(command: string, cwd?: string): Promise<ExecuteResponse> {",
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
  const forbiddenSyncFs =
    /\b(?:existsSync|statSync|readFileSync|writeFileSync|readdirSync|mkdirSync|unlinkSync|accessSync)\b/

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

test("workflow notification turn auto-commits via a fresh snapshot, never a launch baseline", () => {
  // A background workflow shares the workspace with the user's concurrent
  // foreground edits, and auto-commit selects candidates by dirty-diff (not by
  // mutation tracking). Diffing a launch-time baseline against completion would
  // sweep the user's edits into the workflow's commit, so the launch-baseline
  // mechanism is removed entirely: the run's edits are left in the working tree
  // for the user to review, and the notification turn takes a normal fresh
  // snapshot like every other turn.
  assert.doesNotMatch(
    workflowRunManagerSource,
    /launchGitSnapshots|peekLaunchGitSnapshot|clearLaunchGitSnapshot|captureGitSnapshot/,
    "run manager must not retain any launch git snapshot machinery"
  )
  assert.doesNotMatch(
    workflowToolSource,
    /captureGitSnapshot/,
    "workflow tool must not forward a launch git snapshot capture"
  )
  assert.doesNotMatch(
    runtimeSource,
    /captureGitSnapshot/,
    "runtime must not wire a launch git snapshot capture"
  )
  assert.doesNotMatch(
    agentIpcSource,
    /workflowLaunchAutoCommitSnapshot|peekLaunchGitSnapshot|clearLaunchGitSnapshot/,
    "agent IPC must not reference any launch-baseline auto-commit machinery"
  )
  assert.doesNotMatch(
    threadsSource,
    /clearLaunchGitSnapshotsForThread/,
    "thread delete must not reference launch snapshot cleanup"
  )
  // The notification turn still auto-commits its own edits via a fresh snapshot.
  assert.match(
    agentIpcSource,
    /const autoCommit = await beginAutoCommitTracking\(threadId, workspacePath\)/,
    "notification turn takes a fresh auto-commit snapshot"
  )
})

test("workspace-switch/resume state-consistency: leave-while-switch orphan + resume stale flush-failed", () => {
  // #2: leaving workflow mode while ALSO switching workspacePath in one update must look the pending
  // run up in the CURRENT (old) workspace — that's where its files live. Using nextMetadata's NEW
  // path finds nothing → the leave is allowed → the pending run is orphaned. The leave guard's `wsp`
  // must prefer currentMetadata.workspacePath (mirrors the workspace-switch guard, which does too).
  assert.match(
    threadsSource,
    /const wsp =\s*typeof currentMetadata\.workspacePath === "string"/,
    "the leave-workflow-mode guard looks up the pending run in the CURRENT (old) workspace"
  )
  // #3: a fresh launch REUSES the runId on resume, so it must drop any stale flush-failed terminal
  // snapshot for that id — otherwise get-run/hydrate (which prefer getFlushFailedRun) keep showing the
  // OLD terminal run instead of the NEW active one (the disk re-persist may still be failing).
  assert.match(
    workflowRunManagerSource,
    /this\.dropFlushFailedRun\(request\.runId\)/,
    "launch() clears any stale flush-failed snapshot (and its disposal-epoch stamp, kept in lockstep) for the reused runId"
  )
})

test("workflow agent live stream guards a stale frame after a focus switch", () => {
  // P1: the live onWorkflowAgentStream callback writes the GLOBAL workflowAgentFocusSnapshot. A frame
  // can land after a fast focus switch but before unsubscribe, so it must re-check the FULL current
  // focus identity (threadId + runId + agentIndex — a cross-thread switch can collide on
  // runId/agentIndex) and skip the write if it changed. The guard MUST run BEFORE the write — else the
  // previous agent's frame pollutes the new panel (effect 2 only fills an `undefined` snapshot, so a
  // finished/no-sidecar agent would keep showing it). Source-asserted: the panel can't render in tsx.
  const cb = sectionBetween(
    workflowAgentStreamPanelSource,
    "onWorkflowAgentStream(focusThreadId",
    "})"
  )
  assert.match(
    cb,
    /const cur = useAppStore\.getState\(\)\.workflowAgentFocusView/,
    "the live callback reads the CURRENT focus"
  )
  const tIdx = cb.indexOf("cur?.threadId !== focusThreadId")
  const rIdx = cb.indexOf("cur?.runId !== focusRunId")
  const aIdx = cb.indexOf("cur?.agentIndex !== focusAgentIndex")
  const writeIdx = cb.indexOf("setWorkflowAgentFocusSnapshot")
  assert(
    tIdx > 0 && rIdx > 0 && aIdx > 0,
    "the guard re-checks the FULL focus identity: threadId + runId + agentIndex"
  )
  assert(
    Math.max(tIdx, rIdx, aIdx) < writeIdx,
    "the guard runs BEFORE setWorkflowAgentFocusSnapshot (a stale frame skips the write)"
  )
})

test("workflow agent finished-sidecar load re-checks live focus (passive-cleanup gap)", () => {
  // item1 follow-up: `cancelled` only catches frames that resolve AFTER React runs the effect's
  // PASSIVE cleanup. A focus switch updates the store synchronously but DEFERS that cleanup, so the
  // finished-agent getAgentToolStream() promise (or a fired retry) can resolve in the gap with
  // cancelled=false. It must re-check the LIVE focus before writing the GLOBAL snapshot — else agent
  // A's flow lands on agent B's panel and sticks. Source-asserted: the panel can't render in tsx.
  const src = workflowAgentStreamPanelSource
  assert.match(
    src,
    /const isStillFocused = \(\): boolean => \{/,
    "the finished-sidecar effect defines a live-focus re-check"
  )
  // The re-check must guard the AUTHORITATIVE write (...setWorkflowAgentFocusSnapshot(loaded)).
  const loadToWrite = sectionBetween(
    src,
    "getAgentToolStream(focusThreadId",
    "setWorkflowAgentFocusSnapshot(loaded)"
  )
  assert(
    loadToWrite.includes("cancelled || !isStillFocused()"),
    "the load .then re-checks focus BEFORE the authoritative snapshot write"
  )
})

test("workflow surfaces the real reason an invalid resumeFromRunId failed", () => {
  // #7: when only an invalid / unresolvable resumeFromRunId is passed, the error
  // must carry resolveResumeRun's note (invalid id / no journal), not the generic
  // "need a source" message — so a mid-tier model can self-correct.
  assert.match(
    workflowToolSource,
    /function resolveScriptSource\([\s\S]*?resumeNote\?: string/,
    "resolveScriptSource accepts the resume note"
  )
  assert.match(
    workflowToolSource,
    /resumeNote\s*\n?\s*\?\s*`\$\{resumeNote\}/,
    "the missing-source error prefers the resume note when present"
  )
  assert.match(
    workflowToolSource,
    /resolveScriptSource\(workspacePath, input, resume\.run\?\.script, resume\.note\)/,
    "the resume note is threaded into resolveScriptSource"
  )
})

test("workflow warns when the initial run state could not be persisted", () => {
  // #4: a failed initial persist must not be reported as a clean launch. The store
  // resolves whenInitialPersisted to a boolean; the tool warns when it's false (the
  // run executes in memory but isn't durable / resumable).
  assert.match(
    workflowRunStoreSource,
    /whenInitialPersisted: Promise<boolean>/,
    "run store reports whether the initial snapshot reached disk"
  )
  assert.match(
    workflowRunStoreSource,
    /if \(isInitial\) initialPersistOk = false/,
    "an initial write fault flips the persisted flag"
  )
  assert.match(
    workflowToolSource,
    /initialPersisted[\s\S]*?may not be resumable/,
    "the tool warns the user when the run isn't durable"
  )
})

test("workflow allows concurrent runs over the same workspace; workspace lock removed by design", () => {
  // The per-thread guard still serializes runs WITHIN one conversation, but the
  // workspace-level lock (refusing a second run on the same workspace from another
  // thread) was intentionally removed to match Claude Code desktop behavior. CC runs
  // concurrent workflows safely because each gets a git-worktree; cmbcowork has no
  // worktree, so the accepted trade-off is that two write-heavy runs touching the
  // same file can clobber each other — low-frequency and git-recoverable.
  // activeRunForWorkspace is KEPT (auto-commit still skips while ANY run is active on
  // the workspace), so the scan-by-canonical-key + realpath logic must remain.
  assert.match(
    workflowRunManagerSource,
    /activeRunForWorkspace\(workspacePath: string\)[\s\S]*?runKey === key \|\| isPathInside\(runKey, key\) \|\| isPathInside\(key, runKey\)/,
    "activeRunForWorkspace still scans active runs by canonical workspace key (used by auto-commit)"
  )
  assert.match(
    workflowRunManagerSource,
    /function workspaceKey\(p: string\)[\s\S]*?realpathSync\.native\(p\)/,
    "workspace key is realpath-canonicalized"
  )
  // launch() must NOT throw a workspace clash anymore — the lock is gone.
  assert.doesNotMatch(
    workflowRunManagerSource,
    /already running over this workspace/,
    "launch() no longer refuses a clashing workspace (workspace lock removed)"
  )
  assert.doesNotMatch(
    workflowToolSource,
    /already running over this workspace/,
    "tool entry no longer surfaces a workspace clash (workspace lock removed)"
  )
  // The intentional removal is documented in the source so it isn't re-added by mistake.
  assert.match(
    workflowRunManagerSource,
    /No workspace-level mutual exclusion/,
    "the removal is documented as an intentional design decision"
  )
  // The per-thread lock MUST remain (a single conversation still runs one at a time).
  assert.match(
    workflowRunManagerSource,
    /already running in this thread/,
    "per-thread lock is retained"
  )
})

test("workflow subagent hard-stops a hung stream via raceWithAbort", () => {
  // #2: a per-agent timeout / parent abort must unblock even if runtime.stream() or
  // its async iterator never honours the signal (a dead gateway). raceWithAbort
  // settles the race on abort so the subagent — and the engine awaiting it — unblock
  // instead of hanging the whole run on a dead stream.
  assert.match(
    workflowSubagentSource,
    /function raceWithAbort<T>\(work: Promise<T>, signal: AbortSignal\)/,
    "subagent defines a raceWithAbort hard-stop helper"
  )
  assert.match(
    workflowSubagentSource,
    /const onAbort = \(\): void => \{[\s\S]*?reject\(new Error\("aborted while awaiting stream"\)\)/,
    "raceWithAbort rejects on abort even while the work promise is still pending"
  )
  assert.match(
    workflowSubagentSource,
    /signal\.addEventListener\("abort", onAbort, \{ once: true \}\)/,
    "raceWithAbort registers the abort listener on the lifetime signal"
  )
  // BOTH the main turn and the structured-nudge turn must be wrapped.
  const wrapped = workflowSubagentSource.match(/raceWithAbort\(\s*\(async \(\) =>/g) || []
  assert.equal(wrapped.length, 2, "both stream consumptions are wrapped in raceWithAbort")
})

test("workflow persists the explicit resumed flag at launch (survives reload)", () => {
  // Resume is explicit rather than inferred only from the journal: isolated
  // worktrees deliberately are not journal-replayed, but resuming such a run
  // must still preserve its durable records and renderer status.
  assert.match(
    workflowRunManagerSource,
    /resumed: request\.resumed === true/,
    "launch persists the explicit resume state"
  )
  assert.match(
    workflowToolSource,
    /resumed: resume\.run !== null/,
    "workflow tool marks resume even when only durable worktrees are reused"
  )
})

test("workflow notification backlog drains: ack kicks the next pending run", () => {
  // A user can launch a second workflow while the first's completion report is
  // deferred (a settled run is no longer active, so launch isn't blocked),
  // leaving two undelivered terminal runs. findUndeliveredTerminalRun returns
  // newest-first, so acking the newest must kick the next still-pending run —
  // otherwise the older one is stranded until the next hydrate/reload.
  assert.match(
    workflowRunManagerSource,
    /kickNextPendingNotification\(workspacePath: string, threadId: string\): void/,
    "run manager exposes a backlog-draining kick"
  )
  assert.match(
    workflowRunManagerSource,
    /kickNextPendingNotification[\s\S]*?findPendingNotification\(workspacePath, threadId\)[\s\S]*?broadcast\(threadId, \{ type: "workflow_notification"/,
    "the kick re-broadcasts the next undelivered run's notification"
  )
  assert.match(
    agentIpcSource,
    /workflowRunManager\.kickNextPendingNotification\(settle\.workspacePath, threadId\)/,
    "the successful-ack path drains the next pending notification"
  )
})

test("workflow resume keeps an append-only journal (never wiped) for crash safety", () => {
  // #2: resume must NOT clear the journal. The old "read into memory → wipe disk →
  // rebuild" left a window where a crash mid-rebuild lost ALL cached results,
  // forcing every finished agent to re-run — and a file-editing subagent would
  // re-apply non-idempotent edits onto an already-modified workspace. Mirrors
  // MiMo-Code's append-only journal: keep it, cache hits don't re-append, only
  // live calls append (monotonic, no duplicates; a stale entry from a workspace-
  // state-dependent branch may linger harmlessly; a changed script/args drops the
  // journal upstream via effectiveResumeJournal=undefined in tool.ts).
  assert.doesNotMatch(
    workflowEngineSource,
    /resetJournal/,
    "engine must not wipe the journal on resume (append-only crash safety)"
  )
  // The store deep-copies its seed so a live append never mutates the caller's
  // journal object — two resumes seeded from one object would otherwise corrupt
  // each other now that the journal isn't reset.
  assert.match(
    workflowRunStoreSource,
    /const state: PersistedWorkflowRun = JSON\.parse\(JSON\.stringify\(initial\)\)/,
    "run store deep-copies the initial run so appends don't mutate the caller's journal"
  )
  // resetJournal is gone (dead once resume is append-only).
  assert.doesNotMatch(
    workflowRunStoreSource,
    /resetJournal/,
    "run store no longer exposes resetJournal (removed with append-only resume)"
  )
  // #3: persist the JOURNAL before run.json (both atomic tmp+rename). The journal is
  // resume's source of truth (replay by content hash), so a crash between the two
  // renames must leave journal>=run.json (resume re-runs nothing), never run.json>
  // journal (which would re-execute completed edit agents a second time).
  assert.match(
    workflowRunStoreSource,
    /rename\(`\$\{journalPath\}\.tmp`, journalPath\)[\s\S]{0,160}?rename\(`\$\{path\}\.tmp`, path\)/,
    "doWrite renames the journal before run.json (crash-safe resume ordering)"
  )
  assert.doesNotMatch(
    workflowRunStoreSource,
    /rename\(`\$\{path\}\.tmp`, path\)[\s\S]{0,160}?rename\(`\$\{journalPath\}\.tmp`, journalPath\)/,
    "run.json is never renamed before the journal (would let resume re-run completed agents)"
  )
})

test("workflow file reads/writes guard non-regular files (FIFO/device) before touching them", () => {
  // #8: reading/writing a FIFO/socket/device blocks (the other end never comes),
  // and a SYNC read of one freezes the Electron main process. Every path that
  // opens a script/guest path must isFile()-guard first. Behavior tests cover the
  // guest readFile/writeFile and the child workflow scriptPath; the top-level
  // scriptPath runs through tool.func (no engine harness), so it's locked here by
  // source.
  assert.match(
    workflowToolSource,
    /const st = statSync\(resolved\)[\s\S]*?if \(!st\.isFile\(\)\)/,
    "top-level scriptPath isFile-guards before the synchronous readFileSync"
  )
  // engine guards all three of its paths: guest readFile, child workflow
  // scriptPath, and guest writeFile.
  const engineGuards = (workflowEngineSource.match(/\.isFile\(\)/g) ?? []).length
  assert(
    engineGuards >= 3,
    `engine isFile-guards readFile + child scriptPath + writeFile (>=3), got ${engineGuards}`
  )
})

test("edit-and-resume sidecar sweep runs AFTER approval-reject and BEFORE launch", () => {
  // P2: clearAllAgentToolStreams deletes the prior run's tool-stream sidecars on a journal-dropping
  // resume (reused runId, new callHashes). It MUST sit AFTER the approval-reject return — a rejected
  // edit-and-resume must NOT destroy the prior run's still-in-history tool stream — and BEFORE launch
  // (no new sidecar exists yet to race). tool.func imports electron and can't be unit-run, so the
  // call ORDER is locked here by source position. (The sweep's glob scope is behavior-tested in
  // workflow-engine: testClearAllAgentToolStreamsSweepsRunIdSidecars.)
  const rejectReturnAt = workflowToolSource.indexOf('status: "rejected"')
  const sweepAt = workflowToolSource.indexOf("clearAllAgentToolStreams(workspacePath")
  const launchAt = workflowToolSource.indexOf("workflowRunManager.launch(")
  assert(
    rejectReturnAt > 0 && sweepAt > 0 && launchAt > 0,
    "approval-reject, sweep, and launch anchors are all present in tool.ts"
  )
  assert(
    rejectReturnAt < sweepAt,
    "sweep must run AFTER the approval-reject return — a rejected edit-and-resume must not delete history"
  )
  assert(sweepAt < launchAt, "sweep must run BEFORE launch (no new sidecar exists yet to race)")
  // ...and the sweep itself must NOT block the launch on display I/O (run-store:253 — hung writes
  // stall only the sidecar chain, never the run). It is SYNC (void), and in-flight writes get an
  // ORDERED delete on the op chain (enqueueAgentSidecarOp) — never an awaited Promise.allSettled.
  assert.match(
    workflowRunStoreSource,
    /export function clearAllAgentToolStreams\([\s\S]*?\): void \{/,
    "clearAllAgentToolStreams is sync (void) — it can't await/block the launch on display I/O"
  )
  assert.match(
    workflowRunStoreSource,
    /clearAllAgentToolStreams[\s\S]*?enqueueAgentSidecarOp\(opPath/,
    "in-flight writes get an ordered op-chain delete (handles revival without blocking the launch)"
  )
})

test("workflow approval fingerprint distinguishes undefined args from explicit null", () => {
  // P2: "no args" (undefined) and explicit `args: null` are DIFFERENT approvals —
  // a script reads `args === undefined` vs `=== null` differently, so a prior
  // "no args" approve_session must NOT silently cover a later explicit-null launch.
  // The fingerprint must not fold them via `?? null` (mirrors the journal-
  // invalidation fix; tool.func itself can't be unit-tested — it imports electron).
  assert.doesNotMatch(
    workflowToolSource,
    /argsFingerprint = sha256Hex\(JSON\.stringify\(args \?\? null\)\)/,
    "approval fingerprint must not collapse undefined/null via ?? null"
  )
  assert.match(
    workflowToolSource,
    /args === undefined \? "undefined" : JSON\.stringify\(args\)/,
    "approval fingerprint distinguishes undefined args from explicit null"
  )
})

test("workflow approve_session folds in the session-default model (#1 approve_session)", () => {
  // A no-model agent() runs on the session default; switching it changes what runs /
  // costs. A prior "approve for this session" must NOT silently waive the prompt for
  // a DIFFERENT default — fold the model into the approval pattern key, mirroring the
  // engine's resume callHash.
  assert.match(
    workflowToolSource,
    /patternKey = `workflow:launch:[\s\S]*?:m=\$\{options\.modelId \?\? "default"\}`/,
    "approve_session pattern key includes the session-default model"
  )
})

test("workflow approval card surfaces the tokenBudget value (#7)", () => {
  // tokenBudget is folded into the approve_session key, but the card must also SHOW it
  // (args + reason) so the user — including on approve_session reuse — sees the actual
  // budget cap, not just a vague "consumes tokens" note.
  assert.match(
    workflowToolSource,
    /argsPreview,\s*\n\s*tokenBudget/,
    "approval card args include tokenBudget"
  )
  assert.match(
    workflowToolSource,
    /Token 预算上限/,
    "approval card reason surfaces the actual token budget value"
  )
})

test("user-pasted V1 workflow marker is de-weaponized, not swallowed (#5)", () => {
  // The renderer + export path PREFIX-hide any message starting with the V1
  // notification marker (it carries a runId, so they can't full-match it). The main
  // process must neutralize a USER message starting with that marker into ordinary
  // text — exactly as it already does for the TURN trigger — or the user's pasted
  // text silently vanishes from the UI and exports.
  assert.match(
    checkpointTranscriptSource,
    /startsWith\(WORKFLOW_NOTIFICATION_MARKER_PREFIX\)/,
    "shared transcript guard neutralizes a user message starting with the V1 marker"
  )
  assert.match(
    checkpointTranscriptSource,
    /resembles an internal workflow marker\. Treat it as ordinary user input/,
    "the de-weaponized text is relabelled as ordinary user input"
  )
  assert.match(
    agentIpcSource,
    /effectiveMessage = neutralizeWorkflowPlumbingUserText\(effectiveMessage\)/,
    "ordinary sends apply the shared workflow marker guard"
  )
  assert.match(
    agentIpcSource,
    /displayContent: neutralizeWorkflowPlumbingUserText\(/,
    "current-run guided messages apply the same visible transcript guard"
  )
})

test("workflow script writeFile shares the run-level write lock with subagent tool writes (#2)", () => {
  // Script writeFile() used its own fileWriteChain while subagent tool writes used
  // the threadId tool-concurrency lock — two silos that could clobber the same file
  // on a concurrent script+agent write. runtime injects the SAME lock
  // (getToolConcurrencyLock(threadId).write); the engine's writeFile routes through
  // it; run-manager threads it down.
  assert.match(
    runtimeSource,
    /runExclusiveFileWrite:[\s\S]*?getToolConcurrencyLock\(threadId\)\.write\(fn\)/,
    "runtime injects the threadId write lock as the workflow's runExclusiveFileWrite"
  )
  assert.match(
    workflowEngineSource,
    /context\.runExclusiveFileWrite/,
    "engine writeFile routes through the injected run-level write lock"
  )
  assert.match(
    workflowRunManagerSource,
    /runExclusiveFileWrite: request\.runExclusiveFileWrite/,
    "run-manager threads the write lock into the engine"
  )
})

test("auto-commit failure is reported to the renderer as 'failed', not silently swallowed (#2)", () => {
  assert.match(
    agentIpcSource,
    /\[AutoCommit\] finalize failed[\s\S]*?sendAutoCommitResult\(window, channel, \{[\s\S]*?status: "failed"/,
    "a finalize failure sends status 'failed' (a real error, not a deliberate skip)"
  )
})

test("workflow journal sidecar is written atomically (tmp+rename)", () => {
  // #5: the journal sidecar must be tmp+rename like run.json — a torn overwrite on
  // crash would otherwise return an empty journal on resume, losing the replay cache.
  assert.match(
    workflowRunStoreSource,
    /writeFile\(`\$\{journalPath\}\.tmp`[\s\S]*?rename\(`\$\{journalPath\}\.tmp`, journalPath\)/,
    "journal sidecar uses tmp+rename (atomic), not a direct overwrite"
  )
})

test("workflow approval card shows the FULL script (no truncation)", () => {
  // #6: the approval card is a security gate; an inline script has no scriptPath to
  // review at approval time, so the preview must be the WHOLE script, not truncated.
  assert.match(workflowToolSource, /scriptPreview: script,/, "approval shows the full script")
  assert.doesNotMatch(
    workflowToolSource,
    /script\.length > 20_000/,
    "approval no longer truncates the script preview"
  )
})

test("workflow settle reports + retries a failed final persist (no stale notification)", () => {
  // #4: flush() reports success now; settle must retry once and log loudly on a
  // failed final persist instead of broadcasting a notification over a stale run.
  assert.match(
    workflowRunStoreSource,
    /flush\(\): Promise<boolean>/,
    "flush reports persist success/failure"
  )
  assert.match(
    workflowRunManagerSource,
    /const finalPersisted = \(await runStore\.flush\(\)\) \|\| \(await runStore\.flush\(\)\)/,
    "settle retries the final flush once"
  )
  assert.match(
    workflowRunManagerSource,
    /if \(!finalPersisted\)[\s\S]*?could NOT be persisted/,
    "settle logs loudly when the final persist fails"
  )
  const fallbackPublishedAt = workflowRunManagerSource.indexOf(
    "this.flushFailedRuns.set(request.runId"
  )
  const lifecycleRemovedAt = workflowRunManagerSource.indexOf(
    "this.active.delete(request.threadId)"
  )
  assert(
    fallbackPublishedAt >= 0 && lifecycleRemovedAt >= 0 && fallbackPublishedAt < lifecycleRemovedAt,
    "terminal fallback is published before the active lifecycle entry is removed"
  )
})

test("workflow notification reads an in-memory snapshot when final persist failed", () => {
  // #4 (memory read): a failed final persist leaves a stale on-disk run (maybe still
  // "running" and invisible to the disk scan), so the notification must read the
  // in-memory snapshot of the true terminal state instead — then drop it on ack.
  assert.match(
    workflowRunManagerSource,
    /private readonly flushFailedRuns = new Map<string, PersistedWorkflowRun>\(\)/,
    "run manager keeps an in-memory snapshot map for failed final persists"
  )
  assert.match(
    workflowRunManagerSource,
    /if \(!finalPersisted\)[\s\S]*?this\.flushFailedRuns\.set\(/,
    "a failed final persist stores the terminal snapshot"
  )
  assert.match(
    workflowRunManagerSource,
    /findPendingNotification[\s\S]*?for \(const snapshot of this\.flushFailedRuns\.values\(\)\)/,
    "findPendingNotification prefers the in-memory snapshot over the stale disk copy"
  )
  assert.match(
    agentIpcSource,
    /recoverFlushFailedRun\(\s*settle\.workspacePath/,
    "on ack, a flush-failed run's true state is written back to disk (and the snapshot dropped)"
  )
})

test("flush-failed-run snapshot handles the cancel + zombie-reconcile boundaries (#4)", () => {
  // Boundary #1: a user-cancelled run must NOT get a snapshot (it's never reported),
  // else findPendingNotification would re-surface and wrongly report it.
  assert.match(
    workflowRunManagerSource,
    /if \(!entry\.userCancelled && !finalPersisted\)[\s\S]*?flushFailedRuns\.set\(/,
    "flush-failed snapshot is stored only for non-cancelled runs"
  )
  assert.match(
    workflowRunManagerSource,
    /!snapshot\.notificationDelivered/,
    "an already-delivered snapshot is not re-reported (write-back-retry case)"
  )
  // Boundary #2: a flush-failed run actually finished — zombie reconcile must serve
  // its in-memory snapshot, not flip the stale "running" disk copy to "aborted".
  assert.match(
    workflowRunManagerSource,
    /getFlushFailedRun\(runId: string\): PersistedWorkflowRun \| undefined/,
    "run manager exposes the snapshot for zombie reconciliation"
  )
  assert.match(
    workflowsIpcSource,
    /!workflowRunManager\.getFlushFailedRun\(s\.runId\)/,
    "list-runs does NOT reconcile a flush-failed run to aborted"
  )
  assert.match(
    workflowsIpcSource,
    /const recovered = workflowRunManager\.getFlushFailedRun\(runId\)[\s\S]*?if \(recovered\?\.threadId === threadId\)[\s\S]*?retryPersistFlushFailedRun\(workspacePath, threadId, runId\)[\s\S]*?return stripJournalForRenderer\(recovered\)/,
    "get-run serves and retries only an in-memory snapshot owned by the requested thread"
  )
  // ack writes the true terminal state back to disk (disk may have recovered),
  // carrying the capture-time disposal epoch so a snapshot from a deleted (then
  // revived) incarnation is dropped instead of rebuilding the swept run dir.
  assert.match(
    workflowRunManagerSource,
    /persistCurrentFlushFailedRun[\s\S]*?persistRecoveredRun\(\s*workspacePath,\s*threadId,\s*frozen,\s*this\.flushFailedEpochs\.get\(runId\)\s*\)[\s\S]*?flushFailedRevisions\.get\(runId\)[\s\S]*?dropFlushFailedRun\(runId\)/,
    "recoverFlushFailedRun writes the snapshot back to disk on ack, epoch-fenced"
  )
  assert.match(
    workflowRunManagerSource,
    /async recoverFlushFailedRun[\s\S]*?this\.persistCurrentFlushFailedRun\(workspacePath, threadId, runId\)/,
    "the ack path uses the revision-fenced write-back helper"
  )
  // The snapshot keeps the FULL journal (writing an empty one would wipe the resume
  // cache); the real behavior is covered by testPersistRecoveredRunKeepsJournal.
  assert.match(
    workflowRunManagerSource,
    /flushFailedRuns\.set\(request\.runId, JSON\.parse\(JSON\.stringify\(runStore\.state\)\)\)/,
    "flush-failed snapshot keeps the full run incl. journal (no data loss on write-back)"
  )
  // list-runs shows the in-memory terminal summary, not the stale "running" disk row.
  assert.match(
    workflowsIpcSource,
    /const overlays = workflowRunManager\.listFlushFailedRuns\(threadId\)\.map\(toRunSummary\)[\s\S]*?listWorkflowRunsPage\([\s\S]*?overlays/,
    "list-runs surfaces the flush-failed run's true terminal summary"
  )
  // ack kicks the backlog when EITHER delivered persisted or the flush-failed
  // snapshot path says something still wants reporting (memory-first drain).
  assert.match(
    agentIpcSource,
    /if \(delivered \|\| shouldKickPendingDrain\)/,
    "ack drains the notification backlog after a successful write-back too"
  )
  // #5: flushFailedRuns has a SOFT cap (best-effort; each snapshot holds a full
  // journal). Only already-delivered snapshots are evicted, so it can exceed the cap
  // rather than ever drop an unreported result.
  assert.match(
    workflowRunManagerSource,
    /const MAX_FLUSH_FAILED_RUNS = \d+/,
    "the flush-failed snapshot map has a soft cap (best-effort, never drops an unreported result)"
  )
  assert.match(
    workflowRunManagerSource,
    /size > MAX_FLUSH_FAILED_RUNS[\s\S]*?snap\.notificationDelivered && !this\.inFlightNotifications\.has\(id\)[\s\S]*?this\.dropFlushFailedRun\(id\)/,
    "cap evicts ONLY an already-delivered, not-in-flight snapshot (never drops an unreported result)"
  )
})

test("agent tool-stream sidecar: a re-run clears the stale sidecar, OFF the run's critical path", () => {
  // resume REUSES the runId; the runner clears any prior sidecar at re-run start — but
  // FIRE-AND-FORGET (void, never awaited), so display I/O can't block the agent even if a prior
  // write hangs (the cardinal rule: display-only must never affect the run). clear internally
  // awaits any in-flight write so a late rename can't resurrect the file; on a normal disk it
  // finishes in ms, before this agent's finish-write, so it still wins the ordering.
  // Behavior-tested end-to-end in workflow-engine.spec (testAgentToolStreamStaleSidecarKilled).
  assert.match(
    workflowRunManagerSource,
    /void clearAgentToolStream\(/,
    "the subagent runner fires clearAgentToolStream fire-and-forget (never blocks the run)"
  )
  assert.doesNotMatch(
    workflowRunManagerSource,
    /await clearAgentToolStream\(/,
    "clear is NOT awaited on the run's critical path (display-only must never block the run)"
  )
})

test("agent tool-stream sidecar is written atomically (tmp+rename), like run.json/journal", () => {
  // A direct writeFile leaves a half-written .toolstream on a crash mid-write (reader chokes /
  // file permanently unopenable) and a torn read under concurrency. tmp+rename makes a reader
  // see old-or-new, never partial; a crash leaves only a stray .tmp (swept by prune).
  assert.match(
    workflowRunStoreSource,
    /writeFile\(`\$\{path\}\.tmp`, payload\)[\s\S]*?rename\(`\$\{path\}\.tmp`, path\)/,
    "persistAgentToolStream writes <path>.tmp then renames it into place (atomic)"
  )
  assert.match(
    workflowRunStoreSource,
    /file\.endsWith\("\.toolstream"\) \|\| file\.endsWith\("\.toolstream\.tmp"\)/,
    "prune sweeps a crash-left .toolstream.tmp alongside the sidecar"
  )
})

test("agent tool-stream sidecar ops are serialized on a per-path chain (deterministic ordering)", () => {
  // Determinism without blocking the run: clear and write are enqueued on ONE per-path chain, so
  // the order is always write(old) → clear → write(new). clear can't delete this run's write, and
  // a prior write's late rename can't resurrect a cleared file — by ordering, with no awaited I/O
  // on the run's path. Behavior-tested in workflow-engine.spec (testAgentToolStreamStaleSidecarKilled).
  assert.match(
    workflowRunStoreSource,
    /function enqueueAgentSidecarOp\(/,
    "run-store has a per-path sidecar op chain"
  )
  assert.match(
    workflowRunStoreSource,
    /clearAgentToolStream[\s\S]*?return enqueueAgentSidecarOp\(/,
    "clear is enqueued on the chain (ordered after any in-flight write, before the next write)"
  )
})

test("agent tool-stream sidecar is keyed by the COMPOSITE callHash+callIndex, resolved from agentIndex", () => {
  // P1: agentIndex shifts across resume; callHash alone collides for same-prompt agents; callIndex
  // alone collides across a cache-hit/live-miss resume (a new live agent reuses an index a cached
  // agent also carries). So the sidecar key is the COMPOSITE <callHash>_c<callIndex>: callHash
  // separates different agents on the same index, callIndex separates same-prompt instances, and a
  // cached agent uses its ORIGINAL callIndex. The reader maps agentIndex → toolStreamKey via the
  // persisted run. Behavior-tested in workflow-engine.spec (Case F: same callIndex, diff callHash).
  assert.match(
    workflowEngineSource,
    /liveToolStreamKey = `\$\{callHash\}_c\$\{callIndex\}`/,
    "the engine builds the sidecar key from callHash + callIndex (so a same-index collision differs by callHash)"
  )
  assert.match(
    workflowEngineSource,
    /toolStreamKey: `\$\{callHash\}_c\$\{cached\.index\}`/,
    "a cached agent keys by callHash + its ORIGINAL callIndex (reads its own flow, never a live agent's)"
  )
  assert.match(
    workflowRunStoreSource,
    /function agentToolStreamSuffix\(toolStreamKey: string\)/,
    "the sidecar filename is the composite key string, not a bare index"
  )
  assert.match(
    workflowsIpcSource,
    /run\?\.agents\.find\(\(agent\) => agent\.index === agentIndex\)\?\.toolStreamKey/,
    "get-agent-toolstream resolves the requested agentIndex → the agent's composite toolStreamKey"
  )
})

test("opening a running agent gets an immediate catch-up snapshot (no blank wait)", () => {
  // values frames arrive only per super-step, so a viewer who opens an agent mid-(long)-tool
  // call would otherwise see "waiting" until the next frame. main remembers the latest frame
  // per agent (even when unwatched) and replays it to a newly-interested webContents on
  // interest registration; the entry is dropped when the agent finishes (sidecar authoritative).
  assert.match(
    workflowRunManagerSource,
    /agentLatestSnapshot\.set\(interestKey, \{ snapshot, label \}\)/,
    "every frame remembers the latest snapshot for catch-up (even when nobody is watching yet)"
  )
  assert.match(
    workflowRunManagerSource,
    /const latest = agentLatestSnapshot\.get\(key\)[\s\S]*?sendAgentSnapshotTo\(/,
    "registering interest replays the latest remembered frame to the newly-interested webContents"
  )
  assert.match(
    workflowRunManagerSource,
    /agentLatestSnapshot\.delete\(/,
    "the catch-up snapshot is dropped when the agent finishes (no per-finished-agent retention)"
  )
})

test("workflow runs-history dialog can open a finished agent's tool stream", () => {
  // The sidecar + IPC existed but the history dialog had no entry, so once the live panel was
  // cleared a finished agent's tool stream was unreachable. AgentDetail now opens the focused
  // view (which loads the sidecar) keyed by the run's threadId/runId/agentIndex, and closes
  // the dialog so the panel behind it is visible.
  assert.match(
    workflowRunsDialogSource,
    /openWorkflowAgentFocusView\(\{[\s\S]*?agentIndex: agent\.index[\s\S]*?\}\)[\s\S]*?onClose\(\)/,
    "AgentDetail opens the focused tool-stream view for the historical agent, then closes the dialog"
  )
})

test("flush-failed run with NO disk file is still surfaced in history + hydrate (#5)", () => {
  // A run whose INITIAL persist also failed has only an in-memory snapshot (no disk
  // file), so a disk-only listing hides exactly the disk-fault case most needing
  // triage. run-manager lists the memory-only snapshots; list-runs appends the ones
  // absent from disk; hydrate falls back to the newest when disk has none.
  assert.match(
    workflowRunManagerSource,
    /listFlushFailedRuns\(threadId: string\): PersistedWorkflowRun\[\][\s\S]*?snap\.threadId === threadId/,
    "run-manager lists memory-only flush-failed snapshots filtered by thread"
  )
  assert.match(
    workflowsIpcSource,
    /listFlushFailedRuns\(threadId\)\.map\(toRunSummary\)[\s\S]*?listWorkflowRunsPage\([\s\S]*?overlays/,
    "list-runs appends memory-only snapshots that are absent from the disk listing"
  )
  assert.match(
    workflowsIpcSource,
    /const latestPage = await listWorkflowRunsPage\(workspacePath, threadId, \{[\s\S]*?overlays[\s\S]*?const latestRunId = activeRunId \?\? latestPage\.runs\[0\]\?\.runId/,
    "hydrate picks the newest overlay-aware page entry, so a memory-only snapshot can beat a stale disk run"
  )
})

test("deleting a thread clears its in-memory flush-failed snapshots (#3 main-process leak)", () => {
  // cancelAndWait only aborts the active run; a run whose persist failed lives ONLY in
  // run-manager's flushFailedRuns (full journal) and would leak in the main process
  // until restart after the thread is deleted. forgetThread drops it by threadId.
  assert.match(
    workflowRunManagerSource,
    /forgetThread\(threadId: string\): void[\s\S]*?snap\.threadId === threadId[\s\S]*?this\.dropFlushFailedRun\(runId\)/,
    "run-manager.forgetThread drops a deleted thread's in-memory flush-failed snapshots (by threadId)"
  )
  assert.match(
    threadsSource,
    /workflowRunManager\.forgetThread\(threadId\)/,
    "threads:delete calls forgetThread to clear the main-process snapshot table"
  )
})

test("flush-failed snapshot gets a real write-back retry on read paths, not just on ack (#3 closure)", () => {
  // #3: recoverFlushFailedRun fires once, on notification ack. If that write-back also
  // fails (disk still full) the snapshot is stranded in memory until restart — and a
  // restart loses it, so the stale "running" disk row resurfaces. The READ paths
  // (get-run / hydrate) therefore retry the write-back whenever they serve a snapshot
  // (the disk may have recovered since); the retry drops the snapshot on success and
  // does NOT touch notificationDelivered (the ack owns that flag).
  assert.match(
    workflowRunManagerSource,
    /async retryPersistFlushFailedRun\([\s\S]*?return this\.persistCurrentFlushFailedRun\(workspacePath, threadId, runId\)/,
    "run manager exposes a read-path write-back retry that drops the snapshot on success"
  )
  assert.match(
    workflowsIpcSource,
    /retryPersistFlushFailedRun\(workspacePath, threadId, runId\)/,
    "get-run retries the disk write-back when serving a snapshot"
  )
  assert.match(
    workflowsIpcSource,
    /retryPersistFlushFailedRun\(workspacePath, threadId, latestRunId\)/,
    "hydrate retries the disk write-back when serving a snapshot"
  )
})

test("workflow notification turn is recognized on a FULL prompt match, not just the prefix (#1)", () => {
  // #1: a user can paste the short TRIGGER prefix (from a log / code sample); only the
  // FULL prompt is treated as internal plumbing, so a pasted prefix is neutralized as
  // ordinary text instead of being silently swallowed. The full-match compare now lives
  // in the shared helper isWorkflowNotificationTurnMessage (workflow/notification.ts),
  // whose behavior is pinned by a workflow-engine test; here we pin that agent.ts
  // recognition actually routes through that helper instead of a drift-prone
  // hand-rolled compare.
  assert.match(
    agentIpcSource,
    /matchesWorkflowNotificationPrompt = isWorkflowNotificationTurnMessage\(message\)/,
    "an internal workflow turn requires the shared full-match helper"
  )
  assert.match(
    agentIpcSource,
    /matchesWorkflowNotificationPrompt &&\s+getAgentModeFromMetadata\(metadata\) === "workflow"/,
    "the full-match gate is combined with workflow agent mode"
  )
})

test("auto-commit is skipped while background work is active on the thread (#3)", () => {
  // #3: background work (a dynamic workflow OR a coordinator/agent-team worker)
  // writes the workspace asynchronously; a dirty-diff auto-commit during a turn
  // with active background work could sweep its in-progress edits (meant to stay
  // in the working tree for review) into the commit. Skip auto-commit while such
  // work is active — its own completion/notification turn runs after it settles,
  // so the running-check is false there and that turn commits normally.
  assert.match(
    agentIpcSource,
    /workspacePath && workflowRunManager\.activeRunForWorkspace\(workspacePath\)/,
    "finalizeAutoCommit skips at WORKSPACE level (covers a workflow on another thread, same workspace)"
  )
  assert.match(
    agentIpcSource,
    /activeRunForWorkspace\(workspacePath\)[\s\S]*?workflowRunManager\.isActive\(threadId\)[\s\S]*?status: "skipped"/,
    "with an isActive(threadId) fallback, then skips"
  )
  assert.match(
    agentIpcSource,
    /workflowRunManager\.isActive\(threadId\)[\s\S]*?coordinatorWorkerManager\.hasRunningWorkersForThread\(threadId\)[\s\S]*?status: "skipped"/,
    "also skips while a coordinator worker is still writing the shared workspace"
  )
  assert.match(
    agentIpcSource,
    /coordinatorWorkerManager\.hasRunningWorkersForWorkspace\(workspacePath\)[\s\S]*?status: "skipped"/,
    "and skips at WORKSPACE level too (a worker on another task/thread, same repo)"
  )
  assert.match(
    agentIpcSource,
    /workflowRunManager\.hasDeliverablePendingNotification\(workspacePath, threadId\)[\s\S]*?status: "skipped"/,
    "and skips a FAST workflow's undelivered edits (honors 'leave for review'); the delivered run is already markNotified before finalize, so no turn-type guard is needed"
  )
})

test("only source-mutating worktree merge uses the workspace integration guard", () => {
  assert.doesNotMatch(
    agentIpcSource,
    /tryWithWorkspaceIntegrationLease/,
    "worktree integration must not hold a product-wide lease across ordinary auto-commit UI"
  )
  assert.match(
    workflowsIpcSource,
    /if \(payload\.action === "diff"\)[\s\S]*?else if \(payload\.action === "discard"\)[\s\S]*?else if \(payload\.action === "cleanup"\)[\s\S]*?else \{[\s\S]*?withWorkspaceIntegrationLease/,
    "diff/discard/cleanup must not occupy the source-integration lease"
  )
  assert.match(
    workflowsIpcSource,
    /withWorkspaceIntegrationLease\(\s*record\.sourceRoot,\s*`ui:\$\{payload\.threadId\}:\$\{payload\.runId\}`/,
    "merge alone must serialize the shared source checkout mutation"
  )
})

test("isolated worktree provisioning requires the durable run index", () => {
  assert.match(
    workflowRunManagerSource,
    /!\(await runStore\.whenInitialPersisted\)[\s\S]{0,120}!runStore\.isCurrentSnapshotPersisted\(\)[\s\S]{0,500}entry\.worktrees\.acquire/,
    "worktree ownership requires either the eager persist or a later durable snapshot of the current run"
  )
})

test("isolated commits verify the assigned branch again after staging", () => {
  const commit = sectionBetween(
    gitWorktreeSource,
    "export async function commitWorkflowWorktree",
    "interface WorktreeListEntry"
  )
  const stagedAt = commit.indexOf("stageWorkflowWorktreeUnlocked(boundary, signal)")
  const recheckAt = commit.indexOf("assertWorkflowWorktreeCommitBranch(boundary, signal)")
  const gitCommitAt = commit.indexOf('"commit"')
  assert.ok(stagedAt !== -1 && recheckAt > stagedAt && gitCommitAt > recheckAt,
    "a branch switch during staging must be rejected before git commit runs")
})

test("retained worktrees pin only their owning workspace until explicitly resolved", () => {
  assert.match(
    workflowRunManagerSource,
    /isWorkspacePinnedForThread[\s\S]*?countUnresolvedWorkflowWorktrees\(workspacePath, threadId,[\s\S]*?failClosedOnUnreadable: false/,
    "workspace pinning includes durable unresolved worktrees"
  )
  assert.doesNotMatch(
    agentIpcSource,
    /workflowLeaveBlockedMessage[\s\S]{0,900}isWorkspacePinnedForThread/,
    "a retained worktree does not block mode-only changes"
  )
  assert.match(
    workflowRunManagerSource,
    /isWorkspacePinnedForThread[\s\S]*?identifyRepository\(workspacePath\)[\s\S]*?listWorkflowWorktreeRecordsForPrune\(repository\.commonDir\)[\s\S]*?record\.threadId === threadId/,
    "workspace pinning also sees a crash-window manifest absent from run.json"
  )
})

test("flush-failed worktree recovery paths remain actionable", () => {
  assert.match(
    workflowsIpcSource,
    /getFlushFailedRun\(payload\.runId\) \?\?[\s\S]*?loadWorkflowRunAsync\(workspacePath, payload\.threadId, payload\.runId\)/,
    "worktree actions must use the same in-memory terminal run shown by workflow:get-run"
  )
  assert.match(
    workflowsIpcSource,
    /persistActionWorktreeRecord\([\s\S]*?updateFlushFailedWorktreeRecord/,
    "worktree action results must update a flush-failed snapshot before retrying disk persistence"
  )
  assert.match(
    threadsSource,
    /listFlushFailedRuns\(threadId\)[\s\S]*?record\.cleanupPending === true/,
    "thread deletion keeps a flush-failed terminal worktree whose branch or manifest cleanup remains pending"
  )
  assert.match(
    workflowRunManagerSource,
    /updateFlushFailedWorktreeRecord[\s\S]*?newerWorkflowWorktreeRecord\(current, record\)/,
    "flush-failed snapshots use the same terminal-monotonic worktree merge as run.json"
  )
})

test("pristine cleanup keeps a terminal recovery record when ownership deletion fails", () => {
  assert.match(
    workflowRunManagerSource,
    /onRecordDelete: \(record\)[\s\S]*?run\.worktrees = \(run\.worktrees \?\? \[\]\)\.filter/,
    "the normal path still removes a pristine worktree from run history"
  )
  const leaseSource = readFileSync(
    new URL("../src/main/agent/workflow/worktree-lease.ts", import.meta.url),
    "utf8"
  )
  assert.match(
    leaseSource,
    /private async removeAndForget[\s\S]*?deleteWorkflowWorktreeRecord[\s\S]*?catch \(error\)[\s\S]*?"discarded"[\s\S]*?cleanupPending: true[\s\S]*?onRecordChange/,
    "a removed pristine checkout is terminal-pending, never hidden while its manifest remains"
  )
  assert.match(
    threadsSource,
    /alreadyCleaned[\s\S]*?finalizeWorkflowWorktreeRecord/,
    "thread deletion finalizes a clean terminal tombstone before dropping its recovery route"
  )
})

test("child workflow journal cache keys on script content, not meta.name (#5)", () => {
  // Two different child workflow files with the SAME meta.name must NOT cross-hit
  // each other's journal cache — the call-identity hash keys on the child SCRIPT.
  assert.match(
    workflowEngineSource,
    /childCacheKey: sha256Hex\(source\)/,
    "child spawn keys the cache on the child script sha"
  )
  assert.match(
    workflowEngineSource,
    /child: context\.childCacheKey \?\? null/,
    "call-identity hash uses the script-based child key, not the display name"
  )
})

test("workflow call-identity hash folds the session-default model (resume after model switch re-runs) (#1)", () => {
  // An agent() with no opts.model / phase model / profile model runs on the SESSION
  // DEFAULT (subagent.ts falls back to deps.defaultModelId). The journal call-hash
  // must include that default, or switching the thread's model then resuming would
  // replay the OLD default model's cached result instead of re-running.
  assert.match(
    workflowEngineSource,
    /model: resolvedModel \?\? context\.defaultModelId \?\? null/,
    "call-identity hash falls back to the session-default model, not just resolvedModel"
  )
  assert.match(
    workflowEngineSource,
    /defaultModelId\?: string/,
    "WorkflowEngineOptions carries the session-default model"
  )
  assert.match(
    workflowRunManagerSource,
    /defaultModelId: request\.subagentDeps\.defaultModelId/,
    "run-manager threads the session-default model into the engine"
  )
})

test("deleting a thread sweeps leftover workflow-subagent (__wf_) checkpoints (#3)", () => {
  // Workflow subagents self-clean their checkpoint in their finally, but a crash /
  // failed cleanup can leave a `<parent>__wf_<run>_a<index>.sqlite` behind. The
  // thread-delete sweep covered only coordinator `__worker__` checkpoints, leaking
  // the __wf_ ones — add a symmetric sweep.
  assert.match(
    storageSource,
    /export function deleteThreadWorkflowCheckpoints\([\s\S]*?sweepCheckpointVariants\(`\$\{parentThreadId\}__wf_`\)/,
    "storage exposes a __wf_ checkpoint sweep mirroring the __worker__ one"
  )
  assert.match(
    threadsSource,
    /deleteThreadWorkflowCheckpoints\(threadId\)/,
    "threads:delete invokes the __wf_ checkpoint sweep"
  )
})

test("workflow writeFile caps by BYTE length, not UTF-16 char count", () => {
  // #6: content.length counts UTF-16 code units, so a multi-byte (CJK/emoji) payload
  // could slip past a byte cap. writeFile must measure Buffer.byteLength to match
  // readFile's stat.size (real bytes) bound.
  assert.match(
    workflowEngineSource,
    /Buffer\.byteLength\(content, "utf-8"\)/,
    "writeFile measures real byte length"
  )
  assert.doesNotMatch(
    workflowEngineSource,
    /content\.length > FILE_WRITE_MAX_BYTES/,
    "writeFile no longer caps by UTF-16 char count"
  )
})

test("workflow glob caps its result count to avoid huge fan-outs", () => {
  // #7: glob("**/*") on a big repo must not collect+sort an unbounded array on the
  // main process (and tempt the model to feed it straight into parallel()). It's
  // capped with a clear "narrow the pattern" error.
  assert.match(
    workflowEngineSource,
    /const MAX_GLOB_RESULTS = getWorkflowGlobMax\(\)/,
    "glob result count is capped (parsed/guarded in types)"
  )
  assert.match(
    workflowEngineSource,
    /safe\.length > MAX_GLOB_RESULTS[\s\S]*narrow the pattern/,
    "glob throws a narrow-the-pattern error past the cap"
  )
  // #2(P3): lock the implementation to the STREAMING API so a future refactor can't
  // silently regress to materialize-then-check (which the "more than" wording alone
  // wouldn't catch if the message were kept).
  assert.match(
    workflowEngineSource,
    /fastGlob\.stream\(/,
    "glob walks via the streaming API (early-stop), not a full fastGlob() materialize"
  )
  assert.doesNotMatch(
    workflowEngineSource,
    /await fastGlob\(pattern/,
    "glob must not materialize the full match array before the cap check"
  )
})

test("workflow run IPC strips the (tens-of-MB) journal before sending a run to the renderer", () => {
  // The renderer DTO never reads `journal`; resume reads it main-side via
  // loadWorkflowRun, not from a renderer round-trip — so get-run and hydrate must
  // drop it before IPC. `script` is kept (the run dialog renders it).
  assert.match(
    workflowsIpcSource,
    /function stripJournalForRenderer\(run: PersistedWorkflowRun \| null\)/,
    "workflows IPC exposes a journal-stripping projection"
  )
  assert.match(
    workflowsIpcSource,
    /return stripJournalForRenderer\(run\)/,
    "get-run strips the journal from the returned run"
  )
  assert.match(
    workflowsIpcSource,
    /latestRun: stripJournalForRenderer\(latestRun\)/,
    "hydrate strips the journal from latestRun"
  )
})

test("workflow notification is at-least-once: delivered persisted only on SUCCESS (crash re-reports)", () => {
  // Turn START marks the run in-flight IN MEMORY only — it must NOT persist the
  // durable delivered flag here (that was the at-most-once crash hole).
  assert.match(
    agentIpcSource,
    /workflowRunManager\.markNotificationInFlight\(pendingWorkflowRun\.runId\)/,
    "notification turn start marks in-flight in memory"
  )
  // delivered (markNotified) is persisted ONLY on the success/ack path, and its
  // boolean return gates the backlog kick (a failed write must not let the same
  // still-undelivered run be re-selected newest-first and double-reported).
  assert.match(
    agentIpcSource,
    /const delivered = await workflowRunManager\.markNotified\(\s*settle\.workspacePath,\s*threadId,\s*settle\.runId,\s*settle\.startedAt\s*\)/,
    "delivered is persisted on success and captured for gating the kick"
  )
  assert.match(
    agentIpcSource,
    /if \(delivered \|\| shouldKickPendingDrain\) \{\s*\n\s*workflowRunManager\.kickNextPendingNotification\(settle\.workspacePath, threadId\)/,
    "the next pending run is kicked when this run's delivered flag persisted OR its flush-failed state was written back"
  )
  // A turn that ends in the catch clears in-flight UNCONDITIONALLY (abort too) and
  // only renotifies on a genuine failure. Clearing must NOT be gated on
  // !isAbortError — otherwise an aborted notification turn leaves the runId stuck
  // in inFlightNotifications and it can never be re-reported this process.
  assert.match(
    agentIpcSource,
    /workflowRunManager\.clearNotificationInFlight\(settleRunId\)\s*\n\s*if \(!isAbortError\) \{\s*\n\s*workflowRunManager\.renotify\(threadId, settleRunId\)/,
    "abort still clears in-flight; only renotify is gated on genuine failure"
  )
  // run-manager excludes in-flight runs from discovery so a concurrent invoke
  // can't double-report the same run.
  assert.match(
    workflowRunManagerSource,
    /if \(run && this\.inFlightNotifications\.has\(run\.runId\)\) return null/,
    "findPendingNotification excludes in-flight runs"
  )
  // The in-flight set is IN MEMORY: a restart clears it, which is exactly what
  // lets a crash mid-turn re-report (delivered is still false on disk).
  assert.match(
    workflowRunManagerSource,
    /private readonly inFlightNotifications = new Set<string>\(\)/,
    "in-flight set is in-memory (cleared on restart → enables crash re-report)"
  )
  // Guard against regressing to at-most-once: the rollback-on-failure path is gone
  // (there is nothing persisted at turn start to roll back).
  assert.doesNotMatch(
    agentIpcSource,
    /\.rollbackNotified\(/,
    "no rollbackNotified — at-least-once does not persist at turn start"
  )
  // recoverFlushFailedRun carries the SAME startedAt fence as markNotified (isomorphic
  // gap): an old notification's ack must not settle a NEWER instance's flush-failed
  // snapshot (same runId via resume) — that would mark delivered=true for a completion
  // that was never reported. On mismatch it falls back to plain persistence
  // (retryPersistFlushFailedRun) and leaves `notificationDelivered` to the new
  // instance's own ack.
  //
  // Only the ACK-SIDE PLUMBING is pinned here — that startedAt is threaded through at
  // all is something a regex CAN see, and nothing else can. The fence's SEMANTICS (a
  // stale ack must not mark delivered, yet must still report a landed write-back so the
  // pending drain gets kicked) live in run-manager-instance-fence.test.ts: a source
  // regex stays green when `!==` is typo'd to `===`, cannot see delivered=true leaking
  // in from a callee, and — as the earlier `return false` pin did — can freeze a bug in
  // place by asserting the very line that strands the new instance's notification.
  assert.match(
    agentIpcSource,
    /const shouldKickPendingDrain = await workflowRunManager\.recoverFlushFailedRun\(\s*settle\.workspacePath,\s*threadId,\s*settle\.runId,\s*settle\.startedAt\s*\)/,
    "ack passes the reported snapshot's startedAt into recoverFlushFailedRun"
  )
})

test("workflow state gates switch-to-normal, and thread delete clears tool-concurrency locks", () => {
  // #2: LEAVING workflow mode (to ANY non-workflow mode — normal OR coordinator)
  // is blocked while a run is active or its result is pending, so a background
  // workflow isn't orphaned. The guard keys off "current === workflow && next !==
  // workflow", NOT "next === normal" — otherwise workflow → coordinator slips through.
  assert.match(
    threadsSource,
    /currentMetadata\.agentMode === "workflow" && nextMetadata\.agentMode !== "workflow"/,
    "threads:update blocks leaving workflow to ANY non-workflow mode"
  )
  // agent:invoke + resume paths use a shared workflowLeaveBlockedMessage helper,
  // gated on leaving workflow (effectiveAgentMode / requestedAgentMode !== workflow).
  assert.match(
    agentIpcSource,
    /function workflowLeaveBlockedMessage\(/,
    "agent IPC has a shared workflow-leave guard helper"
  )
  assert.match(
    agentIpcSource,
    /metadataAgentMode === "workflow" &&\s*effectiveAgentMode !== "workflow"/,
    "main agent:invoke path blocks leaving workflow to any non-workflow mode"
  )
  assert.match(
    agentIpcSource,
    /metadata\.agentMode === "workflow" && requestedAgentMode !== "workflow"/,
    "resume path blocks leaving workflow to any non-workflow mode"
  )
  // Regression guard: the workflow guard must NOT be bound to "switch to normal"
  // (isNormalModeBlocked) — that was the half-fix that let workflow → coordinator
  // through. isNormalModeBlocked is coordinator-only now.
  assert.doesNotMatch(
    agentIpcSource,
    /state\.workflowActive \|\| state\.workflowPending/,
    "isNormalModeBlocked must NOT carry workflow state (workflow has its own leave guard)"
  )
  // #2: the REAL workspace-picker entry (models.ts assertWorkspaceSwitchAllowed, hit
  // by workspace:set / workspace:select) must block a switch while a workflow is
  // running/pending — otherwise the threads:update guard is just a bypassed side door.
  assert.match(
    modelsSource,
    /assertWorkspaceSwitchAllowed[\s\S]*?workflowRunManager\.isWorkspacePinnedForThread\(/,
    "workspace-picker entry blocks a switch while a workflow is busy (the real entry, not just threads:update)"
  )
  // threads:update is the secondary entry; any real workspace change uses the
  // retained-worktree pin, including a combined mode+workspace update.
  assert.match(
    threadsSource,
    /nextMetadata\.workspacePath !== currentMetadata\.workspacePath[\s\S]*?await workflowRunManager\.isWorkspacePinnedForThread\(\s*threadId,\s*currentMetadata\.workspacePath\s*\)/,
    "threads:update also guards a workspace switch with unresolved worktrees"
  )
  // #7 escape hatch: both guard sites release a pending run whose auto-re-report
  // has been exhausted this process, so a wedged notification can't lock the user
  // in workflow mode with no exit but deleting the thread.
  // #5 strand-caveat parity: the workspace-picker entry (the REAL switch path, hit
  // by "创建 Worktree 并切换" → workspace:set) must, after releasing a
  // renotify-exhausted pending run, log the same strand-under-original-workspace
  // warning the leave-mode guards do — otherwise this switch path is a silent gap.
  assert.match(
    modelsSource,
    /assertWorkspaceSwitchAllowed[\s\S]*?if \(pendingRun\) \{[\s\S]*?console\.warn\([\s\S]*?renotify-exhausted pending run/,
    "workspace switch logs a strand warning when releasing a renotify-exhausted pending run (#5)"
  )
  // #3 background-approval deadlock: the inactivity watchdog must NOT abort a run
  // that is only waiting on a pending user approval (an absent user would
  // otherwise lose all completed work to the 30-min backstop). The engine checks
  // isAwaitingApproval and resets the clock; runtime supplies hasPendingApproval
  // by scanning pendingApprovals for this run's subagent threads.
  assert.match(
    workflowEngineSource,
    /if \(options\.isAwaitingApproval\?\.\(\)\) \{\s*\n\s*lastActivityAt = Date\.now\(\)/,
    "inactivity watchdog skips abort while a subagent approval is pending"
  )
  assert.match(
    runtimeSource,
    /hasPendingApproval: \(runId\?: string\): boolean =>\s*hasPendingWorkflowApproval\(threadId, runId\)/,
    "runtime reports pending workflow-subagent approvals to the engine, scoped to the run"
  )
  // #3 regression: the approval entry must carry the runtime's OWN thread, and the
  // match must use it — NOT the routing threadId (= parent), which made the prefix
  // check always false and the watchdog exemption dead code.
  assert.match(
    runtimeSource,
    /runtimeThreadId: threadId/,
    "pending-approval entry records the runtime's own thread"
  )
  assert.match(
    runtimeSource,
    /isWorkflowSubagentThreadOf\(approval\.runtimeThreadId, parentThreadId, runId\)/,
    "hasPendingWorkflowApproval matches the runtime thread (scoped to the run), not the parent routing thread"
  )
  // #14: a structured-output failure gets one FRESH-session retry (a clean
  // transcript often succeeds where a poisoned one couldn't — mid-tier models
  // especially), bounded by MAX_RUNS so an impossible schema can't loop.
  assert.match(
    workflowSubagentSource,
    /const schemaRetry =\s+request\.schema !== undefined &&\s+\(isStructuredOutputRetryableError\(error\) \|\| isStructuredOutputFailure\(error\)\)/,
    "subagent retries a structured-output failure (explicit retryable marker OR failure message) once on a fresh session"
  )
  assert.match(
    workflowSubagentSource,
    /if \(\(!retryable && !schemaRetry\) \|\| attempt >= WORKFLOW_SUBAGENT_MAX_RUNS\) break/,
    "schema retry shares the bounded MAX_RUNS budget (one extra attempt)"
  )
  // #9: thread delete drops the thread's tool-concurrency locks so the module-level
  // map doesn't keep one idle lock per deleted thread for the process lifetime.
  assert.match(
    runtimeSource,
    /export function clearToolConcurrencyLocksForThread\(threadId: string\)/,
    "runtime exposes per-thread tool-concurrency lock cleanup"
  )
  assert.match(
    threadsSource,
    /clearToolConcurrencyLocksForThread\(threadId\)/,
    "thread delete clears tool-concurrency locks"
  )
})

test("workflow subagent cleanup cancels run_in_background tasks (no leak past the run)", () => {
  // Coordinator workers cancel their background tasks on teardown; the workflow
  // subagent cleanup must too, or a backgrounded process outlives the run and
  // leaks CPU/memory/file writes after the workflow completes or is cancelled.
  assert.match(
    runtimeSource,
    /LocalSandbox\.cancelBackgroundTasksAndWait\(workflowThreadId\)/,
    "workflow subagent cleanup cancels and waits for run_in_background process trees"
  )
  assert.doesNotMatch(
    runtimeSource,
    /waitForWorktreeHookCommands/,
    "worktree hooks reuse the normal hook runner instead of adding a second process registry"
  )
})
