/** The original project/Feature UI, with real public nativeFeatureCommand ownership. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { HarnessRunDetailViewModel } from "../../src/shared/harness-board-types"
import type { FunctionConfigValue } from "../../src/shared/mods/v2/config"
import type { FunctionUserConfigView } from "../../src/shared/mods/v2/user-config-view"
import type { PluginStartUseIdentity } from "../../src/shared/plugin-start-use"
import type { ProjectFunctionSourceReview } from "../../src/shared/project-runtime/function-source"
import type { LocalProjectView } from "../../src/shared/project-runtime/platform-api"
import { normalizeWorkspacePathKey } from "../../src/shared/workspace-path"
import { readPackageProtocolDigestAsync } from "../../src/main/harness-board/project-runtime/package-snapshots"
import { openUnifiedProjectList } from "./project-unified-native-journey"

type JourneyStatus = "passed" | "failed" | "environment-blocked" | "unverified"
type NativeOperation = LocalProjectView["operations"][number]

export interface OriginalFeatureJourneyPaths {
  journeyRoot: string
  workspaceParent: string
  repositoryWorkspace: string
  projectRoot: string
}

export interface OriginalFeatureJourneyResult {
  providerBoundary: "not-started" | "controlled" | "commercial"
  plugin: PluginStartUseIdentity
  paths: OriginalFeatureJourneyPaths
  projectId?: string
  featureId?: string
  hostRunId?: string
  runtimePackageDigest?: string
  runtimePackageSource?: string
  steps: Array<{ name: string; status: JourneyStatus; evidence: Record<string, unknown> }>
  environmentIssues: Array<{ category: "git" | "system-approval"; message: string }>
  pendingReviews: Array<{ kind: "configuration" | "execution" | "result"; message: string }>
  observations: Array<Record<string, unknown>>
  nativeCommands: Array<{
    kind: string
    evidence: "ui-submission" | "public-api-response"
    projectId: string
    featureId: string
    operationId?: string
  }>
}

export interface OriginalFeatureJourneyInput {
  app: ElectronApplication
  page: Page
  /** The caller's unique disposable environment root, never a user's repository. */
  isolationRoot: string
  workspaceParent: string
  artifacts: string
  artifactPrefix?: string
  installed: { pluginId: string; name: string; version: string; sourceDigest: string }
  project: {
    name: string
    code: string
    systemId: string
    systemName: string
    folder: string
    description?: string
  }
  feature: { title: string; goal: string }
  deadline: number
  /** Only explicit, non-sensitive values are entered through the real parameter form. */
  configuration?(input: {
    review: ProjectFunctionSourceReview
    view: FunctionUserConfigView
    paths: OriginalFeatureJourneyPaths
  }): Record<string, FunctionConfigValue> | Promise<Record<string, FunctionConfigValue>>
  /** Omit this to inspect creation/configuration without starting any model execution. */
  execution?: {
    providerBoundary: "controlled" | "commercial"
    /** Stop after this many observed stage transitions; does not invent a stage success. */
    maxStageTransitions: number
    confirmStage?(view: LocalProjectView, operation: NativeOperation): boolean | Promise<boolean>
    /** The caller must inspect the real checks/artifacts before returning true. */
    confirmKnownResult?(view: LocalProjectView): boolean | Promise<boolean>
    /** Explicit controlled fixtures may decide a current one-shot native tool approval. */
    decideKnownEnvironmentApprovals?(input: {
      view: LocalProjectView
      operation: NativeOperation
      pending: unknown[]
    }): Promise<boolean>
  }
  beginStage?(label: string, workspace: string, projectId: string): void
  endStage?(): void
}

/** Fixture preflight follows the unchanged original ProjectForm's metadata constraints. */
export function assertOriginalFeatureMetadata(
  input: Pick<OriginalFeatureJourneyInput, "installed" | "project" | "feature">
) {
  const { project, feature } = input
  for (const [name, value] of Object.entries({
    pluginId: input.installed.pluginId,
    name: project.name,
    code: project.code,
    folder: project.folder,
    systemId: project.systemId,
    systemName: project.systemName,
    featureTitle: feature.title,
    featureGoal: feature.goal
  }))
    assert(typeof value === "string" && value.trim(), `ORIGINAL_FEATURE_REQUIRED:${name}`)
  const description = project.description ?? project.name
  for (const [name, value, maximum] of [
    ["name", project.name, 50],
    ["code", project.code, 15],
    ["description", description, 100],
    ["folder", project.folder, 30]
  ] as const)
    assert(Array.from(value.trim()).length <= maximum, `ORIGINAL_FEATURE_METADATA_TOO_LONG:${name}`)
  const pattern = /^[\u4e00-\u9fffA-Za-z0-9_-]+$/u
  assert(pattern.test(project.code), "ORIGINAL_FEATURE_METADATA_PATTERN:code")
  assert(pattern.test(project.folder), "ORIGINAL_FEATURE_METADATA_PATTERN:folder")
  // The original Feature title input removes whitespace as the user types.
  assert(
    pattern.test(feature.title.replace(/\s/g, "")),
    "ORIGINAL_FEATURE_METADATA_PATTERN:featureTitle"
  )
}

function assertInside(root: string, target: string) {
  const tail = relative(root, target)
  assert(
    !isAbsolute(tail) && tail !== ".." && !tail.startsWith("..\\") && !tail.startsWith("../"),
    "ORIGINAL_FEATURE_PATH_OUTSIDE_ISOLATION"
  )
}

function equalPath(left: string, right: string) {
  return normalizeWorkspacePathKey(left) === normalizeWorkspacePathKey(right)
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sources(review: ProjectFunctionSourceReview) {
  return [...(review.source ? [review.source] : []), ...(review.dependencies ?? [])]
}

function ready(review: ProjectFunctionSourceReview) {
  const executable = Boolean(
    (review.source && !review.source.configurationOnly) || review.dependencies?.length
  )
  return (
    (!executable || (review.workspaceEnabled !== false && review.globallyEnabled !== false)) &&
    sources(review).every(
      (source) => source.state === "ready" && source.configurationReady !== false
    )
  )
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Only one real native picker response is replaced, for an already verified private path. */
async function choosePrivatePath(
  app: ElectronApplication,
  path: string,
  kind: "openDirectory" | "openFile",
  title: string | null,
  act: () => Promise<unknown>
) {
  const token = randomUUID()
  await app.evaluate(
    ({ dialog }, input) => {
      const state = globalThis as typeof globalThis & {
        __originalFeaturePicker?: {
          token: string
          original: typeof dialog.showOpenDialog
          count: number
        }
      }
      if (state.__originalFeaturePicker) throw Error("ORIGINAL_FEATURE_PICKER_ALREADY_INSTALLED")
      const current = { token: input.token, original: dialog.showOpenDialog, count: 0 }
      state.__originalFeaturePicker = current
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        dialog.showOpenDialog = current.original
        current.count++
        const options = args.at(-1) as { title?: string; properties?: string[] } | undefined
        if (
          current.count !== 1 ||
          (options?.title ?? null) !== input.title ||
          !options?.properties?.includes(input.kind)
        )
          throw Error("ORIGINAL_FEATURE_UNEXPECTED_NATIVE_PICKER")
        return { canceled: false, filePaths: [input.path] }
      }) as typeof dialog.showOpenDialog
    },
    { token, path, kind, title }
  )
  let actionError: unknown
  try {
    await act()
  } catch (error) {
    actionError = error
  }
  const count = await app.evaluate(({ dialog }, expected) => {
    const state = globalThis as typeof globalThis & {
      __originalFeaturePicker?: {
        token: string
        original: typeof dialog.showOpenDialog
        count: number
      }
    }
    const current = state.__originalFeaturePicker
    if (!current || current.token !== expected) throw Error("ORIGINAL_FEATURE_PICKER_SCOPE_CHANGED")
    dialog.showOpenDialog = current.original
    delete state.__originalFeaturePicker
    return current.count
  }, token)
  if (actionError) throw actionError
  assert.equal(count, 1, "ORIGINAL_FEATURE_NATIVE_PICKER_NOT_USED")
}

export async function exerciseLiveOriginalFeatureJourney(input: OriginalFeatureJourneyInput) {
  const { app, page } = input
  assertOriginalFeatureMetadata(input)
  assert(input.deadline > Date.now(), "ORIGINAL_FEATURE_DEADLINE_EXPIRED")
  const projectDescription = input.project.description ?? input.project.name
  assert(/^[a-f0-9]{64}$/i.test(input.installed.sourceDigest), "ORIGINAL_FEATURE_DIGEST_REQUIRED")
  const prefix = input.artifactPrefix ?? "original-feature"
  assert(/^[a-z0-9_.-]{1,80}$/i.test(prefix), "ORIGINAL_FEATURE_ARTIFACT_PREFIX_INVALID")
  assert(
    input.project.folder &&
      !/[\\/]/.test(input.project.folder) &&
      ![".", ".."].includes(input.project.folder),
    "ORIGINAL_FEATURE_FOLDER_INVALID"
  )
  if (input.execution)
    assert(
      Number.isSafeInteger(input.execution.maxStageTransitions) &&
        input.execution.maxStageTransitions > 0,
      "ORIGINAL_FEATURE_TRANSITION_LIMIT_INVALID"
    )
  const isolationRoot = realpathSync(input.isolationRoot)
  const workspaceParent = realpathSync(input.workspaceParent)
  assertInside(isolationRoot, workspaceParent)
  const journeyRoot = join(workspaceParent, `journey-${randomUUID().slice(0, 8)}`)
  // This directory did not exist before this test; no existing repository can be modified.
  mkdirSync(journeyRoot)
  const paths: OriginalFeatureJourneyPaths = {
    journeyRoot,
    workspaceParent: join(journeyRoot, "projects"),
    repositoryWorkspace: join(journeyRoot, "repository"),
    projectRoot: join(journeyRoot, "projects", input.project.folder)
  }
  mkdirSync(paths.workspaceParent)
  mkdirSync(paths.repositoryWorkspace)
  const artifacts = realpathSync(input.artifacts)
  const result: OriginalFeatureJourneyResult = {
    providerBoundary: input.execution?.providerBoundary ?? "not-started",
    plugin: {
      pluginId: input.installed.pluginId,
      name: input.installed.name,
      version: input.installed.version,
      digest: input.installed.sourceDigest
    },
    paths,
    steps: [],
    environmentIssues: [],
    pendingReviews: [],
    observations: [],
    nativeCommands: []
  }
  const save = () =>
    writeFileSync(
      join(artifacts, `${prefix}-original-feature.json`),
      JSON.stringify(result, null, 2)
    )
  const step = (name: string, status: JourneyStatus, evidence: Record<string, unknown>) => {
    result.steps.push({ name, status, evidence })
    save()
  }
  const remaining = () => {
    const value = input.deadline - Date.now()
    assert(value > 0, "ORIGINAL_FEATURE_TIME_LIMIT")
    return Math.min(value, 15000)
  }
  const until = async <T>(read: () => Promise<T>, accept: (value: T) => boolean) => {
    while (true) {
      remaining()
      const value = await read()
      if (accept(value)) return value
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  let activeStep = "repository-fixture"
  let activeStage = false
  try {
    writeFileSync(
      join(paths.repositoryWorkspace, "README.md"),
      "# Isolated original Feature acceptance\n\nOnly small text/JSON handoff artifacts are requested.\n"
    )
    try {
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: paths.repositoryWorkspace,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        }).trim()
      git(["init", "--initial-branch=mods-acceptance"])
      assert(
        equalPath(git(["rev-parse", "--show-toplevel"]), paths.repositoryWorkspace),
        "ORIGINAL_FEATURE_REPOSITORY_SCOPE_CHANGED"
      )
      git(["config", "--local", "user.name", "Mods Acceptance"])
      git(["config", "--local", "user.email", "mods-acceptance@example.invalid"])
      git(["config", "--local", "commit.gpgsign", "false"])
      git(["config", "--local", "core.hooksPath", join(paths.journeyRoot, "disabled-hooks")])
      git(["add", "--", "README.md"])
      git([
        "-c",
        "user.name=Mods Acceptance",
        "-c",
        "user.email=mods-acceptance@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "test: initialize isolated Feature workspace"
      ])
      step(activeStep, "passed", {
        independentRepository: paths.repositoryWorkspace,
        commit: git(["rev-parse", "HEAD"])
      })
    } catch (error) {
      const message = errorText(error)
      result.environmentIssues.push({ category: "git", message })
      step(activeStep, "environment-blocked", { message, directory: paths.repositoryWorkspace })
      return result
    }

    activeStep = "original-project-create"
    const before = await page.evaluate(() => window.api.harnessBoard.listProjects())
    const registry = await page.evaluate(() => window.api.harnessBoard.registry())
    const plugin = registry.filter((item) => item.id === input.installed.pluginId)
    assert.equal(plugin.length, 1, "ORIGINAL_FEATURE_INSTALLED_PLUGIN_NOT_UNIQUE")
    assert.equal(plugin[0].runtimeMode, "host", "ORIGINAL_FEATURE_NATIVE_PROJECT_PLUGIN_REQUIRED")
    assert(plugin[0].enabled !== false, "ORIGINAL_FEATURE_INSTALLED_ADAPTER_DISABLED")
    assert.equal(plugin[0].name, input.installed.name)
    assert.equal(plugin[0].version, input.installed.version)
    const installed = (await page.evaluate(() => window.api.plugins.list())).find(
      (plugin) => plugin.id === input.installed.pluginId
    )
    assert(installed, "ORIGINAL_FEATURE_PACKAGE_NOT_FOUND")
    assertInside(isolationRoot, realpathSync(installed.path))
    await openUnifiedProjectList(page)
    await page.getByRole("button", { name: "新建项目", exact: true }).first().click()
    const form = page.getByRole("dialog", { name: "新建项目", exact: true })
    await form.waitFor({ timeout: remaining() })
    assert.equal(
      await form.getByRole("textbox", { name: "希望完成什么", exact: true }).count(),
      0,
      "ORIGINAL_FEATURE_MUST_USE_EXISTING_METADATA_FORM"
    )
    await form.getByRole("button", { name: /^选择插件/ }).click()
    await page.getByRole("textbox", { name: "搜索插件", exact: true }).fill(input.installed.name)
    await page
      .getByRole("option", {
        name: new RegExp(
          `^${escaped(input.installed.name)} · ${escaped(input.installed.version)}(?: |$)`
        )
      })
      .click()
    await form.getByPlaceholder("输入项目编号搜索", { exact: true }).fill(input.project.code)
    await form.getByPlaceholder("输入项目名称搜索", { exact: true }).fill(input.project.name)
    await form.getByRole("textbox", { name: "项目描述", exact: true }).fill(projectDescription)
    await form.getByRole("textbox", { name: /^系统编号/ }).fill(input.project.systemId)
    await form.getByRole("textbox", { name: /^系统名称/ }).fill(input.project.systemName)
    await choosePrivatePath(app, paths.workspaceParent, "openDirectory", "选择工作区文件夹", () =>
      form.getByLabel("插件工作区根目录", { exact: true }).click()
    )
    await until(
      () => form.getByLabel("插件工作区根目录", { exact: true }).inputValue(),
      (value) => equalPath(value, paths.workspaceParent)
    )
    await form.getByLabel("本项目产物文件夹", { exact: true }).fill(input.project.folder)
    await form.getByRole("button", { name: "创建", exact: true }).click()
    await form.waitFor({ state: "hidden", timeout: remaining() })
    const created = (await page.evaluate(() => window.api.harnessBoard.listProjects())).filter(
      (item) => !before.some((old) => old.projectId === item.projectId)
    )
    assert.equal(created.length, 1, "ORIGINAL_FEATURE_PUBLIC_CREATION_NOT_UNIQUE")
    const project = created[0]
    result.projectId = project.projectId
    assert.equal(project.name, input.project.name)
    assert.equal(project.projectCode, input.project.code)
    assert.equal(project.systemId, input.project.systemId)
    assert.equal(project.systemName, input.project.systemName)
    assert.equal(project.projectDir, input.project.folder)
    assert(equalPath(project.workspacePath, paths.workspaceParent))
    assert.equal(project.harnessAdapter.id, input.installed.pluginId)
    assert.equal(project.nativeBinding?.installedPluginId, input.installed.pluginId)
    step(activeStep, "passed", {
      projectId: project.projectId,
      engine: "original-harnessBoard",
      adapterId: project.harnessAdapter.id,
      workspacePath: project.workspacePath
    })

    activeStep = "original-project-config"
    const heading = page.getByRole("heading", { name: input.project.name, exact: true })
    await heading.locator("xpath=ancestor::*[@role='button'][1]").click()
    await page.getByRole("button", { name: "编辑项目配置", exact: true }).click()
    const edit = page.getByRole("dialog", { name: "编辑项目", exact: true })
    await edit.waitFor({ timeout: remaining() })
    assert.equal(
      await edit.getByPlaceholder("输入项目名称搜索", { exact: true }).inputValue(),
      input.project.name
    )
    assert.equal(
      await edit.getByLabel("本项目产物文件夹", { exact: true }).inputValue(),
      input.project.folder
    )
    assert(
      equalPath(
        await edit.getByLabel("插件工作区根目录", { exact: true }).inputValue(),
        paths.workspaceParent
      )
    )
    await edit.getByRole("button", { name: "取消", exact: true }).click()
    const detail = await page.evaluate(
      (id) => window.api.harnessBoard.getProjectDetail(id),
      project.projectId
    )
    assert(equalPath(detail.project.projectRootPath, paths.projectRoot))
    step(activeStep, "passed", {
      persistedMetadata: true,
      projectRoot: detail.project.projectRootPath
    })

    activeStep = "original-feature-create"
    const previous = detail.runs.map((run) => run.slug)
    await page.getByRole("button", { name: "新建特性", exact: true }).first().click()
    const featureForm = page.getByRole("dialog", { name: "创建特性", exact: true })
    await featureForm.getByRole("textbox", { name: /^特性名称/ }).fill(input.feature.title)
    await choosePrivatePath(
      app,
      paths.repositoryWorkspace,
      "openDirectory",
      "选择工作区文件夹",
      () => featureForm.getByLabel("会话工作区", { exact: true }).click()
    )
    await until(
      () => featureForm.getByLabel("会话工作区", { exact: true }).inputValue(),
      (value) => equalPath(value, paths.repositoryWorkspace)
    )
    await featureForm.getByRole("button", { name: "创建", exact: true }).click()
    await featureForm.waitFor({ state: "hidden", timeout: remaining() })
    const runs = (
      await page.evaluate((id) => window.api.harnessBoard.getProjectDetail(id), project.projectId)
    ).runs.filter((run) => !previous.includes(run.slug))
    assert.equal(runs.length, 1, "ORIGINAL_FEATURE_PUBLIC_FEATURE_NOT_UNIQUE")
    result.featureId = runs[0].slug
    const readRun = async () => {
      while (true) {
        remaining()
        try {
          return await page.evaluate(
            ({ projectId, featureId }) =>
              window.api.harnessBoard.getRunDetail(projectId, featureId),
            {
              projectId: project.projectId,
              featureId: runs[0].slug
            }
          )
        } catch (error) {
          if (!errorText(error).includes("Harness catalog request was superseded")) throw error
          await new Promise((done) => setTimeout(done, 100))
        }
      }
    }
    const initial = await readRun()
    const binding = initial.nativeBinding
    assert(binding, "ORIGINAL_FEATURE_NATIVE_BINDING_REQUIRED")
    assert.equal(binding.engine, "host")
    assert.equal(binding.installedPluginId, input.installed.pluginId)
    assert.deepEqual(
      binding.expectedPlugin,
      result.plugin,
      "ORIGINAL_FEATURE_RETAINED_PACKAGE_CHANGED"
    )
    assert(equalPath(binding.repositoryWorkspace, paths.repositoryWorkspace))
    if (binding.worktree) {
      assert(equalPath(realpathSync(binding.worktree.sourceRoot), paths.repositoryWorkspace))
      assert(
        equalPath(
          realpathSync(binding.worktree.workspaceDirectory),
          realpathSync(binding.workspace)
        )
      )
      assertInside(isolationRoot, realpathSync(binding.worktree.directory))
    } else assertInside(realpathSync(journeyRoot), realpathSync(binding.workspace))
    assertInside(isolationRoot, realpathSync(binding.workspace))
    assert(!initial.nativeProject, "ORIGINAL_FEATURE_CREATION_MUST_NOT_EXECUTE")
    result.hostRunId = binding.hostRunId
    step(activeStep, "passed", {
      featureId: runs[0].slug,
      hostRunId: binding.hostRunId,
      expectedPlugin: binding.expectedPlugin,
      repositoryWorkspace: binding.repositoryWorkspace,
      executionWorkspace: binding.workspace,
      operationsAtCreation: 0
    })
    await page.screenshot({ path: join(artifacts, `${prefix}-original-feature-created.png`) })

    activeStep = "fresh-function-consent"
    const readReview = () =>
      page.evaluate((id) => window.api.harnessBoard.nativeFeatureMods.read(id), binding.hostRunId)
    let review = await readReview()
    assert(/^[a-f0-9]{64}$/.test(review.packageDigest))
    const retained = realpathSync(
      join(isolationRoot, "data/local-projects/packages", review.packageDigest, "package")
    )
    assertInside(isolationRoot, retained)
    const runtimePackageDigest = await readPackageProtocolDigestAsync(retained)
    assert.equal(review.packageDigest, runtimePackageDigest)
    result.runtimePackageDigest = runtimePackageDigest
    result.runtimePackageSource = retained
    assert(equalPath(review.workspace, binding.workspace))
    const executableSources = sources(review).filter(
      (source) => !("configurationOnly" in source && source.configurationOnly)
    )
    assert(
      executableSources.every((source) => source.state !== "ready"),
      "ORIGINAL_FEATURE_FRESH_WORKSPACE_MUST_NOT_INHERIT_SOURCE_GRANTS"
    )
    const beforeConsent = sources(review).map((source) => ({
      pluginId: source.pluginId,
      digest: source.digest,
      state: source.state,
      configurationOnly: "configurationOnly" in source && source.configurationOnly === true
    }))
    const permission = page.getByRole("region", { name: "本包功能权限", exact: true })
    if (await permission.count()) {
      const details = permission.locator(":scope > details")
      if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
        await details.locator(":scope > summary").click()
    }
    for (const source of sources(review).filter((source) => source.hasConfiguration)) {
      assert(source.pluginId, "ORIGINAL_FEATURE_CONFIG_PLUGIN_ID_REQUIRED")
      const pluginId = source.pluginId
      let view = await page.evaluate(
        ({ hostRunId, pluginId, workspace }) =>
          window.api.harnessBoard.nativeFeatureMods.config.userConfig(
            hostRunId,
            pluginId,
            workspace
          ),
        { hostRunId: binding.hostRunId, pluginId, workspace: binding.workspace }
      )
      const values = (await input.configuration?.({ review, view, paths })) ?? {}
      for (const key of Object.keys(values)) {
        const field = view.fields.find((item) => item.key === key)
        assert(field?.supported && !field.sensitive, "ORIGINAL_FEATURE_CONFIG_VALUE_NOT_PUBLIC")
        const config = permission.locator("[data-function-user-config]").filter({
          has: page.locator(`label[for=${JSON.stringify(`plugin-param-${pluginId}-${key}`)}]`)
        })
        const summary = config.locator(":scope > summary")
        if (
          (await summary.count()) &&
          !(await config.evaluate((node) => (node as HTMLDetailsElement).open))
        )
          await summary.click()
        const label = config.locator(
          `label[for=${JSON.stringify(`plugin-param-${pluginId}-${key}`)}]`
        )
        const row = label.locator("xpath=..")
        const control = config.getByLabel(new RegExp(`^${escaped(field.label)}(?: · 必填)?$`))
        const value = values[key]
        if (field.multiple) {
          assert(
            Array.isArray(value) && value.every((item) => typeof item === "string"),
            "ORIGINAL_FEATURE_CONFIG_LIST_INVALID"
          )
          while (await row.getByRole("button", { name: /^删除.+第 \d+ 项$/ }).count())
            await row
              .getByRole("button", { name: /^删除.+第 \d+ 项$/ })
              .last()
              .click()
          for (const item of value) {
            await row.getByRole("button", { name: "添加一项", exact: true }).click()
            await row.getByRole("textbox").last().fill(item)
          }
        } else if (field.type === "boolean") {
          assert.equal(typeof value, "boolean")
          await control.setChecked(value as boolean)
        } else if (field.type === "directory" || field.type === "file") {
          assert.equal(typeof value, "string")
          const path = realpathSync(String(value))
          assertInside(realpathSync(journeyRoot), path)
          await choosePrivatePath(
            app,
            path,
            field.type === "directory" ? "openDirectory" : "openFile",
            null,
            () =>
              row
                .getByRole("button", {
                  name: field.type === "directory" ? "选择目录" : "选择文件",
                  exact: true
                })
                .click()
          )
          await until(
            () => control.inputValue(),
            (current) => equalPath(current, path)
          )
        } else if (field.options) await control.selectOption(String(value))
        else await control.fill(String(value))
        const previousRevision = view.savedRevision
        await row.getByRole("button", { name: "保存", exact: true }).click()
        view = await until(
          () =>
            page.evaluate(
              ({ hostRunId, pluginId, workspace }) =>
                window.api.harnessBoard.nativeFeatureMods.config.userConfig(
                  hostRunId,
                  pluginId,
                  workspace
                ),
              { hostRunId: binding.hostRunId, pluginId, workspace: binding.workspace }
            ),
          (next) => next.savedRevision > previousRevision
        )
        assert.deepEqual(
          view.fields.find((item) => item.key === key)?.value,
          value,
          "ORIGINAL_FEATURE_CONFIG_NOT_PERSISTED"
        )
      }
    }
    review = await readReview()
    if (sources(review).some((source) => source.configurationReady === false)) {
      result.pendingReviews.push({
        kind: "configuration",
        message: "Required native configuration remains incomplete"
      })
      step(activeStep, "unverified", { beforeConsent, reason: "required-configuration-incomplete" })
      return result
    }
    if (!ready(review)) {
      const confirm = permission.getByRole("button", {
        name: "确认以上权限并启用项目",
        exact: true
      })
      if (!(await confirm.isVisible()) || !(await confirm.isEnabled())) {
        result.environmentIssues.push({
          category: "system-approval",
          message: "Fresh native source consent is unavailable"
        })
        step(activeStep, "environment-blocked", {
          beforeConsent,
          reason: "native-consent-unavailable"
        })
        return result
      }
      await confirm.click()
      review = await until(readReview, ready)
    }
    step(activeStep, "passed", {
      beforeConsent,
      workspace: review.workspace,
      exactFreshSourceConsent: executableSources.length > 0,
      sources: sources(review).map((source) => ({
        pluginId: source.pluginId,
        digest: source.digest,
        state: source.state,
        configurationReady: source.configurationReady
      }))
    })
    if (!input.execution) {
      step("native-execution", "unverified", { reason: "execution-not-requested" })
      step("stage-handoff", "unverified", { reason: "execution-not-requested" })
      return result
    }

    activeStep = "native-execution"
    await until(
      () => page.getByRole("button", { name: "托管运行当前特性", exact: true }).isEnabled(),
      Boolean
    )
    input.beginStage?.(prefix, binding.workspace, binding.hostRunId)
    activeStage = true
    await page.getByRole("button", { name: "托管运行当前特性", exact: true }).click()
    const managed = page.getByRole("dialog", { name: "开启托管运行", exact: true })
    await managed
      .getByRole("textbox", { name: "启动会话的初始用户消息", exact: true })
      .fill(input.feature.goal)
    await managed.getByRole("button", { name: "确认并开启托管", exact: true }).click()
    await managed.waitFor({ state: "hidden", timeout: remaining() })
    // This is the original UI dispatch, not a replacement Host or an injected result.
    result.nativeCommands.push({
      kind: "start-feature",
      evidence: "ui-submission",
      projectId: project.projectId,
      featureId: runs[0].slug
    })
    const executionStarted = await until(readRun, (current) => Boolean(current.nativeProject))
    assert.equal(executionStarted.nativeProject!.project.projectId, binding.hostRunId)
    assert.equal(executionStarted.nativeProject!.project.stateOwner, "host")
    assert.equal(
      executionStarted.nativeProject!.project.installedPluginId,
      input.installed.pluginId
    )
    assert.equal(executionStarted.nativeProject!.project.pluginDigest, runtimePackageDigest)
    step("native-command-admission", "passed", {
      originalManagedRunDialog: true,
      publicCommand: "harnessBoard.nativeFeatureCommand(start-feature)",
      hostRunId: binding.hostRunId,
      stateOwner: "host"
    })
    activeStep = "stage-handoff"
    const startIndex = 0
    let executionObserved = false
    const reviewed = new Set<string>()
    let lastKey = ""
    while (true) {
      remaining()
      const current: HarnessRunDetailViewModel = await readRun()
      assert.equal(current.nativeBinding?.hostRunId, binding.hostRunId)
      assert.deepEqual(current.nativeBinding?.expectedPlugin, result.plugin)
      const view = current.nativeProject
      assert(view, "ORIGINAL_FEATURE_NATIVE_RUN_DISAPPEARED")
      assert.equal(view.project.pluginDigest, runtimePackageDigest)
      if (
        !executionObserved &&
        view.operations.some((operation) => operation.execution?.threadId)
      ) {
        executionObserved = true
        step("native-execution", "passed", {
          executionThreadIds: view.operations.flatMap((operation) =>
            operation.execution?.threadId ? [operation.execution.threadId] : []
          )
        })
      }
      const key = JSON.stringify([
        view.project.stageIndex,
        view.project.status,
        view.operations.map((operation) => [operation.operationId, operation.status])
      ])
      if (key !== lastKey) {
        lastKey = key
        result.observations.push({
          time: new Date().toISOString(),
          stageIndex: view.project.stageIndex,
          projectStatus: view.project.status,
          version: view.project.version,
          operations: view.operations.map((operation) => ({
            operationId: operation.operationId,
            stageId: operation.stageId,
            status: operation.status,
            executionThreadId: operation.execution?.threadId,
            checks: operation.receipts.map((receipt) => ({
              checkId: receipt.checkId,
              result: receipt.result
            }))
          }))
        })
        save()
      }
      const transitioned = view.operations.filter(
        (operation) => operation.status === "transitioned"
      )
      if (
        view.project.stageIndex - startIndex >= input.execution.maxStageTransitions ||
        view.project.status === "completed"
      ) {
        assert(transitioned.length > 0 && executionObserved, "ORIGINAL_FEATURE_NO_REAL_TRANSITION")
        step(activeStep, "passed", {
          observedTransitions: transitioned.length,
          stageIndex: view.project.stageIndex,
          projectStatus: view.project.status,
          transitionedOperationIds: transitioned.map((operation) => operation.operationId)
        })
        await page.screenshot({ path: join(artifacts, `${prefix}-original-feature-handoff.png`) })
        const running = view.operations.find((operation) =>
          ["started", "cancel_requested"].includes(operation.status)
        )
        if (running) {
          activeStep = "stop-after-handoff"
          const cancelled = await page.evaluate(
            ({ projectId, featureId, operationId }) =>
              window.api.harnessBoard.nativeFeatureCommand(projectId, featureId, {
                kind: "cancel",
                operationId
              }),
            {
              projectId: project.projectId,
              featureId: runs[0].slug,
              operationId: running.operationId
            }
          )
          assert.equal(cancelled.project.projectId, binding.hostRunId)
          result.nativeCommands.push({
            kind: "cancel",
            evidence: "public-api-response",
            projectId: project.projectId,
            featureId: runs[0].slug,
            operationId: running.operationId
          })
          const stopped = cancelled.operations.find(
            (operation) => operation.operationId === running.operationId
          )
          step(
            "stop-after-handoff",
            stopped && ["cancelled", "succeeded", "failed", "transitioned"].includes(stopped.status)
              ? "passed"
              : "unverified",
            {
              publicCommand: "harnessBoard.nativeFeatureCommand(cancel)",
              cancellationRequested: true,
              operationId: running.operationId,
              statuses: cancelled.operations.map((operation) => operation.status)
            }
          )
        } else step("stop-after-handoff", "passed", { noRunningOperation: true })
        return result
      }
      const operation = view.operations.find(
        (item) =>
          item.stageId === view.project.manifest.stages[view.project.stageIndex]?.id &&
          item.expectedVersion === view.project.version &&
          item.status !== "transitioned"
      )
      if (operation?.status === "unknown") {
        step(activeStep, "unverified", {
          reason: "unknown-execution-outcome",
          operationId: operation.operationId
        })
        return result
      }
      if (operation?.execution?.threadId && operation.status === "started") {
        const pending = await page.evaluate(
          (id) => window.api.sandbox.getPendingApprovals(id),
          operation.execution.threadId
        )
        if (pending.length) {
          if (
            await input.execution.decideKnownEnvironmentApprovals?.({ view, operation, pending })
          ) {
            step("native-environment-approval", "passed", {
              operationId: operation.operationId,
              providerBoundary: input.execution.providerBoundary,
              decision: "explicit-current-one-shot-native-approval"
            })
            continue
          }
          result.environmentIssues.push({
            category: "system-approval",
            message: "Native execution is waiting for filesystem/process environment approval"
          })
          step(activeStep, "environment-blocked", {
            reason: "native-environment-approval-pending",
            operationId: operation.operationId,
            pendingApprovalCount: pending.length
          })
          return result
        }
      }
      if (operation && ["failed", "cancelled"].includes(operation.status)) {
        const receiptText = JSON.stringify({
          terminal: operation.execution?.terminal,
          receipts: operation.receipts
        })
        const environment =
          /(?:GIT_|git (?:worktree|repository)|not a git repository|worktree.*(?:fail|error)|审批|approval.*(?:unavailable|environment))/i.test(
            receiptText
          )
        if (environment)
          result.environmentIssues.push({
            category: /git|worktree/i.test(receiptText) ? "git" : "system-approval",
            message: receiptText
          })
        step(activeStep, environment ? "environment-blocked" : "failed", {
          reason: "native-operation-not-completed",
          operationId: operation.operationId,
          status: operation.status,
          receipts: operation.receipts
        })
        return result
      }
      const executeButton = page.getByRole("button", { name: "批准并执行", exact: true })
      const resultButton = page.getByRole("button", { name: "接受成果并继续", exact: true })
      if (
        operation?.status === "prepared" &&
        (await executeButton.isVisible()) &&
        (await executeButton.isEnabled())
      ) {
        const reviewKey = `execution:${operation.operationId}`
        if (!reviewed.has(reviewKey)) {
          reviewed.add(reviewKey)
          if (!(await input.execution.confirmStage?.(view, operation))) {
            result.pendingReviews.push({
              kind: "execution",
              message: `Execution review required for ${operation.stageId}`
            })
            step(activeStep, "unverified", {
              reason: "native-execution-review-required",
              operationId: operation.operationId
            })
            return result
          }
          await executeButton.click()
          result.nativeCommands.push({
            kind: "approve + continue (original Feature UI)",
            evidence: "ui-submission",
            projectId: project.projectId,
            featureId: runs[0].slug,
            operationId: operation.operationId
          })
        }
      } else if (
        operation?.status === "succeeded" &&
        (await resultButton.isVisible()) &&
        (await resultButton.isEnabled())
      ) {
        const reviewKey = `result:${operation.operationId}`
        if (!reviewed.has(reviewKey)) {
          reviewed.add(reviewKey)
          if (!view.resultReview || !(await input.execution.confirmKnownResult?.(view))) {
            result.pendingReviews.push({
              kind: "result",
              message: `Artifact review required for ${operation.stageId}`
            })
            step(activeStep, "unverified", {
              reason: "native-result-review-required",
              operationId: operation.operationId
            })
            return result
          }
          await resultButton.click()
          result.nativeCommands.push({
            kind: "approve-result + continue (original Feature UI)",
            evidence: "ui-submission",
            projectId: project.projectId,
            featureId: runs[0].slug,
            operationId: operation.operationId
          })
        }
      }
      await new Promise((done) => setTimeout(done, 100))
    }
  } catch (error) {
    const message = errorText(error)
    const category =
      /(?:GIT_|git (?:worktree|repository)|not a git repository|worktree.*(?:fail|error))/i.test(
        message
      )
        ? ("git" as const)
        : /(?:APPROVAL_|审批环境|approval.*(?:unavailable|environment))/i.test(message)
          ? ("system-approval" as const)
          : undefined
    if (category) result.environmentIssues.push({ category, message })
    step(activeStep, category ? "environment-blocked" : "failed", { message })
    return result
  } finally {
    if (activeStage) input.endStage?.()
    save()
  }
}
