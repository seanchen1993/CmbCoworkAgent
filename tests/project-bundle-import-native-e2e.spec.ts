/** Real ZIP upload, paged catalog and original project entry; no model/business execution. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  compositionHostFlow,
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import { openModsSettings } from "./support/mods-sidebar-navigation"
import { readModsSourceCandidate } from "./support/mods-source-candidate"
import { resolveHarnessNextAction } from "../src/shared/harness-run-next-action"
import type { HarnessProjectListItem } from "../src/shared/harness-board-types"

const root = resolve(__dirname, "..")
const output = join(root, "output", `project-bundle-import-native-${randomUUID()}`)
process.env.COMPOSITION_E2E_ARTIFACT_ROOT = output
const fixture = projectCompositionEnvironment(root)
fixture.env.CMB_MODS_E2E = "0"
const candidate = projectCompositionCandidate(root)
assert(
  candidate.execution === "built-output" || candidate.execution === "source-isolated",
  "Use the current normal build or a verified isolated source candidate"
)
const expectedRendererUrl =
  candidate.execution === "source-isolated"
    ? readModsSourceCandidate(candidate.sourceManifest!).rendererUrl
    : pathToFileURL(join(root, "out/renderer/index.html")).href
fixture.env.ELECTRON_RENDERER_URL = expectedRendererUrl
const suppliedZip = process.env.PROJECT_BUNDLE_ZIP
const inputZip = suppliedZip ?? join(fixture.isolated, "project-template.zip")
if (!suppliedZip) {
  const zip = new AdmZip()
  zip.addLocalFolder(join(root, "resources/native-compositions/autobiz-lean"), "project-template")
  zip.writeZip(inputZip)
}
const inputBytes = readFileSync(inputZip)
const inputSha256 = createHash("sha256").update(inputBytes).digest("hex")
const projectContainers = join(fixture.workspace, "project-containers")
const selectedRepository = join(fixture.workspace, "selected-repository")
mkdirSync(projectContainers)
mkdirSync(selectedRepository)
const userFile = join(selectedRepository, "preserve-user-file.txt")
const userFileText = "User-selected directory; opening manual sessions must not execute a task.\n"
writeFileSync(userFile, userFileText)
// This directory is below output/, so without an explicit repository Git discovers the parent
// development checkout. Keep all Git mutations inside this new profile-owned fixture instead.
const selectedTail = relative(realpathSync(fixture.workspace), realpathSync(selectedRepository))
assert(
  selectedTail && !selectedTail.startsWith("..") && !isAbsolute(selectedTail),
  "FIXTURE_GIT_REPOSITORY_MUST_STAY_INSIDE_THIS_PROFILE_WORKSPACE"
)
const gitTemplate = join(fixture.isolated, "empty-git-template")
const gitHooks = join(fixture.isolated, "empty-git-hooks")
mkdirSync(gitTemplate)
mkdirSync(gitHooks)
fixture.env.GIT_CONFIG_GLOBAL = join(fixture.isolated, "empty-gitconfig")
fixture.env.GIT_CONFIG_NOSYSTEM = "1"
fixture.env.GIT_TERMINAL_PROMPT = "0"
writeFileSync(fixture.env.GIT_CONFIG_GLOBAL, "")
const fixtureGit = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      selectedRepository,
      "-c",
      "user.name=Project Acceptance Fixture",
      "-c",
      "user.email=project-acceptance@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      `core.hooksPath=${gitHooks}`,
      ...args
    ],
    { env: fixture.env, encoding: "utf8", windowsHide: true }
  ).trim()
fixtureGit("init", "--initial-branch=codex/uat-fixture", `--template=${gitTemplate}`)
assert.equal(
  realpathSync(fixtureGit("rev-parse", "--show-toplevel")),
  realpathSync(selectedRepository)
)
fixtureGit("add", "--", "preserve-user-file.txt")
fixtureGit(
  "commit",
  "--no-verify",
  "--no-gpg-sign",
  "-m",
  "test: establish isolated workspace fixture"
)
const pendingUserFile = join(selectedRepository, "pending-user-change.txt")
const pendingUserFileText = "Uncommitted user work must survive original project sessions.\n"
writeFileSync(pendingUserFile, pendingUserFileText)
const initialGitStatus = fixtureGit("status", "--porcelain=v1", "--untracked-files=normal")
assert.equal(initialGitStatus, "?? pending-user-change.txt")
assert.equal(fixtureGit("remote"), "", "The isolated fixture must not configure a remote")
const evidence: Record<string, unknown> = {
  candidate,
  inputZip,
  inputSha256,
  expectedRendererUrl,
  selectedGitFixture: {
    directory: selectedRepository,
    branch: fixtureGit("branch", "--show-current"),
    initialStatus: initialGitStatus,
    remoteCount: 0,
    gitConfiguration:
      "Only this profile's empty global/system-disabled config and per-command identity/signing/hooks options"
  },
  scope:
    "Original built App, real upload/paged catalog/Plugins/Mods/original project form, inline project consent, ordinary Claw contrast, project controls without creator workbench or separate composition entry, original resource panels, two Features per template, detail/sidebar manual sessions and actual editable Composer after reload, original UI archival and read-only history; isolated profile and offline SSO/native-directory-picker boundaries; no installer, external login, model or business execution"
}
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let passed = false
const save = () =>
  writeFileSync(
    join(fixture.isolated, "report.json"),
    JSON.stringify({ ...evidence, passed, errors }, null, 2) + "\n"
  )
const phase = (name: string) => {
  evidence.phase = name
  save()
  console.log(`PHASE project bundle acceptance: ${name}`)
}

async function openOrdinaryWorkbench(threadId: string) {
  const chat = page!.locator(`[data-chat-thread-id="${threadId}"]`)
  await chat.locator("[data-claw-composer]").waitFor()
  await chat.getByRole("button", { name: "查看任务进展", exact: true }).click()
  const progress = page!.getByRole("complementary", { name: "任务进展", exact: true })
  await progress.waitFor()
  for (const name of ["当前任务", "输出与面板", "高级设置"])
    await progress.getByRole("tab", { name, exact: true }).waitFor()
  assert.equal(await page!.locator(`[data-claw-sidebar-host="${threadId}"]`).count(), 1)
  // Keep the real ordinary-workbench state open when navigating into project mode.
  return {
    threadId,
    ordinaryProgressAvailable: true,
    threeTabsAvailable: true,
    leftOpenBeforeProjectEntry: true
  }
}

async function assertProjectWorkbenchAbsent(chat: ReturnType<Page["locator"]>, phaseName: string) {
  assert.equal(await chat.locator("[data-claw-composer]").count(), 0, phaseName)
  assert.equal(
    await page!.locator("[data-claw-composer]").count(),
    0,
    `${phaseName}: no retained creator composer`
  )
  assert.equal(await page!.locator("[data-claw-sidebar-host]").count(), 0, phaseName)
  assert.equal(
    await page!.locator("[data-claw-sidebar-shell]").count(),
    0,
    `${phaseName}: no empty workbench shell`
  )
  assert.equal(
    await page!.getByRole("button", { name: /^(任务进展|查看任务进展|收起任务进展)$/ }).count(),
    0,
    phaseName
  )
  assert.equal(
    await page!.getByRole("complementary", { name: "任务进展", exact: true }).count(),
    0,
    phaseName
  )
  assert.equal(
    await page!.getByRole("tab", { name: /^(当前任务|输出与面板|高级设置)$/ }).count(),
    0,
    phaseName
  )
  assert.equal(
    await chat.getByRole("button", { name: "改为普通发送", exact: true }).count(),
    0,
    "A retained creator-flow choice must not become the project draft's send route"
  )
  assert.equal(
    await page!.getByRole("button", { name: "项目能力", exact: true }).count(),
    0,
    "Mature projects must not open a second composition/authorization workflow"
  )
}

async function checkOriginalProjectResourcePanels(
  chat: ReturnType<Page["locator"]>,
  draft: string
) {
  // With ordinary Claw still the raw selection, project mode must render the original work panel.
  const work = page!.getByTestId("workspace-info-panel")
  await work.waitFor()
  const files = work.getByRole("button").filter({ has: page!.getByText("文件", { exact: true }) })
  assert(await files.isEnabled())
  if ((await files.getAttribute("aria-expanded")) !== "true") await files.click()
  await work.getByText("preserve-user-file.txt", { exact: true }).waitFor()
  const artifacts = work
    .getByRole("button")
    .filter({ has: page!.getByText("插件运行产物", { exact: true }) })
  await artifacts.waitFor()
  if ((await artifacts.getAttribute("aria-expanded")) !== "true") await artifacts.click()
  await work.getByText("暂无已生成的插件运行产物", { exact: true }).waitFor()
  await page!.getByRole("button", { name: "文件预览", exact: true }).click()
  await page!.getByTestId("resource-preview-surface").waitFor()
  await page!.getByRole("button", { name: "Git 面板", exact: true }).click()
  await page!.getByText("分支 codex/uat-fixture", { exact: true }).waitFor()
  await page!.getByRole("button", { name: /^查看 .*pending-user-change\.txt 的 diff$/ }).waitFor()
  assert(
    (await page!
      .getByRole("button", { name: "Git 面板", exact: true })
      .getAttribute("aria-pressed")) === "true"
  )
  assert((await page!.getByText("selected-repository", { exact: true }).count()) > 0)
  await page!.getByRole("button", { name: "工作目录", exact: true }).click()
  await work.waitFor()
  await page!.evaluate(() =>
    window.dispatchEvent(new CustomEvent("claw:sidebar-tab", { detail: "configuration" }))
  )
  await page!.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  await assertProjectWorkbenchAbsent(
    chat,
    "project resource panels after stale workbench-tab event"
  )
  assert.equal(await chat.locator("textarea.composer-textarea").inputValue(), draft)
  assert(await chat.locator("textarea.composer-textarea").isEditable())
  return {
    originalFilesVisible: true,
    originalArtifactPanelVisible: true,
    previewAvailable: true,
    fixtureGitPanelAvailable: true,
    exactFixtureBranchVisible: true,
    pendingUserChangeVisible: true,
    projectDraftPreserved: true
  }
}

async function startCreatorFlowReadObserver() {
  await app!.evaluate(({ ipcMain }) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
    type Observer = { events: Array<{ channel: string; threadId?: string }>; restore(): void }
    const target = globalThis as typeof globalThis & { __projectCreatorFlowObserver?: Observer }
    if (target.__projectCreatorFlowObserver) throw Error("CREATOR_FLOW_OBSERVER_ALREADY_INSTALLED")
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    if (!(handlers instanceof Map)) throw Error("REAL_INVOKE_HANDLERS_REQUIRED")
    const channels = [...handlers.keys()].filter(
      (channel) =>
        channel.startsWith("mods:flow-") ||
        channel === "mods:claw-view" ||
        channel === "project-composition:catalog"
    )
    for (const channel of [
      "mods:flow-runs",
      "mods:flow-active",
      "mods:claw-view",
      "project-composition:catalog"
    ])
      if (!channels.includes(channel)) throw Error(`REAL_CREATOR_FLOW_HANDLER_REQUIRED:${channel}`)
    const events: Observer["events"] = []
    const originals = channels.map((channel) => {
      const original = handlers.get(channel)!
      const observed: Handler = {
        invoke(event: Electron.IpcMainInvokeEvent, ...args: unknown[]) {
          const input = args[0]
          const threadId =
            typeof input === "string"
              ? input
              : input &&
                  typeof input === "object" &&
                  "threadId" in input &&
                  typeof input.threadId === "string"
                ? input.threadId
                : undefined
          events.push({ channel, threadId })
          return original(event, ...args)
        }
      }.invoke
      handlers.set(channel, observed)
      return { channel, original, observed }
    })
    target.__projectCreatorFlowObserver = {
      events,
      restore() {
        for (const { channel, original, observed } of originals) {
          if (handlers.get(channel) !== observed) throw Error("CREATOR_FLOW_HANDLER_CHANGED")
          handlers.set(channel, original)
        }
      }
    }
  })
}

async function openPlugins() {
  const sourceList = page!.locator("[data-plugin-source-list]")
  if (await sourceList.isVisible()) return sourceList
  await page!.getByRole("button", { name: "自定义设置", exact: true }).click()
  const group = page!
    .getByRole("navigation")
    .getByRole("button", {
      name: "基础功能",
      exact: true
    })
    .and(page!.locator("button[aria-expanded]"))
  if ((await group.getAttribute("aria-expanded")) === "false") await group.click()
  await page!.getByRole("navigation").getByRole("button", { name: "插件", exact: true }).click()
  await sourceList.waitFor()
  return sourceList
}

/** Only the native OS picker is controlled; renderer forms and business IPC stay real. */
async function chooseDirectory(path: string, trigger: () => Promise<void>) {
  await app!.evaluate(({ dialog }, selected) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      dialog.showOpenDialog = original
      const options = args.at(-1) as { title?: string }
      if (options?.title !== "选择工作区文件夹") throw Error("UNEXPECTED_DIRECTORY_PICKER")
      return { canceled: false, filePaths: [selected] }
    }) as typeof dialog.showOpenDialog
  }, path)
  await trigger()
}

async function existingProjectReview(project: HarnessProjectListItem) {
  return page!.evaluate(
    (project) =>
      window.api.harnessBoard.reviewProjectUse({
        adapterId: project.harnessAdapter.id,
        adapterType: "plugin",
        workspacePath: project.workspacePath,
        projectDir: project.projectDir,
        existingProjectId: project.projectId
      }),
    project
  )
}

async function submitOriginalProject(name: string, code: string, pluginId: string) {
  const dialog = page!.getByRole("dialog", { name: "新建项目", exact: true })
  const previous = await page!.evaluate(() => window.api.harnessBoard.listProjects())
  await dialog.getByPlaceholder("输入项目编号搜索", { exact: true }).fill(code)
  await dialog.getByRole("textbox", { name: "项目名称 *", exact: true }).fill(name)
  await dialog.getByRole("textbox", { name: "系统编号 *", exact: true }).fill("FIXTURE_SYSTEM")
  await dialog.getByRole("textbox", { name: "系统名称 *", exact: true }).fill("原界面回归系统")
  await dialog
    .getByRole("textbox", { name: /^(本项目产物文件夹|本项目文件夹)$/ })
    .fill(code.toLowerCase())
  await chooseDirectory(projectContainers, () =>
    dialog.getByRole("textbox", { name: "插件工作区根目录", exact: true }).click()
  )
  await page!.waitForFunction(
    (expected) =>
      document.querySelector<HTMLInputElement>('[aria-label="插件工作区根目录"]')?.value ===
      expected,
    projectContainers
  )
  await dialog.locator('[aria-label="创建项目时授权"]').waitFor()
  assert.equal(
    await page!.getByRole("dialog").count(),
    1,
    "Consent must stay inline in the original project form"
  )
  const submit = dialog.getByRole("button", { name: /^(创建|创建并授权)$/ })
  const submitLabel = (await submit.innerText()).trim()
  await submit.click()
  await dialog.waitFor({ state: "hidden" })
  const projects = await page!.evaluate(() => window.api.harnessBoard.listProjects())
  const created = projects.filter(
    (project) => !previous.some((old) => old.projectId === project.projectId)
  )
  assert.equal(created.length, 1, "One original-form submission creates exactly one project")
  const project = created[0]
  assert.equal(project.name, name)
  assert.equal(project.projectCode, code)
  assert.equal(project.systemId, "FIXTURE_SYSTEM")
  assert.equal(project.systemName, "原界面回归系统")
  assert.equal(project.harnessAdapter.id, pluginId)
  assert.equal(project.nativeBinding?.installedPluginId, pluginId)
  assert.equal(realpathSync(project.workspacePath), realpathSync(projectContainers))
  const review = await existingProjectReview(project)
  assert.equal(
    review.authorizationCurrent,
    true,
    "The original create submission must persist project consent without a second authorization"
  )
  assert.equal(
    submitLabel,
    review.sources.some((source) => !source.configurationOnly) ? "创建并授权" : "创建",
    "Configuration-only templates do not add a code authorization step"
  )
  return { project, review, originalFormSubmitClicks: 1 }
}

async function openOriginalProject(project: HarnessProjectListItem) {
  const list = page!
    .getByRole("main")
    .locator("nav")
    .getByRole("button", { name: "项目列表", exact: true })
  if (await list.isVisible()) await list.click()
  const card = page!.locator('article[role="button"]').filter({
    has: page!.getByText(project.name, { exact: true })
  })
  await card.click()
  await originalProjectHeader().getByRole("button", { name: "新建特性", exact: true }).waitFor()
}

function originalProjectHeader() {
  // The existing breadcrumb and project actions share the main content's header.
  // An empty project also offers New Feature in its body; choose the header action explicitly.
  return page!
    .getByRole("main")
    .locator("nav")
    .filter({ has: page!.getByRole("button", { name: "项目列表", exact: true }) })
    .locator("..")
    .locator("..")
}

async function createOriginalFeature(project: HarnessProjectListItem, name: string) {
  await openOriginalProject(project)
  const previous = await page!.evaluate(
    (id) => window.api.harnessBoard.getProjectDetail(id),
    project.projectId
  )
  await originalProjectHeader().getByRole("button", { name: "新建特性", exact: true }).click()
  const dialog = page!.getByRole("dialog", { name: "创建特性", exact: true })
  await dialog.getByRole("textbox", { name: "特性名称 *", exact: true }).fill(name)
  await chooseDirectory(selectedRepository, () =>
    dialog.getByRole("textbox", { name: "会话工作区", exact: true }).click()
  )
  await page!.waitForFunction(
    (expected) =>
      document.querySelector<HTMLInputElement>('[aria-label="会话工作区"]')?.value === expected,
    selectedRepository
  )
  assert.equal(
    await page!.getByRole("dialog").count(),
    1,
    "New Features must use the original form and the project consent already recorded"
  )
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
  await page!.getByRole("main").getByRole("button", { name: "新增会话", exact: true }).waitFor()
  const detail = await page!.evaluate(
    (id) => window.api.harnessBoard.getProjectDetail(id),
    project.projectId
  )
  const added = detail.runs.filter((run) => !previous.runs.some((old) => old.slug === run.slug))
  assert.equal(added.length, 1)
  assert.equal(added[0].title, name)
  const run = await page!.evaluate(
    ({ id, slug }) => window.api.harnessBoard.getRunDetail(id, slug),
    { id: project.projectId, slug: added[0].slug }
  )
  assert.equal(run.nativeBinding?.workspaceMode, "selected-directory")
  assert.equal(realpathSync(run.nativeBinding!.workspace), realpathSync(selectedRepository))
  assert.equal(
    realpathSync(run.run.resolvedSessionWorkspacePath!),
    realpathSync(selectedRepository)
  )
  assert.equal(run.nativeProject, undefined, "Feature registration must not create a Host run")
  assert.deepEqual(run.sessions, [])
  return { slug: added[0].slug, title: name, run }
}

async function createManualSession(
  project: HarnessProjectListItem,
  feature: Awaited<ReturnType<typeof createOriginalFeature>>,
  entry: "detail" | "sidebar"
) {
  const previous = await page!.evaluate(() => window.api.threads.list())
  if (entry === "detail") {
    await page!.getByRole("main").getByRole("button", { name: "新增会话", exact: true }).click()
  } else {
    const group = page!.locator(
      `[data-sidebar-group-key="feature:${project.projectId}:${feature.slug}"]`
    )
    await group.waitFor()
    await group.hover()
    await group.getByRole("button", { name: "新增会话", exact: true }).click()
  }
  const previousIds = new Set(previous.map((thread) => thread.thread_id))
  const deadline = Date.now() + 25_000
  let threads = await page!.evaluate(() => window.api.threads.list())
  // Playwright's waitForFunction treats a returned Promise as truthy before it resolves.
  // Poll the real IPC in Node and use the same completed snapshot for the exact-one check.
  while (!threads.some((thread) => !previousIds.has(thread.thread_id)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())))
    if (Date.now() >= deadline) break
    threads = await page!.evaluate(() => window.api.threads.list())
  }
  const created = threads.filter(
    (thread) => !previous.some((old) => old.thread_id === thread.thread_id)
  )
  assert.equal(created.length, 1, "Each Add Session click must create one persisted manual session")
  const thread = created[0]
  const chat = page!.locator(`[data-chat-thread-id="${thread.thread_id}"]`)
  const composer = chat.locator("textarea.composer-textarea")
  await composer.waitFor()
  await page!.waitForFunction((id) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      `[data-chat-thread-id="${CSS.escape(id)}"] textarea.composer-textarea`
    )
    return !!textarea && !textarea.disabled
  }, thread.thread_id)
  assert.equal(
    realpathSync(thread.metadata?.workspacePath as string),
    realpathSync(selectedRepository)
  )
  assert.equal(thread.metadata?.hostProjectRuntime, undefined)
  const featureMetadata = thread.metadata?.harnessFeature as { projectId: string; slug: string }
  assert.equal(featureMetadata.projectId, project.projectId)
  assert.equal(featureMetadata.slug, feature.slug)
  const node = feature.run.run.nodes.find((node) => node.id === feature.run.run.currentNodeId)!
  const nextAction = resolveHarnessNextAction(feature.run.workflow, node.id, node.nodeStatus)
  const expectedDraft = nextAction?.userMessage ?? ""
  assert.equal(
    await composer.inputValue(),
    expectedDraft,
    "The existing next-action message stays a draft; native templates without one open an empty draft"
  )
  const editedDraft = `${feature.title} ${entry}：先讨论方案，用户尚未发送。`
  await composer.fill(editedDraft)
  assert.equal(await composer.inputValue(), editedDraft)
  await assertProjectWorkbenchAbsent(chat, `${project.projectCode}-${feature.slug}-${entry}-chat`)
  assert.equal(
    await chat.getByText(/Response is not JSON|Unexpected token/).count(),
    0,
    "Optional remote catalogs must not expose raw response-parser errors above manual chat"
  )
  assert.equal(await page!.getByRole("dialog", { name: "开启托管运行", exact: true }).count(), 0)
  assert.equal(
    await page!.getByRole("dialog").count(),
    0,
    "Manual discussion must not ask for another project authorization"
  )
  const messages = await page!.evaluate(
    (id) => window.api.threads.getMessages(id),
    thread.thread_id
  )
  assert.deepEqual(messages, [], "Opening or editing a manual session must not auto-send")
  const detail = await page!.evaluate(
    ({ id, slug }) => window.api.harnessBoard.getRunDetail(id, slug),
    { id: project.projectId, slug: feature.slug }
  )
  assert.equal(detail.nativeProject, undefined, "Manual sessions must not create Host operations")
  await page!.screenshot({
    path: join(fixture.isolated, `${project.projectCode}-${feature.slug}-${entry}-composer.png`),
    animations: "disabled"
  })
  return { threadId: thread.thread_id, title: thread.title, entry, expectedDraft, editedDraft }
}

async function exerciseOriginalProject(project: HarnessProjectListItem) {
  const features = [] as Array<{
    feature: Awaited<ReturnType<typeof createOriginalFeature>>
    sessions: Array<Awaited<ReturnType<typeof createManualSession>>>
  }>
  const initialReview = await existingProjectReview(project)
  assert.equal(initialReview.authorizationCurrent, true)
  for (const index of [1, 2]) {
    phase(`${project.projectCode}-original-feature-${index}`)
    const feature = await createOriginalFeature(project, `${project.projectCode}-需求${index}`)
    await assertProjectWorkbenchAbsent(
      page!.getByRole("main"),
      `${project.projectCode}-${feature.slug}-initial-detail`
    )
    const detail = await createManualSession(project, feature, "detail")
    if (index === 1) {
      const chat = page!.locator(`[data-chat-thread-id="${detail.threadId}"]`)
      evidence[`${project.projectCode}OriginalResourcePanels`] =
        await checkOriginalProjectResourcePanels(chat, detail.editedDraft)
    }
    const sidebar = await createManualSession(project, feature, "sidebar")
    features.push({ feature, sessions: [detail, sidebar] })
  }
  phase(`${project.projectCode}-reload-persisted-sessions`)
  await page!.reload()
  await page!.waitForURL(expectedRendererUrl)
  // A normal page re-entry shows the existing first-use guide until the user acknowledges it.
  // Handle it only here, preserving the earlier start-use assertion that exactly one form opens.
  const guide = page!.getByRole("dialog", { name: "项目模式使用引导", exact: true })
  let guideAcknowledged = false
  await page!.addLocatorHandler(guide, async () => {
    await guide.getByRole("button", { name: "知道了，不再提示", exact: true }).click()
    await guide.waitFor({ state: "hidden" })
    guideAcknowledged = true
  })
  try {
    await page!.getByRole("tab", { name: "项目模式", exact: true }).click()
    await openOriginalProject(project)
  } finally {
    await page!.removeLocatorHandler(guide)
  }
  for (const { feature, sessions } of features) {
    const group = page!.locator(
      `[data-sidebar-group-key="feature:${project.projectId}:${feature.slug}"]`
    )
    await group.waitFor()
    const collapsed = group.getByRole("button", { name: "展开特性会话", exact: true })
    if (await collapsed.isVisible()) await collapsed.click()
    const thread = sessions.at(-1)!
    const row = group
      .locator("..")
      .locator(`div[title=${JSON.stringify(thread.title?.trim() || thread.threadId)}]`)
      .first()
    await row.click()
    const chat = page!.locator(
      sessions.map((session) => `[data-chat-thread-id="${session.threadId}"]:visible`).join(",")
    )
    await chat.waitFor()
    const selectedThreadId = await chat.getAttribute("data-chat-thread-id")
    assert(
      sessions.some((session) => session.threadId === selectedThreadId),
      "The real sidebar must reopen a persisted session belonging to this Feature"
    )
    const composer = chat.locator("textarea.composer-textarea")
    await composer.waitFor()
    await page!.waitForFunction((id) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        `[data-chat-thread-id="${CSS.escape(id!)}"] textarea.composer-textarea`
      )
      return !!textarea && !textarea.disabled
    }, selectedThreadId)
    assert(
      await composer.isEditable(),
      "Persisted manual sessions must reopen an editable real Composer"
    )
    await composer.fill(`刷新后继续编辑 ${feature.title}，尚未发送。`)
    await assertProjectWorkbenchAbsent(chat, `${project.projectCode}-${feature.slug}-reloaded-chat`)
    assert.equal(
      await chat.getByText(/Response is not JSON|Unexpected token/).count(),
      0,
      "Reopened manual chat must not expose raw response-parser errors"
    )
    for (const session of sessions) {
      const persisted = await page!.evaluate((id) => window.api.threads.get(id), session.threadId)
      assert(persisted)
      const binding = persisted.metadata?.harnessFeature as { projectId: string; slug: string }
      assert.equal(binding.projectId, project.projectId)
      assert.equal(binding.slug, feature.slug)
      assert.equal(persisted.metadata?.hostProjectRuntime, undefined)
      assert.deepEqual(
        await page!.evaluate((id) => window.api.threads.getMessages(id), session.threadId),
        []
      )
    }
    const detail = await page!.evaluate(
      ({ id, slug }) => window.api.harnessBoard.getRunDetail(id, slug),
      { id: project.projectId, slug: feature.slug }
    )
    assert.equal(detail.nativeProject, undefined)
    assert.equal(await page!.getByRole("dialog").count(), 0)
  }
  const finalReview = await existingProjectReview(project)
  assert.equal(finalReview.authorizationCurrent, true)
  assert.equal(
    finalReview.reviewDigest,
    initialReview.reviewDigest,
    "Features, manual sessions and reload must retain the original project authorization"
  )
  assert.equal(readFileSync(userFile, "utf8"), userFileText)
  assert.equal(readFileSync(pendingUserFile, "utf8"), pendingUserFileText)
  assert.equal(fixtureGit("status", "--porcelain=v1", "--untracked-files=normal"), initialGitStatus)
  return { project, initialReview, finalReview, features, guideAcknowledged }
}

async function archiveAndReadExistingHistory(
  journey: Awaited<ReturnType<typeof exerciseOriginalProject>>
) {
  const { project, features } = journey
  phase(`${project.projectCode}-archive-through-original-project-menu`)
  await page!
    .getByRole("main")
    .locator("nav")
    .getByRole("button", { name: "项目列表", exact: true })
    .click()
  const card = page!
    .locator('article[role="button"]')
    .filter({ has: page!.getByText(project.name, { exact: true }) })
  await card.waitFor()
  const threadsBefore = await page!.evaluate(() => window.api.threads.list())
  // Count calls while preserving the real handler, event, arguments, result and rejection.
  // This never replaces a business result or changes renderer/native authorization behavior.
  const observedChannels = await app!.evaluate(({ ipcMain }) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
    type Observer = { calls: Record<string, number>; restore: () => void }
    const target = globalThis as typeof globalThis & { __projectBundleArchiveObserver?: Observer }
    if (target.__projectBundleArchiveObserver) throw Error("ARCHIVE_OBSERVER_ALREADY_INSTALLED")
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    if (!(handlers instanceof Map)) throw Error("REAL_INVOKE_HANDLERS_REQUIRED")
    const channels = [...handlers.keys()].filter(
      (channel) =>
        channel.startsWith("harness-native-feature:") ||
        channel === "harnessBoard:reviewProjectUse" ||
        channel === "harnessBoard:nativeFeatureCommand"
    )
    for (const required of [
      "harness-native-feature:mods-read",
      "harnessBoard:reviewProjectUse",
      "harnessBoard:nativeFeatureCommand"
    ])
      if (!channels.includes(required)) throw Error(`REAL_ARCHIVE_HANDLER_REQUIRED:${required}`)
    const calls = Object.fromEntries(channels.map((channel) => [channel, 0]))
    const originals = channels.map((channel) => {
      const original = handlers.get(channel)!
      const observed: Handler = {
        invoke(event: Electron.IpcMainInvokeEvent, ...args: unknown[]) {
          calls[channel]++
          return original(event, ...args)
        }
      }.invoke
      handlers.set(channel, observed)
      return { channel, original, observed }
    })
    target.__projectBundleArchiveObserver = {
      calls,
      restore() {
        for (const { channel, original, observed } of originals) {
          if (handlers.get(channel) !== observed) throw Error("ARCHIVE_HANDLER_CHANGED")
          handlers.set(channel, original)
        }
      }
    }
    return channels
  })
  try {
    await card.getByRole("button", { name: "项目操作", exact: true }).click()
    await page!.getByRole("button", { name: "归档项目", exact: true }).click()
    const confirmation = page!.getByRole("dialog", { name: "归档项目", exact: true })
    await confirmation.waitFor()
    await confirmation.getByRole("button", { name: "归档项目", exact: true }).click()
    await confirmation.waitFor({ state: "hidden" })
    const archived = (await page!.evaluate(() => window.api.harnessBoard.listProjects())).find(
      (item) => item.projectId === project.projectId
    )
    assert.equal(
      archived?.lifecycle.status,
      "archived",
      "The original archive confirmation must persist lifecycle state"
    )

    phase(`${project.projectCode}-read-archived-history-from-existing-sidebar-session`)
    const { feature, sessions } = features[0]
    const projectGroup = page!.locator(`[data-sidebar-group-key="project:${project.projectId}"]`)
    await projectGroup.waitFor()
    const expandProject = projectGroup.getByRole("button", { name: "展开项目会话", exact: true })
    if (await expandProject.isVisible()) await expandProject.click()
    const group = page!.locator(
      `[data-sidebar-group-key="feature:${project.projectId}:${feature.slug}"]`
    )
    await group.waitFor()
    const expandFeature = group.getByRole("button", { name: "展开特性会话", exact: true })
    if (await expandFeature.isVisible()) await expandFeature.click()
    await group.hover()
    assert(
      await group.getByRole("button", { name: "新增会话", exact: true }).isDisabled(),
      "An archived native Feature cannot create a new session from the existing sidebar"
    )
    const session = sessions.at(-1)!
    await group
      .locator("..")
      .locator(`div[title=${JSON.stringify(session.title?.trim() || session.threadId)}]`)
      .first()
      .click()
    const chat = page!.locator(
      sessions.map((item) => `[data-chat-thread-id="${item.threadId}"]:visible`).join(",")
    )
    await chat.waitFor()
    const openedThreadId = await chat.getAttribute("data-chat-thread-id")
    assert(sessions.some((item) => item.threadId === openedThreadId))
    const composer = chat.locator("textarea.composer-textarea")
    await composer.waitFor()
    await assertProjectWorkbenchAbsent(chat, `${project.projectCode}-archived-historical-chat`)
    assert(
      await composer.isDisabled(),
      "The real historical Composer must be read-only after archival"
    )
    await chat.getByText("项目已归档，仅可查看历史会话。", { exact: true }).waitFor()
    assert.equal(await chat.getByText(/Response is not JSON|Unexpected token/).count(), 0)
    assert.equal(await page!.getByRole("button", { name: "项目能力", exact: true }).count(), 0)
    await page!.screenshot({
      path: join(fixture.isolated, "archived-existing-conversation-read-only.png"),
      animations: "disabled"
    })

    await page!
      .getByRole("main")
      .locator("nav")
      .getByRole("button", { name: feature.title, exact: true })
      .click()
    const main = page!.getByRole("main")
    await main.getByText("项目已归档，仅可查看历史记录。", { exact: true }).waitFor()
    for (const name of ["托管运行当前特性", "编辑特性配置", "新增会话"])
      assert(
        await main.getByRole("button", { name, exact: true }).isDisabled(),
        `Archived history cannot use ${name}`
      )
    assert.equal(await main.getByRole("region", { name: "本包功能权限", exact: true }).count(), 0)
    const detail = await page!.evaluate(
      ({ projectId, slug }) => window.api.harnessBoard.getRunDetail(projectId, slug),
      { projectId: project.projectId, slug: feature.slug }
    )
    assert.equal(detail.project.lifecycle?.status, "archived")
    assert.equal(detail.run.title, feature.title)
    assert.equal(
      detail.nativeProject,
      undefined,
      "Viewing archived manual history must not create a Host or execute Guest/Skill providers"
    )
    const threadsAfter = await page!.evaluate(() => window.api.threads.list())
    assert.deepEqual(
      threadsAfter.map((item) => item.thread_id).sort(),
      threadsBefore.map((item) => item.thread_id).sort()
    )
    for (const thread of threadsAfter)
      assert.deepEqual(
        await page!.evaluate((id) => window.api.threads.getMessages(id), thread.thread_id),
        []
      )
    const ipcCounts = await app!.evaluate(() => {
      const observer = (
        globalThis as typeof globalThis & {
          __projectBundleArchiveObserver?: { calls: Record<string, number> }
        }
      ).__projectBundleArchiveObserver
      if (!observer) throw Error("ARCHIVE_OBSERVER_MISSING")
      return observer.calls
    })
    assert(
      Object.values(ipcCounts).every((count) => count === 0),
      "Archived history must not request active native permission/configuration review or execution"
    )
    await page!.screenshot({
      path: join(fixture.isolated, "archived-existing-feature-read-only.png"),
      animations: "disabled"
    })
    return {
      projectId: project.projectId,
      featureId: feature.slug,
      openedThreadId,
      lifecycle: archived!.lifecycle,
      archiveEntry: "Original project card menu and confirmation dialog",
      historyEntry: "Existing sidebar session and original Feature breadcrumb",
      observedChannels,
      ipcCounts,
      noNewThreadsOrMessages: true,
      actualComposerReadOnly: true,
      authorizationEvidenceMoment:
        "The journey's unchanged authorization receipts were captured before archive. Archival revokes owner consent; no post-archive active review is requested or claimed valid."
    }
  } finally {
    await app!.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __projectBundleArchiveObserver?: { restore(): void }
      }
      target.__projectBundleArchiveObserver?.restore()
      delete target.__projectBundleArchiveObserver
    })
  }
}

async function main() {
  try {
    phase("launch-isolated-app")
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    evidence.pid = app.process().pid
    for (const [name, stream] of [
      ["stdout", app.process().stdout],
      ["stderr", app.process().stderr]
    ] as const)
      stream?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes)
      )
    page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForURL(expectedRendererUrl, { timeout: 60_000 })
    evidence.actualRendererUrl = page.url()
    page.setDefaultTimeout(25_000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.plugins?.install))
    phase("create-good-and-unavailable-fixture-projects")
    const setup = await page.evaluate(
      async ({ workspace, oldZip, goodZip }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        const thread = await window.api.threads.create({
          title: "项目包导入验收",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const threadId = thread.thread_id
        await window.api.workspace.set(threadId, workspace)
        const install = async (bytes: number[], name: string) => {
          const result = await window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            `${name}.zip`,
            "local"
          )
          if (!result.success) throw Error(result.error)
          const plugin = (await window.api.plugins.list()).find((item) => item.name === name)
          if (!plugin) throw Error("FIXTURE_PLUGIN_MISSING")
          await window.api.plugins.setEnabled(plugin.id, true)
          const prepared = await window.api.plugins.prepareStartUse({
            pluginId: plugin.id,
            threadId,
            expectedWorkspace: workspace,
            expected: { name: plugin.name, version: plugin.version }
          })
          if (prepared.kind !== "host-project") throw Error("REAL_NATIVE_PROJECT_REQUIRED")
          return { plugin, prepared }
        }
        const create = async (
          source: Awaited<ReturnType<typeof install>>,
          name: string,
          code: string
        ) => {
          const input = {
            adapterId: source.plugin.id,
            adapterType: "plugin" as const,
            name,
            projectCode: code,
            projectFromLean: false,
            projectDir: code.toLowerCase(),
            description: "Isolated container only; no feature or business run",
            systemId: "fixture",
            systemName: "Fixture",
            workspacePath: workspace,
            expectedNativeTemplate: source.prepared.identity
          }
          // Setup projects use the same real review and submitting frame as the UI.
          const review = await window.api.harnessBoard.reviewProjectUse({
            adapterId: input.adapterId,
            adapterType: "plugin",
            workspacePath: input.workspacePath,
            projectDir: input.projectDir,
            expectedNativeTemplate: input.expectedNativeTemplate
          })
          return window.api.harnessBoard.createProject({
            ...input,
            projectUseApproval: { reviewId: review.reviewId, reviewDigest: review.reviewDigest }
          })
        }
        const old = await install(oldZip, "composition-host-fixture")
        const unavailable = await create(old, "旧插件已移除的项目", "MISSING_PLUGIN_OLD")
        const removed = await window.api.plugins.delete(old.plugin.id)
        if (!removed.success) throw Error(removed.error)
        const good = await install(goodZip, "composition-reader-fixture")
        const available = await create(good, "正常的独立项目", "HEALTHY_PROJECT")
        return { threadId, unavailable, available, goodPluginId: good.plugin.id }
      },
      {
        workspace: fixture.workspace,
        oldZip: compositionHostFlow(),
        goodZip: compositionHostFlow(true)
      }
    )
    evidence.setup = setup
    await startCreatorFlowReadObserver()
    phase("upload-original-zip")
    await page.reload()
    await page.getByText("项目包导入验收", { exact: true }).first().click()
    const sourceList = await openPlugins()
    await sourceList.getByRole("button", { name: /composition-reader-fixture/ }).waitFor()
    // Select the header action, independently of the initial empty/loading state.
    await sourceList
      .locator(":scope > div")
      .first()
      .locator("button")
      .filter({ has: page.locator("svg.lucide-plus") })
      .click()
    const upload = page.getByRole("dialog", { name: "安装 Plugin", exact: true })
    await upload.locator("input[type=file]").setInputFiles(inputZip)
    await upload.waitFor({ state: "hidden", timeout: 60_000 })

    const catalog = await page.evaluate(async () => {
      const plugins = [] as Awaited<ReturnType<typeof window.api.plugins.list>>
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await window.api.skills.catalog.read(
          {
            kind: "plugins",
            limit: 2,
            revision: "real-bundle-import-acceptance",
            ...(cursor ? { cursor } : {})
          },
          "real-bundle-import-acceptance"
        )
        plugins.push(...page.plugins)
        cursor = page.cursor ?? undefined
        pages++
        if (pages > 20) throw Error("UNEXPECTED_CATALOG_PAGE_COUNT")
      } while (cursor)
      return { plugins, pages }
    })
    const mainPlugins = catalog.plugins.filter(
      (plugin) => (plugin.projectDependencyIds?.length ?? 0) === 3
    )
    assert.equal(
      mainPlugins.length,
      1,
      "The real paged catalog must identify exactly one uploaded project"
    )
    const main = mainPlugins[0]
    assert.equal(
      catalog.plugins.length,
      5,
      "Four bundle identities and one independent fixture remain installed"
    )
    assert(catalog.pages >= 3, "The acceptance must cross real catalog page boundaries")
    const dependencies = main.projectDependencyIds!.map(
      (id) => catalog.plugins.find((plugin) => plugin.id === id)!
    )
    assert(dependencies.every(Boolean))
    evidence.catalog = catalog
    phase("verify-paged-plugin-grouping")
    const assertPluginGrouping = async () => {
      const list = page!.locator("[data-plugin-source-list]")
      await list
        .getByRole("button", { name: new RegExp(main.name) })
        .first()
        .waitFor()
      const group = list.getByLabel(`${main.name}的依赖组件`, { exact: true })
      assert.equal(await group.count(), 1)
      assert.equal(await group.getAttribute("open"), null)
      for (const child of dependencies)
        assert.equal(await list.getByRole("button", { name: child.name, exact: true }).count(), 0)
      await group.locator("summary").click()
      for (const child of dependencies)
        await group.getByRole("button", { name: child.name, exact: true }).waitFor()
      await group.locator("summary").click()
      return list
    }
    await assertPluginGrouping()
    await page.screenshot({
      path: join(fixture.isolated, "plugins-one-project-collapsed.png"),
      animations: "disabled"
    })
    await page.reload()
    await page.getByText("项目包导入验收", { exact: true }).first().click()
    evidence.ordinaryWorkbench = await openOrdinaryWorkbench(setup.threadId)
    await openPlugins()
    await assertPluginGrouping()

    phase("open-original-project-form-from-mods")
    await openModsSettings(page)
    const installed = page.getByRole("region", { name: "已安装插件", exact: true })
    const rootCard = installed.locator(`[data-installed-mod-id="${main.id}"]`)
    await rootCard.getByRole("heading", { name: main.name, exact: true }).waitFor()
    assert.equal(await installed.locator(":scope > article").count(), 2)
    for (const child of dependencies)
      assert.equal(
        await installed.locator(`[data-installed-mod-id="${child.id}"]`).isVisible(),
        false
      )
    await rootCard.getByRole("button", { name: /^(开始使用|去使用)$/ }).click()
    const dialog = page.getByRole("dialog", { name: "新建项目", exact: true })
    await dialog.waitFor()
    await dialog.getByRole("textbox", { name: "项目名称 *", exact: true }).waitFor()
    for (const name of ["项目编号 *", "系统编号 *", "系统名称 *", "插件配置"])
      await dialog.getByText(name, { exact: true }).waitFor()
    for (const field of [
      dialog.getByPlaceholder("输入项目编号搜索", { exact: true }),
      dialog.getByRole("textbox", { name: "项目名称 *", exact: true }),
      dialog.getByRole("textbox", { name: "系统编号 *", exact: true }),
      dialog.getByRole("textbox", { name: "系统名称 *", exact: true })
    ]) {
      assert(await field.isEnabled())
      assert(await field.isEditable())
    }
    assert.equal(await page.getByRole("dialog", { includeHidden: true }).count(), 1)
    evidence.originalProjectForm = {
      accessible: true,
      openDialogCount: 1,
      originalProjectFields: true
    }
    assert.equal(await page.getByText("PROJECT_PLUGIN_UNAVAILABLE", { exact: false }).count(), 0)
    await page.screenshot({
      path: join(fixture.isolated, "original-project-form.png"),
      animations: "disabled"
    })
    phase("create-original-project-and-consent-once")
    const primary = await submitOriginalProject("原插件导入后试用项目", "BUNDLE_UAT", main.id)
    assert.equal(
      primary.review.sources.length,
      4,
      "The actual imported project and three dependencies must share the original project consent"
    )
    evidence.primaryProject = primary
    await assertProjectWorkbenchAbsent(page.getByRole("main"), "primary-original-project-entry")
    const primaryJourney = await exerciseOriginalProject(primary.project)
    evidence.primaryJourney = primaryJourney

    phase("use-generic-non-autobiz-template-through-original-form")
    // Open a normal discussion before going back to Mods, preserving the ordinary start-use scope.
    await page.getByRole("tab", { name: "对话模式", exact: true }).click()
    await page.getByText("项目包导入验收", { exact: true }).first().click()
    evidence.ordinaryWorkbenchBeforeGeneric = await openOrdinaryWorkbench(setup.threadId)
    await openModsSettings(page)
    const generic = page
      .getByRole("region", { name: "已安装插件", exact: true })
      .locator(`[data-installed-mod-id="${setup.goodPluginId}"]`)
    await generic.getByRole("button", { name: /^(开始使用|去使用)$/ }).click()
    await page.getByRole("dialog", { name: "新建项目", exact: true }).waitFor()
    const secondary = await submitOriginalProject(
      "通用非AutoBiz项目试用",
      "GENERIC_UAT",
      setup.goodPluginId
    )
    assert.equal(
      secondary.review.sources.length,
      0,
      "A skill-only native template declares neither extension code nor configuration sources"
    )
    evidence.genericProject = secondary
    await assertProjectWorkbenchAbsent(page.getByRole("main"), "generic-original-project-entry")
    const genericJourney = await exerciseOriginalProject(secondary.project)
    evidence.genericJourney = genericJourney

    const details = await page.evaluate(async ({ unavailable, available }) => {
      const batch = await window.api.harnessBoard.getProjectDetails(
        [unavailable.projectId, available.projectId],
        { watchRefs: false }
      )
      return { unavailable: batch[unavailable.projectId], available: batch[available.projectId] }
    }, setup)
    assert(details.unavailable.error)
    assert.equal(details.unavailable.projectState?.uiKind, "warning")
    assert.equal(details.available.error, null)
    assert(!JSON.stringify(details).includes("PROJECT_PLUGIN_UNAVAILABLE"))
    const messages = await page.evaluate(
      (threadId) => window.api.threads.getMessages(threadId),
      setup.threadId
    )
    assert.equal(
      messages.length,
      0,
      "Project setup and trials must not send through the entry chat"
    )
    const allMessages = await page.evaluate(async () => {
      const threads = await window.api.threads.list()
      return Promise.all(
        threads.map(async (thread) => ({
          threadId: thread.thread_id,
          count: (await window.api.threads.getMessages(thread.thread_id)).length
        }))
      )
    })
    assert(
      allMessages.every((thread) => thread.count === 0),
      "No project form, Feature or manual session may auto-send or invoke a model"
    )
    assert.deepEqual(errors, [])
    assert.equal(createHash("sha256").update(readFileSync(inputZip)).digest("hex"), inputSha256)
    assert.equal(projectCompositionCandidate(root).sha256, candidate.sha256)
    evidence.details = details
    evidence.messages = messages
    evidence.allMessageCounts = allMessages
    evidence.manualSessionCount = 8
    evidence.featureCount = 4
    evidence.realComposerEditableBeforeAndAfterReload = true
    evidence.directorySelectionBoundary =
      "Only Electron showOpenDialog returns the isolated user choice"
    evidence.noModelOrHostExecution = true
    evidence.inputZipUnchanged = true
    evidence.authorizationEvidenceMoment =
      "All unchanged receipt assertions above occur before project archival"
    evidence.archivedHistory = await archiveAndReadExistingHistory(primaryJourney)
    assert.equal(readFileSync(pendingUserFile, "utf8"), pendingUserFileText)
    assert.equal(
      fixtureGit("status", "--porcelain=v1", "--untracked-files=normal"),
      initialGitStatus
    )
    const creatorFlowEvents = await app.evaluate(() => {
      const observer = (
        globalThis as typeof globalThis & {
          __projectCreatorFlowObserver?: { events: Array<{ channel: string; threadId?: string }> }
        }
      ).__projectCreatorFlowObserver
      if (!observer) throw Error("CREATOR_FLOW_OBSERVER_MISSING")
      return observer.events
    })
    const projectThreadIds = [primaryJourney, genericJourney].flatMap((journey) =>
      journey.features.flatMap(({ sessions }) => sessions.map((session) => session.threadId))
    )
    assert.equal(new Set(projectThreadIds).size, 8)
    const projectCreatorFlowEvents = creatorFlowEvents.filter(
      (event) => event.threadId && projectThreadIds.includes(event.threadId)
    )
    assert.deepEqual(
      projectCreatorFlowEvents,
      [],
      "Project chats must not read creator-flow bindings, catalog, active runs or history"
    )
    assert.deepEqual(
      creatorFlowEvents.filter((event) => event.channel === "project-composition:catalog"),
      [],
      "The mature project workflow must not request the separate composition catalog"
    )
    assert(
      creatorFlowEvents.some(
        (event) => event.threadId === setup.threadId && event.channel === "mods:claw-view"
      ),
      "The passive observer must see the ordinary chat's real creator-binding read"
    )
    evidence.projectChatWorkbench = {
      ordinaryProgressAndThreeTabsAvailable: true,
      allProjectChatsHaveNoCreatorControlsOrEmptyShell: true,
      projectThreadIds,
      projectCreatorFlowEvents,
      ordinaryCreatorReadCount: creatorFlowEvents.filter(
        (event) => event.threadId === setup.threadId
      ).length,
      passiveRealIpcEvents: creatorFlowEvents,
      boundary:
        "Real App ordinary Claw selection, original project panels and stale sidebar-tab event are covered. Drafts remain editable without sending; private creator-choice state and project business execution are not seeded or exercised. Original plugin pane/runtime slots remain unchanged."
    }
    assert.deepEqual(errors, [])
    assert.equal(createHash("sha256").update(readFileSync(inputZip)).digest("hex"), inputSha256)
    assert.equal(projectCompositionCandidate(root).sha256, candidate.sha256)
    phase("complete")
    passed = true
    console.log(`PASS real project bundle import and original entry: ${fixture.isolated}`)
  } catch (error) {
    evidence.failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
    if (app)
      evidence.creatorFlowEventsAtFailure = await app
        .evaluate(() => {
          const target = globalThis as typeof globalThis & {
            __projectCreatorFlowObserver?: {
              events: Array<{ channel: string; threadId?: string }>
            }
          }
          return target.__projectCreatorFlowObserver?.events
        })
        .catch(() => undefined)
    if (page && !page.isClosed()) {
      evidence.dialogs = await page
        .locator('[role="dialog"]')
        .evaluateAll((dialogs) =>
          dialogs.map((dialog) => ({
            label: dialog.getAttribute("aria-label"),
            title: dialog.querySelector("h2")?.textContent,
            hidden: dialog.getAttribute("aria-hidden"),
            ancestorHidden: dialog.parentElement?.closest('[aria-hidden="true"]')?.tagName,
            display: getComputedStyle(dialog).display
          }))
        )
        .catch(() => undefined)
      await page.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => undefined)
    }
    throw error
  } finally {
    save()
    if (app) {
      try {
        await app.evaluate(() => {
          const target = globalThis as typeof globalThis & {
            __projectCreatorFlowObserver?: { restore(): void }
          }
          target.__projectCreatorFlowObserver?.restore()
          delete target.__projectCreatorFlowObserver
        })
      } finally {
        await app.close()
      }
    }
  }
}

export const projectBundleImportAcceptance = main().catch((error) => {
  console.error(error)
  process.exitCode = 1
  throw error
})
