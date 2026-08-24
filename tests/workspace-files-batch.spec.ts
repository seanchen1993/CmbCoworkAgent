import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

async function readSource(relativePath: string): Promise<string> {
  return (await readFile(resolve(__dirname, "..", relativePath), "utf8")).replace(/\r\n/g, "\n")
}

async function main(): Promise<void> {
  const [watcher, preload, threadContext, workspaceLoader, rightPanel, gitPanel, harnessBoard, app] =
    await Promise.all([
      readSource("src/main/services/workspace-watcher.ts"),
      readSource("src/preload/index.ts"),
      readSource("src/renderer/src/lib/thread-context.tsx"),
      readSource("src/renderer/src/lib/workspace-file-load.ts"),
      readSource("src/renderer/src/components/panels/RightPanel.tsx"),
      readSource("src/renderer/src/components/panels/GitPanelView.tsx"),
      readSource("src/renderer/src/components/harness-board/HarnessBoardView.tsx"),
      readSource("src/renderer/src/App.tsx")
    ])

  const notifyStart = watcher.indexOf("function notifyRenderer(")
  const notifyEnd = watcher.indexOf("function notifyWorkspaceHooksChanged", notifyStart)
  const notifySource = watcher.slice(notifyStart, notifyEnd)
  assert.match(
    notifySource,
    /const payload:[\s\S]*threadIds,[\s\S]*workspacePath,[\s\S]*changeType/,
    "one physical watcher event must build one batch payload"
  )
  assert.equal(
    notifySource.match(/webContents\.send\("workspace:files-changed"/g)?.length ?? 0,
    1,
    "each BrowserWindow must receive one workspace-path notification"
  )
  assert.match(
    watcher,
    /MAX_INCREMENTAL_PATHS = 128[\s\S]*FILE_STAT_CONCURRENCY = 24/,
    "watcher file patches must cap both payload paths and concurrent stats"
  )
  const patchApplyStart = workspaceLoader.indexOf("function applyWorkspaceFilePatch(")
  const patchApplyEnd = workspaceLoader.indexOf("function enqueueWorkspaceUpdate", patchApplyStart)
  const patchApplySource = workspaceLoader.slice(patchApplyStart, patchApplyEnd)
  assert.match(
    patchApplySource,
    /cached\.filesByPath\.get\(entry\.path\)/,
    "incremental updates must use the path index"
  )
  assert.doesNotMatch(
    patchApplySource,
    /loadFromDisk|cached\.result\.files\.(?:find|map|filter|sort)/,
    "existing-file patches must not scan disk or walk the cached file array"
  )
  assert.doesNotMatch(
    notifySource,
    /for \(const threadId/,
    "renderer IPC must not be nested inside a per-thread loop"
  )
  assert.match(
    rightPanel,
    /fileTreeCache = new WeakMap<FileInfo\[\], TreeNode\[\]>\(\)/,
    "same-array task switches and panel remounts must share the built file tree"
  )
  assert.doesNotMatch(
    rightPanel.slice(
      rightPanel.indexOf("function buildFileTree"),
      rightPanel.indexOf("function FileTree")
    ),
    /\[\.\.\.files\]\.sort/,
    "file-tree construction must not globally copy-sort every file"
  )

  assert.match(
    preload,
    /normalizeWorkspaceFilesChangedPayload\(data\)[\s\S]*if \(payload\) callback\(payload\)/,
    "preload must normalize both batched and legacy payloads at the boundary"
  )

  const sharedRefreshStart = threadContext.lastIndexOf(
    "useEffect(() => {",
    threadContext.indexOf("subscribeWorkspaceFileResults((workspaceKey")
  )
  const sharedRefreshEnd = threadContext.indexOf("useLayoutEffect(() => {", sharedRefreshStart)
  const sharedRefreshSource = threadContext.slice(sharedRefreshStart, sharedRefreshEnd)
  assert.equal(
    sharedRefreshSource.match(/commitThreadStateChanges\(/g)?.length ?? 0,
    1,
    "one shared file generation must update all same-path ThreadStates in one transaction"
  )
  assert.match(
    sharedRefreshSource,
    /workspaceThreadIdsByPathRef\.current\.get\(workspaceKey\)[\s\S]*workspaceFiles: files/,
    "same-path ThreadStates must share the exact published files-array reference"
  )
  assert.equal(
    sharedRefreshSource.match(/refreshWorkspaceFilesFromChangeBatch\(/g)?.length ?? 0,
    1,
    "one batched IPC must enter the shared scan coordinator once"
  )

  const filesContentStart = rightPanel.indexOf("function FilesContent(")
  assert.ok(filesContentStart >= 0, "RightPanel FilesContent must exist")
  assert.doesNotMatch(
    rightPanel.slice(filesContentStart),
    /onFilesChanged/,
    "FilesContent must consume ThreadProvider results instead of starting a duplicate scan"
  )
  for (const [name, source] of [
    ["App", app],
    ["GitPanel", gitPanel],
    ["HarnessBoard", harnessBoard]
  ] as const) {
    assert.match(source, /data\.threadIds/, `${name} must consume the batched thread id list`)
    assert.doesNotMatch(
      source,
      /onFilesChanged\([\s\S]{0,400}data\.threadId\b/,
      `${name} must not read the removed single-thread payload field`
    )
  }

  console.log("workspace files batch contracts passed")
}

void main()
