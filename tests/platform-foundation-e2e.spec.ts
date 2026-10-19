/** Isolated production app: independent author packages, real streams and native lifecycle. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(
  process.env.COMPOSITION_E2E_PACKAGED_DIR || process.env.PLATFORM_G4_BUILT_PREVIEW === "1",
  "Select an explicit production candidate"
)
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
for (let index = 0; index < 16; index++)
  writeFileSync(join(fixture.workspace, `task-input-${index}.txt`), `actual task input ${index}\n`)
const sustained = process.env.PLATFORM_G4_SUSTAINED === "1"
const demoSmoke = process.env.PLATFORM_DEMO_SMOKE === "1"
assert(!(demoSmoke && sustained), "Demo functional smoke must not run sustained observation")
const observationMs = sustained ? 60 * 60 * 1000 : 0
const rows: unknown[] = [],
  checks: string[] = [],
  errors: string[] = []
const requests: Array<{ round: number; pieces: number; acceptedAt: number; firstByteAt?: number }> = []
let app: ElectronApplication | undefined,
  page: Page | undefined,
  passed = false
const record = (value: unknown) => {
  rows.push(value)
  appendFileSync(
    join(fixture.isolated, "platform-observation.ndjson"),
    JSON.stringify(value) + "\n"
  )
}
const check = (value: unknown, label: string) => {
  assert(value, label)
  checks.push(label)
}
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  timeout = 45000
): Promise<T> {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    const value = await read()
    if (ready(value)) return value
    await pause(100)
  }
  throw Error("Timed out: " + label)
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let raw = ""
    for await (const chunk of request) {
      raw += chunk
      assert(raw.length < 8_000_000)
    }
    const body = JSON.parse(raw)
    const round = requests.length + 1
    assert(round <= 24, "No extra model retries or background model invocations")
    const streamed = { round, pieces: 0, acceptedAt: Date.now(), firstByteAt: undefined as number | undefined }
    requests.push(streamed)
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (let index = 0; index < 40; index++) {
      await pause(20)
      assert(!response.destroyed, "Stream must finish without unexpected cancellation")
      streamed.pieces++
      if (index === 0) streamed.firstByteAt = Date.now()
      response.write(
        `data: ${JSON.stringify({
          id: "g4-" + round,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                ...(index === 0 ? { role: "assistant" } : {}),
                content: `G4_${round}_${index} streaming paragraph.\n\n`
              },
              finish_reason: null
            }
          ]
        })}\n\n`
      )
    }
    response.write(
      `data: ${JSON.stringify({
        id: "g4-" + round,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const watchdog = setTimeout(() => void app?.close(), observationMs + 15 * 60_000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(30000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => !!window.api?.mods)
    await app.evaluate(({ dialog }, workspace) => {
      const original = dialog.showMessageBox.bind(dialog)
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string; detail?: string; message?: string }
        if (!["批准插件运行本机命令", "批准插件操作"].includes(options.title ?? ""))
          return Reflect.apply(original, dialog, args)
        const offset = options.detail?.indexOf("{") ?? -1
        const request = offset >= 0 ? JSON.parse(options.detail!.slice(offset)) : {}
        const expected =
          "const fs=require('node:fs');const files=fs.readdirSync('.').slice(0,16);let i=0;function step(){if(i>=files.length)return;const name=files[i++];const s=fs.statSync(name);console.log(name+' '+s.size+' bytes');setTimeout(step,200)}step()"
        const processAllowed =
          options.title === "批准插件运行本机命令" &&
          Array.isArray(request.argv) &&
          request.argv.length === 3 &&
          request.argv[0] === "node" &&
          request.argv[1] === "-e" &&
          request.argv[2] === expected
        const fileAllowed =
          options.title === "批准插件操作" &&
          options.message?.includes("function:edit-reminder") &&
          options.message.includes("write_file") &&
          ["edit-reminder.txt", workspace.replace(/\\/g, "/") + "/edit-reminder.txt"]
            .map((value) => value.toLowerCase())
            .includes(
              String(request.file_path ?? request.filePath)
                .replace(/\\/g, "/")
                .toLowerCase()
            ) &&
          request.content === "此文件由编辑提醒的明确操作写入。" &&
          Object.keys(request).length === 2 &&
          Object.keys(request).every((key) => ["file_path", "filePath", "content"].includes(key))
        const allowed = processAllowed || Boolean(fileAllowed)
        ;(
          globalThis as typeof globalThis & { g4ProcessApprovals?: unknown[] }
        ).g4ProcessApprovals ??= []
        ;(
          globalThis as typeof globalThis & { g4ProcessApprovals: unknown[] }
        ).g4ProcessApprovals.push({ allowed, title: options.title, request })
        console.log(
          "[G4 isolated native approval]",
          JSON.stringify({ allowed, title: options.title, request })
        )
        return { response: allowed ? 1 : 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    }, fixture.workspace)
    const packages = [
      "provider",
      "consumer",
      "behavior-prefix",
      "behavior-compact",
      "edit-reminder"
    ]
    for (const name of packages) {
      if (demoSmoke) {
        const exampleId = {
          provider: "task-workbench-provider",
          consumer: "task-workbench-consumer",
          "behavior-prefix": "task-behavior-prefix",
          "behavior-compact": "task-behavior-compact",
          "edit-reminder": "edit-reminder"
        }[name]!
        const result = await page.evaluate(
          (id) => window.api.mods.communityExamples.install({ exampleId: id }),
          exampleId as import("../src/shared/mods/community-examples").CommunityExampleId
        )
        assert.equal(result.requiresApproval, true)
        record({ kind: "real-bundled-example-install", exampleId, result })
        continue
      }
      const zip = new AdmZip()
      zip.addLocalFolder(
        name === "edit-reminder"
          ? join(root, "examples/sparks-edit-reminder")
          : join(root, "examples/sparks-task-workbench", name)
      )
      const result = await page.evaluate(
        ({ bytes, name }) =>
          window.api.plugins.install(new Uint8Array(bytes).buffer, `g4-${name}.zip`, "local"),
        { bytes: [...zip.toBuffer()], name }
      )
      assert(result.success, JSON.stringify(result))
      record({
        kind: "real-package-install",
        name,
        digest: createHash("sha256").update(zip.toBuffer()).digest("hex"),
        result
      })
    }
    const scopes = await page.evaluate(
      async ({ workspace, url, demoSmoke }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "g4-loopback",
          name: "G4 controlled streaming",
          baseUrl: url,
          model: "g4-loopback",
          apiKey: "isolated-loopback",
          maxTokens: 1000000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:g4-loopback")
        await window.api.mods.configureGlobal(true)
        const result: Array<{ threadId: string; workspace: string; title: string }> = []
        for (const title of ["G4 任务与长会话 A", "G4 隔离会话 B"]) {
          const row = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const threadId = row.thread_id
          await window.api.workspace.set(threadId, workspace)
          const initial = await window.api.mods.status(threadId)
          await window.api.mods.configure(threadId, true, true, initial.workspace)
          const status = await window.api.mods.status(threadId)
          for (const item of status.functionMods ?? [])
            if (item.state === "needs-approval" && item.digest)
              await window.api.mods.approveFunction(
                threadId,
                item.pluginId,
                item.digest,
                status.workspace
              )
          await window.api.mods.commands(threadId)
          result.push({ threadId, workspace: status.workspace, title })
        }
        const historicalCreatedAt = new Date()
        const historical = Array.from({ length: demoSmoke ? 0 : 160 }, (_, index) => ({
          id: `g4-history-${index}`,
          role: index % 2 ? "assistant" as const : "user" as const,
          created_at: historicalCreatedAt,
          content:
            `History ${index}\n\n` +
            "Historical **formatted** paragraph for actual hydration.\n\n".repeat(24)
        }))
        if (historical.length)
          await window.api.threads.appendMessages(result[0].threadId, historical)
        return result
      },
      { workspace: fixture.workspace, url: `http://127.0.0.1:${address.port}/v1`, demoSmoke }
    )
    record({ kind: "native-scopes", scopes })
    check(requests.length === 0, "Discovery and installation do not invoke the model")
    await page.reload()
    await page.waitForFunction(() => !!window.api?.mods)
    const select = async (index: number) => {
      await page!.getByText(scopes[index].title, { exact: true }).first().click()
      try {
        await page!.locator(`[data-platform-workspace="${scopes[index].threadId}"]`).waitFor()
      } catch (error) {
        record({
          kind: "workspace-launch-diagnostic",
          value: await page!.evaluate(
            async (id) => ({
              visibility: document.visibilityState,
              body: document.body.innerText.slice(0, 4000),
              status: await window.api.mods.status(id),
              surfaces: await window.api.mods.platformSurfaceList(id),
              runtime: await window.api.mods.runtimeSessions(id)
            }),
            scopes[index].threadId
          )
        })
        await page!.screenshot({ path: join(fixture.isolated, "launch-failure.png") })
        throw error
      }
    }
    await select(0)
    const catalog = () =>
      page!.evaluate((id) => window.api.mods.platformSurfaceList(id), scopes[0].threadId)
    const initial = await catalog()
    check(
      initial.entries.filter((row) => row.ref.provider === "task-workbench-consumer").length === 5,
      "Independent consumer registers all five native placements"
    )
    const entry = initial.entries.find((row) => row.placement === "page")!
    const nativeAddress = { key: entry.key, revision: initial.revision }
    const sidebar = page.getByRole("complementary", { name: "扩展侧栏" })
    check(
      await sidebar.isVisible(),
      "Sidebar contribution uses the same controlled surface registry"
    )
    const open = async () => {
      await page!
        .getByRole("navigation", { name: "扩展工作区" })
        .getByRole("button", { name: "个人任务工作台", exact: true })
        .first()
        .click()
      await page!.getByRole("region", { name: "个人任务工作台", exact: true }).waitFor()
      await page!.getByRole("button", { name: "启动实际任务", exact: true }).waitFor()
    }
    const close = async () => {
      const back = page!.getByRole("button", { name: "返回聊天", exact: true })
      if (await back.count()) await back.click()
      await until(
        () => page!.evaluate((id) => window.api.mods.runtimeSessions(id), scopes[0].threadId),
        (value) => {
          const diagnostics = value.sessions.find(
            (row) => row.threadId === scopes[0].threadId
          )?.diagnostics
          return (
            !!diagnostics &&
            diagnostics.subscriptions === 0 &&
            diagnostics.inFlight === 0 &&
            diagnostics.backgroundResources === 0
          )
        },
        "actual subscription cleanup"
      )
    }
    await page.evaluate(() => {
      const chat =
        document.querySelector("[data-testid='virtuoso-item-list']") ??
        document.querySelector("textarea.composer-textarea")
      ;(window as unknown as { g4Chat: Element | null }).g4Chat = chat
    })
    await open()
    check(
      await page.evaluate(() => {
        const saved = (window as unknown as { g4Chat: Element | null }).g4Chat
        return !!saved?.isConnected
      }),
      "Opening a custom page keeps the original chat DOM mounted"
    )
    let nativeCancelCompleted = false
    await page.getByRole("button", { name: "启动实际任务", exact: true }).evaluate(button => {
      const root = button.getRootNode() as Document | ShadowRoot
      const events: unknown[] = []
      const callbacks = {
        captureRows() {
          return Array.from(root.querySelectorAll('tr,[role="row"]')).flatMap(row => {
            const cells = row.querySelectorAll('td,[role="cell"]')
            const title = cells[0]?.textContent?.trim()
            if (title !== "G4 actual process" && title !== "G4 cancel actual process") return []
            const status = cells[1]?.textContent?.trim()
            return [{ title, status: ["running", "succeeded", "failed", "cancelled"].includes(status ?? "") ? status : "unknown" }]
          })
        },
        emit(value: unknown) {
          events.push(value)
          if (events.length > 128) events.shift()
        },
        click(event: Event) {
          const control = event.composedPath().find(node => node instanceof HTMLElement &&
            node.matches('button,[role="button"]'))
          if (!(control instanceof HTMLElement)) return
          const label = control.getAttribute("aria-label") ?? control.textContent?.trim()
          if (label !== "启动实际任务" && label !== "取消 G4 cancel actual process") return
          callbacks.emit({ event: event.type, at: Date.now(), trusted: event.isTrusted, label,
            connected: control.isConnected, rows: callbacks.captureRows() })
        }
      }
      for (const event of ["pointerdown", "pointerup", "click"]) root.addEventListener(event, callbacks.click, true)
      let last = ""
      const observer = new MutationObserver(() => {
        const rows = callbacks.captureRows(), text = JSON.stringify(rows)
        if (text === last) return
        last = text
        callbacks.emit({ event: "ui-observed-task-state", at: Date.now(), rows })
      })
      observer.observe(root, { subtree: true, childList: true, characterData: true })
      const target = window as unknown as { __platformG4TaskDiagnostic?: {
        events: unknown[]; dispose(): void } }
      target.__platformG4TaskDiagnostic = { events, dispose() {
        observer.disconnect()
        for (const event of ["pointerdown", "pointerup", "click"]) root.removeEventListener(event, callbacks.click, true)
      } }
    })
    const allowTimer = setInterval(() => {
      void (async () => {
        const button = page!.getByRole("button", { name: "允许", exact: true }).first()
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 1000 })
          record({ kind: "native-per-operation-approval", at: new Date().toISOString() })
        }
      })().catch(() => {})
    }, 150)
    try {
      await page.getByLabel("任务名称", { exact: true }).fill("G4 actual process")
      await page.getByRole("button", { name: "启动实际任务", exact: true }).click()
      await page
        .getByRole("table")
        .getByRole("row")
        .filter({ hasText: "G4 actual process" })
        .getByRole("cell", { name: "succeeded", exact: true })
        .waitFor({ timeout: 60000 })
      check(
        true,
        "Actual provider process completes through independent consumer UI and native permission chain"
      )
      await page.getByLabel("任务名称", { exact: true }).fill("G4 cancel actual process")
      await page.getByRole("button", { name: "启动实际任务", exact: true }).click()
      await page
        .getByRole("table")
        .getByRole("row")
        .filter({ hasText: "G4 cancel actual process" })
        .getByRole("cell", { name: "running", exact: true })
        .waitFor()
      const cancel = page.getByRole("button", {
        name: "取消 G4 cancel actual process",
        exact: true
      })
      await cancel.waitFor()
      await cancel.click()
      await page
        .getByRole("table")
        .getByRole("row")
        .filter({ hasText: "G4 cancel actual process" })
        .getByRole("cell", { name: "cancelled", exact: true })
        .waitFor({ timeout: 60000 })
      check(
        true,
        "Cancelling an independent author task waits for the existing process resource acknowledgment"
      )
      nativeCancelCompleted = true
      record({
        kind: "controlled-native-process-approval",
        decisions: await app.evaluate(
          () =>
            (globalThis as typeof globalThis & { g4ProcessApprovals?: unknown[] })
              .g4ProcessApprovals
        )
      })
      if (demoSmoke)
        await page.getByLabel("任务名称", { exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(fixture.isolated, "real-workbench.png") })
      await close()
      await sidebar.getByRole("button", { name: "编辑提醒", exact: true }).click()
      await page.getByRole("button", { name: "明确写入示例文件", exact: true }).click()
      await until(
        async () => {
          const path = join(fixture.workspace, "edit-reminder.txt")
          return existsSync(path) ? readFileSync(path, "utf8") : ""
        },
        (value) => value.includes("此文件由编辑提醒"),
        "actual file bytes"
      )
      await page.getByText(/宿主已完成.*edit-reminder\.txt/).waitFor()
      await page.screenshot({ path: join(fixture.isolated, "native-edit-reminder.png") })
      check(
        true,
        "Real native file write completion reaches the author reminder through a targeted subscription"
      )
      await close()
    } finally {
      clearInterval(allowTimer)
      try {
        const value = await page.evaluate(capture => {
          const target = window as unknown as { __platformG4TaskDiagnostic?: {
            events: unknown[]; dispose(): void } }
          const state = target.__platformG4TaskDiagnostic
          const events = capture ? state?.events ?? [] : null
          state?.dispose()
          delete target.__platformG4TaskDiagnostic
          return events
        }, !nativeCancelCompleted)
        if (!nativeCancelCompleted) {
          const diagnostic = { events: value, timingScope: "Trusted DOM dispatch and UI-observed provider state only",
            nativeProcessStartExit: "Not instrumented; no exact physical timestamps are claimed",
            nativeCancelRequest: "Not instrumented; a DOM click is not a native cancellation request timestamp" }
          record({ kind: "native-cancel-failure-diagnostic", ...diagnostic })
          writeFileSync(join(fixture.isolated, "native-cancel-failure-diagnostic.json"), JSON.stringify(diagnostic, null, 2))
        }
      } catch (diagnosticError) {
        rows.push({ kind: "native-cancel-diagnostic-unavailable", error: String(diagnosticError),
          nativeProcessStartExit: "Not instrumented", nativeCancelRequest: "Not instrumented" })
      }
    }
    await close()
    const isolation = await page.evaluate(
      async ({ id, address }) => {
        try {
          await window.api.mods.platformSurfaceOpen(id, address, "foreign-target")
          return false
        } catch {
          return true
        }
      },
      { id: scopes[1].threadId, address: nativeAddress }
    )
    check(isolation, "A surface source address cannot address a different native conversation")
    const behavior = await page.evaluate(
      (id) => window.api.mods.platformBehaviorList(id),
      scopes[0].threadId
    )
    check(
      behavior.bindings.length >= 4,
      "Two author packages register actual behavior alternatives"
    )
    const conflict = await page.evaluate(
      ({ id, selected }) => window.api.mods.platformBehaviorPreview(id, selected),
      { id: scopes[0].threadId, selected: behavior.bindings.map((row) => row.key) }
    )
    record({ kind: "behavior-conflict-preview", value: conflict })
    check(
      !conflict.canApply && conflict.conflicts.length > 0,
      "Competing replacement implementations cannot be silently applied"
    )
    await page.getByRole("button", { name: "行为设置", exact: true }).click()
    const prefixChoices = page.getByRole("checkbox", { name: /前缀提醒：/ })
    assert.equal(await prefixChoices.count(), 2)
    await prefixChoices.nth(0).check()
    await prefixChoices.nth(1).check()
    await page.getByRole("button", { name: "预览顺序与影响", exact: true }).click()
    await page.getByRole("button", { name: "确认应用", exact: true }).click()
    await until(
      () => page!.evaluate((id) => window.api.mods.platformBehaviorList(id), scopes[0].threadId),
      (value) => value.active.length === 2,
      "explicit behavior application"
    )
    await close()
    await open()
    await page.getByRole("button", { name: "核对通知样式", exact: true }).click()
    const replaced = await until(
      () => page!.evaluate((id) => window.api.mods.feedback(id), scopes[0].threadId),
      (value) => value.some((row) => row.text === "提醒：任务工作台通知"),
      "real native toast replacement"
    )
    record({ kind: "actual-behavior-replacement", feedback: replaced })
    await close()
    await page.getByRole("button", { name: "行为设置", exact: true }).click()
    await page.getByRole("button", { name: "停用全部并恢复原实现", exact: true }).click()
    await until(
      () => page!.evaluate((id) => window.api.mods.platformBehaviorList(id), scopes[0].threadId),
      (value) => value.active.length === 0,
      "native behavior restoration"
    )
    await close()
    await open()
    await page.getByRole("button", { name: "核对通知样式", exact: true }).click()
    const restored = await until(
      () => page!.evaluate((id) => window.api.mods.feedback(id), scopes[0].threadId),
      (value) => value.some((row) => row.text === "任务工作台通知"),
      "real native toast restoration"
    )
    record({ kind: "actual-native-restoration", feedback: restored })
    check(
      true,
      "Explicit behavior preview/apply replaces real host presentation; disable restores it"
    )
    await close()
    if (demoSmoke) {
      assert.deepEqual(errors, [])
      assert.equal(requests.length, 0, "This functional smoke does not invoke a model")
      assert.equal(createHash("sha256").update(readFileSync(candidate.path)).digest("hex"),
        candidate.sha256)
      check(true, "Bundled examples execute real tasks, editing and behavior through native APIs")
      passed = true
      return
    }
    await page.getByRole("button", { name: "隐藏侧边栏", exact: true }).click()
    await page.getByRole("button", { name: "隐藏右侧面板", exact: true }).click()
    await page.setViewportSize({ width: 375, height: 812 })
    await open()
    const narrowSurface = await page
      .getByRole("region", { name: "个人任务工作台", exact: true })
      .boundingBox()
    assert(
      narrowSurface && narrowSurface.x >= 0 && narrowSurface.width >= 350 &&
        narrowSurface.x + narrowSurface.width <= 375,
      "The actual narrow surface occupies the available viewport after both desktop panels close"
    )
    await page.screenshot({ path: join(fixture.isolated, "workbench-375.png") })
    await page.keyboard.press("Escape")
    await close()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole("button", { name: "显示侧边栏", exact: true }).click()
    await page.getByRole("button", { name: "显示右侧面板", exact: true }).click()
    check(
      await page.locator("textarea.composer-textarea").isVisible(),
      "Escape at narrow width returns to usable chat"
    )
    const start = performance.now()
    const startedAt = new Date().toISOString()
    const streams: Array<{ round: number; elapsedMs: number; firstMs: number; deltas: number }> = []
    const probeInput = async (round: number | null, sample: number) => {
      const inputBegan = performance.now()
      await page!.locator("textarea.composer-textarea").fill("G4 输入响应核对")
      assert(await page!.getByRole("button", { name: "发送消息", exact: true }).isEnabled())
      await page!.locator("textarea.composer-textarea").fill("")
      record({ kind: "actual-input-response", round, sample,
        elapsedMs: performance.now() - inputBegan })
    }
    let sample = 0
    do {
      if (sample < 20) {
        await select(0)
        const round = sample + 1
        const began = performance.now(),
          beganWall = Date.now(),
          prior = requests.length
        await page
          .locator("textarea.composer-textarea")
          .fill(`G4 observation actual stream ${round}`)
        await page.getByRole("button", { name: "发送消息", exact: true }).click()
        await page.getByText(`G4_${round}_0 streaming paragraph.`, { exact: true }).waitFor()
        const firstMs = performance.now() - began
        const firstObservedWall = Date.now()
        const finalParagraph = page.getByText(`G4_${round}_39 streaming paragraph.`, {
          exact: true
        })
        await finalParagraph.waitFor({ timeout: 45000 })
        await page
          .getByRole("button", { name: "发送消息", exact: true })
          .waitFor({ timeout: 45000 })
        await probeInput(round, sample)
        assert.equal(
          await finalParagraph.count(),
          1,
          "One visible completed answer per real composer send"
        )
        assert.equal(requests.length, prior + 1, "One physical request per native composer send")
        const stream = {
          round,
          elapsedMs: performance.now() - began,
          firstMs,
          beforeModelMs: requests.at(-1)!.acceptedAt - beganWall,
          firstDeliveryMs: firstObservedWall - requests.at(-1)!.firstByteAt!,
          deltas: requests.at(-1)!.pieces
        }
        streams.push(stream)
        record({ kind: "actual-stream", ...stream })
      } else await probeInput(null, sample)
      await open()
      await close()
      await select(1)
      await select(0)
      const messageViewport = page.locator(
        `[data-chat-thread-id=${JSON.stringify(scopes[0].threadId)}] ` +
        "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
      )
      const viewportHandle = await messageViewport.elementHandle()
      assert(viewportHandle, "The selected message viewport has a stable native element")
      const scroll = await (async () => {
        try {
          const wheelIssuedAt = performance.now()
          await viewportHandle.evaluate(element => {
            type Probe = { controller: AbortController; wheelSeen: boolean; trusted: boolean;
              wheelStartTop: number; minimumTop: number; wheelAt: number }
            const viewport = element as HTMLElement & { __platformG4UpwardAck?: Probe }
            if (viewport.__platformG4UpwardAck) throw Error("A prior gesture probe was not disposed")
            const controller = new AbortController()
            const probe: Probe = { controller, wheelSeen: false, trusted: false,
              wheelStartTop: viewport.scrollTop, minimumTop: viewport.scrollTop, wheelAt: 0 }
            viewport.__platformG4UpwardAck = probe
            const rect = viewport.getBoundingClientRect()
            const scope = viewport.closest('[data-chat-thread-id]')
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            Object.defineProperty(viewport, "__platformG4InputInitial", { configurable: true, value: {
              at: Date.now(), top: viewport.scrollTop, height: viewport.clientHeight,
              scrollHeight: viewport.scrollHeight, connected: viewport.isConnected,
              threadId: scope?.getAttribute("data-chat-thread-id"),
              presentation: scope?.querySelector('[data-chat-initial-presentation]')?.getAttribute('data-chat-initial-presentation'),
              documentVisibility: document.visibilityState, documentHasFocus: document.hasFocus(),
              hitTag: hit?.tagName, hitRole: hit?.getAttribute("role"),
              hitWithinViewport: !!hit && viewport.contains(hit)
            } })
            viewport.addEventListener("wheel", event => {
              if (event.deltaY >= 0 || probe.wheelSeen) return
              probe.wheelSeen = true
              probe.trusted = event.isTrusted
              probe.wheelAt = performance.now()
            }, { passive: true, signal: controller.signal })
            viewport.addEventListener("scroll", () => {
              probe.minimumTop = Math.min(probe.minimumTop, viewport.scrollTop)
            }, { passive: true, signal: controller.signal })
          })
          const viewportBox = await viewportHandle.boundingBox()
          assert(viewportBox, "The selected message viewport accepts real user scrolling")
          const x = viewportBox.x + viewportBox.width / 2
          const y = viewportBox.y + viewportBox.height / 2
          await page.mouse.move(x, y)
          await page.mouse.wheel(0, -600)
          record({ kind: "actual-user-wheel", sample, threadId: scopes[0].threadId,
            deltaY: -600, direction: "up", viewport: viewportBox })
          const upwardAck = await until<{
            wheelSeen: boolean
            trusted: boolean
            wheelStartTop: number
            minimumTop: number
            currentTop: number
            upwardObserved: boolean
            detached: boolean
            elapsedSinceWheelMs: number | null
          }>(
            () => viewportHandle.evaluate((element, threadId) => {
              const scope = document.querySelector<HTMLElement>(
                '[data-chat-thread-id="' + CSS.escape(threadId) + '"]'
              )
              const viewports = scope?.querySelectorAll<HTMLElement>(
                "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
              )
              if (!scope || viewports?.length !== 1 || viewports[0] !== element)
                throw Error("The selected viewport changed before real upward input acknowledgment")
              const viewport = element as HTMLElement & { __platformG4UpwardAck?: {
                controller: AbortController; wheelSeen: boolean; trusted: boolean;
                wheelStartTop: number; minimumTop: number; wheelAt: number } }
              const probe = viewport.__platformG4UpwardAck
              if (!probe) throw Error("The native upward gesture probe is missing")
              const upwardObserved = probe.wheelSeen && probe.minimumTop < probe.wheelStartTop - 1
              const detached = !!scope.querySelector('[aria-label="回到会话底部"]')
              if (probe.trusted && upwardObserved && detached) probe.controller.abort()
              return { wheelSeen: probe.wheelSeen, trusted: probe.trusted,
                wheelStartTop: probe.wheelStartTop, minimumTop: probe.minimumTop,
                currentTop: viewport.scrollTop, upwardObserved, detached,
                elapsedSinceWheelMs: probe.wheelSeen ? performance.now() - probe.wheelAt : null }
            }, scopes[0].threadId),
            value => value.trusted && value.upwardObserved && value.detached,
            "A real upward viewport scroll and native detached state before the exact middle target"
          ).catch(async error => {
            try {
              const diagnostic = await viewportHandle.evaluate((element, threadId) => {
                const viewport = element as HTMLElement & { __platformG4InputInitial?: unknown;
                  __platformG4UpwardAck?: { wheelSeen: boolean; trusted: boolean;
                    wheelStartTop: number; minimumTop: number; wheelAt: number } }
                const scope = document.querySelector('[data-chat-thread-id="' + CSS.escape(threadId) + '"]')
                const viewports = scope?.querySelectorAll(
                  "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
                )
                const rect = viewport.getBoundingClientRect(), probe = viewport.__platformG4UpwardAck
                const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                const hitChain: Array<{ tag: string; role: string | null; className: string | null }> = []
                for (let node = hit; node && hitChain.length < 12; node = node.parentElement)
                  hitChain.push({ tag: node.tagName, role: node.getAttribute("role"), className: node.getAttribute("class") })
                const button = scope?.querySelector<HTMLElement>('[aria-label="回到会话底部"]')
                const buttonRect = button?.getBoundingClientRect()
                return { at: Date.now(), initial: viewport.__platformG4InputInitial,
                  listener: probe ? { wheelSeen: probe.wheelSeen, trusted: probe.trusted,
                    wheelStartTop: probe.wheelStartTop, minimumTop: probe.minimumTop,
                    wheelAt: probe.wheelAt, upwardDelta: probe.minimumTop - probe.wheelStartTop } : null,
                  top: viewport.scrollTop, height: viewport.clientHeight, scrollHeight: viewport.scrollHeight,
                  connected: viewport.isConnected, expectedThreadId: threadId,
                  scopeThreadId: scope?.getAttribute("data-chat-thread-id"),
                  viewportCount: viewports?.length ?? 0, sameViewport: viewports?.[0] === element,
                  presentation: scope?.querySelector('[data-chat-initial-presentation]')?.getAttribute('data-chat-initial-presentation'),
                  documentVisibility: document.visibilityState, documentHasFocus: document.hasFocus(),
                  hitWithinViewport: !!hit && viewport.contains(hit), hitChain,
                  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  detachedButton: buttonRect ? { connected: button!.isConnected,
                    x: buttonRect.x, y: buttonRect.y, width: buttonRect.width, height: buttonRect.height,
                    visible: buttonRect.width > 0 && buttonRect.height > 0 && getComputedStyle(button!).visibility !== "hidden" } : null }
              }, scopes[0].threadId)
              record({ kind: "failed-upward-input-ack", sample, diagnostic })
              writeFileSync(join(fixture.isolated, "input-ack-failure-" + sample + ".json"), JSON.stringify(diagnostic, null, 2))
            } catch (diagnosticError) {
              rows.push({ kind: "failed-upward-input-ack-diagnostic-unavailable", sample, error: String(diagnosticError) })
            }
            throw error
          })
          record({ kind: "actual-upward-input-ack", sample, threadId: scopes[0].threadId,
            issueToAckMs: performance.now() - wheelIssuedAt, ...upwardAck })
          const readMiddle = () => viewportHandle.evaluate(async (element, threadId) => {
            const scope = document.querySelector<HTMLElement>(
              `[data-chat-thread-id="${CSS.escape(threadId)}"]`
            )
            const viewports = scope?.querySelectorAll<HTMLElement>(
              "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
            )
            if (!scope || viewports?.length !== 1)
              throw Error("The selected conversation must own exactly one real message viewport")
            const viewport = viewports[0]
            if (viewport !== element) throw Error("The selected viewport changed during sampling")
            if (!(viewport.clientHeight > 0 && viewport.clientHeight <= window.innerHeight))
              throw Error("The real message viewport must fit inside the window")
            if (!(viewport.scrollHeight > 2 * viewport.clientHeight))
              throw Error("The history must exceed two real viewports to verify middle scrolling")
            const before = viewport.scrollTop
            const target = (viewport.scrollHeight - viewport.clientHeight) / 2
            viewport.scrollTop = target
            for (let frame = 0; frame < 2; frame++)
              await new Promise<void>((done) => requestAnimationFrame(() => done()))
            const rect = viewport.getBoundingClientRect()
            const style = getComputedStyle(viewport)
            const visible = [...viewport.querySelectorAll<HTMLElement>("[data-index]")].filter(
              (row) => {
                const box = row.getBoundingClientRect()
                return box.height > 0 && box.width > 0 &&
                  box.bottom > Math.max(0, rect.top) &&
                  box.top < Math.min(window.innerHeight, rect.bottom) &&
                  box.right > Math.max(0, rect.left) &&
                  box.left < Math.min(window.innerWidth, rect.right)
              }
            )
            return {
              threadId,
              documentVisibility: document.visibilityState,
              viewportVisible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
                rect.top < window.innerHeight && style.visibility === "visible" &&
                style.display !== "none",
              windowHeight: window.innerHeight,
              height: viewport.clientHeight,
              scrollHeight: viewport.scrollHeight,
              overflowY: style.overflowY,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              before,
              target,
              after: viewport.scrollTop,
              delta: viewport.scrollTop - before,
              middleRatio: viewport.scrollTop / (viewport.scrollHeight - viewport.clientHeight),
              rows: visible.length,
              indexes: visible.map((row) => row.getAttribute("data-index")),
              blank: visible.filter((row) => !row.textContent?.trim()).length,
              userDetached: !!scope.querySelector('[aria-label="回到会话底部"]')
            }
          }, scopes[0].threadId)
          const restoreBottom = () => viewportHandle.evaluate(async (element, threadId) => {
            const scope = document.querySelector<HTMLElement>(
              "[data-chat-thread-id=" + JSON.stringify(threadId) + "]"
            )
            const viewports = scope?.querySelectorAll<HTMLElement>(
              "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]"
            )
            if (!scope || viewports?.length !== 1 || viewports[0] !== element)
              throw Error("The selected viewport changed during bottom restoration")
            const viewport = viewports[0]
            viewport.scrollTop = viewport.scrollHeight
            for (let frame = 0; frame < 2; frame++)
              await new Promise<void>(done => requestAnimationFrame(() => done()))
            const rect = viewport.getBoundingClientRect()
            const visible = [...viewport.querySelectorAll<HTMLElement>("[data-index]")]
              .filter(row => {
                const box = row.getBoundingClientRect()
                return box.height > 0 && box.width > 0 && box.bottom > Math.max(0, rect.top) &&
                  box.top < Math.min(window.innerHeight, rect.bottom) &&
                  box.right > Math.max(0, rect.left) && box.left < Math.min(window.innerWidth, rect.right)
              })
            return { restoredScrollTop: viewport.scrollTop,
              restoredScrollHeight: viewport.scrollHeight, restoredClientHeight: viewport.clientHeight,
              restoredWindowHeight: window.innerHeight,
              restoredVisibleRows: visible.length,
              restoredBlankRows: visible.filter(row => !row.textContent?.trim()).length,
              restoredPendingNativeSites: visible.reduce((sum, row) => sum +
                row.querySelectorAll('[data-function-site][aria-busy="true"]').length, 0) }
          }, scopes[0].threadId)
          let middle: {
            threadId: string
            documentVisibility: string
            viewportVisible: boolean
            windowHeight: number
            height: number
            scrollHeight: number
            overflowY: string
            rect: {
              x: number
              y: number
              width: number
              height: number
            }
            before: number
            target: number
            after: number
            delta: number
            middleRatio: number
            rows: number
            indexes: Array<string | null>
            blank: number
            userDetached: boolean
          } | undefined
          let restored: {
            restoredScrollTop: number
            restoredScrollHeight: number
            restoredClientHeight: number
            restoredWindowHeight: number
            restoredVisibleRows: number
            restoredBlankRows: number
            restoredPendingNativeSites: number
          } | undefined
          try {
            middle = await readMiddle()
          } finally {
            // A genuine downward gesture reattaches following through native scroll confirmation.
            try {
              await page.mouse.move(x, y)
              await page.mouse.wheel(0, 600)
              record({ kind: "actual-user-wheel", sample, threadId: scopes[0].threadId,
                deltaY: 600, direction: "down", viewport: viewportBox })
            } finally {
              restored = await restoreBottom()
            }
          }
          if (!middle || !restored) throw Error("No real viewport scroll sample was captured")
          return { ...middle, ...restored,
            mixedPhaseDistanceToBottom: restored.restoredScrollHeight - middle.height -
              restored.restoredScrollTop,
            samePhaseDistanceToBottom: restored.restoredScrollHeight - restored.restoredClientHeight -
              restored.restoredScrollTop }
        } finally {
          try {
            await viewportHandle.evaluate(element => {
              const viewport = element as HTMLElement & { __platformG4UpwardAck?: {
                controller: AbortController } }
              viewport.__platformG4UpwardAck?.controller.abort()
              delete viewport.__platformG4UpwardAck
              delete (element as HTMLElement & { __platformG4InputInitial?: unknown }).__platformG4InputInitial
            })
          } finally {
            await viewportHandle.dispose()
          }
        }
      })()
      record({ kind: "actual-scroll-viewport", sample, ...scroll })
      assert(scroll.height > 0 && scroll.height <= scroll.windowHeight)
      assert(scroll.scrollHeight > 2 * scroll.height)
      assert.equal(scroll.documentVisibility, "visible")
      assert(scroll.viewportVisible, "The selected conversation's actual viewport is visible")
      assert(["auto", "scroll"].includes(scroll.overflowY), "The measured element must own scrolling")
      assert(Math.abs(scroll.delta) > 1, "The real viewport must actually change scroll position")
      assert(scroll.middleRatio >= 0.35 && scroll.middleRatio <= 0.65, "History reaches its real middle")
      assert(scroll.rows > 0 && scroll.blank === 0, "Visible middle-history rows stay painted")
      assert(scroll.restoredClientHeight > 0 &&
        scroll.restoredClientHeight <= scroll.restoredWindowHeight,
      "The same native bottom viewport fits inside its current window")
      assert(
        scroll.restoredScrollTop >= scroll.restoredScrollHeight - scroll.restoredClientHeight - 2,
        "The real viewport returns to the bottom after sampling"
      )
      assert(scroll.userDetached, "The real upward gesture detaches native bottom following")
      // Restore the original following state only after every original two-frame verdict.
      const bottomButton = page.getByRole("button", { name: "回到会话底部", exact: true })
      if (await bottomButton.isVisible()) await bottomButton.click()
      const followingRestored = await page.evaluate(async threadId => {
        for (let frame = 0; frame < 2; frame++)
          await new Promise<void>(done => requestAnimationFrame(() => done()))
        const scope = document.querySelector(
          `[data-chat-thread-id="${CSS.escape(threadId)}"]`
        )
        return !!scope && !scope.querySelector('[aria-label="回到会话底部"]')
      }, scopes[0].threadId)
      record({ kind: "actual-follow-restored", sample, followingRestored })
      assert(followingRestored, "The native bottom action restores following for the next sample")
      if (sample % 10 === 0) {
        const presentation = await app.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          window.minimize()
          await new Promise((done) => setTimeout(done, 250))
          const minimized = window.isMinimized()
          window.restore()
          await new Promise((done) => setTimeout(done, 250))
          return { minimized, restored: !window.isMinimized() }
        })
        record({ kind: "native-window-recovery", sample, presentation })
        assert(presentation.restored)
      }
      const measurements = await page.evaluate(
        async (id) => ({
          runtime: await window.api.mods.runtimeSessions(id),
          composerVisible: !!document.querySelector("textarea.composer-textarea"),
          memory:
            (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
              ?.usedJSHeapSize ?? null
        }),
        scopes[0].threadId
      )
      for (const row of measurements.runtime.sessions)
        if (row.diagnostics) {
          assert.equal(row.diagnostics.subscriptions, 0, "Closed pages release real subscriptions")
          assert.equal(row.diagnostics.inFlight, 0, "Settled actions do not accumulate")
          assert.equal(
            row.diagnostics.backgroundResources,
            0,
            "Closed pages and terminal tasks release their actual resources"
          )
        }
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      record({
        kind: "activity-sample",
        sample,
        elapsedMs: performance.now() - start,
        scroll,
        measurements,
        metrics
      })
      writeFileSync(
        join(fixture.isolated, "progress.json"),
        JSON.stringify(
          {
            candidate,
            startedAt,
            observationMs,
            elapsedMs: performance.now() - start,
            samples: sample + 1,
            streams: streams.length,
            checks,
            errors
          },
          null,
          2
        )
      )
      console.log(
        JSON.stringify({
          sample,
          elapsedMs: Math.round(performance.now() - start),
          streams: streams.length
        })
      )
      sample++
      if (sustained && performance.now() - start < observationMs) await pause(30000)
    } while (sample < 20 || (sustained && performance.now() - start < observationMs))
    check(
      streams.length === 20 && requests.length === 20 && requests.every((row) => row.pieces === 40),
      "Twenty complete physical model streams without duplicate requests or lost responses"
    )
    if (sustained)
      check(
        performance.now() - start >= observationMs,
        "At least sixty actual minutes of active page lifecycle, conversation switching and resource observation"
      )
    assert.deepEqual(errors, [])
    check(
      createHash("sha256").update(readFileSync(candidate.path)).digest("hex") === candidate.sha256,
      "The tested candidate remains immutable throughout observation"
    )
    passed = true
  } catch (error) {
    if (page) {
      writeFileSync(
        join(fixture.isolated, "failure.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "Page unavailable")
      )
      await page
        .screenshot({ path: join(fixture.isolated, "failure.png"), timeout: 5000 })
        .catch(() => {})
    }
    throw error
  } finally {
    clearTimeout(watchdog)
    writeFileSync(
      join(fixture.isolated, "platform-acceptance.json"),
      JSON.stringify(
        {
          passed,
          candidate,
          sustained,
          demoSmoke,
          requiredMinutes: sustained ? 60 : 0,
          checks,
          requests,
          errors,
          observations: rows.length,
          profile: fixture.isolated
        },
        null,
        2
      )
    )
    console.log(
      JSON.stringify({
        passed,
        profile: fixture.isolated,
        checks: checks.length,
        requests: requests.length
      })
    )
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}
if (existsSync(join(fixture.isolated, "STOP"))) throw Error("G4_STOP_REQUESTED")
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
