/** Normal built Electron UI: installed QuickJS Function guests -> explicit use consent -> Claw.
 * Setup and observations use public IPC. No test bridge, mocked services, command or model run.
 */
import assert from "node:assert/strict"
import { appendFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { compositionPlugin } from "./support/mods-composition-fixtures"
import { openModsSettings } from "./support/mods-sidebar-navigation"
import { projectBuiltPreview } from "./support/project-built-preview"
import {
  createHeadlessProjectCompositionLaunch,
  compositionHostFlow,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert.equal(process.env.CREATOR_E2E_BUILT_PREVIEW, "1", "Explicit normal build preview required")
assert.equal(process.env.COMPOSITION_E2E_PACKAGED_DIR, undefined, "This acceptance uses no package")
assert.notEqual(process.env.CMB_MODS_E2E, "1", "A testing entry/bridge cannot run this acceptance")
assert.match(process.env.CREATOR_E2E_EXPECTED_SHA256 ?? "", /^[a-f0-9]{64}$/)
const guard = projectBuiltPreview(root, undefined, {
  ...process.env,
  CMB_PROJECT_BUILT_PREVIEW: process.env.CREATOR_E2E_BUILT_PREVIEW,
  CMB_PROJECT_EXPECTED_MAIN_SHA256: process.env.CREATOR_E2E_EXPECTED_SHA256
})
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.execution, "built-output")
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
process.env.COMPOSITION_E2E_ARTIFACT_ROOT ??= join(
  root,
  "output/installed-plugin-activation-native-e2e"
)

// compositionPlugin uses the real v2 register(on) guest and $.command.register SDK. The
// retained Skill is a real installed source, so preservation is checked with a nonempty choice.
function installedPackages() {
  const producer = new AdmZip(Buffer.from(compositionPlugin("composition-a")))
  producer.addFile(
    "skills/activation-retained/SKILL.md",
    Buffer.from(
      "---\nname: activation-retained\ndescription: Retained activation acceptance skill\n---\n" +
        "Inspect only the isolated fixture when explicitly asked.\n"
    )
  )
  for (let index = 1; index <= 24; index++)
    producer.addFile(
      `skills/layout-skill-${index}/SKILL.md`,
      Buffer.from(
        `---\nname: layout-skill-${index}\ndescription: Native source detail scrolling sample ${index}\n---\n` +
          "This installed skill is never invoked by the activation acceptance.\n"
      )
    )
  return [[...producer.toBuffer()], compositionPlugin("composition-b")]
}

interface PassiveUiSample {
  at: number
  target: Array<{ text: string; disabled: boolean }>
  other: Array<{ text: string; disabled: boolean }>
}

async function exercise(binding: "implicit" | "only-a", modelUrl: string, requests: string[]) {
  const fixture = projectCompositionEnvironment(root)
  fixture.env.CMB_MODS_E2E = "0"
  const errors: string[] = []
  const evidence: Record<string, unknown> = {
    binding,
    candidate,
    execution: guard.execution,
    isolated: fixture.isolated,
    restrictions: [
      "Production registered native window and unchanged public IPC; no test entry or renderer service replacement.",
      "Reads the registered command catalogue without enqueueing or running commands.",
      "No model/agent/business task is executed. The configured loopback endpoint must receive zero requests."
    ]
  }
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let passed = false
  const save = () =>
    writeFileSync(
      join(fixture.isolated, "evidence.json"),
      JSON.stringify({ ...evidence, passed, errors, modelRequests: requests }, null, 2)
    )
  const watchdog = setTimeout(() => void app?.close(), 120000)
  try {
    guard.assertCurrent()
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    evidence.application = await guard.verify(app, fixture.isolated)
    for (const [name, stream] of [
      ["stdout", app.process().stdout],
      ["stderr", app.process().stderr]
    ] as const)
      stream?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes)
      )
    assert.equal(await app.evaluate(() => process.env.CMB_MODS_E2E), "0")
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(20000)
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.plugins?.prepareStartUse))
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate((window) => window.setContentSize(1366, 900))
    const title = `Installed plugin activation ${binding}`
    const scope = await page.evaluate(
      async ({ workspace, packages, title, modelUrl, binding }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        for (const id of ["activation-default", "activation-review"])
          await window.api.models.setCustomConfig({
            id,
            name: id,
            baseUrl: modelUrl,
            model: id,
            apiKey: "isolated-loopback-only",
            maxTokens: 64000,
            maxOutputTokens: 2048
          })
        await window.api.models.setDefault("custom:activation-default")
        const thread = await window.api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        const threadId = thread.thread_id
        await window.api.workspace.set(threadId, workspace)
        await window.api.threads.patchMetadata(threadId, {
          set: { model: "custom:activation-default" }
        })
        for (const bytes of packages) {
          const result = await window.api.plugins.install(
            new Uint8Array(bytes).buffer,
            "independent-function-guest.zip",
            "local",
            undefined,
            true
          )
          if (!result.success) throw Error(result.error)
        }
        const installed = (await window.api.plugins.list()).filter((plugin) =>
          ["composition-a", "composition-b"].includes(plugin.name)
        )
        if (installed.length !== 2) throw Error("TWO_INDEPENDENT_INSTALLATIONS_REQUIRED")
        for (const plugin of installed) await window.api.plugins.setEnabled(plugin.id, true)
        let status = await window.api.mods.status(threadId)
        const a = status.functionMods?.find((plugin) => plugin.name === "composition-a")
        const b = status.functionMods?.find((plugin) => plugin.name === "composition-b")
        if (!a?.digest || !b?.digest || a.state === "invalid" || b.state === "invalid")
          throw Error("REAL_FUNCTION_GUESTS_REQUIRED")
        if (a.state !== "needs-approval" || b.state !== "needs-approval")
          throw Error("ISOLATED_SOURCES_MUST_BEGIN_WITHOUT_GRANTS")
        await window.api.mods.approveFunction(threadId, a.pluginId, a.digest, status.workspace)
        const retainedSkill = (await window.api.mods.clawSources(threadId)).skills.find(
          (skill) => skill.name === "activation-retained"
        )
        if (!retainedSkill) throw Error("REAL_INSTALLED_SKILL_REQUIRED")
        if (binding === "only-a") {
          const before = await window.api.mods.clawView(threadId)
          const saved = await window.api.mods.clawChange(threadId, {
            kind: "save",
            workspace: before.workspace,
            revision: before.revision,
            profile: {
              id: "retained-a",
              name: "保留原插件、技能与模型",
              capabilities: [{ pluginId: a.pluginId, name: a.name, digest: a.digest }],
              skills: { mode: "selected", items: [retainedSkill] },
              models: {
                default: "custom:activation-default",
                roles: { review: "custom:activation-review" }
              }
            }
          })
          await window.api.mods.clawChange(threadId, {
            kind: "apply",
            id: "retained-a",
            workspace: saved.workspace,
            revision: saved.revision,
            bindingRevision: saved.bindingRevision
          })
        }
        status = await window.api.mods.status(threadId)
        await window.api.mods.configure(threadId, false, status.outputPolicy, status.workspace)
        await window.api.mods.configureGlobal(false)
        await window.api.plugins.setEnabled(b.pluginId, false)
        return { threadId, a, b, retainedSkill }
      },
      { workspace: fixture.workspace, packages: installedPackages(), title, modelUrl, binding }
    )
    const snapshot = () =>
      page!.evaluate(async (threadId) => {
        const [status, claw, global, jobs, messages, defaultModel] = await Promise.all([
          window.api.mods.status(threadId),
          window.api.mods.clawView(threadId),
          window.api.mods.globalEnabled(),
          window.api.mods.jobs(threadId),
          window.api.threads.getMessages(threadId),
          window.api.models.getDefault()
        ])
        const thread = await window.api.threads.get(threadId)
        return { status, claw, global, jobs, messages, defaultModel, metadata: thread?.metadata }
      }, scope.threadId)
    const before = await snapshot()
    assert.equal(before.claw.usageContext, "chat")
    assert.equal(before.metadata?.agentMode, "normal")
    assert.equal(before.global, false)
    assert.equal(before.status.enabled, false)
    assert.equal(
      before.status.functionMods?.find((item) => item.pluginId === scope.b.pluginId)?.state,
      "disabled"
    )
    assert.deepEqual(
      before.claw.active?.capabilities.map((item) => item.pluginId) ?? [],
      binding === "only-a" ? [scope.a.pluginId] : []
    )
    if (binding === "implicit") assert.equal(before.claw.active, null)
    else assert.equal(before.claw.active?.skills?.items.length, 1)
    evidence.before = before
    evidence.scope = scope
    await page.reload()
    await page.getByText(title, { exact: true }).first().click()

    const enter = async () => {
      await openModsSettings(page!)
      const installed = page!.getByRole("region", { name: "已安装插件", exact: true })
      const card = installed.locator(`[data-installed-mod-id="${scope.b.pluginId}"]`)
      await card.getByRole("heading", { name: "composition-b", exact: true }).waitFor()
      const primary = card.getByRole("button", { name: "开始使用", exact: true })
      assert.equal(await primary.isEnabled(), true)
      await primary.click()
      const approve = card.getByRole("button", { name: "确认并进入使用", exact: true })
      await approve.waitFor()
      assert.equal(
        await approve.isEnabled(),
        true,
        "The real card must finish read-only preparation and release its busy state"
      )
      return { card, approve }
    }

    await enter()
    const withoutConsent = await snapshot()
    assert.equal(
      withoutConsent.status.functionMods?.find((item) => item.pluginId === scope.b.pluginId)?.state,
      "disabled",
      "Opening exact source consent must leave the installed plugin disabled"
    )
    assert.deepEqual(withoutConsent.claw.active, before.claw.active)
    assert.equal(withoutConsent.global, false)
    assert.equal(withoutConsent.status.enabled, false)
    await page.screenshot({
      path: join(fixture.isolated, "before-consent.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    const cancelled = await snapshot()
    assert.equal(
      cancelled.status.functionMods?.find((item) => item.pluginId === scope.b.pluginId)?.state,
      "disabled",
      "Leaving the form without confirming must neither enable the installation nor grant authority"
    )
    assert.deepEqual(cancelled.claw.active, before.claw.active)
    assert.equal(cancelled.global, false)
    assert.equal(cancelled.status.enabled, false)
    evidence.cancelled = cancelled
    // A renderer reload proves cancelled consent did not become a persisted authorization.
    await page.reload()
    await page.getByText(title, { exact: true }).first().click()
    const { card, approve } = await enter()
    await page.evaluate(
      ({ target, other }) => {
        const samples: PassiveUiSample[] = []
        const buttons = (id: string) =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              `[data-installed-mod-id="${id}"] button`
            )
          ].map((button) => ({ text: button.textContent?.trim() ?? "", disabled: button.disabled }))
        const capture = () =>
          samples.push({ at: performance.now(), target: buttons(target), other: buttons(other) })
        const observer = new MutationObserver(capture)
        observer.observe(document.querySelector("[data-installed-mods]")!, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["disabled"]
        })
        capture()
        Object.assign(window, {
          activationUiObservation: {
            samples,
            stop: () => {
              observer.disconnect()
              capture()
              return samples
            }
          }
        })
      },
      { target: scope.b.pluginId, other: scope.a.pluginId }
    )

    guard.assertCurrent()
    await approve.click()
    await card.getByText("/composition-b", { exact: true }).waitFor()
    const returnToChat = card.getByRole("button", { name: "返回聊天", exact: true })
    await returnToChat.waitFor()
    assert.equal(await returnToChat.isEnabled(), true)
    assert.equal(await card.getByRole("button", { name: "确认并进入使用", exact: true }).count(), 0)
    const busySamples = await page.evaluate<PassiveUiSample[]>(
      "window.activationUiObservation.stop()"
    )
    assert(
      busySamples.some((sample) =>
        sample.target.some((button) => button.text === "正在授权…" && button.disabled)
      ),
      "Native activation must show a disabled busy action"
    )
    assert(
      busySamples.some((sample) =>
        sample.other.some((button) => button.text === "开始使用" && button.disabled)
      ),
      "Other card actions must be fenced during activation"
    )
    evidence.busySamples = busySamples

    const after = await snapshot()
    assert.equal(after.global, true)
    assert.equal(after.status.enabled, true)
    assert.equal(
      after.status.functionMods?.find((item) => item.pluginId === scope.b.pluginId)?.state,
      "ready"
    )
    assert.equal(
      after.status.functionMods?.find((item) => item.pluginId === scope.a.pluginId)?.state,
      "ready"
    )
    assert.deepEqual(
      after.claw.active?.capabilities.map((item) => item.pluginId).sort(),
      [scope.a.pluginId, scope.b.pluginId].sort()
    )
    assert.deepEqual(
      after.claw.active?.capabilities.find((item) => item.pluginId === scope.a.pluginId),
      before.claw.active?.capabilities[0] ?? {
        pluginId: scope.a.pluginId,
        name: scope.a.name,
        digest: scope.a.digest
      }
    )
    assert.deepEqual(after.claw.issues, [])
    if (binding === "only-a") {
      assert.deepEqual(after.claw.active?.models, before.claw.active?.models)
      assert.deepEqual(after.claw.active?.skills, before.claw.active?.skills)
    }
    assert.equal(after.defaultModel, before.defaultModel)
    assert.equal(after.metadata?.model, before.metadata?.model)
    const registered = await page.evaluate(
      (threadId) => window.api.mods.commands(threadId),
      scope.threadId
    )
    for (const source of [scope.a, scope.b]) {
      const command = registered.find((entry) => entry.command === source.name)
      assert(command, `Actual QuickJS command registration required: ${source.name}`)
      assert.equal(command.apiVersion, "cmb.mods/v2")
      assert.equal(command.modId, `function:${source.name}`)
      assert.equal(command.digest, source.digest)
      assert.equal(command.immediate, true)
    }
    assert.deepEqual(after.jobs, [])
    assert.deepEqual(after.messages, [])
    assert.deepEqual(requests, [])
    assert.deepEqual(errors, [])
    evidence.after = after
    evidence.registered = registered
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await openModsSettings(page)
    const readyCard = page.locator(`[data-installed-mod-id="${scope.b.pluginId}"]`)
    await readyCard.getByRole("button", { name: "去使用", exact: true }).click()
    await readyCard.getByText("/composition-b", { exact: true }).waitFor()
    assert.equal(
      await readyCard.getByRole("button", { name: "确认并进入使用", exact: true }).count(),
      0,
      "An exact native-ready source in the same workspace opens its use entries directly"
    )
    const reused = await snapshot()
    assert.deepEqual(reused.claw, after.claw)
    assert.deepEqual(reused.jobs, [])
    assert.deepEqual(reused.messages, [])
    assert.deepEqual(requests, [])
    evidence.reused = reused
    await page.screenshot({
      path: join(fixture.isolated, "after-activation.png"),
      animations: "disabled"
    })
    if (binding === "only-a") {
      await page.getByRole("button", { name: "导入与发布", exact: true }).click()
      const layout = page.locator("[data-plugin-source-layout]")
      const list = layout.locator("[data-plugin-source-list]")
      await list
        .getByRole("button")
        .filter({ has: page.getByText("composition-a", { exact: true }) })
        .click()
      const detail = layout.locator("[data-plugin-source-detail]")
      await detail.getByRole("heading", { name: "composition-a", exact: true }).waitFor()
      await detail.getByRole("heading", { name: "Skills", exact: true }).waitFor()
      const originalWindow = await nativeWindow.evaluate((window) => ({
        minimum: window.getMinimumSize(),
        content: window.getContentSize()
      }))
      const viewportSession = await page.context().newCDPSession(page)
      try {
        for (const width of [1366, 375]) {
          await nativeWindow.evaluate((window, width) => {
            // Only this isolated test BrowserWindow changes; production window policy is untouched.
            window.setMinimumSize(0, 0)
            window.setContentSize(width, 900)
          }, width)
          await page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() => requestAnimationFrame(() => done()))
              )
          )
          const windowRequest = {
            requestedContent: { width, height: 900 },
            actual: await nativeWindow.evaluate((window) => ({
              bounds: window.getBounds(),
              contentBounds: window.getContentBounds(),
              minimum: window.getMinimumSize(),
              maximized: window.isMaximized()
            })),
            renderer: await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
          }
          const windowRequests = (evidence.sourceWindowRequests ??= []) as unknown[]
          windowRequests.push(windowRequest)
          save()
          // Windows can retain the ordinary main window's desktop size despite a temporary
          // minimum-size override. Exercise narrow production CSS on the same registered
          // Electron WebContents through Chromium viewport emulation, never a replacement DOM.
          const presentation =
            width === 375 ? "same-Electron-page-CDP-viewport" : "native-OS-window"
          if (width === 375)
            await viewportSession.send("Emulation.setDeviceMetricsOverride", {
              width,
              height: 900,
              deviceScaleFactor: 1,
              mobile: false,
              screenWidth: width,
              screenHeight: 900
            })
          await page.waitForFunction((width) => window.innerWidth === width, width)
          const geometry = await layout.evaluate((element) => {
            const bounds = (node: Element) => {
              const value = node.getBoundingClientRect()
              return {
                x: value.x,
                y: value.y,
                width: value.width,
                height: value.height,
                right: value.right,
                bottom: value.bottom
              }
            }
            const list = element.querySelector<HTMLElement>("[data-plugin-source-list]")!
            const detail = element.querySelector<HTMLElement>("[data-plugin-source-detail]")!
            const viewport = detail.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]")!
            const publish = [...detail.querySelectorAll<HTMLButtonElement>("button")].find(
              (button) => button.textContent?.includes("发布")
            )!
            return {
              viewportWidth: innerWidth,
              layout: bounds(element),
              list: bounds(list),
              detail: bounds(detail),
              publish: bounds(publish),
              direction: getComputedStyle(element).flexDirection,
              documentWidth: document.documentElement.scrollWidth,
              layoutWidth: element.clientWidth,
              layoutScrollWidth: element.scrollWidth,
              detailWidth: detail.clientWidth,
              detailScrollWidth: detail.scrollWidth,
              scrollHeight: viewport.scrollHeight,
              scrollClientHeight: viewport.clientHeight,
              stylesheets: [...document.styleSheets].map((sheet) => sheet.href).filter(Boolean)
            }
          })
          const sourceLayouts = (evidence.sourceLayouts ??= []) as unknown[]
          sourceLayouts.push({ presentation, windowRequest, ...geometry })
          save()
          for (const [name, rectangle] of [
            ["list", geometry.list],
            ["detail", geometry.detail]
          ] as const) {
            assert(
              rectangle.width > 0 && rectangle.height > 0,
              `${width}: real ${name} stays visible`
            )
            assert(
              rectangle.x >= geometry.layout.x - 1 &&
                rectangle.y >= geometry.layout.y - 1 &&
                rectangle.right <= geometry.layout.right + 1 &&
                rectangle.bottom <= geometry.layout.bottom + 1,
              `${width}: real ${name} must remain inside the source content container`
            )
          }
          assert.equal(geometry.direction, width < 640 ? "column" : "row")
          assert(
            geometry.stylesheets.length > 0,
            "Use the actual normal build's production stylesheet"
          )
          assert(
            geometry.documentWidth <= width + 1 &&
              geometry.layoutScrollWidth <= geometry.layoutWidth + 1 &&
              geometry.detailScrollWidth <= geometry.detailWidth + 1,
            `${width}: source layout must not overflow horizontally`
          )
          assert(
            geometry.publish.x >= geometry.detail.x - 1 &&
              geometry.publish.right <= geometry.detail.right + 1 &&
              geometry.publish.y >= geometry.detail.y - 1 &&
              geometry.publish.bottom <= geometry.detail.bottom + 1,
            `${width}: the real publish action must stay inside its detail pane`
          )
          if (width < 640)
            assert(
              geometry.list.height <= geometry.layout.height * 0.4 + 1,
              "Narrow source lists must leave room for the selected plugin detail"
            )
          assert(
            geometry.scrollClientHeight > 0 && geometry.scrollHeight > geometry.scrollClientHeight,
            `${width}: the real skill list must have a bounded scrollable detail viewport`
          )
          const scrolling = detail.locator("[data-radix-scroll-area-viewport]").first()
          await scrolling.evaluate((element) => {
            element.scrollTop = 0
          })
          await scrolling.hover()
          await page.mouse.wheel(0, 600)
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLElement>(
                "[data-plugin-source-detail] [data-radix-scroll-area-viewport]"
              )!.scrollTop > 0
          )
          const publish = detail.getByRole("button", { name: /发布/ })
          assert.equal(await publish.isEnabled(), true)
          await publish.click({ trial: true }) // Actionability only: never opens or submits publication.
          await page.screenshot({
            path: join(fixture.isolated, `source-layout-${width}.png`),
            animations: "disabled"
          })
        }
      } finally {
        await viewportSession.send("Emulation.clearDeviceMetricsOverride")
        await viewportSession.detach()
        await nativeWindow.evaluate((window, original) => {
          window.setMinimumSize(...original.minimum)
          window.setContentSize(...original.content)
        }, originalWindow)
      }
      await page.getByRole("button", { name: "返回插件", exact: true }).click()
      // Source management may remount the usage card. Its ready action was checked above;
      // return through the real settings navigation without preparing or authorizing again.
      await page.getByRole("button", { name: "返回应用", exact: true }).click()
    } else await returnToChat.click()
    await page.locator(`[data-chat-thread-id="${scope.threadId}"]`).waitFor()
    const final = await snapshot()
    assert.deepEqual(final.jobs, [])
    assert.deepEqual(final.messages, [])
    assert.deepEqual(requests, [])
    guard.assertCurrent()
    passed = true
    save()
    console.log(JSON.stringify({ passed, binding, output: fixture.isolated }))
  } catch (cause) {
    evidence.failure = String(cause)
    if (page) {
      await page
        .screenshot({ path: join(fixture.isolated, "failure.png"), animations: "disabled" })
        .catch(() => {})
      evidence.body = await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable")
    }
    save()
    throw cause
  } finally {
    clearTimeout(watchdog)
    await app?.close()
  }
}

async function exerciseProjectWithoutChat(modelUrl: string, requests: string[]) {
  const fixture = projectCompositionEnvironment(root)
  fixture.env.CMB_MODS_E2E = "0"
  const evidence: Record<string, unknown> = { candidate, passed: false }
  const errors: string[] = []
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const watchdog = setTimeout(() => void app?.close(), 120000)
  try {
    guard.assertCurrent()
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    evidence.application = await guard.verify(app, fixture.isolated)
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(20000)
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.plugins?.flowDefinition))
    const plugin = await page.evaluate(
      async ({ bytes, modelUrl }) => {
        await window.api.models.setCustomConfig({
          id: "activation-default",
          name: "activation-default",
          baseUrl: modelUrl,
          model: "activation-default",
          apiKey: "isolated-loopback-only",
          maxTokens: 64000,
          maxOutputTokens: 2048
        })
        await window.api.models.setDefault("custom:activation-default")
        const result = await window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "native-project.zip",
          "local"
        )
        if (!result.success) throw Error(result.error)
        const installed = (await window.api.plugins.list()).find(
          (item) => item.name === "composition-host-fixture"
        )
        if (!installed) throw Error("NATIVE_PROJECT_INSTALLATION_REQUIRED")
        await window.api.plugins.setEnabled(installed.id, false)
        return installed
      },
      { bytes: compositionHostFlow(), modelUrl }
    )
    assert.equal(plugin.hasProjectMode, false, "Legacy metadata must not determine Host entry")
    assert.deepEqual(await page.evaluate(() => window.api.threads.list()), [])
    await page.reload()
    await openModsSettings(page)
    // Normal first launch creates a blank chat. It has no workspace or configuration scope;
    // reading and using a project plugin must neither bind it nor create another chat.
    const initialThreads = await page.evaluate(() => window.api.threads.list())
    assert.equal(initialThreads.length, 1)
    assert.equal(initialThreads[0].metadata?.workspacePath, undefined)
    assert.deepEqual(
      await page.evaluate((id) => window.api.threads.getMessages(id), initialThreads[0].thread_id),
      []
    )
    evidence.initialThreads = initialThreads
    const card = page.locator(`[data-installed-mod-id="${plugin.id}"]`)
    await card.getByRole("button", { name: "管理", exact: true }).click()
    await card.getByRole("button", { name: "查看流程定义", exact: true }).click()
    const definition = card.getByRole("region", { name: "已安装插件流程定义", exact: true })
    await definition.getByText("核对隔离报告", { exact: true }).first().waitFor()
    assert.equal(
      await card.getByText("当前项目流程尚未读取成功，请重新核对绑定。", { exact: true }).count(),
      0
    )
    assert.deepEqual(await page.evaluate(() => window.api.threads.list()), initialThreads)
    evidence.definition = await page.evaluate(
      ({ id, name, version }) =>
        window.api.plugins.flowDefinition({ pluginId: id, expected: { name, version } }),
      plugin
    )
    await page.screenshot({
      path: join(fixture.isolated, "flow-without-chat.png"),
      animations: "disabled"
    })
    await card.getByRole("button", { name: "启用插件", exact: true }).click()
    await card.getByRole("button", { name: "去使用", exact: true }).click()
    const form = page.locator("form").filter({ has: page.getByLabel("项目名称", { exact: true }) })
    await form.waitFor({ state: "visible" })
    await page
      .getByRole("dialog", { name: "新建项目", exact: true })
      .getByRole("button", { name: /composition-host-fixture/ })
      .waitFor()
    assert.deepEqual(await page.evaluate(() => window.api.threads.list()), initialThreads)
    await form.getByLabel("项目名称", { exact: true }).fill("无需聊天即可创建的项目")
    await form.getByLabel("希望完成什么", { exact: true }).fill("核对普通项目入口，不执行任务")
    await app.evaluate(({ dialog }, selected) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string }
        if (options?.title !== "选择任务工作目录") return Reflect.apply(original, dialog, args)
        dialog.showOpenDialog = original
        return { canceled: false, filePaths: [selected] }
      }) as typeof dialog.showOpenDialog
    }, fixture.workspace)
    await form.getByRole("button", { name: "选择工作目录", exact: true }).click()
    await form.getByRole("button", { name: "创建项目", exact: true }).click()
    await form.waitFor({ state: "hidden" })
    const projects = await page.evaluate(() => window.api.harnessBoard.localProjects.list())
    assert.equal(projects.length, 1)
    const view = await page.evaluate(
      (id) => window.api.harnessBoard.localProjects.get(id),
      projects[0].projectId
    )
    assert.equal(view.project.installedPluginId, plugin.id)
    assert.equal(view.project.stageIndex, 0)
    assert.deepEqual(view.operations, [])
    assert.deepEqual(await page.evaluate(() => window.api.threads.list()), initialThreads)
    assert.deepEqual(requests, [])
    assert.deepEqual(errors, [])
    evidence.project = view
    evidence.passed = true
    guard.assertCurrent()
    await page.screenshot({
      path: join(fixture.isolated, "created-without-chat.png"),
      animations: "disabled"
    })
    console.log(
      JSON.stringify({ passed: true, binding: "project-without-chat", output: fixture.isolated })
    )
  } catch (cause) {
    evidence.failure = String(cause)
    if (page) {
      evidence.body = await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable")
      await page.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
    }
    throw cause
  } finally {
    clearTimeout(watchdog)
    writeFileSync(
      join(fixture.isolated, "evidence.json"),
      JSON.stringify({ ...evidence, errors, modelRequests: requests }, null, 2)
    )
    await app?.close()
  }
}

async function main() {
  const selectedCase = process.env.INSTALLED_PLUGIN_ACTIVATION_CASE ?? "all"
  assert(["all", "project-without-chat"].includes(selectedCase), "Unknown activation case")
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(503, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "Activation must never invoke a model" }))
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  try {
    if (selectedCase === "all")
      for (const binding of ["implicit", "only-a"] as const)
        await exercise(binding, `http://127.0.0.1:${address.port}/v1`, requests)
    await exerciseProjectWithoutChat(`http://127.0.0.1:${address.port}/v1`, requests)
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
}

main().catch((cause) => {
  console.error(cause)
  process.exitCode = 1
})
